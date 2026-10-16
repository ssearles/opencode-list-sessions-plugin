/**
 * Tests for the range check on numbered commands.
 *
 * A number is a position in the menu the user was just shown, and nothing else.
 * These cover the case that used to be wrong: an out-of-range number used to
 * fall through to a text lookup, so `/archive_Put 99` could archive a session
 * whose title merely contained "99" while the user believed they had picked a
 * row that did not exist.
 *
 *   node --test test/
 */

import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

import { SessionStore } from "../src/db.ts"
import { __pickByNumber as pickByNumber } from "../index.ts"
import type { SessionRow } from "../src/db.ts"

const SCHEMA = `
CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY, title TEXT, directory TEXT, project_id TEXT,
  time_created INTEGER, time_updated INTEGER, time_archived INTEGER, parent_id TEXT
);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
`

/**
 * "99 versions" is the trap: an out-of-range number that is *also* a substring
 * of a real title. Under the old fall-through, `/archive_Put 99` would have
 * archived it.
 */
const SEED = [
  ["ses_a1", "Alpha report", "/tmp/opencode/plugtest", null],
  ["ses_b2", "Beta notes", "/tmp/opencode/plugtest", null],
  ["ses_c3", "Gamma summary", "/tmp/opencode/plugtest", null],
  ["ses_d4", "99 versions of the manual", "/tmp/opencode/plugtest", null],
] as const

let tmp: string
let dbPath: string
let savedDb: string | undefined

before(() => {
  savedDb = process.env.OPENCODE_DB
  tmp = mkdtempSync(join(tmpdir(), "range-"))
  dbPath = join(tmp, "opencode.db")
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  const insert = db.prepare(
    `INSERT INTO session_v2 (id, title, directory, time_created, time_updated, time_archived)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const [id, title, dir, archived] of SEED) {
    insert.run(id, title, dir, 1000, 1000, archived)
  }
  db.close()
  process.env.OPENCODE_DB = dbPath
})

after(() => {
  if (savedDb === undefined) delete process.env.OPENCODE_DB
  else process.env.OPENCODE_DB = savedDb
  rmSync(tmp, { recursive: true, force: true })
})

const rows = (): Promise<SessionRow[]> => SessionStore.open(dbPath).then((s) => s.list())

describe("an out-of-range number is refused, not reinterpreted", () => {
  it("resolves nothing when the number is past the end of the list", async () => {
    const all = await rows()
    const r = await pickByNumber(["99"], all, await SessionStore.open(dbPath))

    assert.deepEqual(r.ids, [])
    assert.equal(r.ambiguous, false)
    assert.deepEqual(r.outOfRange, ["99"])
  })

  it("does NOT fall through to a title containing that number", async () => {
    // ses_d4 is titled "99 versions of the manual". A number is a position,
    // not a search term, so this session must be left alone.
    const all = await rows()
    const r = await pickByNumber(["99"], all, await SessionStore.open(dbPath))

    assert.ok(
      !r.ids.includes("ses_d4"),
      "ses_d4 must not be picked by an out-of-range number just because its " +
        "title contains those digits",
    )
  })

  it("refuses zero and negatives", async () => {
    const all = await rows()
    const store = await SessionStore.open(dbPath)

    for (const bad of ["0", "-1"]) {
      const r = await pickByNumber([bad], all, store)
      assert.deepEqual(r.ids, [], `${bad} must not resolve to a row`)
    }
  })

  it("accepts a number inside the range", async () => {
    const all = await rows()
    const r = await pickByNumber(["2"], all, await SessionStore.open(dbPath))

    assert.deepEqual(r.ids, ["ses_b2"])
    assert.deepEqual(r.outOfRange, [])
  })

  it("reports the bad number and still takes the good one", async () => {
    // Mixed input: 1 is valid, 99 is not. The caller must be able to tell that
    // something was refused, so outOfRange is populated rather than swallowed.
    const all = await rows()
    const r = await pickByNumber(["1", "99"], all, await SessionStore.open(dbPath))

    assert.deepEqual(r.ids, ["ses_a1"])
    assert.deepEqual(r.outOfRange, ["99"])
  })

  it("leaves outOfRange empty when the argument is not a number at all", async () => {
    // A title or id goes down the text path, which has its own ambiguity
    // handling and must not be reported as a range problem.
    const all = await rows()
    const r = await pickByNumber(["Gamma"], all, await SessionStore.open(dbPath))

    assert.deepEqual(r.ids, ["ses_c3"])
    assert.deepEqual(r.outOfRange, [])
  })
})
