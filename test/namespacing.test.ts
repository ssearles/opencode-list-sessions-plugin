/**
 * Guard against the failure that took this plugin offline.
 *
 * The host builds each tool id as `<namespace>_<name>`, falling back to a bare
 * `<name>` when `options.namespace` is absent. Calling `editor.namespace()`
 * does NOT namespace anything — it only records a display descriptor. So a tool
 * registered without `options.namespace` lands in the same flat registry as the
 * core tools, and a name like `read` silently replaces the host's own.
 *
 * That broke every request that touched a file, not just archiving.
 *
 * These tests read index.ts as text rather than running the plugin, because the
 * collision only exists inside the host's registry, which we cannot construct
 * here. Asserting on the source is a blunt instrument, but it fails loudly the
 * moment the namespace is dropped, which is the whole point.
 *
 *   node --test test/
 */

import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const source = readFileSync(join(root, "index.ts"), "utf8")

/** Core tool names that must never be reused bare by this plugin. */
const CORE_TOOLS = [
  "bash",
  "edit",
  "glob",
  "grep",
  "list",
  "patch",
  "read",
  "shell",
  "write",
  "webfetch",
  "todowrite",
  "todoread",
  "question",
  "skill",
  "subagent",
]

/**
 * Every *tool* `editor.add({ ... })` registration, as source text.
 *
 * Commands are registered the same way but live in a separate namespace, so
 * only the `ctx.tool.transform(...)` section is considered.
 */
function registrations(): string[] {
  const start = source.indexOf("await ctx.tool.transform(")
  assert.ok(start !== -1, "ctx.tool.transform(...) block not found in index.ts")

  return source
    .slice(start)
    .split("editor.add(")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("\n      })") + 6))
}

function toolNameIn(block: string): string | undefined {
  return block.match(/name:\s*"([^"]+)"/)?.[1]
}

describe("tool namespacing", () => {
  it("registers at least four tools", () => {
    assert.ok(
      registrations().length >= 4,
      `expected the 4 session_archive tools, found ${registrations().length}`,
    )
  })

  it("every tool declares options.namespace", () => {
    const missing = registrations()
      .map((b) => toolNameIn(b))
      .filter((name) => {
        const block = registrations().find((b) => toolNameIn(b) === name)!
        return !/options:\s*\{\s*namespace:\s*NS\s*\}/.test(block)
      })

    assert.deepEqual(
      missing,
      [],
      `these tools would register under a bare name and risk shadowing a core ` +
        `tool: ${missing.join(", ")}. Add options: { namespace: NS }.`,
    )
  })

  it("no tool shadows a core tool name", () => {
    const names = registrations().map((b) => toolNameIn(b)).filter(Boolean) as string[]

    for (const core of CORE_TOOLS) {
      // Safe if namespaced; the danger is a bare `read` replacing core `read`.
      const offenders = names.filter((n) => n === core)
      assert.deepEqual(
        offenders,
        [],
        `tool "${core}" collides with a core tool name — rename it even when ` +
          `namespaced, so a missing namespace cannot shadow the core tool.`,
      )
    }
  })

  it("uses one namespace constant consistently", () => {
    const namespaces = [...source.matchAll(/options:\s*\{\s*namespace:\s*([^}]+)\}/g)].map(
      (m) => m[1].trim(),
    )
    assert.ok(namespaces.length >= 4, `expected 4 namespaced tools, found ${namespaces.length}`)
    assert.deepEqual(
      [...new Set(namespaces)],
      ["NS"],
      "all tools should share the NS constant so a rename cannot miss one",
    )
  })

  it("declares NS before it is used", () => {
    const declared = source.indexOf('const NS = "session_archive"')
    const firstUse = source.indexOf("options: { namespace: NS }")
    assert.ok(declared !== -1, "NS constant is missing")
    assert.ok(declared < firstUse, "NS is used before it is declared")
  })
})
