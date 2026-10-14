/**
 * Tests for Markdown transcript rendering.
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
import { messageText, slug, toMarkdown } from "../src/markdown.ts"

const SCHEMA = `
CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY, title TEXT, directory TEXT,
  time_created INTEGER, time_updated INTEGER, time_archived INTEGER
);
CREATE TABLE session_message (
  id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
  time_created INTEGER, data TEXT
);
`

let tmp: string
let dbPath: string

const insert = (type: string, seq: number, data: unknown) => ({
  type,
  seq,
  data: JSON.stringify(data),
})

// Deliberately does not touch OPENCODE_DB: the test runner executes files in
// parallel, so an env var set here would be clobbered by another suite's
// teardown. Each test opens the fixture by explicit path instead.
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "oc-md-"))
  dbPath = join(tmp, "opencode.db")

  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  db.prepare(
    `INSERT INTO session_v2 (id,title,directory,time_created,time_updated,time_archived)
     VALUES (?,?,?,?,?,NULL)`,
  ).run("ses_1", "A chat: about *things*", "/home/u/proj", 1000, 2000)

  const ins = db.prepare(
    "INSERT INTO session_message (id,session_id,type,seq,time_created,data) VALUES (?,?,?,?,?,?)",
  )
  const rows = [
    insert("user", 1, { time: { created: 1000 }, text: "hello" }),
    insert("assistant", 2, {
      time: { created: 2000 },
      content: [
        { type: "text", text: "hi there" },
        { type: "tool-call", name: "read", state: { status: "completed", output: "file contents" } },
      ],
    }),
    insert("synthetic", 3, { time: { created: 3000 }, text: "a note" }),
    insert("idle", 4, { time: { created: 4000 } }),
    insert("system", 5, { time: { created: 5000 }, text: "noise" }),
  ]
  for (const [i, r] of rows.entries()) {
    ins.run(`m${i}`, "ses_1", r.type, r.seq, 1000 + i, r.data)
  }
  db.close()
})

after(() => rmSync(tmp, { recursive: true, force: true }))

describe("messageText", () => {
  it("reads a user message", () => {
    assert.equal(messageText({ type: "user", data: '{"text":"hi"}' }), "hi")
  })

  it("reads an assistant message from content parts", () => {
    const out = messageText({
      type: "assistant",
      data: '{"content":[{"type":"text","text":"answer"}]}',
    })
    assert.equal(out, "answer")
  })

  it("keeps tool calls", () => {
    const out = messageText({
      type: "assistant",
      data: '{"content":[{"type":"tool-call","name":"read","state":{"status":"completed","output":"x"}}]}',
    })
    assert.match(out, /\*\*\[tool\]\*\* `read`/)
    assert.match(out, /completed/)
  })

  it("truncates long tool output", () => {
    const out = messageText({
      type: "assistant",
      data: JSON.stringify({
        content: [{ type: "tool-call", name: "read", state: { output: "y".repeat(500) } }],
      }),
    })
    assert.ok(out.length < 250, `expected truncation, got ${out.length} chars`)
  })

  it("drops reasoning", () => {
    const out = messageText({
      type: "assistant",
      data: '{"content":[{"type":"reasoning","text":"secret"},{"type":"text","text":"final"}]}',
    })
    assert.equal(out, "final")
  })

  it("returns empty for malformed json rather than throwing", () => {
    assert.equal(messageText({ type: "user", data: "{not json" }), "")
  })
})

describe("slug", () => {
  it("makes a safe filename", () => {
    assert.equal(slug("A chat: about *things*"), "a-chat-about-things")
  })

  it("falls back when nothing usable remains", () => {
    assert.equal(slug("!!!"), "session")
  })
})

describe("toMarkdown", () => {
  it("includes the title and id", async () => {
    const md = await toMarkdown(await SessionStore.open(dbPath), "ses_1")
    assert.match(md, /^# A chat: about \*things\*/)
    assert.match(md, /ses_1/)
  })

  it("labels each speaker", async () => {
    const md = await toMarkdown(await SessionStore.open(dbPath), "ses_1")
    assert.match(md, /### You/)
    assert.match(md, /### Assistant/)
    assert.match(md, /### Note/)
  })

  it("omits bookkeeping message types", async () => {
    const md = await toMarkdown(await SessionStore.open(dbPath), "ses_1")
    assert.ok(!md.includes("noise"), "system messages must not appear")
    assert.equal(md.match(/^### /gm)?.length, 3, "only user/assistant/synthetic count")
  })

  it("keeps tool calls in the output", async () => {
    const md = await toMarkdown(await SessionStore.open(dbPath), "ses_1")
    assert.match(md, /\*\*\[tool\]\*\* `read`/)
  })

  it("orders messages oldest first", async () => {
    const md = await toMarkdown(await SessionStore.open(dbPath), "ses_1")
    assert.ok(md.indexOf("hello") < md.indexOf("hi there"), "user message must come first")
    assert.ok(md.indexOf("hi there") < md.indexOf("a note"), "synthetic note must come last")
  })
})
