/**
 * Drive the plugin's real command logic and write the output to a file.
 *
 * Why this exists: commands report through `ctx.session.synthetic()`, and the
 * desktop app does not reliably render synthetic messages — so running a command
 * from the TUI can appear to do nothing. This calls the same functions the
 * commands call, against the same database, and captures the exact string that
 * would have been sent.
 *
 * Read-only by default. Pass `--write` to also exercise the archive/restore
 * round trip against the real database (it snapshots with VACUUM INTO first, and
 * only ever sets time_archived / time_updated).
 *
 *   node probe.ts [outfile] [--write]
 */

import { SessionStore } from "./src/db.ts"
import { __menu as menu, __inventory as inventory, __parseArgs as parseArgs } from "./index.ts"

const write = process.argv.includes("--write")
const out: string[] = []

function show(label: string, body: string) {
  out.push("", "=".repeat(64), label, "=".repeat(64), "", body)
}

const s = await SessionStore.open()
const all = await s.list()
const working = all.filter((r) => !r.archived)
const archived = all.filter((r) => r.archived)

show("/list_sessions", inventory(all))
show(
  "/archive_Put   (no argument)",
  menu(working, {
    heading: "Current sessions",
    empty: "No current sessions to archive.",
    action: "Archive one with `/archive_Put <number>`, or name it directly.",
  }),
)
show(
  "/archive_Pull  (no argument)",
  menu(archived, {
    heading: "Archived sessions",
    empty: "No archived sessions.",
    action: "Restore one with `/archive_Pull <number>`, or name it directly.",
  }),
)
show(
  "parseArgs — command name is stripped",
  [
    'parse("/archive_Put")             -> ' + JSON.stringify(parseArgs("/archive_Put")),
    'parse("/archive_Put 2")           -> ' + JSON.stringify(parseArgs("/archive_Put 2")),
    'parse("/archive_Pull")            -> ' + JSON.stringify(parseArgs("/archive_Pull")),
    'parse(undefined)  [palette click] -> ' + JSON.stringify(parseArgs(undefined)),
  ].join("\n"),
)

// An out-of-range number, and a number that is also a substring of a title.
const { __pickByNumber: pickByNumber } = await import("./index.ts")
show(
  "/archive_Put 99  (out of range)",
  [
    `rows in the current menu: ${working.length}`,
    "result: " + JSON.stringify(await pickByNumber(["99"], working, s), null, 2),
  ].join("\n"),
)
show(
  "/archive_Put 0  (invalid, not row 0)",
  "result: " + JSON.stringify(await pickByNumber(["0"], working, s), null, 2),
)

if (write && working.length > 0) {
  const target = working[working.length - 1]
  const put = await s.archive([target.id])
  show(
    "/archive_Put <n>  (round trip)",
    [
      `archived: ${target.title}`,
      `  changed: ${JSON.stringify(put.changed)}`,
      `  errors:  ${JSON.stringify(put.errors)}`,
      `  backup:  ${put.backup}`,
    ].join("\n"),
  )
  const pull = await s.unarchive([target.id])
  show(
    "/archive_Pull <n>  (round trip)",
    [`restored: ${target.title}`, `  changed: ${JSON.stringify(pull.changed)}`].join("\n"),
  )
}

const dest = process.argv[2]?.startsWith("--") ? "/tmp/opencode/probe-output.md" : process.argv[2]
const file = dest ?? "/tmp/opencode/probe-output.md"
const { writeFileSync } = await import("node:fs")
writeFileSync(file, out.join("\n") + "\n", "utf8")

console.log("wrote " + file)
console.log(
  `sessions: ${all.length} total, ${working.length} working, ${archived.length} archived` +
    (write ? "  [round trip exercised]" : ""),
)
