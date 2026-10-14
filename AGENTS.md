# AGENTS.md — opencode-session-archive

## Project Overview
OpenCode plugin to archive, list, read, and restore sessions — including sessions OpenCode itself can no longer bring back. The core problem: OpenCode's API ignores `time_archived` changes, making archiving one-way. This plugin writes directly to SQLite.

## Key Commands
```bash
npm test          # node --test test/  (47 tests, no install required)
npm run check     # verifies both index.ts and src/db.ts load without syntax errors
npm run typecheck # tsc --noEmit (requires TypeScript installed)
```

## Architecture Notes
- **Entry point must be at package root** — OpenCode resolves local plugins but does **not** honor `main`/`exports` pointing into subdirectories. `index.ts` lives at `/`, `src/db.ts` is internal.
- Zero runtime dependencies: declares `@opencode/plugin` as optional peerDependency but **does not import it**; uses local structural types instead.
- Dual SQLite driver: `bun:sqlite` (Bun) or `node:sqlite` (Node 22+). Resolved at runtime.
- Schema-agnostic: discovers `session_v2` (v2) or `session` (v1) at runtime and introspects columns. No hardcoded schemas.

## Database Safety Model
- Only `time_archived` and `time_updated` are ever written — **never messages**.
- Every write takes a consistent snapshot first via `VACUUM INTO` (WAL-safe). Backups land in `~/.local/share/opencode/backups/`.
- Writes are transactional per-session; unknown ids are reported, not thrown.

## Critical Behavior: Restoring
Clearing `time_archived` alone is **not enough**. OpenCode orders sessions by `time_updated DESC` and pages per directory, so a session archived weeks ago stays buried. Restoring **must also refresh `time_updated`** to surface it.

## Commands (slash, appear in TUI/desktop)
| Command | Purpose |
|---------|---------|
| `/archived` | List archived sessions |
| `/archive [id…]` | Archive current session, or named ones |
| `/unarchive <id or title>` | Restore — refuses ambiguous terms |
| `/session <id or title>` | Print transcript (archived included) |

## Tools (agent-callable)
- `session_archive.list_archived` — list, optional `search`
- `session_archive.read` — read transcript by id or search
- `session_archive.archive` — archive by `session_ids[]`
- `session_archive.unarchive` — restore by `session_ids[]`

## Argument Resolution (resolver logic)
Used by `/archive`, `/unarchive`, `/session`. **Narrowest-first matching**:
1. Exact session id always wins
2. Whole phrase against title
3. Prefix match on title
4. Substring on title/directory/id — **only if unambiguous**

Ambiguous terms resolve to **nothing** (not multiple sessions). This prevents `/unarchive ZZ fix verify` from restoring every session containing "fix".

## Test Suite Structure
- `test/db.test.ts` — 36 tests against shared suite run twice (v1 + v2 schemas)
- `test/resolve.test.ts` — 11 tests for the argument resolver
- Fixtures: each test file builds its own throwaway DB in a temp dir via `OPENCODE_DB` env var
- Run with `node --test test/` — no TypeScript compilation needed

## Why There Is No Dropdown (tested — do not retry)
OpenCode renders `/model` as a real popup. That popup is **not bespoke** — it is a
*form* with a `multiselect` field whose `options` are the model list, and the
server exposes the whole lifecycle over HTTP (`POST /api/session/{id}/form`,
`GET .../form/{fid}`, `POST .../reply`, `DELETE ...`). `Form.Option` is
`{value, label, description}`, which maps exactly onto a session row.

**A form created by a plugin does not render.** Verified twice on v2.0.24:

1. Posted directly to the API outside any turn — stayed pending, never drawn.
2. Created from *inside* a command execution, i.e. mid-turn, the state `/model`
   uses — still never drawn. The session showed no change at all.

The client evidently renders a form only in specific built-in flows. A plugin
also has no `form` key on its context; reaching the API means reading the
password from `~/.config/opencode/service.json` and looping back to
`127.0.0.1`, which would be unacceptable to ship even if it worked.

The TUI event bus carries only `command.execute`, `prompt.append`,
`session.select` and `toast.show`, and a plugin's context exposes
`event.subscribe` with **no publish**, so a plugin cannot raise any UI itself.

Numbered text menus are the ceiling. That is a deliberate, tested decision.

## Plugin Commands Are Type-Only (desktop)
The desktop command palette dispatches through `tui.command.execute`, whose
schema is a **fixed enum** of built-in names only:

```
session.list, session.new, session.share, session.interrupt, session.background,
session.compact, session.page.up, session.page.down, session.line.up,
session.line.down, session.half.page.up, session.half.page.down, session.first,
session.last, prompt.clear, prompt.submit, agent.cycle
```

No plugin command appears in that enum and it is compiled into the client, so
**clicking `/list`, `/archive` or `/unarchive` in the palette does nothing at
all.** The commands must be typed. A plugin cannot register into the enum.

This also plausibly explains an intermittent case where `/archive 2` did
nothing while `/archive 1` worked: if the autocomplete dropdown is still open
when Enter is pressed, the click path runs and matches nothing. Unverified, but
consistent.

## `/session` Is Hidden From The Palette
`/session` is registered on the service (`GET /api/command` returns it) yet
does not appear in the desktop palette. Cause unknown — possibly reserved as a
built-in name. If renaming it is ever considered, check first.

## Common Gotchas
- **Every tool MUST set `options: { namespace: NS }`.** The host builds a tool's id as `<namespace>_<name>`, falling back to a bare `<name>` when `options.namespace` is absent. `editor.namespace({name})` only records a display descriptor — it namespaces nothing. A tool named `read` without it **replaces the host's own read tool** and breaks every request that touches a file. This took the plugin offline once; `test/namespacing.test.ts` guards it, and it also forbids reusing a core tool name (`bash`, `edit`, `glob`, `grep`, `list`, `patch`, `read`, `shell`, `write`, …) even when namespaced.
- **Desktop app doesn't restart the background service** — closing/reopening the window reuses the existing `opencode-cli serve --service` process. Must run `opencode reload` or kill the service process to pick up config/plugin changes.
- **A plugin's config is read from the server's project root**, not the subdirectory you `cd` into. When testing against a throwaway server, put `opencode.json` in the directory the server actually resolves as its location, or it is silently ignored.
- **`/api/plugin`** is the way to confirm a local plugin loaded (look for `source.type == "local"` and the entry path). There is **no tool-listing endpoint** — verify core tools still work by prompting a throwaway session to use one.
- `GET /api/session/{id}/message` returns items in **non-chronological order**. Sort by `time.created` before reading the newest output, or you will read a stale message.
- The `check` script exists because the test suite only covers `src/db.ts`; `index.ts` syntax errors went undetected until manual load testing.
- Template literals with nested quotes: prefer concatenation (`"foo " + bar + " baz"`) over `` `foo ${bar} baz` `` when the string contains both backticks and quotes.

## Verifying a Change End-to-End
1. `npm test` and `npm run check`
2. Start a throwaway server: `(setsid opencode serve --port NNNN > log 2>&1 < /dev/null &)` with `opencode.json` in the server's resolved project root.
3. Password comes from the `server password …` line in the log; all calls use basic auth `opencode:$PW`.
4. Confirm load: `GET /api/plugin` → `source.type == "local"`.
5. Confirm commands: `GET /api/command` → expect `archived, archive, session, unarchive` alongside `init, review`.
6. Confirm no shadowing: prompt a session to use the **core** `read` tool and check it still reads a file.
7. Confirm function: flip `time_archived` in `session_v2` via `/archive` and `/unarchive`.
8. Kill the server and delete every test session — they land in the **real** database.

## File Layout
```
index.ts          # plugin entry — commands + tools, exports default + __resolve
src/db.ts         # SessionStore, schema detection, backup, archive/unarchive
test/db.test.ts   # DB layer tests (both schemas)
test/resolve.test.ts  # Resolver tests
test/namespacing.test.ts  # Guards tool namespacing / core-tool collisions
package.json      # main: "./index.ts", exports: ".": "./index.ts"
tsconfig.json     # noEmit, strict, include: src/** test/**
```

## Environment
- Default DB: `~/.local/share/opencode/opencode.db` (or `XDG_DATA_HOME/opencode/opencode.db`)
- Override with `OPENCODE_DB` env var (used by tests)
- Requires Node 22+ or Bun