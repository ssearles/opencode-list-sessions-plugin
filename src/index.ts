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

import { ArchiveError, SessionStore, type SessionRow } from "./db.ts"

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
 * Resolve ids from free-form arguments. Accepts explicit session ids and
 * otherwise falls back to a substring match on id/title/directory.
 */
async function resolve(args: string[]): Promise<{ ids: string[]; matches: SessionRow[] }> {
  const s = await store()
  const ids: string[] = []
  const matches: SessionRow[] = []
  for (const raw of args) {
    const term = raw.trim()
    if (!term) continue
    const all = await s.list()
    if (all.some((r) => r.id === term)) {
      ids.push(term)
      continue
    }
    const hit = all.filter(
      (r) =>
        r.id.toLowerCase().includes(term.toLowerCase()) ||
        r.title.toLowerCase().includes(term.toLowerCase()),
    )
    matches.push(...hit)
    ids.push(...hit.map((r) => r.id))
  }
  return { ids: [...new Set(ids)], matches }
}

function parseArgs(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith("/"))
}

const REMINDER =
  "\n\nReloading OpenCode will pick this up, because the write happens outside " +
  "the server and emits no session update event."

export default {
  id: "opencode-session-archive",

  async setup(ctx: PluginContext) {
    const say = (sessionID: string, text: string) =>
      ctx.session.synthetic({ sessionID, text })

    // ---- commands (appear in the TUI and desktop command palettes) ----

    await ctx.command.transform((editor) => {
      editor.add({
        name: "archived",
        description: "List archived OpenCode sessions",
        execute: async ({ sessionID, prompt }) => {
          try {
            const s = await store()
            const rows = await s.list({ archived: "only" })
            if (rows.length === 0) {
              await say(sessionID, "No archived sessions.")
              return
            }
            await say(
              sessionID,
              [
                `**${rows.length} archived session(s)**`,
                "",
                ...rows.map(describe),
                "",
                "Restore one with `/unarchive <id or title>`.",
              ].join("\n"),
            )
          } catch (err) {
            await say(sessionID, `Error: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
      })

      editor.add({
        name: "archive",
        description: "Archive the current session, or the sessions named after it",
        execute: async ({ sessionID, prompt }) => {
          try {
            const s = await store()
            const args = parseArgs(prompt?.text ?? "")
            const ids = args.length === 0 ? [sessionID] : (await resolve(args)).ids
            if (ids.length === 0) {
              await say(sessionID, "Nothing matched to archive.")
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
        name: "session",
        description: "Show a session transcript by id or title, including archived ones",
        execute: async ({ sessionID, prompt }) => {
          try {
            const s = await store()
            const args = parseArgs(prompt?.text ?? "")
            if (args.length === 0) {
              await say(
                sessionID,
                "Usage: `/session <id or title>` — shows a transcript. Archived sessions work too.",
              )
              return
            }
            const term = args.join(" ")
            const all = await s.list()
            const hit =
              all.find((r) => r.id === term) ??
              all.find((r) => r.id.toLowerCase().includes(term.toLowerCase())) ??
              (await s.find(term))[0]

            if (!hit) {
              await say(sessionID, `No session matched "${term}". Try \`/archived\`.`)
              return
            }

            const msgs = await s.readMessages(hit.id, { limit: 40 })
            const head =
              `**${hit.title}**\n` +
              `${hit.id} · ${hit.directory || "(no directory)"} · ` +
              `${hit.messages ?? msgs.length} messages · ` +
              `${when(hit.created)} → ${when(hit.updated)}` +
              (hit.archived ? " · **archived**" : "")

            if (msgs.length === 0) {
              await say(sessionID, `${head}\n\n(no readable messages)`)
              return
            }

            const body = msgs
              .map((m) => {
                const who =
                  m.type === "user" ? "**You**" : m.type === "synthetic" ? "**Note**" : "**Assistant**"
                const text =
                  m.text.length > 900 ? `${m.text.slice(0, 900)}\n…[truncated]` : m.text
                return `${who} (#${m.seq})\n${text}`
              })
              .join("\n\n")

            const footer = hit.archived ? `\n\nRestore it with \`/unarchive ${hit.id}\`.` : ""
            await say(sessionID, `${head}\n\n${body}${footer}`)
          } catch (err) {
            await say(sessionID, `Error: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
      })

      editor.add({
        name: "unarchive",
        description: "Restore an archived session by id or title",
        execute: async ({ sessionID, prompt }) => {
          try {
            const s = await store()
            const args = parseArgs(prompt?.text ?? "")
            if (args.length === 0) {
              const rows = await s.list({ archived: "only" })
              await say(
                sessionID,
                rows.length === 0
                  ? "No archived sessions."
                  : [
                      `Name a session to restore. Archived sessions:`,
                      "",
                      ...rows.map(describe),
                    ].join("\n"),
              )
              return
            }
            const { ids } = await resolve(args)
            if (ids.length === 0) {
              await say(sessionID, `Nothing matched ${args.join(" ")}. Try \`/archived\`.`)
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

    // ---- tools (the agent can call these) ----

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "session_archive",
        description: "Archive and restore OpenCode sessions that are no longer needed.",
      })

      editor.add({
        name: "list_archived",
        description: "List archived OpenCode sessions. Optionally filter by text.",
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
        name: "read",
        description:
          "Read a session transcript as text. Works on archived sessions, which " +
          "OpenCode's own UI cannot display — use this to review an old session " +
          "before restoring it.",
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
