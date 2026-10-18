/**
 * Tests that `/list_sessions` reports are framed as status, not as requests.
 *
 * `ctx.session.synthetic()` posts a **user** message — OpenCode's own plugin API
 * calls it a "synthetic user message" — so the agent reads a command's output as
 * something it was asked to do. The `/list_sessions` success note used to end
 * with "Right-click a session there to get its buttons: Archive or Restore,
 * Transcript.md, …", which on a fresh session read as an instruction to go and
 * work the popup. The agent looked for the window; every re-run of the command
 * posted the same note and started it again.
 *
 * The failure branch has the same shape with a sharper edge: "could not open the
 * window, here is why" is a message an agent tries to *fix*, and a retry reports
 * failure again.
 *
 * These assert the wording, because wording is the whole mechanism here. There
 * is no flag to set — a plugin cannot post into a session without the model
 * seeing it — so a rewording is all that stands between this and the loop, and
 * nothing else would catch it.
 *
 *   node --test test/
 */

import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"

import {
  __popupFailedNote,
  __popupOpenedNote,
  __statusNote,
} from "../index.ts"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, "..", "index.ts"), "utf8")

/** Every report `/list_sessions` can send, in the shapes it can send them. */
const REPORTS: Array<[string, string]> = [
  ["success", __popupOpenedNote()],
  ["failure", __popupFailedNote("session-list-popup not found", [])],
]

/**
 * The sentences that have to survive a reader treating the note as a request.
 *
 * "no action needed" alone was not enough on its own — it describes the note
 * rather than forbidding the behaviour, and a model looking for something to do
 * can still go and do it. Each of these closes a specific loop.
 */
const GUARDS = [
  /no action needed/i,
  /not a request/i,
  /do not go looking for the session window/i,
  /reply to nothing/i,
]

describe("/list_sessions reports are status, not instructions", () => {
  for (const [name, report] of REPORTS) {
    it(`the ${name} report carries every guard`, () => {
      for (const guard of GUARDS) {
        assert.match(report, guard, `${name} report lost its "${guard.source}" guard`)
      }
    })

    it(`the ${name} report says the command is the source`, () => {
      // Without this the text is unattributed, and "no action needed" has
      // nothing to be about.
      assert.match(report, /\/list_sessions/)
    })
  }

  it("does not instruct the reader to interact with the window", () => {
    // The sentence that started the loop. It is still true that right-clicking
    // a row is how you reach a session's buttons — but as a description of what
    // the window is for, with the mouse, attributed to the user.
    const opened = __popupOpenedNote()
    assert.ok(
      !/right-click a session there/i.test(opened),
      "the imperative 'right-click a session there' is back; it reads as a task",
    )
    assert.match(opened, /the user drives it with the mouse/i)
  })

  it("does not offer the agent a way to finish the job", () => {
    // Every branch must be terminal. A note that ends by inviting another tool
    // call or another command is a loop with one more step in it.
    for (const [name, report] of REPORTS) {
      for (const invitation of [
        /try (again|to install|to fix)/i,
        /install(ing)? (the|it|gtk)/i,
        /let me know if/i,
        /would you like/i,
        /next step/i,
      ]) {
        assert.ok(!invitation.test(report), `${name} report invites further action: ${invitation.source}`)
      }
    }
  })

  it("still tells the user what the window is for", () => {
    // The guard is not a substitute for the report. Dropping the detail would
    // make the note shorter and no less likely to be read as a request.
    const opened = __popupOpenedNote()
    for (const expected of ["Archive or Restore", "Transcript.md", "Export .json", "Delete"]) {
      assert.ok(opened.includes(expected), `the success report no longer mentions ${expected}`)
    }
  })

  it("still prints the list when the window failed", () => {
    // The fallback is the reason the failure branch exists at all. A guard that
    // suppressed the inventory would make the message safe and useless.
    const failed = __popupFailedNote("session-list-popup not found", [])
    assert.match(failed, /session-list-popup not found/)
    assert.match(failed, /No sessions found\./)
  })

  it("frames whatever it is given", () => {
    const note = __statusNote("the body")
    assert.ok(note.endsWith("the body"), "the body must survive framing")
    assert.ok(note.indexOf("no action needed") < note.indexOf("the body"), "the guard must come first")
  })
})

describe("the command actually sends the framed reports", () => {
  it("routes both branches through the note builders", () => {
    // A guarded helper nobody calls is not a fix. This is the assertion that
    // would have caught the guard being written and then left unwired.
    assert.match(source, /launched\.ok\s*\?\s*popupOpenedNote\(\)/)
    assert.match(source, /popupFailedNote\(launched\.reason,/)
  })

  it("does not build the old imperative report inline any more", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    assert.ok(
      !/Right-click a session there/.test(code),
      "the unframed success text is back inline in the command",
    )
  })
})