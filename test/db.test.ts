/**
 * Tests for the database layer.
 *
 * Each test builds a throwaway database on disk in either the v1 or the v2
 * schema, so both code paths are genuinely exercised rather than assumed.
 *
 *   node --test test/
 */

import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import { ArchiveError, SessionStore, resolveDbPath } from "../src/db.ts"

// v2: sessions in session_v2, messages in session_message.
const V2 = `
CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY, title TEXT, directory TEXT, project_id TEXT,
  time_created INTEGER, time_updated INTEGER, time_archived INTEGER, parent_id TEXT
);
CREATE TABLE session_message (
  id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
  time_created INTEGER, data TEXT
);
`

// v1: sessions in session, messages in message.
const V1 = `
CREATE TABLE session (
  id TEXT PRIMARY KEY, title TEXT, directory TEXT, project_id TEXT,
  time_created INTEGER, time_updated INTEGER, time_archived INTEGER, parent_id TEXT
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
  time_created INTEGER, data TEXT
);
`

const SEED: Record<string, number | null> = { ses_a: null, ses_b: 5000, ses_c: null }

/** Message payloads mirroring the shapes OpenCode actually stores. */
const MESSAGES: { type: string; data: string }[] = [
  { type: "user", data: JSON.stringify({ metadata: { displayText: "delete my old repos" } }) },
  {
    type: "assistant",
    data: JSON.stringify({
      content: [
        { type: "reasoning", text: "internal scratchpad, should be hidden" },
        { type: "text", text: "I will check your repositories first." },
      ],
    }),
  },
  { type: "system", data: JSON.stringify({ note: "no displayable text" }) },
  { type: "assistant", data: JSON.stringify({ content: [{ type: "text", text: "All done." }] }) },
]

const tmpDirs: string[] = []

function seedDb(schema: string, table: string, msgs: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-arch-test-"))
  tmpDirs.push(dir)
  const path = join(dir, "opencode.db")
  const db = new DatabaseSync(path)
  db.exec(schema)
  const insert = db.prepare(
    `INSERT INTO ${table} (id, title, directory, time_created, time_updated, time_archived)
     VALUES (?,?,?,?,?,?)`,
  )
  for (const [id, archived] of Object.entries(SEED)) {
    insert.run(id, `Session ${id}`, "/home/u/project", 1000, 2000, archived)
    const addMsg = db.prepare(
      `INSERT INTO ${msgs} (id, session_id, type, seq, time_created, data)
       VALUES (?,?,?,?,?,?)`,
    )
    MESSAGES.forEach((m, i) =>
      addMsg.run(`msg_${id}_${i}`, id, m.type, i, 1000 + i, m.data),
    )
  }
  db.close()
  return path
}

after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** Run the same assertions against one schema layout. */
function layoutSuite(name: string, schema: string, table: string, msgs: string) {
  describe(`schema: ${name}`, () => {
    const open = () => SessionStore.open(seedDb(schema, table, msgs))

    it("detects the right table and schema version", async () => {
      const s = await open()
      assert.equal(s.tableName, table)
      assert.equal(s.schema, name)
    })

    it("counts messages per session", async () => {
      const s = await open()
      const all = await s.list()
      assert.equal(all.length, 3)
      assert.ok(all.every((r) => r.messages === 4))
    })

    it("filters archived / active / all", async () => {
      const s = await open()
      assert.equal((await s.list({ archived: "only" })).length, 1)
      assert.equal((await s.list({ archived: "active" })).length, 2)
      assert.equal((await s.list({ archived: "all" })).length, 3)
    })

    it("rejects an unknown filter", async () => {
      const s = await open()
      await assert.rejects(() => s.list({ archived: "bogus" as never }), ArchiveError)
    })

    it("archives by stamping time_archived", async () => {
      const s = await open()
      const before = Date.now()
      const r = await s.archive(["ses_a"])
      assert.deepEqual(r.changed, ["ses_a"])
      assert.deepEqual(r.errors, [])
      const stamped = (await s.get("ses_a"))!.archived
      assert.ok(stamped !== null, "archive must set the flag")
      assert.ok(stamped! >= before, `stamp ${stamped} should be >= ${before}`)
      assert.ok(r.backup)
    })

    it("restores by clearing the flag and bumping time_updated", async () => {
      const s = await open()
      const before = (await s.get("ses_b"))!.updated!
      const r = await s.unarchive(["ses_b"])
      assert.deepEqual(r.changed, ["ses_b"])
      const after = await s.get("ses_b")
      assert.equal(after!.archived, null)
      assert.ok(
        after!.updated! > before,
        "time_updated must advance or the session stays buried below the page limit",
      )
    })

    it("reports an unknown id instead of throwing", async () => {
      const s = await open()
      const r = await s.unarchive(["ses_missing"])
      assert.deepEqual(r.changed, [])
      assert.equal(r.errors.length, 1)
      assert.match(r.errors[0], /no such session/)
    })

    it("takes the backup before the write", async () => {
      const s = await open()
      const { backup } = await s.archive(["ses_a"])
      const check = new DatabaseSync(backup!, { readOnly: true })
      const row = check.prepare(`SELECT time_archived FROM ${table} WHERE id='ses_a'`).get()
      check.close()
      assert.equal(row.time_archived, null, "backup must capture pre-write state")
    })

    it("is idempotent", async () => {
      const s = await open()
      await s.archive(["ses_a"])
      await s.archive(["ses_a"])
      assert.notEqual((await s.get("ses_a"))!.archived, null)
      await s.unarchive(["ses_a"])
      await s.unarchive(["ses_a"])
      assert.equal((await s.get("ses_a"))!.archived, null)
    })

    it("never touches messages", async () => {
      const s = await open()
      const before = Object.fromEntries((await s.list()).map((r) => [r.id, r.messages]))
      const ids = Object.keys(before)
      await s.archive(ids)
      await s.unarchive(ids)
      const after = Object.fromEntries((await s.list()).map((r) => [r.id, r.messages]))
      assert.deepEqual(after, before)
    })

    it("treats an empty id list as a no-op", async () => {
      const s = await open()
      const r = await s.archive([])
      assert.deepEqual(r, { changed: [], errors: [], backup: null })
    })

    it("searches id, title and directory", async () => {
      const s = await open()
      assert.equal((await s.find("ses_a")).length, 1)
      assert.equal((await s.find("project")).length, 3)
      assert.equal((await s.find("nope")).length, 0)
    })

    it("reads back a transcript as readable text", async () => {
      const s = await open()
      const msgs = await s.readMessages("ses_a")
      assert.ok(msgs.length > 0, "expected a non-empty transcript")
      assert.ok(msgs.every((m) => m.text.trim().length > 0))
      // Only user/assistant/synthetic carry displayable text.
      assert.ok(msgs.every((m) => ["user", "assistant", "synthetic"].includes(m.type)))
    })

    it("keeps only the newest messages when limited", async () => {
      const s = await open()
      const all = await s.readMessages("ses_a")
      const few = await s.readMessages("ses_a", { limit: 1 })
      assert.equal(few.length, 1)
      assert.equal(few[0].text, all[all.length - 1].text)
    })

    it("returns nothing for a session with no messages", async () => {
      const s = await open()
      assert.deepEqual(await s.readMessages("ses_missing"), [])
    })

    it("survives a payload it cannot parse", async () => {
      const s = await open()
      const path = s.dbPath
      const db = new DatabaseSync(path)
      db.prepare(`INSERT INTO ${msgs} (session_id, data) VALUES (?, ?)`).run(
        "ses_a",
        "{not json",
      )
      db.close()
      // Must degrade to a raw slice, not throw.
      const out = await s.readMessages("ses_a")
      assert.ok(out.some((m) => m.text.includes("{not json")))
    })
  })
}

layoutSuite("v2", V2, "session_v2", "session_message")
layoutSuite("v1", V1, "session", "message")

describe("discovery", () => {
  it("prefers session_v2 when both tables exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-arch-both-"))
    tmpDirs.push(dir)
    const path = join(dir, "opencode.db")
    const db = new DatabaseSync(path)
    db.exec(V1)
    db.exec(V2)
    db.close()
    assert.equal((await SessionStore.open(path)).tableName, "session_v2")
  })

  it("errors when there is no session table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-arch-empty-"))
    tmpDirs.push(dir)
    const path = join(dir, "opencode.db")
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE unrelated (x INT)")
    db.close()
    await assert.rejects(() => SessionStore.open(path), ArchiveError)
  })

  it("errors when the database file is missing", async () => {
    await assert.rejects(() => SessionStore.open("/nonexistent/opencode.db"), ArchiveError)
  })

  it("honours an explicit path, then OPENCODE_DB, then the XDG default", () => {
    assert.equal(resolveDbPath("/explicit.db"), "/explicit.db")
    const prev = process.env.OPENCODE_DB
    process.env.OPENCODE_DB = "/env.db"
    try {
      assert.equal(resolveDbPath(), "/env.db")
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_DB
      else process.env.OPENCODE_DB = prev
    }
  })
})