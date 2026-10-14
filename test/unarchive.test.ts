/**
 * Tests for `/unarchive` argument resolution.
 *
 * This drives a database write, so the cases that matter are the ones that
 * could restore the *wrong* session: a number that doesn't exist, a term
 * matching several titles, and an id that looks like something else.
 *
 *   node --test test/
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { __resolve } from "../index.ts"
import type { SessionRow } from "../src/db.ts"

const rows = [
  { id: "ses_a1", title: "Alpha report", directory: "/home/u/one" },
  { id: "ses_b2", title: "Beta notes", directory: "/home/u/two" },
  { id: "ses_c3", title: "Gamma summary", directory: "/home/u/three" },
  { id: "ses_d4", title: "Delta draft", directory: "/home/u/two" },
] as SessionRow[]

describe("resolve() for /unarchive", () => {
  it("treats a bare number as a 1-based position", () => {
    assert.deepEqual(__resolve(["1"], rows).ids, ["ses_a1"])
    assert.deepEqual(__resolve(["3"], rows).ids, ["ses_c3"])
  })

  it("ignores a number past the end of the list", () => {
    // Must not fall through and match something unexpected.
    assert.deepEqual(__resolve(["9"], rows).ids, [])
  })

  it("treats 0 as invalid rather than as the first row", () => {
    assert.deepEqual(__resolve(["0"], rows).ids, [])
  })

  it("prefers an exact id over a number", () => {
    assert.deepEqual(__resolve(["ses_b2"], rows).ids, ["ses_b2"])
  })

  it("matches a title fragment", () => {
    assert.deepEqual(__resolve(["Gamma"], rows).ids, ["ses_c3"])
  })

  it("refuses a term matching several titles", () => {
    // "e" appears in Beta, Delta... and as a substring elsewhere. The point is
    // that it must not pick one arbitrarily.
    const r = __resolve(["e"], rows)
    assert.equal(r.ambiguous, true)
    assert.deepEqual(r.ids, [])
  })

  it("falls back to directory and id when no title matches", () => {
    // "three" is only a directory, not in any title.
    assert.deepEqual(__resolve(["three"], rows).ids, ["ses_c3"])
  })

  it("reports ambiguity when a directory matches several", () => {
    const r = __resolve(["two"], rows)
    assert.equal(r.ambiguous, true)
    assert.deepEqual(r.ids, [])
  })

  it("resolves a number and a title together", () => {
    assert.deepEqual(__resolve(["1", "Gamma"], rows).ids.sort(), ["ses_a1", "ses_c3"])
  })

  it("never returns duplicates", () => {
    assert.deepEqual(__resolve(["1", "Alpha report"], rows).ids, ["ses_a1"])
  })

  it("matches case-insensitively", () => {
    assert.deepEqual(__resolve(["GAMMA"], rows).ids, ["ses_c3"])
  })

  it("returns nothing for blank arguments", () => {
    assert.deepEqual(__resolve(["", "  "], rows).ids, [])
    assert.equal(__resolve([""], rows).ambiguous, false)
  })
})