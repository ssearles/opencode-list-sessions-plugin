/**
 * Render a session as a readable Markdown transcript.
 *
 * OpenCode stores messages in `session_message`, one row per message, with
 * `type` in its own column and a JSON blob in `data`. The shapes differ by
 * type:
 *
 *   user        data.text                       — a plain string
 *   synthetic   data.text                       — a plain string
 *   assistant   data.content[]                  — parts: text / tool-call
 *   idle, system, model-switched, compaction    — bookkeeping, not conversation
 *
 * Tool calls are kept but their output is truncated, and assistant reasoning
 * is dropped: a transcript is a record of what was decided, not of the scratch
 * pad that led there.
 */

import type { SessionStore } from "./db.ts"

/** Message types worth putting in a transcript. */
const RENDERED = new Set(["user", "assistant", "synthetic"])

const LABEL: Record<string, string> = {
  user: "You",
  assistant: "Assistant",
  synthetic: "Note",
}

/** One row of `session_message`. */
interface Row {
  type: string
  data: string
}

/**
 * Pull displayable text out of a message blob.
 *
 * Deliberately forgiving: anything unrecognised is skipped rather than thrown,
 * because a partial transcript is more useful than an error when someone is
 * trying to rescue an old conversation.
 */
export function messageText(row: Row): string {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(row.data) as Record<string, unknown>
  } catch {
    return ""
  }

  const text = msg.text
  if (typeof text === "string" && text.trim()) return text.trim()

  const parts: string[] = []
  for (const raw of (msg.content as unknown[]) || []) {
    const p = raw as Record<string, unknown>
    const kind = p.type

    if (kind === "text" && typeof p.text === "string" && p.text.trim()) {
      parts.push(p.text.trim())
      continue
    }

    // Reasoning is scratchpad; skip it.
    if (kind === "reasoning" || kind === "thinking") continue

    if (kind === "tool-call" || kind === "tool" || kind === "tool-result") {
      const name = String(p.name ?? p.tool ?? "tool")
      const state = (p.state ?? {}) as Record<string, unknown>
      const status = state.status ? String(state.status) : ""
      const raw = state.output ?? state.error ?? state.result ?? ""
      let detail = typeof raw === "string" ? raw : JSON.stringify(raw ?? "")
      detail = detail.trim().replace(/\s+/g, " ")
      if (detail.length > 160) detail = `${detail.slice(0, 160)}…`

      const label = name.startsWith("session_archive") ? name : name
      parts.push(
        detail
          ? `**[tool]** \`${label}\`${status ? ` — ${status}` : ""}\n> ${detail}`
          : `**[tool]** \`${label}\`${status ? ` — ${status}` : ""}`,
      )
    }
  }

  return parts.join("\n\n").trim()
}

/** `YYYY-MM-DD HH:MM` from a millisecond timestamp. */
function when(ms: number | null | undefined): string {
  if (!ms) return ""
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ""
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `HH:MM` from a millisecond timestamp. */
function clock(ms: number | null | undefined): string {
  if (!ms) return ""
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ""
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Turn a session title into a safe filename. */
export function slug(title: string, fallback = "session"): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return base || fallback
}

/**
 * Build the Markdown for one session.
 *
 * @param store an already-open SessionStore
 * @param sessionID the session to render
 */
export async function toMarkdown(store: SessionStore, sessionID: string): Promise<string> {
  const meta = await store.get(sessionID)
  const rows = await store.messages(sessionID)

  const out: string[] = [`# ${meta?.title || sessionID}`, ""]

  if (meta?.created) out.push(`**Started:** ${when(meta.created)}`)
  if (meta?.directory) out.push(`**Directory:** \`${meta.directory}\``)
  if (meta?.archived) out.push("**Archived:** yes")
  out.push(`**Session id:** \`${sessionID}\``)
  out.push("", "---", "")

  let count = 0
  for (const row of rows) {
    if (!RENDERED.has(row.type)) continue
    const body = messageText(row)
    if (!body) continue

    let t: number | undefined
    try {
      t = (JSON.parse(row.data) as { time?: { created?: number } }).time?.created
    } catch {
      t = undefined
    }

    out.push(`### ${LABEL[row.type] ?? row.type} · ${clock(t)}`)
    out.push("")
    out.push(body)
    out.push("")
    count++
  }

  out.push("---", "", `*${count} messages.*`, "")
  return out.join("\n")
}