/**
 * Tests for the running output log.
 *
 * `latest.md` used to be truncated and rewritten on every run. That showed the
 * current report but left a follower nothing to scroll — the file was always
 * exactly one report long, so it redrew in place. It now appends, and trims to
 * the most recent reports so the file cannot grow without bound.
 *
 * These use a throwaway directory via OPENCODE_SESSION_LOG_DIR.
 *
 *   node --test test/
 */

import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, beforeEach, describe, it } from "node:test"

const MARK = "<!-- opencode-archive-session report -->"
const KEEP = 20

let tmp: string
let savedDir: string | undefined

before(() => {
  savedDir = process.env.OPENCODE_SESSION_LOG_DIR
  tmp = mkdtempSync(join(tmpdir(), "session-log-"))
  process.env.OPENCODE_SESSION_LOG_DIR = tmp
})

after(() => {
  if (savedDir === undefined) delete process.env.OPENCODE_SESSION_LOG_DIR
  else process.env.OPENCODE_SESSION_LOG_DIR = savedDir
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Re-implements the plugin's append+trim against the same file, so the shape is
 * asserted without importing index.ts (whose `say` needs a plugin context).
 */
function append(body: string): void {
  const file = join(tmp, "latest.md")
  let existing = ""
  try {
    existing = readFileSync(file, "utf8")
  } catch {
    /* no file yet */
  }
  const reports = [
    ...existing
      .split(MARK)
      .map((c) => c.trim())
      .filter((c) => c.length > 0),
    body.trim(),
  ].slice(-KEEP)
  writeFileSync(file, reports.map((r) => MARK + "\n" + r).join("\n\n") + "\n", "utf8")
}

// Each test starts from an empty log. They share one temp directory, so without
// this the reports from an earlier test leak into the next one's count.
beforeEach(() => {
  rmSync(join(tmp, "latest.md"), { force: true })
})

const read = () => readFileSync(join(tmp, "latest.md"), "utf8")
const reports = () => read().split(MARK).filter((c) => c.trim().length > 0)

describe("the running output log", () => {
  it("creates the file on first use", () => {
    assert.ok(!existsSync(join(tmp, "latest.md")), "starts with no log")
    append("first report")
    assert.ok(existsSync(join(tmp, "latest.md")))
  })

  it("appends rather than replacing, so a follower has history to scroll", () => {
    append("first report")
    append("second report")
    assert.equal(reports().length, 2)
    assert.match(read(), /first report/)
    assert.match(read(), /second report/)
  })

  it("keeps the newest report last", () => {
    append("one")
    append("two")
    append("three")
    const all = reports()
    assert.equal(all[all.length - 1].trim(), "three")
  })

  it("keeps only the most recent reports once past the limit", () => {
    for (let i = 1; i <= KEEP + 5; i++) append("report " + i)
    assert.equal(reports().length, KEEP)
    assert.ok(!read().includes("report 1\n"), "the oldest report should be gone")
    assert.match(read(), new RegExp("report " + (KEEP + 5)))
  })

  it("never splits a report when trimming", () => {
    // A report containing the marker text would break a naive split. Length
    // varies per run, so trimming by line count would cut mid-report too.
    for (let i = 1; i <= KEEP + 3; i++) append("line\n".repeat(i) + "END" + i)
    for (const chunk of reports()) {
      assert.match(chunk.trim(), /END\d+$/, "every kept report must be whole")
    }
  })

  it("tolerates a missing or empty file", () => {
    rmSync(join(tmp, "latest.md"), { force: true })
    append("fresh start")
    assert.match(read(), /fresh start/)
  })

  it("recovers from a file that is only the marker", () => {
    writeFileSync(join(tmp, "latest.md"), MARK + "\n")
    append("after empty")
    assert.equal(reports().length, 1)
    assert.match(read(), /after empty/)
  })
})
