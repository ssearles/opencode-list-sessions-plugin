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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

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

/**
 * Where a window script lives, and how to launch it.
 *
 * Three places, in order:
 *
 *   1. `~/.local/bin`, by bare name if that directory is on PATH.
 *   2. The package's own `popup/` directory, resolved from this file.
 *   3. `~/.local/bin` by absolute path.
 *
 * (2) is what makes the window work for someone who installed the package from
 * npm and never ran the bundle. The script ships in `files`, so it is already
 * on disk beside this file -- running it from there costs one `existsSync` and
 * writes nothing into the user's home. The alternative, having the plugin
 * install itself into `~/.local/bin` on load, was rejected: a plugin silently
 * writing to a PATH directory is the sort of thing that should be a deliberate
 * act, not a side effect of the package loading.
 *
 * Every candidate is checked before anything is spawned, because a spawn that
 * fails asynchronously looks exactly like a window that never opened — and the
 * report then blames the window rather than the missing file.
 */
function windowCommand(name: string, extraArgs: string[] = []): { bin: string; args: string[] } | { error: string } {
  const localBin = join(homedir(), ".local", "bin")
  const candidates = [join(localBin, name)]
  const onPath = process.env.PATH ?? ""
  if (onPath.split(":").includes(localBin)) candidates.unshift(name)

  // Resolved from this file's own location, not from process.cwd(): a plugin is
  // loaded from wherever it was installed, and the cwd is the user's project.
  const packaged = join(dirname(fileURLToPath(import.meta.url)), "popup", name)
  candidates.push(packaged)

  for (const bin of candidates) {
    const absolute = bin.includes("/") ? bin : join(localBin, bin)
    if (existsSync(absolute)) return { bin, args: extraArgs }
  }
  return { error: `${name} not found (looked in ~/.local/bin and the package)` }
}

/** The session window, with no arguments. */
function popupCommand(): { bin: string; args: string[] } | { error: string } {
  return windowCommand("session-list-popup")
}

/**
 * Launch the popup, detached from this process.
 *
 * `detached: true` plus `unref()` matters: without it the window is a child of
 * the OpenCode server, and closing the app that ran the command takes the window
 * with it. `setsid` is belt-and-braces for the same reason.
 */
function openPopup(): { ok: true } | { ok: false; reason: string } {
  return launch(popupCommand())
}

/**
 * Spawn a window script, detached.
 *
 * `detached: true` plus `unref()` matters: without it the window is a child of
 * the OpenCode server, and closing the app that ran the command takes the window
 * with it. `setsid` is belt-and-braces for the same reason.
 */
function launch(
  found: { bin: string; args: string[] } | { error: string },
): { ok: true } | { ok: false; reason: string } {
  if ("error" in found) return { ok: false, reason: found.error }

  try {
    // Imported lazily so a plugin load never fails on a missing builtin.
    const { spawn } = require("node:child_process") as typeof import("node:child_process")
    const child = spawn("setsid", [found.bin, ...found.args], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

function shortId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 20)}…` : id
}

function when(ms: number | null): string {
  if (!ms) return "-"
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ")
}

/**
 * One menu row: the title first, then the detail needed to tell two similarly
 * named sessions apart.
 *
 * This used to lead with the short id, message count and timestamp, which put
 * the title at the far right where it wrapped off screen — so the one field that
 * identifies a session was the hardest to read. Title leads now; the id and
 * counts follow on the same line and are safe to lose off the edge.
 */
function describe(r: SessionRow): string {
  const msgs = r.messages === null ? "?" : r.messages
  const dir = r.directory ? shortDir(r.directory) : ""
  const bits = [`${shortId(r.id)}`, `${msgs} msg`, when(r.updated)]
  if (dir) bits.push(dir)
  return `${r.title}  —  ${bits.join(" · ")}`
}

/** Last one or two path segments, enough to tell projects apart. */
function shortDir(dir: string): string {
  const parts = dir.split("/").filter(Boolean)
  return parts.slice(-2).join("/")
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
/**
 * ANSI attributes for the row numbers in a menu.
 *
 * The number is the one token the user has to type back, so it is the one thing
 * worth making unmissable — bold and cyan against the plain rows around it.
 *
 * These go in the *file* channel. The synthetic message strips them again
 * ({@link stripAnsi}), because that channel is rendered as Markdown by the
 * client, where a raw escape sequence is noise. Deriving the app copy by
 * stripping the file copy keeps a single source of truth, so the two cannot
 * drift into describing different reports.
 */
const NUM = "\u001b[1;36m" // bold cyan
const OFF = "\u001b[0m"

/** Matches CSI sequences, so they can be removed before the Markdown channel. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g

/** Remove ANSI colour codes, leaving the plain text beneath. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

/**
 * Bold-cyan the leading `N.` of every menu row.
 *
 * Only touches a number at the start of a line, so a session id, a timestamp or
 * a message count elsewhere in the row is left alone.
 */
function emphasizeNumbers(text: string): string {
  return text.replace(/^(\s*)(\d+\.)/gm, (_m, space: string, num: string) =>
    space + NUM + num + OFF,
  )
}

function menu(
  rows: SessionRow[],
  opts: { heading: string; empty: string; action: string; limit?: number },
): string {
  if (rows.length === 0) return opts.empty

  const limit = opts.limit ?? 20
  const shown = rows.slice(0, limit)
  const width = String(shown.length).length

  return emphasizeNumbers([
    `**${opts.heading}**`,
    "",
    ...shown.map((r, i) => `${String(i + 1).padStart(width)}. ${describe(r)}`.replace(/\n/g, " ")),
    ...(rows.length > shown.length
      ? ["", `…and ${rows.length - shown.length} more. Narrow by title instead.`]
      : []),
    "",
    opts.action,
  ].join("\n"))
}

/**
 * One entry per session: title on its own line, id and detail beneath.
 *
 * This used to lead with the state, message count and timestamp, which pushed
 * the title to the far right where it wrapped — and it put the id on an indented
 * continuation line that was easy to misread as belonging to the row above. The
 * title leads, because it is what you scan for; the id is last on its own line
 * where it can be selected and copied whole.
 *
 * The state is carried by the section heading (Working / Archived) rather than
 * repeated on every row, since a row is only ever in one section.
 */
/**
 * Order session rows by title, the way both listings now present them.
 *
 * Case-insensitive, so "apple" and "Banana" file under one alphabet rather than
 * two. Untitled sessions sort last: an empty title would otherwise beat every
 * real one and put the least identifiable rows at the top. `id` breaks the last
 * tie, because titles repeat and a list that reshuffles itself on every write is
 * unreadable while you are reaching for a row in it.
 *
 * This is display order only. `SessionStore.list()` still returns
 * `time_updated DESC`, which is what OpenCode itself uses and what restoring
 * depends on to resurface an archived session.
 */
function byName(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    const at = (a.title ?? "").trim()
    const bt = (b.title ?? "").trim()
    if (at === "" && bt !== "") return 1
    if (bt === "" && at !== "") return -1
    const byText = at.toLowerCase().localeCompare(bt.toLowerCase())
    return byText !== 0 ? byText : a.id.localeCompare(b.id)
  })
}

function inventoryRow(r: SessionRow): string {
  const msgs = r.messages === null ? "?" : r.messages
  const dir = r.directory ? shortDir(r.directory) : ""
  const bits = [`${msgs} msg`, when(r.updated)]
  if (dir) bits.push(dir)
  const state = r.archived ? "archived · Restore" : "unarchived · Archive"
  return `  ${r.title}\n      ${r.id}  ·  ${bits.join(" · ")}  ·  ${state}`
}

/**
 * `/list_sessions` — the whole inventory: working sessions first, then archived.
 *
 * A read-only reference rather than a numbered menu, and deliberately
 * unnumbered. Every line carries its full session id so a row can be selected
 * with the mouse and acted on in the popup window.
 *
 * Numbering is omitted on purpose: every action is a click on a button, so a
 * number in front of a row was a position the reader had to hold in their head
 * and had no way to use. Copying an id is unambiguous, where a remembered number
 * would not be.
 *
 * Rows are sorted by title within each section, matching the popup window.
 * `SessionStore.list()` returns most-recent-first, which is right for
 * OpenCode but made the window's order jump about under the pointer; a list
 * sorted by name stays where you put it.
 *
 * The two sections are ordered unarchived-then-archived because that is also
 * the order the popup window groups them in, and because the state decides the
 * action available: a session cannot be archived twice or restored before it is
 * archived. Each heading says which.
 *
 * This was briefly split into `/list_Current` and `/list_Archived` and put back.
 * Splitting it lost the only single-screen view of both halves, and gained
 * nothing.
 */
function inventory(all: SessionRow[], limit = 60): string {
  if (all.length === 0) return "No sessions found."

  const working = byName(all.filter((r) => !r.archived))
  const archived = byName(all.filter((r) => r.archived))

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
  // The heading names the action that applies to its rows, not just the state.
  // "Working — current" said what a session was but not what could be done to
  // it, and with the archive commands gone this list is the only place a user
  // is told where archiving happens.
  if (working.length) sections.push(block("Unarchived — Archive from the popup window", working).join("\n"))
  if (archived.length) sections.push(block("Archived — Restore from the popup window", archived).join("\n"))

  const hidden = all.length > limit * 2 ? ["", "Some sessions were omitted."] : []

  return [
    ...sections,
    ...hidden,
    "",
    "Archive and restore from the `session-list-popup` window: right-click a",
      "session there for an Archive or Restore button on it.",
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

  // Write in place, deliberately.
  //
  // This was temp-file-plus-rename, to stop a reader seeing a half-written
  // report. But renaming replaces the inode, and a `tail -F` holding the old
  // one then follows a file nothing writes to any more — so the pane froze
  // while the log grew behind it. Atomicity buys very little for a log a person
  // reads; following is the entire point. In-place it is.
  writeFileSync(file, reports.map((r) => REPORT_MARK + "\n" + r).join("\n\n") + "\n", "utf8")
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
        // Stripped: this channel is rendered as Markdown, where a raw escape
        // sequence would be shown literally.
        await ctx.session.synthetic({ sessionID, text: stripAnsi(text) })
      } catch {
        // The file is the fallback; losing the inline copy is survivable.
      }
    }

    // ---- commands (appear in the TUI and desktop command palettes) ----

    await ctx.command.transform((editor) => {
      editor.add({
        name: "list_sessions",
        description:
          "Open the session popup window — unarchived first, then archived, " +
          "with Archive, Restore, Transcript.md, Export .json and Delete on " +
          "each row",
        execute: async ({ sessionID, prompt }) => {
          try {
            // `/list_sessions --text` keeps the old behaviour of printing the
            // inventory into the conversation, for when a window is not wanted
            // or will not open — over SSH, or on a machine with no GTK.
            if (parseArgs(prompt?.text).includes("--text")) {
              const s = await store()
              await say(sessionID, inventory(await s.list()))
              return
            }
            const launched = openPopup()
            await say(
              sessionID,
              launched.ok
                ? [
                    "Opened the session popup window.",
                    "",
                    "Right-click a session there to get its buttons: Archive " +
                      "or Restore, Transcript.md, Export .json, Delete, and " +
                      "Close to back out without doing anything. Unarchived " +
                      "sessions are listed first, each section sorted by name.",
                    "",
                    "`/list_sessions --text` prints the same list as text instead.",
                  ].join("\n")
                : [
                    `Could not open the popup window: ${launched.reason}`,
                    "",
                    "Printing the list as text instead. Archive, restore, delete and " +
                      "export are in the popup window when it is available; " +
                      "the `session_archive` tools still work without it, " +
                      "and so does a transcript of any session.",
                    "",
                    inventory(await (await store()).list()),
                  ].join("\n"),
            )
          } catch (err) {
            await say(sessionID, `Error: ${err instanceof Error ? err.message : String(err)}`)
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
export const __stripAnsi = stripAnsi
export const __emphasizeNumbers = emphasizeNumbers
export const __pickByNumber = pickByNumber
export const __inventory = inventory
/** Exposed for tests: prompt-text argument parsing. */
export const __parseArgs = parseArgs
