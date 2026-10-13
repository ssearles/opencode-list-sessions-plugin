/**
 * Tests for the numbered menus that stand in for a dropdown picker.
 *
 * OpenCode exposes no picker to plugins — the TUI bus carries only
 * `command.execute`, `prompt.append`, `session.select` and `toast.show`, and
 * a plugin's context has `event.subscribe` but no publish. So the commands
 * print a numbered list and accept the number back.
 *
 * These matter because the numbers index into a list the user just read. An
 * off-by-one here archives the wrong session.
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
import { __menu, __pickByNumber, __inventory, __parseArgs } from "../index.ts"
import type { SessionRow } from "../src/db.ts"

const SCHEMA = `
CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY, title TEXT, directory TEXT,
  time_created INTEGER, time_updated INTEGER, time_archived INTEGER
);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
`

let tmp: string
let dbPath: string
let savedDb: string | undefined

before(() => {
  savedDb = process.env.OPENCODE_DB
  tmp = mkdtempSync(join(tmpdir(), "oc-menu-"))
  dbPath = join(tmp, "opencode.db")

  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  const ins = db.prepare(
    `INSERT INTO session_v2 (id, title, directory, time_created, time_updated, time_archived)
     VALUES (?,?,?,?,?,?)`,
  )
  // time_updated ascending, so list() DESC puts these in a known order.
  ins.run("ses_a1", "Alpha work", "/tmp/one", 1000, 5000, null)
  ins.run("ses_b2", "Beta work", "/tmp/two", 2000, 4000, null)
  ins.run("ses_c3", "Gamma work", "/tmp/three", 3000, 3000, 9000)
  ins.run("ses_d4", "Delta work", "/tmp/four", 4000, 2000, 9000)
  db.close()

  process.env.OPENCODE_DB = dbPath
})

after(() => {
  if (savedDb === undefined) delete process.env.OPENCODE_DB
  else process.env.OPENCODE_DB = savedDb
  rmSync(tmp, { recursive: true, force: true })
})

const rows = (): Promise<SessionRow[]> => SessionStore.open(dbPath).then((s) => s.list())

describe("numbered menus", () => {
  it("numbers rows from 1 in list order", async () => {
    const all = await rows()
    const out = __menu(all, {
      heading: "All sessions",
      empty: "none",
      action: "pick one",
    })

    const lines = out.split("\n").filter((l) => /^\d+\./.test(l))
    assert.equal(lines.length, 4)
    assert.match(lines[0], /^1\. /)
    assert.match(lines[3], /^4\. /)
    // Ordered by time_updated DESC, so Alpha (5000) comes first.
    assert.match(lines[0], /Alpha work/)
  })

  it("says something useful when there is nothing to list", () => {
    assert.equal(
      __menu([], { heading: "x", empty: "No open sessions to archive.", action: "y" }),
      "No open sessions to archive.",
    )
  })

  it("caps the list and says how many were hidden", async () => {
    const all = await rows()
    const out = __menu(all, { heading: "x", empty: "none", action: "y", limit: 2 })
    assert.match(out, /…and 2 more/)
    assert.equal(out.split("\n").filter((l) => /^\d+\./.test(l)).length, 2)
  })
})

describe("prompt text parsing", () => {
  // The host passes the whole submitted line, command name included. Testing
  // the raw text for emptiness therefore never fires, the command falls
  // through to the argument path, and no menu is ever shown. This is the bug
  // that made /archive appear to do nothing.
  const parse = __parseArgs

  it("treats a bare command name as no argument", () => {
    assert.deepEqual(parse("/archive"), [])
    assert.deepEqual(parse("/unarchive"), [])
    assert.deepEqual(parse("/session"), [])
  })

  it("treats empty and missing text as no argument", () => {
    assert.deepEqual(parse(""), [])
    assert.deepEqual(parse("   "), [])
    assert.deepEqual(parse(undefined), [])
  })

  it("keeps the argument after the command name", () => {
    assert.deepEqual(parse("/archive 3"), ["3"])
    assert.deepEqual(parse("/unarchive ses_abc"), ["ses_abc"])
    assert.deepEqual(parse("/session Delete outdated GitHub repositories"), [
      "Delete",
      "outdated",
      "GitHub",
      "repositories",
    ])
  })

  it("handles a palette click, which sends no text at all", () => {
    assert.deepEqual(parse(undefined), [])
  })
})

describe("/list inventory", () => {
  it("puts working sessions before archived ones", async () => {
    const out = __inventory(await rows())
    const workingAt = out.indexOf("**Working**")
    const archivedAt = out.indexOf("**Archived**")

    assert.ok(workingAt !== -1, "missing a Working section")
    assert.ok(archivedAt !== -1, "missing an Archived section")
    assert.ok(workingAt < archivedAt, "working sessions must come first")
  })

  it("shows the full id on its own line so it can be copied", async () => {
    const out = __inventory(await rows())
    for (const id of ["ses_a1", "ses_b2", "ses_c3", "ses_d4"]) {
      assert.ok(out.includes(id), `${id} must appear in full so it can be copied`)
    }
  })

  it("marks which sessions are archived", async () => {
    const out = __inventory(await rows())
    assert.match(out, /working\s+/)
    assert.match(out, /archived\s+/)
  })

  it("counts each section", async () => {
    const out = __inventory(await rows())
    assert.match(out, /\*\*Working\*\* \(2\)/)
    assert.match(out, /\*\*Archived\*\* \(2\)/)
  })

  it("omits a section that is empty rather than showing an empty heading", async () => {
    const onlyWorking = (await rows()).filter((r) => !r.archived)
    const out = __inventory(onlyWorking)
    assert.ok(!out.includes("**Archived**"), "no Archived heading when nothing is archived")
  })

  it("handles having nothing at all", () => {
    assert.equal(__inventory([]), "No sessions found.")
  })

  it("does not number rows, because the two menus count different subsets", async () => {
    // /archive numbers working only; /unarchive numbers archived only. A
    // number shared across the inventory would match neither once either
    // group changed size.
    const out = __inventory(await rows())
    assert.ok(!/^\s*\d+\.\s/m.test(out), "inventory must not imply selectable numbering")
  })
})

describe("picking by number", () => {
  it("selects the row at that position, not a session whose title looks numeric", async () => {
    const all = await rows()
    const r = await __pickByNumber(["1"], all, await SessionStore.open(dbPath))
    assert.deepEqual(r.ids, ["ses_a1"])
    assert.equal(r.ambiguous, false)
  })

  it("selects the last row correctly", async () => {
    const all = await rows()
    const r = await __pickByNumber(["4"], all, await SessionStore.open(dbPath))
    assert.deepEqual(r.ids, ["ses_d4"])
  })

  it("selects several rows at once", async () => {
    const all = await rows()
    const r = await __pickByNumber(["1", "3"], all, await SessionStore.open(dbPath))
    assert.deepEqual(r.ids.sort(), ["ses_a1", "ses_c3"])
  })

  it("is 1-based, so 0 selects nothing rather than the first row", async () => {
    const all = await rows()
    const r = await __pickByNumber(["0"], all, await SessionStore.open(dbPath))
    assert.deepEqual(r.ids, [], "0 must not silently mean row 1")
  })

  it("ignores a number past the end of the list", async () => {
    const all = await rows()
    const r = await __pickByNumber(["99"], all, await SessionStore.open(dbPath))
    assert.deepEqual(r.ids, [])
  })

  it("still resolves a title typed as text", async () => {
    const all = await rows()
    const r = await __pickByNumber(["Gamma work"], all, await SessionStore.open(dbPath))
    assert.deepEqual(r.ids, ["ses_c3"])
  })

  it("still resolves an exact id", async () => {
    const all = await rows()
    const r = await __pickByNumber(["ses_b2"], all, await SessionStore.open(dbPath))
    assert.deepEqual(r.ids, ["ses_b2"])
  })

  it("reports ambiguity rather than picking one", async () => {
    const all = await rows()
    const r = await __pickByNumber(["work"], all, await SessionStore.open(dbPath))
    assert.equal(r.ambiguous, true, `"work" matches three titles and must not pick one`)
    assert.deepEqual(r.ids, [])
  })

  it("mixes numbers and names in one command", async () => {
    const all = await rows()
    const r = await __pickByNumber(["2", "Delta work"], all, await SessionStore.open(dbPath))
    assert.deepEqual(r.ids.sort(), ["ses_b2", "ses_d4"])
  })

  it("leaves the database untouched", async () => {
    const store = await SessionStore.open(dbPath)
    const before = await store.list({ archived: "only" })
    await __pickByNumber(["1"], await rows(), store)
    const after = await store.list({ archived: "only" })
    assert.equal(after.length, before.length)
    assert.deepEqual(
      after.map((r) => r.id),
      before.map((r) => r.id),
    )
  })
})
