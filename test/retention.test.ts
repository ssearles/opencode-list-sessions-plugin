/**
 * Backup retention tests.
 *
 * Every archive or restore writes a full database snapshot — tens of megabytes.
 * One per write, with nothing pruning them, so the directory grows without
 * bound. A user archiving a few sessions a day fills the disk in weeks.
 *
 *   node --test test/
 */

import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

import { SessionStore } from "../src/db.ts"

const SCHEMA = `
CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY, title TEXT, directory TEXT,
  time_created INTEGER, time_updated INTEGER, time_archived INTEGER
);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
`

let tmp: string
let dbPath: string
let backupDir: string

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "oc-retain-"))
  dbPath = join(tmp, "opencode.db")
  backupDir = join(tmp, "backups")
  mkdirSync(backupDir, { recursive: true })

  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  const ins = db.prepare(
    `INSERT INTO session_v2 (id, title, directory, time_created, time_updated, time_archived)
     VALUES (?,?,?,?,?,NULL)`,
  )
  for (let i = 0; i < 5; i++) ins.run(`ses_${i}`, `Session ${i}`, "/tmp", 1000 + i, 2000 + i)
  db.close()
})

after(() => rmSync(tmp, { recursive: true, force: true }))

const snapshots = () =>
  readdirSync(backupDir).filter((f) => f.startsWith("opencode.backup-")).sort()

describe("backup retention", () => {
  it("keeps at most RETAIN snapshots no matter how many writes happen", async () => {
    const store = await SessionStore.open(dbPath)

    for (let i = 0; i < 8; i++) {
      await store.archive([`ses_${i % 5}`])
    }

    const kept = snapshots()
    assert.equal(
      kept.length,
      SessionStore.RETAIN,
      `expected ${SessionStore.RETAIN} snapshots after 8 writes, found ${kept.length}: ${kept.join(", ")}`,
    )
  })

  it("keeps the newest snapshots, not the oldest", async () => {
    const store = await SessionStore.open(dbPath)
    const before = snapshots()
    const newest = before[before.length - 1]

    await store.unarchive(["ses_0"])
    const after = snapshots()

    assert.ok(after.includes(newest), "the most recent snapshot must survive pruning")
    assert.equal(after.length, SessionStore.RETAIN)
  })

  it("still performs the write after pruning", async () => {
    // Pruning is housekeeping; it must never be able to fail the archive.
    const store = await SessionStore.open(dbPath)
    const { changed } = await store.archive(["ses_1"])
    assert.deepEqual(changed, ["ses_1"])

    const db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db
      .prepare("SELECT time_archived FROM session_v2 WHERE id = ?")
      .get("ses_1") as { time_archived: number | null }
    db.close()
    assert.notEqual(row.time_archived, null, "session must actually be archived")
  })

  it("leaves unrelated files in the backups directory alone", async () => {
    const foreign = join(backupDir, "notes.txt")
    writeFileSync(foreign, "not a snapshot")
    const other = join(backupDir, "opencode.db.pre-archive.bak")
    writeFileSync(other, "legacy")

    const store = await SessionStore.open(dbPath)
    await store.archive(["ses_2"])

    assert.ok(readdirSync(backupDir).includes("notes.txt"), "notes.txt must not be pruned")
    assert.ok(
      readdirSync(backupDir).includes("opencode.db.pre-archive.bak"),
      "a differently-named database backup must not be pruned",
    )
  })
})
