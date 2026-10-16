# AGENTS.md — opencode-archive-session

## Project Overview
OpenCode plugin to archive, list, read, save and restore sessions — including
sessions OpenCode itself can no longer bring back.

Two problems, one plugin:

- **Archiving is one-way.** OpenCode's API ignores `time_archived` changes, so an
  archived session cannot be restored through it. This plugin writes directly to
  SQLite, and is the only way back.
- **Export is truncated and unreadable.** The TUI `/export` writes only the
  messages currently loaded in the window, and both it and
  `opencode session export` produce JSON. `/save` reads every message for the
  session straight out of SQLite and writes Markdown.

Forked from `opencode-session-transcript`, which had dropped archiving in
`f5a38ef` when it pivoted to Markdown export. That commit deleted ~714 lines of
`index.ts` and all four archive test files. They are restored here, and `/save`
ships alongside them rather than instead of them.

## Key Commands
```bash
npm test          # node --test test/  (111 tests, no install required)
npm run check     # verifies index.ts and src/db.ts load without syntax errors
npm run typecheck # tsc --noEmit (requires TypeScript installed)
```

## Architecture Notes
- **Entry point must be at package root** — OpenCode resolves local plugins but
  does **not** honor `main`/`exports` pointing into subdirectories. `index.ts`
  lives at `/`, `src/db.ts` and `src/markdown.ts` are internal.
- Zero runtime dependencies: declares `@opencode/plugin` as an optional
  peerDependency but **does not import it**; uses local structural types.
- Dual SQLite driver: `bun:sqlite` (Bun) or `node:sqlite` (Node 22+). Resolved at
  runtime.
- Schema-agnostic: discovers `session_v2` (v2) or `session` (v1) at runtime and
  introspects columns. No hardcoded schemas.
- `src/db.ts` came through the fork untouched — the transcript copy is already
  the archive-era file plus the `messages()` method that Markdown export added.

## Database Safety Model
- Only `time_archived` and `time_updated` are ever written — **never messages**.
- Every write takes a consistent snapshot first via `VACUUM INTO` (WAL-safe).
  Backups land in `~/.local/share/opencode/backups/`.
- Writes are transactional per-session; unknown ids are reported, not thrown.
- `/save` is **read-only**. It opens the store and renders; it never writes.

## Critical Behavior: Restoring
Clearing `time_archived` alone is **not enough**. OpenCode orders sessions by
`time_updated DESC` and pages per directory, so a session archived weeks ago
stays buried. Restoring **must also refresh `time_updated`** to surface it.

## Commands (slash — must be typed, see the palette note below)
| Command | Purpose |
|---------|---------|
| `/list_sessions` | Every session — working first, then archived, full ids, **unnumbered** |
| `/archive_Put [num \| id \| title]` | Archive a current session — bare form prints a numbered menu |
| `/archive_Pull [num \| id \| title]` | Restore an archived session — bare form prints a numbered menu |
| `/save [path.md]` | Write the session to Markdown, default `~/Documents/<title>.md` |

`/save` takes an explicit output path when the argument ends in `.md`, so
`/save ~/Desktop/today.md` works unconfigured. Otherwise the filename is the
session's own title, slugified — **two sessions sharing a title will overwrite
each other**, which is why the explicit form exists. Override the default folder
with `OPENCODE_TRANSCRIPT_DIR`.

## Tools (agent-callable, namespace `session_archive`)
| Tool | Purpose |
|------|---------|
| `list_sessions` | List working sessions |
| `list_archived` | List archived sessions, optional `search` |
| `archive` | Archive by `session_ids[]` |
| `read_transcript` | Read a transcript by id or search |
| `unarchive` | Restore by `session_ids[]` |

## Argument Resolution — `__resolve` Is Overloaded
One export serves two eras of this plugin, and **both are exercised by tests**:

- `__resolve(args)` opens the store and resolves narrowest-first against every
  session. Asynchronous, because reading them is.
- `__resolve(args, rows)` resolves against rows the caller already has, and is
  **synchronous**, so a numbered menu can resolve without a second round trip.
  This is the `opencode-session-transcript` contract: a bare number is a 1-based
  position in `rows`, an exact id beats a number, and an out-of-range number
  resolves to nothing rather than falling through to a text match.

Callers that `await` work with either form, since awaiting a plain value is a
no-op. `test/resolve.test.ts` uses the first form; `test/unarchive.test.ts` uses
the second. **Changing the signature to a single shape breaks one of them.**

Store-backed matching is narrowest-first: exact id, then whole phrase against
the title, then prefix, then substring on title/directory/id. Ambiguous terms
resolve to **nothing** rather than to several sessions — this is what stops
`/archive_Pull ZZ fix verify` restoring every session containing "fix".

## Test Suite Structure
| File | Tests | Covers |
|------|-------|--------|
| `test/db.test.ts` | 38 | Shared suite run twice (v1 + v2 schemas), discovery |
| `test/unarchive.test.ts` | 12 | Sync resolver — the `rows` form of `__resolve` |
| `test/menu.test.ts` | 24 | Numbered menus, prompt parsing, inventory rendering, picking by number |
| `test/markdown.test.ts` | 13 | `messageText`, `slug`, `toMarkdown` |
| `test/resolve.test.ts` | 9 | Store-backed resolver — the async form of `__resolve` |
| `test/namespacing.test.ts` | 5 | Guards tool namespacing / core-tool collisions |
| `test/range.test.ts` | 6 | Out-of-range numbers refused, not reinterpreted |
| `test/retention.test.ts` | 4 | Bounded backup snapshots |

Fixtures: each test file builds its own throwaway DB in a temp dir via the
`OPENCODE_DB` env var. Run with `node --test test/` — no compilation needed.

## Test Suite History — Do Not Trust a Merge to Keep It
`f5a38ef` deleted four of these test files while rewriting `index.ts`, and a
later merge of master **silently reproduced that deletion** with zero conflicts:
git saw master had removed the files and the branch had not touched them, so it
took the removal. `npm test` then failed 14 tests — which is how it was caught.

**After any merge or rebase, check `git status` for unexpected `D` entries in
`test/` before believing the suite is green.**

## Why There Is No Dropdown (tested — do not retry)
OpenCode renders `/model` as a real popup. That popup is **not** bespoke — it is
a *form* with a `multiselect` field whose `options` are the model list, and the
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
**clicking `/list_sessions`, `/archive_Put`, `/archive_Pull` or `/save` in the
palette does nothing at all.** The commands must be typed. A plugin cannot
register into the enum.

This also plausibly explains an intermittent case where `/archive_Put 2` did
nothing while `/archive_Put 1` worked: if the autocomplete dropdown is still open
when Enter is pressed, the click path runs and matches nothing. Unverified, but
consistent.

**A command's absence from the palette is never a bug in that command.** Do not
rename anything to "fix" the palette.

## Deep Links Are Plumbed But Not Implemented (2.0.24)
The desktop app registers `opencode://` as a protocol handler, so
`opencode://session/<id>` looks like a way to give a plugin clickable navigation.

It does not work. The main process accepts the URL, filters for the `opencode://`
prefix, logs `deep link received via open-url`, and forwards it to the renderer.
The renderer parks it in a global and fires an event, then stops:

```js
window.__OPENCODE__.deepLinks = [...(window.__OPENCODE__.deepLinks ?? []), ...urls]
window.dispatchEvent(new CustomEvent(`opencode:deep-link`, {detail: {urls}}))
```

Searching every file in `/usr/lib/opencode-desktop/app.asar`: exactly one writes
`deepLinks`, exactly one dispatches the event, and **nothing listens**. No
navigation, no routing.

So there is no clickable navigation available to a plugin, and therefore no way
to build a child-session picker with a usable way back.

To re-extract the archive (headers are a size-prefixed JSON, file bodies start
at `16 + headerLen`):

```python
import json, struct, pathlib
d = pathlib.Path("/usr/lib/opencode-desktop/app.asar").read_bytes()
hl = struct.unpack("<I", d[12:16])[0]
hdr = json.loads(d[16:16+hl].decode()); base = 16 + hl
```

## Command Output Goes to Two Channels
Every command writes to `~/.local/share/opencode/session-log/<timestamp>.md`
**and** posts a synthetic message. Override with `OPENCODE_SESSION_LOG_DIR`.

The file is not belt-and-braces, it is the load-bearing channel: the desktop app
does not reliably render synthetic messages, so a command can appear to do
nothing at all — indistinguishable from one that did nothing, which is the worst
ambiguity for a command that archived three sessions. The file is written first
and synchronously; if the synthetic call throws, the output is already on disk.

`/session` was removed because `/list_sessions` covers it. The `readMessages`
DB method stays — the `read_transcript` tool uses it.

## An Out-of-Range Number Is Refused, Not Reinterpreted
`pickByNumber` returns `outOfRange: string[]` alongside `ids` and `ambiguous`.
A number is a position in the menu just shown and nothing else. It used to fall
through to a text lookup, so `/archive_Put 99` could archive a session whose
title merely contained "99" while the user believed they had picked a row that
did not exist. `test/range.test.ts` guards this, including a seeded session
titled "99 versions of the manual".

## Common Gotchas
- **Every tool MUST set `options: { namespace: NS }`.** The host builds a tool's
  id as `<namespace>_<name>`, falling back to a bare `<name>` when
  `options.namespace` is absent. `editor.namespace({name})` only records a
  display descriptor — it namespaces nothing. A tool named `read` without it
  **replaces the host's own read tool** and breaks every request that touches a
  file. This took the plugin offline once; `test/namespacing.test.ts` guards it,
  and it also forbids reusing a core tool name (`bash`, `edit`, `glob`, `grep`,
  `list`, `patch`, `read`, `shell`, `write`, …) even when namespaced. Note the
  the tool `list_sessions` and the command of the same name coexist for this
  reason — and `list` as a bare tool name remains forbidden.
- **Desktop app doesn't restart the background service** — closing/reopening the
  window reuses the existing `opencode-cli serve --service` process. Must run
  `opencode reload` or kill the service process to pick up config/plugin changes.
- **A plugin's config is read from the server's project root**, not the
  subdirectory you `cd` into. When testing against a throwaway server, put
  `opencode.json` in the directory the server actually resolves as its location,
  or it is silently ignored.
- **`/api/plugin`** is the way to confirm a local plugin loaded (look for
  `source.type == "local"` and the entry path). There is **no tool-listing
  endpoint** — verify core tools still work by prompting a throwaway session to
  use one.
- `GET /api/session/{id}/message` returns items in **non-chronological order**.
  Sort by `time.created` before reading the newest output, or you will read a
  stale message.
- The `check` script exists because most of the suite covers `src/db.ts`;
  `index.ts` syntax errors went undetected until manual load testing.
- Template literals with nested quotes: prefer concatenation (`"foo " + bar`)
  over `` `foo ${bar}` `` when the string contains both backticks and quotes.
- **`/list_sessions` must stay unnumbered.** It was briefly split into
  `/list_Current` and `/list_Archived` and put back. Splitting it lost the only
  single-screen view of both halves and gained nothing, since the numbered menus
  were always available by running `/archive_Put` or `/archive_Pull` bare. If you
  are tempted to unify them again, read `inventory()`'s doc comment first.
- **`list_sessions` is both a command and a tool name.** Different namespaces
  (commands are separate from `ctx.tool.transform`), so there is no collision —
  but do not "fix" the apparent duplicate.
- **Editing `index.ts` reloads the plugin on every save**, and each reload
  re-registers every command, which visibly re-renders the palette. A batch of
  edits makes the screen flicker. Commit before testing.
- **Cherry-picking an ancestor commit does not work here.** `8a754f6` predates
  `master`, so replaying it onto master re-applies a diff master already
  contains and partially undid — every file conflicts add/add. Recovering
  deleted code means checking it out (`git show f5a38ef^:index.ts`) and porting
  it forward, not cherry-picking.

## Verifying a Change End-to-End
1. `npm test` and `npm run check`
2. Start a throwaway server: `(setsid opencode serve --port NNNN > log 2>&1 < /dev/null &)`
   with `opencode.json` in the server's resolved project root.
3. Password comes from the `server password …` line in the log; all calls use
   basic auth `opencode:$PW`.
4. Confirm load: `GET /api/plugin` → `source.type == "local"`.
5. Confirm commands: `GET /api/command` → expect
   `list_sessions, archive_Put, archive_Pull, save` alongside `init, review`.
6. Confirm no shadowing: prompt a session to use the **core** `read` tool and
   check it still reads a file.
7. Confirm function: flip `time_archived` in `session_v2` via `/archive_Put`
   and `/archive_Pull`; write a Markdown file via `/save`.
   `probe.ts` drives all of this headlessly — `node probe.ts <out>` to read,
   `node probe.ts <out> --write` to exercise the archive/restore round trip.
8. Kill the server and delete every test session — they land in the **real**
   database.

## File Layout
```
index.ts              # plugin entry — commands + tools, test-only exports
src/db.ts             # SessionStore, schema detection, backup, archive/unarchive
src/markdown.ts       # messageText, slug, toMarkdown
test/db.test.ts       # DB layer (both schemas)
test/unarchive.test.ts    # sync resolver (__resolve with rows)
test/menu.test.ts         # menus, parsing, inventory, pickByNumber
test/markdown.test.ts     # Markdown rendering
test/resolve.test.ts      # store-backed resolver (__resolve with args only)
test/namespacing.test.ts  # Guards tool namespacing / core-tool collisions
test/range.test.ts        # Out-of-range numbers refused, not reinterpreted
test/retention.test.ts    # Bounded backups
probe.ts                  # Headless driver — run commands, capture to a file
package.json           # main: "./index.ts", exports: ".": "./index.ts"
tsconfig.json          # noEmit, strict, include: src/** test/**
```

Test-only exports from `index.ts`: `__resolve`, `__menu`, `__pickByNumber`,
`__inventory`, `__parseArgs`, plus `slug` / `toMarkdown` / `ArchiveError`.

## Environment
- Default DB: `~/.local/share/opencode/opencode.db` (or `XDG_DATA_HOME/opencode/opencode.db`)
- Override with `OPENCODE_DB` env var (used by tests)
- `/save` output dir override: `OPENCODE_TRANSCRIPT_DIR`
- Requires Node 22+ or Bun
- The repo is **private while in testing**. It is not published to npm, and
  `~/.config/opencode/opencode.json` loads `opencode-session-transcript` from npm
  — so nothing here is live until you either publish or repoint that entry at
  this checkout by absolute path.
- Command names are mixed-case (`/archive_Put`). They are matched literally, so
  `/archive_put` will not autocomplete — the casing is deliberate, not a typo.

## Git Rules
- **Never check out another branch while OpenCode is running against this
  directory.** If this checkout is the live plugin source (configured by
  absolute path), the file watcher reloads on every save — so the moment a
  checkout lands, whatever is on disk is live. This has bitten twice: `master`
  predated the namespacing fix, so checking it out registered a bare `read`,
  replacing the host's core tool; a mid-merge checkout flashed stale tools
  before the pull completed.
- Develop on a branch, merge on GitHub. `master` is not a place to visit locally.
- If a branch must be checked out, stop OpenCode first, then verify:

```bash
curl -su "opencode:$(python3 -c "import json;print(json.load(open('$HOME/.config/opencode/service.json'))['password'])")" \
  http://127.0.0.1:49374/api/command | python3 -c "import sys,json;print([c['name'] for c in json.load(sys.stdin)['data']])"
```

With the npm package loaded, expect exactly `['init', 'review', 'save']`. Any
`list_sessions`, `archive_Put` or `archive_Pull` in that output means a local
checkout is live.
