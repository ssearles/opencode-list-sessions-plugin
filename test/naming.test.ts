/**
 * Tests that user-facing text names only commands that exist.
 *
 * A footer reading "copy an id into `/archive_Put`, `/archive_Pull` or
 * `/session`" survived three commits after `/session` was removed, because
 * every other test asserts behaviour rather than wording. It shipped to a
 * working install and was caught by a person reading the output.
 *
 * These read index.ts as source text and check the two ways a stale name can
 * survive: a backticked command reference, and a registered command name.
 *
 *   node --test test/
 */

import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"

import { __emphasizeNumbers as emphasizeNumbers, __stripAnsi as stripAnsi } from "../index.ts"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, "..", "index.ts"), "utf8")

/** The commands this plugin registers, in source order. */
const REGISTERED = [
  ...source.matchAll(/^\s+name:\s*"([^"]+)",$/gm),
]
  .map((m) => m[1])
  // `ctx.tool.transform` registrations repeat some of these names; the command
  // block comes first, so the first occurrence of each is the command.
  .filter((name, i, all) => all.indexOf(name) === i)
  .filter((name) => !["session_archive"].includes(name))

/**
 * Strip comments, then find every backticked `/name`.
 *
 * Comments are excluded deliberately. They discuss commands that were removed
 * and explain why, which is exactly the history worth keeping — but it is not
 * user-facing text and must not fail this check. Only what a user can actually
 * read on screen counts.
 */
const CODE = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")

const REFERENCED = [...CODE.matchAll(/`\/([A-Za-z_][A-Za-z0-9_]*)(?:[^`]*?)`/g)].map((m) => m[1])

/**
 * Commands that belong to OpenCode itself rather than to this plugin. A
 * reference to one of these is documentation, not a stale name.
 */
const EXTERNAL = new Set(["export"])

describe("command names in text", () => {
  it("finds the registered commands (guard on the extraction itself)", () => {
    // If this fails, the extraction above is broken and every other assertion
    // in this file would pass vacuously.
    for (const expected of ["list_sessions", "save"]) {
      assert.ok(
        REGISTERED.includes(expected),
        `expected to find the /${expected} command in the source; extraction found ` +
          `[${REGISTERED.join(", ")}]`,
      )
    }
  })

  it("registers no archiving command, which now lives in the popup window", () => {
    // Archive and restore moved to `session-list-popup`. Re-registering them
    // here would put two competing archive paths back in the palette, one of
    // which cannot restore anything the other archived.
    for (const gone of ["archive_Put", "archive_Pull"]) {
      assert.ok(
        !REGISTERED.includes(gone),
        `/${gone} is registered as a command again; archiving belongs in the popup`,
      )
    }
  })

  it("never references a command that is not registered", () => {
    const known = new Set([...REGISTERED, ...EXTERNAL])
    const stale = [...new Set(REFERENCED)].filter((name) => !known.has(name))

    assert.deepEqual(
      stale,
      [],
      `these commands are named in user-facing text but not registered: ` +
        `${stale.map((s) => "/" + s).join(", ")}. Either the command was removed ` +
        `and the text still names it, or the command needs registering.`,
    )
  })

  it("names no command this plugin has removed", () => {
    // Commands only. `archive` and `unarchive` survive as *tools* under the
    // `session_archive` namespace — a separate registry, so their presence here
    // says nothing about the command of the same name. `list` is a core tool
    // name and was never a command here either.
    for (const removed of [
      "session",
      "list_Current",
      "list_Archived",
      "list",
      "archive_Put",
      "archive_Pull",
    ]) {
      assert.ok(
        !REGISTERED.includes(removed),
        `/${removed} was removed but is registered as a command again`,
      )
      assert.ok(
        !REFERENCED.includes(removed),
        `/${removed} was removed but is still named in text`,
      )
    }
  })

  it("registers no command whose name collides with a core tool", () => {
    // `list` is a core tool name. Commands are a separate namespace so this
    // cannot shadow anything, but a bare `/list` next to the core `list` tool
    // is confusing enough to be worth refusing.
    for (const name of REGISTERED) {
      assert.notEqual(name, "list", "/list collides with the core list tool name")
    }
  })
})

describe("menu numbers are emphasised for the terminal", () => {
  it("bolds and colours the leading number of each row", () => {
    const out = emphasizeNumbers("**Current sessions**\n\n1. one\n2. two")
    assert.match(out, /\u001b\[1;36m1\.\u001b\[0m one/)
    assert.match(out, /\u001b\[1;36m2\.\u001b\[0m two/)
  })

  it("leaves numbers that are not row numbers alone", () => {
    // A session id, message count or timestamp must not be recoloured — only a
    // bare "N." at the start of a line is a row number.
    const out = emphasizeNumbers("ses_123  42 msg  2026-10-16  title")
    assert.equal(out, "ses_123  42 msg  2026-10-16  title")
    assert.ok(!out.includes("\u001b["))
  })

  it("does not touch a decimal number mid-row", () => {
    const out = emphasizeNumbers("  3. row with 1.5 in the title")
    assert.equal(out.match(/\u001b\[1;36m/g)?.length, 1, "only the row number is emphasised")
  })

  it("strips the codes again for the Markdown channel", () => {
    const coloured = emphasizeNumbers("1. one\n2. two")
    assert.notEqual(coloured, "1. one\n2. two", "input was actually coloured")
    assert.equal(stripAnsi(coloured), "1. one\n2. two")
  })

  it("round-trips: stripping restores the exact original", () => {
    const original = "**Heading**\n\n1. ses_a  10 msg  now  Title\n2. ses_b  20 msg  now  Other"
    assert.equal(stripAnsi(emphasizeNumbers(original)), original)
  })
})
