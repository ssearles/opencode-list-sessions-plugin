/**
 * Database access for the session archive plugin.
 *
 * OpenCode ships two incompatible on-disk schemas:
 *
 *   v1.x  sessions in table `session`
 *   v2.x  sessions in table `session_v2`
 *
 * Nothing here hardcodes either layout. The table is discovered and its
 * columns introspected, so the same code works across both and degrades
 * gracefully if a future release drops something we relied on.
 *
 * Safety model:
 *   - Reads go through the plugin's own connection and never write.
 *   - Every write first takes a consistent snapshot via `VACUUM INTO`, which
 *     is safe while OpenCode holds the database open in WAL mode.
 *   - Only `time_archived` and `time_updated` are ever written. Archiving and
 *     restoring never touch a single message.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Minimal surface shared by `bun:sqlite` and `node:sqlite`. */
interface SqlStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}
interface SqlDatabase {
  prepare(sql: string): SqlStatement
  exec(sql: string): void
  close(): void
}

type DatabaseCtor = new (path: string, ...rest: unknown[]) => SqlDatabase

let ctorPromise: Promise<DatabaseCtor> | null = null

/**
 * OpenCode executes plugins under Bun, which exposes `bun:sqlite`. Node 22+
 * exposes the equivalent `node:sqlite`. Resolve whichever this runtime has.
 */
async function loadSqlite(): Promise<DatabaseCtor> {
  if (!ctorPromise) {
    ctorPromise = (async () => {
      try {
        const bun = (await import(/* @vite-ignore */ "bun:sqlite")) as unknown as {
          Database: DatabaseCtor
        }
        if (bun?.Database) return bun.Database
      } catch {
        /* not running under Bun */
      }
      const node = (await import(/* @vite-ignore */ "node:sqlite")) as unknown as {
        DatabaseSync: DatabaseCtor
      }
      if (!node?.DatabaseSync) {
        throw new Error(
          "No SQLite driver available: needs Bun (bun:sqlite) or Node >= 22 (node:sqlite).",
        )
      }
      return node.DatabaseSync
    })()
  }
  return ctorPromise
}

export class ArchiveError extends Error {}

/** Candidate session tables, most preferred first. */
const CANDIDATE_TABLES = ["session_v2", "session"] as const

export interface SessionRow {
  id: string
  title: string
  directory: string
  created: number | null
  updated: number | null
  archived: number | null
  messages: number | null
}

/** One readable message pulled back out of a session transcript. */
export interface MessageView {
  seq: number
  type: string
  at: number | null
  text: string
}

/**
 * Pull displayable text out of a stored message payload.
 *
 * Message `data` differs by type and has changed shape between releases, so
 * this is deliberately forgiving: anything unrecognised falls back to a short
 * raw slice rather than throwing, because a partial transcript is more useful
 * than an error when someone is trying to recover a session.
 */
function extractText(type: string, raw: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return raw.slice(0, 240)
  }

  const str = (v: unknown): string => (typeof v === "string" ? v : "")

  switch (type) {
    case "user": {
      const meta = (parsed.metadata ?? {}) as Record<string, unknown>
      return str(meta.displayText) || str(parsed.text)
    }
    case "assistant": {
      const parts = Array.isArray(parsed.content) ? parsed.content : []
      return parts
        .map((p) => {
          const part = p as Record<string, unknown>
          // "text" is the answer proper; "reasoning" is scratchpad.
          return part.type === "text" ? str(part.text) : ""
        })
        .filter(Boolean)
        .join("\n\n")
    }
    case "synthetic":
      return str(parsed.text)
    default:
      return ""
  }
}

export function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit
  const fromEnv = process.env.OPENCODE_DB
  if (fromEnv) return fromEnv
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "opencode.db")
}

/**
 * A read/write handle on OpenCode's session store.
 *
 * The handle is opened per operation and closed immediately, so a long-running
 * OpenCode server never holds a connection we forgot to release.
 */
export class SessionStore {
  readonly dbPath: string
  private table!: string
  private columns!: Set<string>

  private constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  static async open(explicitPath?: string): Promise<SessionStore> {
    const dbPath = resolveDbPath(explicitPath)
    if (!existsSync(dbPath)) {
      throw new ArchiveError(
        `OpenCode database not found at ${dbPath}. ` +
          `Set OPENCODE_DB to point at it explicitly.`,
      )
    }
    const store = new SessionStore(dbPath)
    await store.#detectSchema()
    return store
  }

  async #connect(): Promise<SqlDatabase> {
    const Ctor = await loadSqlite()
    return new Ctor(this.dbPath)
  }

  async #detectSchema(): Promise<void> {
    const db = await this.#connect()
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
      const names = new Set(rows.map((r) => r.name))

      const found = CANDIDATE_TABLES.find((t) => names.has(t))
      if (!found) {
        throw new ArchiveError(
          `No session table found. Looked for ${CANDIDATE_TABLES.join(" and ")}; ` +
            `found: ${[...names].sort().join(", ") || "nothing"}.`,
        )
      }
      this.table = found
      this.columns = new Set(
        (db.prepare(`PRAGMA table_info(${this.table})`).all() as { name: string }[]).map(
          (r) => r.name,
        ),
      )
    } finally {
      db.close()
    }
  }

  get tableName(): string {
    return this.table
  }

  get schema(): "v1" | "v2" {
    return this.table === "session_v2" ? "v2" : "v1"
  }

  #require(...cols: string[]): void {
    const missing = cols.filter((c) => !this.columns.has(c))
    if (missing.length)
      throw new ArchiveError(`Table ${this.table} is missing: ${missing.join(", ")}`)
  }

  /** Find a message table and return a per-session count expression, if possible. */
  async #messageExpr(db: SqlDatabase): Promise<string> {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string
      }[]).map((r) => r.name),
    )
    for (const [table, col] of [
      ["session_message", "session_id"],
      ["message", "session_id"],
      ["message_part", "session_id"],
    ] as const) {
      if (!tables.has(table)) continue
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (r) => r.name,
        ),
      )
      if (cols.has(col)) return `(SELECT COUNT(*) FROM ${table} WHERE ${col} = s.id)`
    }
    return "NULL"
  }

  /** List sessions. `archived` is one of `all`, `only`, `active`. */
  async list(
    opts: { archived?: "all" | "only" | "active"; limit?: number } = {},
  ): Promise<SessionRow[]> {
    const { archived = "all", limit } = opts
    this.#require("id", "time_archived")

    const db = await this.#connect()
    try {
      const col = (name: string) => (this.columns.has(name) ? `s.${name}` : "NULL")
      const msgExpr = await this.#messageExpr(db)

      let sql =
        `SELECT s.id AS id, ${col("title")} AS title, ${col("directory")} AS directory, ` +
        `${col("time_created")} AS time_created, ${col("time_updated")} AS time_updated, ` +
        `s.time_archived AS time_archived, ${msgExpr} AS messages FROM ${this.table} s`

      if (archived === "only") sql += " WHERE s.time_archived IS NOT NULL"
      else if (archived === "active") sql += " WHERE s.time_archived IS NULL"
      else if (archived !== "all")
        throw new ArchiveError(`Unknown archived filter: ${archived}`)

      const order = this.columns.has("time_updated") ? "time_updated" : "time_created"
      sql += ` ORDER BY s.${order} DESC`
      if (limit !== undefined) sql += ` LIMIT ${Number(limit)}`

      const rows = db.prepare(sql).all() as Record<string, unknown>[]
      return rows.map((r) => ({
        id: String(r.id),
        title: (r.title as string) || "(untitled)",
        directory: (r.directory as string) || "",
        created: (r.time_created as number) ?? null,
        updated: (r.time_updated as number) ?? null,
        archived: (r.time_archived as number) ?? null,
        messages: (r.messages as number) ?? null,
      }))
    } finally {
      db.close()
    }
  }

  /** Case-insensitive substring match over id, title and directory. */
  async find(needle: string, opts: { archived?: "all" | "only" | "active" } = {}) {
    const q = needle.toLowerCase()
    const all = await this.list(opts)
    return all.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        s.title.toLowerCase().includes(q) ||
        s.directory.toLowerCase().includes(q),
    )
  }

  /**
   * Read back a session transcript as readable messages.
   *
   * Works for archived sessions, which is the point: OpenCode's own session
   * list cannot show archived ones, so this is often the only way to remember
   * what a finished conversation contained before deciding to restore it.
   *
   * @param limit cap the number of returned messages (newest kept).
   */
  async readMessages(
    sessionID: string,
    opts: { limit?: number; includeReasoning?: boolean } = {},
  ): Promise<MessageView[]> {
    const { limit = 40 } = opts
    const db = await this.#connect()
    try {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
          name: string
        }[]).map((r) => r.name),
      )

      let sql: string | null = null
      for (const table of ["session_message", "message"]) {
        if (!tables.has(table)) continue
        const cols = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
            (r) => r.name,
          ),
        )
        if (!cols.has("session_id")) continue
        const hasSeq = cols.has("seq")
        const hasTime = cols.has("time_created")
        const hasData = cols.has("data")
        sql =
          `SELECT ${hasSeq ? "seq" : "0"} AS seq, type, ` +
          `${hasTime ? "time_created" : "NULL"} AS at, ` +
          `${hasData ? "data" : "''"} AS data ` +
          `FROM ${table} WHERE session_id = ?` +
          (hasSeq ? " ORDER BY seq ASC" : hasTime ? " ORDER BY time_created ASC" : "")
        break
      }
      if (!sql) return []

      const rows = db.prepare(sql).all(sessionID) as Record<string, unknown>[]
      const out: MessageView[] = []
      for (const r of rows) {
        const type = String(r.type ?? "")
        let text = extractText(type, String(r.data ?? ""))
        if (!text && type === "assistant" && opts.includeReasoning) {
          try {
            const parsed = JSON.parse(String(r.data)) as {
              content?: { type?: string; text?: string }[]
            }
            text = (parsed.content ?? [])
              .filter((p) => p.type === "reasoning")
              .map((p) => p.text ?? "")
              .join("\n\n")
          } catch {
            /* keep empty */
          }
        }
        if (!text.trim()) continue
        out.push({
          seq: Number(r.seq ?? 0),
          type,
          at: (r.at as number) ?? null,
          text: text.trim(),
        })
      }
      return limit > 0 ? out.slice(-limit) : out
    } finally {
      db.close()
    }
  }

  async get(id: string): Promise<SessionRow | undefined> {
    return (await this.list()).find((s) => s.id === id)
  }

  /**
   * How many snapshots to keep in the backups directory.
   *
   * Each snapshot is a full copy of the database — tens of megabytes — and one
   * is taken per write, so without a cap the directory grows without bound.
   */
  static readonly RETAIN = 3

  /**
   * Drop the oldest snapshots beyond `SessionStore.RETAIN`.
   *
   * Runs after a successful backup. A failure here is never fatal: pruning is
   * housekeeping, and losing an old snapshot must not fail the archive that
   * already succeeded.
   */
  async #prune(): Promise<number> {
    try {
      const { readdirSync, statSync, unlinkSync } = await import("node:fs")
      const dir = this.dbPath.replace(/\/[^/]+$/, "/backups")
      const prefix = `${this.dbPath.split("/").pop()?.replace(/\.db$/, "") ?? "opencode"}.backup-`

      const mine = readdirSync(dir)
        .filter((f) => f.startsWith(prefix))
        .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)

      let dropped = 0
      for (const { f } of mine.slice(SessionStore.RETAIN)) {
        unlinkSync(join(dir, f))
        dropped++
      }
      return dropped
    } catch {
      return 0
    }
  }

  /**
   * Snapshot the database with `VACUUM INTO`.
   *
   * Preferred over a file copy because it is consistent even while OpenCode
   * holds the source database open in WAL mode. `VACUUM INTO` refuses to
   * overwrite, so pick the first free name: two writes inside the same second
   * must not collide.
   */
  async backup(): Promise<string> {
    const { mkdirSync, existsSync } = await import("node:fs")
    const dir = this.dbPath.replace(/\/[^/]+$/, "/backups")
    mkdirSync(dir, { recursive: true })

    const base = this.dbPath.split("/").pop()?.replace(/\.db$/, "") ?? "opencode"
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)

    let target = `${dir}/${base}.backup-${stamp}.db`
    for (let n = 1; existsSync(target); n++) {
      target = `${dir}/${base}.backup-${stamp}-${n}.db`
    }

    const db = await this.#connect()
    try {
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    } finally {
      db.close()
    }
    return target
  }

  /**
   * Archive or restore sessions.
   *
   * Restoring also refreshes `time_updated`. That is required, not cosmetic:
   * OpenCode orders sessions by `time_updated DESC` and pages per directory,
   * so clearing the flag alone leaves the session buried out of reach.
   *
   * @returns ids changed, per-id errors, and the backup that was taken first.
   */
  async setArchived(
    ids: string[],
    archived: boolean,
  ): Promise<{ changed: string[]; errors: string[]; backup: string | null }> {
    this.#require("id", "time_archived")
    const unique = [...new Set(ids)].filter(Boolean)
    if (unique.length === 0) return { changed: [], errors: [], backup: null }

    const backup = await this.backup()
    await this.#prune()
    const now = Date.now()
    const hasUpdated = this.columns.has("time_updated")

    const sql = archived
      ? `UPDATE ${this.table} SET time_archived = ? WHERE id = ?`
      : hasUpdated
        ? `UPDATE ${this.table} SET time_archived = NULL, time_updated = ? WHERE id = ?`
        : `UPDATE ${this.table} SET time_archived = NULL WHERE id = ?`

    const db = await this.#connect()
    const changed: string[] = []
    const errors: string[] = []
    try {
      db.exec("PRAGMA busy_timeout = 15000")
      db.exec("BEGIN IMMEDIATE")
      for (const id of unique) {
        try {
          const hit = db.prepare(`SELECT 1 FROM ${this.table} WHERE id = ?`).get(id)
          if (hit === undefined) {
            errors.push(`${id}: no such session`)
            continue
          }
          const params: unknown[] = archived || hasUpdated ? [now, id] : [id]
          const info = db.prepare(sql).run(...params) as { changes?: number }
          if ((info?.changes ?? 0) > 0) changed.push(id)
          else errors.push(`${id}: no rows changed`)
        } catch (err) {
          errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      db.exec("COMMIT")
    } catch (err) {
      try {
        db.exec("ROLLBACK")
      } catch {
        /* already rolled back */
      }
      throw err
    } finally {
      db.close()
    }

    return { changed, errors, backup }
  }

  archive(ids: string[]) {
    return this.setArchived(ids, true)
  }

  unarchive(ids: string[]) {
    return this.setArchived(ids, false)
  }
}