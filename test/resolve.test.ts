/**
 * Tests for the argument resolver used by the slash commands.
 *
 * The resolver feeds destructive commands, so it is tested directly rather
 * than only through the database layer.
 *
 *   node --test test/
 */

import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, afterEach, before, describe, it } from "node:test"

import { SessionStore } from "../src/db.ts"
import { __resolve as resolve } from "../index.ts"

const SCHEMA = `
CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY, title TEXT, directory TEXT, project_id TEXT,
  time_created INTEGER, time_updated INTEGER, time_archived INTEGER, parent_id TEXT
);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
`

/** Titles chosen so that one token ("fix") is shared by two unrelated rows. */
const SEED = [
  ["ses_aaa111", "ZZ fix verify", "/tmp/opencode/plugtest"],
  ["ses_bbb222", "Flameshot fix review and GitHub issue", "/home/u/Default Project"],
  ["ses_ccc333", "Diagnosing 2TB external drive", "/home/u/Default Project"],
] as const

let tmp: string
let dbPath: string
let savedDb: string | undefined

before(() => {
  savedDb = process.env.OPENCODE_DB
  tmp = mkdtempSync(join(tmpdir(), "oc-resolve-"))
  dbPath = join(tmp, "opencode.db")
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  const ins = db.prepare(
    `INSERT INTO session_v2 (id, title, directory, time_created, time_updated, time_archived)
     VALUES (?,?,?,?,?,?)`,
  )
  for (const [id, title, dir] of SEED) ins.run(id, title, dir, 1000, 2000, 5000)
  db.close()
  // The resolver resolves the database itself, so point it at the fixture.
  process.env.OPENCODE_DB = dbPath
})

afterEach(() => {
  process.env.OPENCODE_DB = dbPath
})

after(() => {
  if (savedDb === undefined) delete process.env.OPENCODE_DB
  else process.env.OPENCODE_DB = savedDb
  rmSync(tmp, { recursive: true, force: true })
})

describe("resolve()", () => {
  it("prefers an exact session id over any title match", async () => {
    const r = await resolve(["ses_bbb222"])
    assert.deepEqual(r.ids, ["ses_bbb222"])
    assert.equal(r.ambiguous, false)
  })

  it("refuses to act on an ambiguous term", async () => {
    // "fix" appears in two unrelated titles.
    const r = await resolve(["fix"])
    assert.equal(r.ambiguous, true, "a term matching several sessions must be ambiguous")
  })

  it("does not restore unrelated sessions when one word matches many", async () => {
    // The regression: "ZZ fix verify" split into words used to match "fix",
    // pulling in the Flameshot session too.
    const r = await resolve(["ZZ", "fix", "verify"])
    assert.equal(r.ambiguous, true)
    assert.ok(!r.ids.includes("ses_bbb222"), "must not pull in the unrelated 'fix' session")
  })

  it("matches a whole multi-word phrase unambiguously", async () => {
    const r = await resolve(["ZZ fix verify"])
    assert.deepEqual(r.ids, ["ses_aaa111"])
    assert.equal(r.ambiguous, false)
  })

  it("returns nothing for a term that matches nothing", async () => {
    const r = await resolve(["zzzz-no-such-thing"])
    assert.deepEqual(r.ids, [])
    assert.equal(r.ambiguous, false)
  })

  it("resolves several distinct ids at once", async () => {
    const r = await resolve(["ses_aaa111", "ses_ccc333"])
    assert.deepEqual(r.ids.sort(), ["ses_aaa111", "ses_ccc333"])
  })

  it("never returns duplicate ids", async () => {
    const r = await resolve(["ses_aaa111", "ses_aaa111", "ZZ fix verify"])
    assert.deepEqual(r.ids, ["ses_aaa111"])
  })

  it("ignores blank arguments", async () => {
    const r = await resolve(["", "   "])
    assert.deepEqual(r.ids, [])
    assert.equal(r.ambiguous, false)
  })

  it("leaves the database untouched", async () => {
    const store = await SessionStore.open(dbPath)
    await resolve(["ZZ fix verify"])
    const rows = await store.list({ archived: "only" })
    assert.equal(rows.length, 3, "resolving must not change any archived flag")
  })
})