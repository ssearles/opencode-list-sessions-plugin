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
  __listSessionsDescription,
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

  it("advertises the same buttons the window actually has", () => {
    // Four places enumerate the window's buttons: the window's own banner, the
    // palette line, this note, and the row strip itself. They drifted once --
    // the banner described a window with no Stats button and the palette line
    // omitted it -- and nothing caught it, because every test asserted against
    // a hand-written list rather than against the buttons.
    //
    // So the labels come from the popup source. Adding a button without adding
    // it to a list now fails here instead of shipping quietly.
    const popup = readFileSync(join(here, "..", "popup", "session-list-popup"), "utf8")
    const labels = [...popup.matchAll(/Gtk\.Button\(label="([^"]+)"/g)].map((m) => m[1])
    assert.ok(labels.includes("Stats"), "the popup no longer has a Stats button")
    assert.ok(labels.includes("Database"), "the popup no longer has a Database button")

    // The two report buttons are the ones a row strip and a palette line can
    // both be expected to name.
    for (const action of ["Stats", "Database"]) {
      assert.ok(
        __popupOpenedNote().includes(action),
        `the success report does not mention ${action}`,
      )
    }
    assert.ok(
      __listSessionsDescription.includes("Stats"),
      "the palette line does not mention Stats",
    )
  })

  it("still tells the user what the window is for", () => {
    // The guard is not a substitute for the report. Dropping the detail would
    // make the note shorter and no less likely to be read as a request.
    const opened = __popupOpenedNote()
    for (const expected of ["Stats", "Archive or Restore", "Transcript.md", "Export .json", "Delete"]) {
      assert.ok(opened.includes(expected), `the success report no longer mentions ${expected}`)
    }
  })

  it("describes the sort the window actually opens on", () => {
    // The report said "sorted by name" for three commits after the default
    // became newest-first — the same failure DEFAULT_SORT_LABEL's own comment
    // records, in the same repo, in the sentence that comment warns about.
    //
    // Read from the popup rather than repeated here: a second copy of "the
    // default is newest-first" is a second thing to forget. Python and
    // TypeScript cannot share a constant, so this is the join.
    const popup = readFileSync(join(here, "..", "popup", "session-list-popup"), "utf8")
    const mode = popup.match(/^DEFAULT_SORT = "([a-z]+)"/m)?.[1]
    assert.ok(mode, "could not read DEFAULT_SORT out of the popup")

    const opened = __popupOpenedNote()
    // What each mode is called, as the report must call it.
    const phrases: Record<string, string> = {
      name: /sorted by name/i,
      created: /most recently started|newest first|start date/i,
      updated: /most recently modified|newest first|last modified/i,
    }
    assert.match(opened, phrases[mode], `the report does not describe the ${mode} sort`)

    // And names neither of the other two as the order it opens in. The
    // alternation needs its own group: `a[^.]*x|y` parses as `(a[^.]*x)|(y)`,
    // so an ungrouped one matches "start date" anywhere in the report — which
    // is what happened the first time this ran, against a correct sentence.
    for (const [other, phrase] of Object.entries(phrases)) {
      if (other === mode) continue
      assert.ok(
        !new RegExp(`opens in[^.]*(?:${phrase.source})`, "i").test(opened),
        `the report claims the window opens in the ${other} sort`,
      )
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

/**
 * The palette line is the only place the removed commands' replacements are
 * advertised.
 *
 * `/archive_Put`, `/archive_Pull` and `/save` are gone, and their jobs are
 * buttons in the popup window. A command that no longer exists has no way to
 * tell the person who used to type it where its job went — so if this line
 * stops naming the actions, nobody finds out and the easiest way to archive a
 * session stays unknown to them.
 *
 * It used to describe the window's layout instead ("unarchived first, then
 * archived, with… on each row"), which is what the window's own banner is for.
 */
describe("the /list_sessions palette line", () => {
  it("names every action the window offers", () => {
    for (const action of ["Stats", "Archive", "Restore", "Transcript.md", "Export .json", "Delete"]) {
      assert.ok(
        __listSessionsDescription.includes(action),
        `the palette line no longer mentions ${action}, and that is how the removed commands are advertised`,
      )
    }
  })

  it("names the two report buttons, which are not actions on a session", () => {
    // Database is in the window's footer rather than on a row, so it is not in
    // the action list above and there is nothing else that would keep anyone
    // from knowing it exists.
    assert.match(__popupOpenedNote(), /Database/, "the opened note must name the footer report")
  })

  it("says the actions are clicked rather than typed", () => {
    // The point of the line. Without it, "Archive, Restore, …" reads as a list
    // of things this command does, which is what it used to mean.
    assert.match(__listSessionsDescription, /nothing to type/i)
  })

  it("stays short enough for a palette entry", () => {
    // The palette truncates, and the front is what survives — so the actions
    // have to be in front, and the line has to be over before it is cut.
    assert.ok(
      __listSessionsDescription.length <= 110,
      `palette line is ${__listSessionsDescription.length} chars: ${__listSessionsDescription}`,
    )
    const firstAction = __listSessionsDescription.indexOf("Archive")
    assert.ok(firstAction < 40, `the actions start too late to survive truncation: ${firstAction}`)
  })

  it("does not describe the window's layout, which is the banner's job", () => {
    // Both were true of the old line at once, which is how it ran to 161 chars.
    for (const layout of ["unarchived first", "on each row", "then archived"]) {
      assert.ok(
        !__listSessionsDescription.toLowerCase().includes(layout),
        `the palette line describes layout ("${layout}") instead of what can be done`,
      )
    }
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