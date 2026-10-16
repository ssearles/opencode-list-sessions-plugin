/**
 * opencode-session-archive
 *
 * OpenCode can archive a session but offers no supported way to bring one
 * back: the HTTP API ignores changes to `time_archived`, and the CLI only
 * exposes `list` and `delete`. Archived sessions are effectively write-only.
 *
 * This plugin fills that gap. It registers three slash commands, which appear
 * in the TUI and desktop command palettes, and three tools the agent can call.
 * All writes go straight to the session table after taking a backup, and only
 * ever touch `time_archived` and `time_updated` — never a single message.
 */

import { ArchiveError, SessionStore, type SessionRow } from "./src/db.ts"
import { slug, toMarkdown } from "./src/markdown.ts"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Where `/save` writes by default. Override with OPENCODE_TRANSCRIPT_DIR.
 *
 * ~/Documents rather than a plugin-owned folder, so the file is recognisable in
 * a file manager without the user having to know where a plugin keeps things.
 */
function transcriptDir(): string {
  const custom = process.env.OPENCODE_TRANSCRIPT_DIR
  if (custom) return custom
  return join(homedir(), "Documents")
}

/**
 * Human-readable form of the default output directory, for the `/save`
 * description. Uses `~` rather than an expanded home path so the command popup
 * reads the same on every machine rather than naming one user's account.
 */
function displayDir(): string {
  const dir = transcriptDir()
  const home = homedir()
  return dir === home ? "~" : dir.startsWith(home + "/") ? "~/" + dir.slice(home.length + 1) : dir
}

/**
 * Minimal structural types for the slice of the plugin context this plugin
 * uses. Declared locally rather than imported from `@opencode/plugin` so the
 * package installs with zero dependencies — a local-path plugin cannot rely on
 * that module resolving.
 */
interface CommandEditor {
  add(def: {
    name: string
    description?: string
    execute(input: { sessionID: string; prompt?: { text?: string } }): Promise<void>
  }): void
}
interface ToolEditor {
  namespace(ns: { name: string; description: string }): void
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    /**
     * `options.namespace` is what actually namespaces the tool.
     *
     * Calling `namespace()` above only records a display descriptor — it does
     * not affect the tool id. The host builds each id as
     * `<namespace>_<name>`, falling back to a bare `<name>` when
     * `options.namespace` is absent. Omitting it therefore registers the tool
     * in the same flat registry as the core tools, where a name like `read`
     * silently replaces the host's own.
     */
    options?: { namespace?: string }
    execute(input: any, context?: { signal?: AbortSignal }): Promise<{ content: string }>
  }): void
}
interface PluginContext {
  options: Record<string, unknown>
  app: { version?: string }
  command: { transform(cb: (e: CommandEditor) => void): Promise<unknown> }
  tool: { transform(cb: (e: ToolEditor) => void): Promise<unknown> }
  session: { synthetic(input: { sessionID: string; text: string }): Promise<unknown> }
}

/** Sessions loaded per plugin instance. */
const store = () => SessionStore.open()

function shortId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 20)}…` : id
}

function when(ms: number | null): string {
  if (!ms) return "-"
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ")
}

function describe(r: SessionRow): string {
  const msgs = r.messages === null ? "?" : r.messages
  return `${shortId(r.id)}  ${String(msgs).padStart(4)} msg  ${when(r.updated)}  ${r.title}`
}

/**
 * Resolve session ids from free-form arguments.
 *
 * Matching is deliberately conservative, because this feeds destructive
 * commands. Splitting a title into words and matching each one separately
 * would mean `/archive_Pull my big session` also restored anything else
 * containing "big", so instead:
 *
 *   1. an exact session id always wins
 *   2. otherwise the whole argument is matched as one phrase against the title
 *   3. otherwise a prefix match, then a substring match, are tried in turn
 *
 * The broadest match is used only when it is unambiguous. An ambiguous term
 * resolves to nothing rather than to several sessions, because restoring the
 * wrong session is worse than asking the user to be more specific.
 */
async function resolve(
  args: string[],
): Promise<{ ids: string[]; ambiguous: boolean }> {
  const s = await store()
  const all = await s.list()
  const ids: string[] = []
  let ambiguous = false

  for (const raw of args) {
    const term = raw.trim()
    if (!term) continue

    if (all.some((r) => r.id === term)) {
      ids.push(term)
      continue
    }

    const needle = term.toLowerCase()
    const byField = (r: SessionRow, field: "title" | "directory") =>
      (r[field] ?? "").toLowerCase()

    // Narrowest first: phrase, then prefix, then substring.
    const tiers: SessionRow[][] = [
      all.filter((r) => byField(r, "title").includes(needle)),
      all.filter((r) => byField(r, "title").startsWith(needle)),
      all.filter(
        (r) =>
          byField(r, "title").includes(needle) ||
          byField(r, "directory").includes(needle) ||
          r.id.toLowerCase().includes(needle),
      ),
    ]

    const tier = tiers.find((t) => t.length > 0)
    if (!tier || tier.length === 0) continue
    if (tier.length > 1) {
      ambiguous = true
      continue
    }
    ids.push(tier[0].id)
  }

  return { ids: [...new Set(ids)], ambiguous }
}

/**
 * Pull the arguments out of a command's prompt text.
 *
 * The host passes the whole submitted line, command name included, so
 * `/archive_Put` arrives as the text `"/archive_Put"` rather than `""`. Testing
 * the raw text for emptiness therefore never fires and the command falls through
 * to the argument path, where nothing matches. Tokens starting with `/` are the
 * command name and are dropped, so an empty result means "no argument" however
 * the command was invoked — palette click, typed, or sent with no text.
 */
function parseArgs(text: string | undefined): string[] {
  return (text ?? "")
    .trim()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith("/"))
}

/**
 * Render sessions as a numbered menu.
 *
 * OpenCode gives plugins no way to show a real picker — the TUI bus only
 * carries `command.execute`, `prompt.append`, `session.select` and
 * `toast.show`, none of which displays a list, and a plugin's context exposes
 * `event.subscribe` with no publish. So a dropdown is not reachable from here.
 *
 * Numbered rows are the closest equivalent that works today: the user types a
 * digit instead of a title fragment, and the numbering is stable for the list
 * just printed.
 */
function menu(
  rows: SessionRow[],
  opts: { heading: string; empty: string; action: string; limit?: number },
): string {
  if (rows.length === 0) return opts.empty

  const limit = opts.limit ?? 20
  const shown = rows.slice(0, limit)
  const width = String(shown.length).length

  return [
    `**${opts.heading}**`,
    "",
    ...shown.map((r, i) => `${String(i + 1).padStart(width)}. ${describe(r)}`),
    ...(rows.length > shown.length
      ? ["", `…and ${rows.length - shown.length} more. Narrow by title instead.`]
      : []),
    "",
    opts.action,
  ].join("\n")
}

/** One line per session, with the full id so it can be selected and copied. */
function inventoryRow(r: SessionRow): string {
  const msgs = r.messages === null ? "?" : String(r.messages).padStart(4)
  const state = r.archived ? "archived" : "working"
  return `${state.padEnd(8)} ${msgs} msg  ${when(r.updated)}  ${r.title}\n              ${r.id}`
}

/**
 * `/list_sessions` — the whole inventory: working sessions first, then archived.
 *
 * A read-only reference rather than a numbered menu, and deliberately
 * unnumbered. Every line carries its full session id so a row can be selected
 * with the mouse and pasted straight into `/archive_Put`, `/archive_Pull` or
 * `/session`.
 *
 * Numbering is omitted on purpose: the two write commands count different
 * subsets (`/archive_Put` numbers current only, `/archive_Pull` numbers
 * archived only), so one shared numbering would match neither menu once either
 * group changed size. Copying an id is unambiguous, where a remembered number
 * would not.
 *
 * This was briefly split into `/list_Current` and `/list_Archived` and put back.
 * Splitting it lost the only single-screen view of both halves, and gained
 * nothing: the numbered menus were always available by running `/archive_Put` or
 * `/archive_Pull` with no argument.
 */
function inventory(all: SessionRow[], limit = 60): string {
  if (all.length === 0) return "No sessions found."

  const working = all.filter((r) => !r.archived)
  const archived = all.filter((r) => r.archived)

  const block = (heading: string, rows: SessionRow[]) => {
    if (rows.length === 0) return [`**${heading}**`, "", "_none_"]
    const shown = rows.slice(0, limit)
    return [
      `**${heading}** (${rows.length})`,
      "",
      ...shown.map(inventoryRow),
      ...(rows.length > shown.length ? ["", `…and ${rows.length - shown.length} more.`] : []),
    ]
  }

  const sections: string[] = []
  if (working.length) sections.push(block("Working", working).join("\n"))
  if (archived.length) sections.push(block("Archived", archived).join("\n"))

  const hidden = all.length > limit * 2 ? ["", "Some sessions were omitted."] : []

  return [
    ...sections,
    ...hidden,
    "",
    "Copy a line's id into `/archive_Put <id>` or `/archive_Pull <id>`.",
  ].join("\n\n")
}

/**
 * Resolve a bare 1-based index against a list, as typed in response to a menu.
 *
 * Only digits are treated as a position, so an id or title fragment always
 * wins over a number. Out-of-range values fall through to the normal resolver
 * so the user gets "nothing matched" rather than a silent no-op.
 */
async function pickByNumber(
  args: string[],
  rows: SessionRow[],
  s: SessionStore,
): Promise<{ ids: string[]; ambiguous: boolean; outOfRange: string[] }> {
  const numeric = args.filter((a) => /^\d+$/.test(a))
  if (numeric.length !== args.length) return { ...(await resolve(args)), outOfRange: [] }

  const ids: string[] = []
  const outOfRange: string[] = []
  let ambiguous = false

  for (const a of numeric) {
    const n = Number(a)
    if (n >= 1 && n <= rows.length) ids.push(rows[n - 1].id)
    else {
      // Out of range: stop. Do NOT fall back to a text lookup.
      //
      // A number is a position in the menu the user was just shown, and nothing
      // else. Falling through to a title/id search meant `/archive_Put 99` could
      // archive a session whose title merely contained "99", while the user
      // believed they had picked a row that does not exist. On a write command
      // that is the worst way to be wrong, so an unmatchable number resolves to
      // nothing and the caller explains the range.
      outOfRange.push(a)
    }
  }

  return { ids: [...new Set(ids)], ambiguous, outOfRange }
}

const REMINDER =
  "\n\nReloading OpenCode will pick this up, because the write happens outside " +
  "the server and emits no session update event."

/**
 * Where command output is mirrored to disk, and the name of the file for one run.
 *
 * A synthetic message is the only channel a plugin has for showing text in the
 * session. It normally renders — verified against v2.0.24 on the desktop app for
 * every command here — but it is a channel this plugin does not control, and
 * there was a build where it silently rendered nothing at all.
 *
 * So every command writes the same text here as well. The file is the floor, not
 * the primary: cheap insurance that a successful command can never be mistaken
 * for one that did nothing, which is the unacceptable ambiguity for a command
 * that archived three sessions. Both channels get the same string, so neither
 * can drift from the other.
 *
 * Override with OPENCODE_SESSION_LOG_DIR. One file per run, timestamped, because
 * successive runs must not overwrite each other.
 */
function logDir(): string {
  const custom = process.env.OPENCODE_SESSION_LOG_DIR
  if (custom) return custom
  return join(homedir(), ".local", "share", "opencode", "session-log")
}

/**
 * Explain a number that is not a row in the menu.
 *
 * A number is a position in the list the user was just shown and nothing else,
 * so an out-of-range one has to be refused rather than reinterpreted. The
 * message names the valid range because the most likely cause is a stale menu:
 * archiving or restoring something in between shifts every position after it.
 */
function rangeMessage(
  bad: string[],
  total: number,
  verb: string,
  command: string,
): string {
  return [
    `Nothing ${verb}. ${bad.length === 1 ? "That number is" : "Those numbers are"} not in the menu: ` +
      bad.map((b) => `\`${b}\``).join(", ") + ".",
    "",
    total === 0
      ? `There are no rows to pick — the list is empty. Run \`${command}\` with no argument to see it.`
      : `Valid numbers are 1 to ${total}. Run \`${command}\` with no argument to see the current menu, ` +
        "then use a number from that.",
    "",
    "Positions shift as sessions are archived and restored, so a number that " +
      "worked a moment ago may no longer be in range. Naming a session by id " +
      "always works.",
  ].join("\n")
}

/** `2026-10-16T22-31-29` — filename-safe, sorts chronologically. */
function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/:/g, "-")
}

/**
 * A stable path for the live output, so a follower has one file to watch.
 *
 * The timestamped files are the per-run history; this is the running log.
 * `tail -f` on the directory does not work, and `tail -f *.md` expands once at
 * start so it never picks up a file created later — which is every run after the
 * first. A fixed name sidesteps both.
 *
 * Watch it with `tail -n +1 -F`, not plain `tail -f`: `-n +1` prints from line
 * one so a whole report is visible rather than just its last ten lines, and
 * capital `-F` keeps following across the truncate-and-rewrite below.
 *
 * **Appended, then trimmed — not rewritten.** Rewriting showed the current
 * report but left a follower nothing to scroll: the file was always exactly one
 * report long, so it redrew in place with no history. Appending gives the pane
 * something to scroll through, and {@link KEEP_REPORTS} bounds the growth.
 */
const LATEST = "latest.md"

/** How many reports {@link LATEST} keeps before dropping the oldest. */
const KEEP_REPORTS = 20

/** Reports are separated by a marker so a follower can see where one ends. */
const REPORT_MARK = "<!-- opencode-archive-session report -->"

/**
 * Append one report to the running log, keeping only the most recent few.
 *
 * Split on the marker rather than counting lines, because a report's length
 * varies with the number of sessions — a line count would cut mid-report.
 */
function appendReport(body: string): void {
  const file = join(logDir(), LATEST)

  let existing = ""
  try {
    existing = readFileSync(file, "utf8")
  } catch {
    // No file yet, or unreadable — start from nothing.
  }

  // Push first, then trim — not trim then push. Trimming to KEEP_REPORTS and
  // then appending the new report leaves KEEP_REPORTS + 1, so the cap never
  // holds. Filtering happens before slicing because splitting on the marker
  // leaves an empty leading chunk that would otherwise consume a slot.
  const kept = (existing.split(REPORT_MARK) as string[])
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)

  const reports = [...kept, body.trim()].slice(-KEEP_REPORTS)

  // Write via a temp file and rename, so a reader tailing this path never
  // observes a half-written report.
  const tmp = file + ".tmp"
  writeFileSync(tmp, reports.map((r) => REPORT_MARK + "\n" + r).join("\n\n") + "\n", "utf8")
  renameSync(tmp, file)
}

export default {
  id: "opencode-archive-session",

  async setup(ctx: PluginContext) {
    /**
     * Report command output on both channels: a file that is always readable,
     * and a synthetic message that is convenient when the client renders it.
     *
     * The file is written first and synchronously. If the synthetic message
     * throws — and it can, since the desktop app's handling of them is
     * unreliable — the command has still left its output on disk rather than
     * failing with nothing to show.
     */
    const say = async (sessionID: string, text: string) => {
      const body = text + "\n"
      try {
        mkdirSync(logDir(), { recursive: true })
        writeFileSync(join(logDir(), stamp() + ".md"), body, "utf8")
        // Stable path for `tail -f`. Rewritten, not appended.
        appendReport(body)
      } catch {
        // A read-only or missing directory must not stop the command working.
      }
      try {
        await ctx.session.synthetic({ sessionID, text })
      } catch {
        // The file is the fallback; losing the inline copy is survivable.
      }
    }

    // ---- commands (appear in the TUI and desktop command palettes) ----

    await ctx.command.transform((editor) => {
      editor.add({
        name: "list_sessions",
        description: "List every session — working first, then archived — with copyable ids",
        execute: async ({ sessionID }) => {
          try {
            const s = await store()
            await say(sessionID, inventory(await s.list()))
          } catch (err) {
            await say(sessionID, `Error: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
      })

      editor.add({
        name: "archive_Put",
        description: "Archive a current session by number, id or title",
        execute: async ({ sessionID, prompt }) => {
          try {
            const s = await store()
            const args = parseArgs(prompt?.text)

            // No argument: show the current sessions as a numbered menu. This is
            // the default rather than archiving the session in play, because
            // that is never what someone means when they open the command list.
            if (args.length === 0) {
              const open = await s.list({ archived: "active" })
              await say(
                sessionID,
                menu(open, {
                  heading: "Current sessions",
                  empty: "No current sessions to archive.",
                  action: "Archive one with `/archive_Put <number>`, or name it directly.",
                }),
              )
              return
            }
            const open = await s.list({ archived: "active" })
            const { ids, ambiguous, outOfRange } = await pickByNumber(args, open, s)

            if (outOfRange.length > 0) {
              await say(
                sessionID,
                rangeMessage(outOfRange, open.length, "archived", "/archive_Put"),
              )
              return
            }
            if (ambiguous) {
              await say(
                sessionID,
                `"${args.join(" ")}" matched more than one session, so nothing was archived.`,
              )
              return
            }
            if (ids.length === 0) {
              await say(
                sessionID,
                `Nothing matched "${args.join(" ")}", so nothing was archived. ` +
                  "Run `/list_sessions` to see them, or name one exactly.",
              )
              return
            }
            const { changed, errors, backup } = await s.archive(ids)
            const lines = [`Archived ${changed.length} session(s).`]
            for (const c of changed) lines.push(`  ${shortId(c)}`)
            if (errors.length) lines.push("", "Failed:", ...errors.map((e) => `  ${e}`))
            lines.push("", `Backup: ${backup}`)
            if (ids.includes(sessionID)) lines.push("", `This session (${shortId(sessionID)}) is now archived.`)
            lines.push(REMINDER)
            await say(sessionID, lines.join("\n"))
          } catch (err) {
            await say(sessionID, `Error: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
      })


      editor.add({
        name: "archive_Pull",
        description: "Restore an archived session by number, id or title",
        execute: async ({ sessionID, prompt }) => {
          try {
            const s = await store()
            const args = parseArgs(prompt?.text)
            const rows = await s.list({ archived: "only" })

            if (args.length === 0) {
              await say(
                sessionID,
                menu(rows, {
                  heading: "Archived sessions",
                  empty: "No archived sessions.",
                  action: "Restore one with `/archive_Pull <number>`, or name it directly.",
                }),
              )
              return
            }
            const { ids, ambiguous, outOfRange } = await pickByNumber(args, rows, s)
            if (outOfRange.length > 0) {
              await say(
                sessionID,
                rangeMessage(outOfRange, rows.length, "restored", "/archive_Pull"),
              )
              return
            }
            if (ambiguous) {
              await say(
                sessionID,
                [
                  `The term "${args.join(" ")}" matched more than one session, ` +
                    "so nothing was restored.",
                  "",
                  "Name one by number from the list, or use a more specific phrase.",
                ].join("\n"),
              )
              return
            }
            if (ids.length === 0) {
              await say(
                sessionID,
                `Nothing matched "${args.join(" ")}", so nothing was restored. ` +
                  "Run `/list_sessions` to see them.",
              )
              return
            }
            const { changed, errors, backup } = await s.unarchive(ids)
            const lines = [`Restored ${changed.length} session(s).`]
            for (const c of changed) {
              const row = await s.get(c)
              lines.push(`  ${shortId(c)}  → ${row?.directory || "(unknown directory)"}`)
            }
            if (errors.length) lines.push("", "Failed:", ...errors.map((e) => `  ${e}`))
            lines.push(
              "",
              "Restored sessions are listed under their original project folder and",
              "sort to the top of that folder's recent list.",
              "",
              `Backup: ${backup}`,
              REMINDER,
            )
            await say(sessionID, lines.join("\n"))
          } catch (err) {
            await say(sessionID, `Error: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
      })
    })

    /**
     * `/save` — write the session out as readable Markdown.
     *
     * Added when this plugin was forked from `opencode-session-transcript`,
     * where it is the only command. It is read-only: it opens the store and
     * renders, and never writes to the database.
     *
     * Unlike `/export` and `opencode session export`, which both emit JSON,
     * and unlike the TUI `/export`, which only sees the messages currently
     * loaded in the window, this reads every message for the session straight
     * out of SQLite — so the transcript is complete however long the thread is
     * and however little of it has been scrolled.
     */
    await ctx.command.transform((editor) => {
      editor.add({
        name: "save",
        description:
          "Export the whole session to " + displayDir() + "/<title>.md — " +
          "like /export, but flushes all messages",
        execute: async ({ sessionID, prompt }: { sessionID: string; prompt?: { text?: string } }) => {
          try {
            const s = await SessionStore.open()
            const meta = await s.get(sessionID)
            const markdown = await toMarkdown(s, sessionID)

            // An argument ending in .md is taken as an explicit output path, so
            // `/save ~/Desktop/today.md` works without any configuration.
            const asked = (prompt?.text ?? "")
              .trim()
              .split(/\s+/)
              .filter((t) => t && !t.startsWith("/"))
            const explicit = asked.find((a) => a.endsWith(".md"))

            const target = explicit
              ? explicit.replace(/^~(?=\/)/, homedir())
              : join(transcriptDir(), (slug(meta?.title ?? "session")) + ".md")

            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, markdown, "utf8")

            const headings = markdown.split("\n").filter((l) => l.startsWith("### "))
            await ctx.session.synthetic({
              sessionID,
              text:
                "`" + target + "`\n\n" +
                headings.length + " messages · " +
                Math.round(markdown.length / 1024) + " KB",
            })
          } catch (err) {
            await ctx.session.synthetic({
              sessionID,
              text: "Error: " + (err instanceof Error ? err.message : String(err)),
            })
          }
        },
      })
    })

    // ---- tools (the agent can call these) ----

    /**
     * Every tool must set `options.namespace` explicitly, otherwise the host
     * registers it under its bare name and it can shadow a core tool.
     */
    const NS = "session_archive"

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: NS,
        description: "Archive and restore OpenCode sessions that are no longer needed.",
      })

      editor.add({
        // Not `list`: that is a core tool name, and test/namespacing.test.ts
        // rightly refuses to reuse one even when namespaced.
        name: "list_sessions",
        description:
          "List OpenCode sessions with their ids. Defaults to every session; " +
          "set archived to 'active' for working sessions or 'only' for archived. " +
          "Use this to show a numbered list the user can then pick from by number.",
        options: { namespace: NS },
        input: {
          type: "object",
          properties: {
            archived: {
              type: "string",
              enum: ["all", "active", "only"],
              description: "Which sessions to list. Default all.",
            },
            search: { type: "string", description: "Filter by id, title or directory." },
          },
          additionalProperties: false,
        },
        execute: async (input: { archived?: "all" | "active" | "only"; search?: string }) => {
          const s = await store()
          const archived = input.archived ?? "all"
          const rows = input.search
            ? await s.find(input.search, { archived })
            : await s.list({ archived })

          if (rows.length === 0) return { content: "No sessions matched." }

          return {
            content: rows
              .map(
                (r) =>
                  `${r.id}\t${r.archived ? "archived" : "working"}\t${r.messages ?? "?"} msg\t` +
                  `${when(r.updated)}\t${r.directory || "-"}\t${r.title}`,
              )
              .join("\n"),
          }
        },
      })

      editor.add({
        name: "list_archived",
        description: "List archived OpenCode sessions. Optionally filter by text.",
        options: { namespace: NS },
        input: {
          type: "object",
          properties: { search: { type: "string" } },
          additionalProperties: false,
        },
        execute: async (input: { search?: string }) => {
          const s = await store()
          const rows = input.search
            ? await s.find(input.search, { archived: "only" })
            : await s.list({ archived: "only" })
          return {
            content:
              rows.length === 0
                ? "No archived sessions."
                : rows
                    .map((r) => `${r.id}\t${when(r.updated)}\t${r.directory}\t${r.title}`)
                    .join("\n"),
          }
        },
      })

      editor.add({
        name: "archive",
        description: "Archive one or more sessions by id so they leave the active list.",
        options: { namespace: NS },
        input: {
          type: "object",
          properties: {
            session_ids: {
              type: "array",
              items: { type: "string" },
              description: "Session ids such as ses_abc123.",
            },
          },
          required: ["session_ids"],
          additionalProperties: false,
        },
        execute: async (input: { session_ids: string[] }) => {
          const s = await store()
          const { changed, errors, backup } = await s.archive(input.session_ids)
          return {
            content: [
              `Archived ${changed.length}: ${changed.join(", ") || "none"}`,
              errors.length ? `Errors: ${errors.join("; ")}` : "",
              `Backup: ${backup}`,
            ]
              .filter(Boolean)
              .join("\n"),
          }
        },
      })

      editor.add({
        // Not `read`: an unnamespaced tool of that name replaces the host's own
        // read tool, which breaks every other request that touches a file.
        name: "read_transcript",
        description:
          "Read a session transcript as text. Works on archived sessions, which " +
          "OpenCode's own UI cannot display — use this to review an old session " +
          "before restoring it.",
        options: { namespace: NS },
        input: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "Session id such as ses_abc123." },
            search: {
              type: "string",
              description: "Find the session by title or id fragment instead.",
            },
            limit: {
              type: "number",
              description: "Return at most this many of the newest messages (default 40).",
            },
          },
          additionalProperties: false,
        },
        execute: async (input: { session_id?: string; search?: string; limit?: number }) => {
          const s = await store()
          let hit = input.session_id ? await s.get(input.session_id) : undefined
          if (!hit && input.search) hit = (await s.find(input.search))[0]
          if (!hit) return { content: "No matching session." }

          const msgs = await s.readMessages(hit.id, { limit: input.limit ?? 40 })
          const head =
            `${hit.title}\n${hit.id} · ${hit.directory || "(no directory)"}` +
            (hit.archived ? " · archived" : "")
          if (msgs.length === 0) return { content: `${head}\n(no readable messages)` }
          const body = msgs.map((m) => `[${m.type} #${m.seq}] ${m.text}`).join("\n\n")
          return { content: `${head}\n\n${body}` }
        },
      })

      editor.add({
        name: "unarchive",
        description:
          "Restore archived sessions by id. This is the only way to recover a session " +
          "that has been archived, because OpenCode provides no API for it.",
        options: { namespace: NS },
        input: {
          type: "object",
          properties: {
            session_ids: {
              type: "array",
              items: { type: "string" },
              description: "Session ids such as ses_abc123.",
            },
          },
          required: ["session_ids"],
          additionalProperties: false,
        },
        execute: async (input: { session_ids: string[] }) => {
          const s = await store()
          const { changed, errors, backup } = await s.unarchive(input.session_ids)
          const detail: string[] = []
          for (const id of changed) {
            const row = await s.get(id)
            detail.push(`  ${id} → ${row?.directory ?? "(unknown)"}`)
          }
          return {
            content: [
              `Restored ${changed.length}: ${changed.join(", ") || "none"}`,
              ...detail,
              errors.length ? `Errors: ${errors.join("; ")}` : "",
              `Backup: ${backup}`,
            ]
              .filter(Boolean)
              .join("\n"),
          }
        },
      })
    })
  },
}

export { ArchiveError }
export { slug, toMarkdown }
/** Exposed for tests: the argument resolver, which drives destructive commands. */
/**
 * Resolve against a caller-supplied row list, synchronously.
 *
 * This is the `/archive_Pull` contract from `opencode-session-transcript`, kept
 * alongside the store-backed resolver above because both are exercised: a bare
 * number is a 1-based position in the list that was just printed, an exact id
 * always wins over a number, and a term matching several rows resolves to
 * nothing rather than to an arbitrary pick.
 *
 * Narrowest-first:
 *   1. an exact session id
 *   2. a bare number, as a 1-based position in `rows`
 *   3. a title substring, then a broader directory/id substring
 */
function resolveRows(
  args: string[],
  rows: SessionRow[],
): { ids: string[]; ambiguous: boolean } {
  const ids: string[] = []
  let ambiguous = false

  for (const raw of args) {
    const term = raw.trim()
    if (!term) continue

    if (rows.some((r) => r.id === term)) {
      ids.push(term)
      continue
    }

    if (/^\d+$/.test(term)) {
      const n = Number(term)
      if (n >= 1 && n <= rows.length) ids.push(rows[n - 1].id)
      continue
    }

    const needle = term.toLowerCase()
    const byTitle = rows.filter((r) => r.title.toLowerCase().includes(needle))
    // Fall back only when the narrow match found nothing — `[]` is truthy, so
    // this cannot be written as `||`.
    const hits =
      byTitle.length > 0
        ? byTitle
        : rows.filter(
            (r) =>
              r.directory.toLowerCase().includes(needle) ||
              r.id.toLowerCase().includes(needle),
          )

    if (hits.length > 1) {
      ambiguous = true
      continue
    }
    if (hits.length === 1) ids.push(hits[0].id)
  }

  return { ids: [...new Set(ids)], ambiguous }
}

/**
 * The exported resolver, overloaded across the two eras of this plugin.
 *
 * - `__resolve(args)` opens the store and resolves narrowest-first against every
 *   session it knows about. Asynchronous, because reading them is.
 * - `__resolve(args, rows)` resolves against rows the caller already has, and is
 *   synchronous, so a numbered menu can resolve without a second round trip.
 *
 * Callers that `await` the result work with either form, since awaiting a plain
 * value is a no-op — which is what lets both test suites share one export.
 */
export function __resolve(args: string[]): Promise<{ ids: string[]; ambiguous: boolean }>
export function __resolve(
  args: string[],
  rows: SessionRow[],
): { ids: string[]; ambiguous: boolean }
export function __resolve(
  args: string[],
  rows?: SessionRow[],
): { ids: string[]; ambiguous: boolean } | Promise<{ ids: string[]; ambiguous: boolean }> {
  return rows ? resolveRows(args, rows) : resolve(args)
}
/** Exposed for tests: numbered-menu selection and rendering. */
export const __menu = menu
export const __pickByNumber = pickByNumber
export const __inventory = inventory
/** Exposed for tests: prompt-text argument parsing. */
export const __parseArgs = parseArgs
