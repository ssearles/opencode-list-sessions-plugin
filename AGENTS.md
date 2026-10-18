# AGENTS.md — opencode-archive-session

## Project Overview
OpenCode plugin to archive, list, read and restore sessions — including
sessions OpenCode itself can no longer bring back.

Two problems, one plugin:

- **Archiving is one-way.** OpenCode's API ignores `time_archived` changes, so an
  archived session cannot be restored through it. This plugin writes directly to
  SQLite, and is the only way back.
- **Export is truncated and unreadable.** The TUI `/export` writes only the
  messages currently loaded in the window, and both it and
  `opencode session export` produce JSON. The popup window reads every message
  for a session straight out of SQLite and writes Markdown.

Forked from `opencode-session-transcript`, which had dropped archiving in
`f5a38ef` when it pivoted to Markdown export. That commit deleted ~714 lines of
`index.ts` and all four archive test files. They are restored here, and the
popup window ships alongside them rather than instead of them.

## Key Commands
```bash
npm test          # node --test test/ (131) + the three popup suites (134 checks)
npm run test:plugin   # the TypeScript suite alone
npm run test:popup    # the popup suites alone (needs WAYLAND_DISPLAY)
npm run install:popup # symlink ~/.local/bin/session-list-popup at the repo copy
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
- Transcript writing is **read-only**. It opens the store and renders; it never
  writes to the database.

## Critical Behavior: Restoring
Clearing `time_archived` alone is **not enough**. OpenCode orders sessions by
`time_updated DESC` and pages per directory, so a session archived weeks ago
stays buried. Restoring **must also refresh `time_updated`** to surface it.

## Commands (slash — must be typed, see the palette note below)
| Command | Purpose |
|---------|---------|
| `/list_sessions` | Opens the session popup window, told which session opened it; `--text` prints the list instead |

**`/archive_Put` and `/archive_Pull` were removed.** Archiving, restoring,
deleting, transcript and JSON export all moved into the popup window
(`~/.local/bin/session-list-popup`), because they are click targets rather than
things worth typing, and because a plugin cannot present a menu the desktop app
will render — see "Why There Is No Dropdown" below. The `session_archive` tools
are unchanged: archive and restore are still agent-callable.

**`/save` was removed too.** It wrote a Markdown transcript to
`~/Downloads/<title>.md`, which the popup's **Transcript.md** button does — and
does better, because it also decodes the ~200KB base64 blobs of pasted
screenshots into real PNGs beside the file, which `toMarkdown` never did. Two
commands writing the same file, one of them worse, is a trap. `OPENCODE_TRANSCRIPT_DIR`
went with it.

What is lost: a transcript with no display. `session_archive`'s `read_transcript`
tool still reads one, and reads archived sessions OpenCode's own UI cannot show.
`toMarkdown`, `slug` and `messageText` stay in `src/markdown.ts` — the popup
renders its own Markdown in Python, but these are still exported for tests.

### `/popup` Lives In Another Repository

`/popup` opens the generic info window and knows nothing about sessions, so it
is **not registered here**. It is `opencode-popup-window`, its own repository,
loaded separately from `opencode.json`. The two share no code — each has its own
`windowCommand()`, duplicated rather than imported, because a shared package
between two private repos costs more than 25 duplicated lines.

`test/naming.test.ts` fails if `/popup` is ever registered here again.

## The Popup Window
`popup/session-list-popup` in this repo, installed to
`~/.local/bin/session-list-popup` as a **symlink** (`npm run install:popup`).
The repo copy is the source of truth; edit it there, not in `~/.local/bin`.
A GTK3 script that reads and writes the same database directly. Above the list
are three sort buttons — **Name**, **Start date** (`time_created`),
**Last modified** (`time_updated`) — and a search box. Both date orders are
newest-first, and both columns were already selected by the store. **The window
opens on Last modified**, from `DEFAULT_SORT`; Name is one click away, which is
the right way round — "what did I work on lately" is what most sessions are
opened to answer, and "what was it called" is a question you already know the
answer to. Right-click a row to open its strip:

| Button | Does |
|--------|------|
| Archive / Restore | The primary action; refused on the session you are working in |
| Copy id | The session id, for handing to the CLI |
| Transcript.md | Full transcript to `~/Downloads/<title>.md` |
| Export .json | `opencode session export` output to `~/Downloads/<title>.json`, importable |
| Delete | Removes the session, after a dialog defaulting to Cancel |
| Close | Nothing at all — backs out of the strip without writing |

**Two view controls sit above the list: three sort buttons and a search box.**
`Name` / `Start date` / `Last modified` are radio buttons in one group, and the
box filters as you type. Both apply to unarchived and archived rows alike,
because "the session I want to revisit" is archived as often as not.

- **The search box is a `Gtk.SearchEntry`, and its signal is `search-changed`,
  not `changed`.** SearchEntry debounces on a ~150ms timer, which is the point:
  rapid typing coalesces into one rebuild instead of one per keystroke. The
  cost is that `search-changed` does **not** fire from `set_text()` — so any
  test that sets the box without running the main loop sees a window with no
  filter on it, and every check after it passes for the wrong reason. That is
  not hypothetical; it is what the first run of this block did. `settle()` in
  `test-popup-gui.py` pumps the main loop until `win.query` catches up, and
  every filter check goes through it.
- **The filter and the sort are read off `self` in `reload()`, not passed in.**
  `reload()` runs after every archive, restore and delete, so passing them as
  arguments would mean a write threw away the search you had just typed — and
  left the row you acted on as the only one on screen.
- **Words are ANDed, not ORed.** Typing a second word narrows the list.
  Alternating makes the list *grow* as you type, which is what makes people
  distrust a search box.
- **The search covers title, id and directory.** The window lists every session
  on the machine, so most rows are not in the folder you are sitting in, and
  the id is what arrives in a terminal.
- **A no-match message is marked `is_section`.** A bare widget added to a
  `Gtk.ListBox` is wrapped in a `ListBoxRow` of its own, and an unmarked row is
  a *session* to everything downstream — it lands in the totals, and
  right-clicking it opens a strip for a session that does not exist. Same trap
  `_section()` documents; the empty state is wrapped explicitly for the same
  reason.
- **Esc in the search box clears it; it does not close the window.** A second
  Esc still closes, and a row's strip still takes the first one. `on_key`
  checks the box's contents before falling through to the row and window logic.
- Neither control is remembered between launches: the window opens on
  `DEFAULT_SORT` (last modified) with an empty box. State on disk for two
  preferences is more machinery than the two preferences are worth.
- **`DEFAULT_SORT` is read by the window *and* by `plain_text()`, which are the
  same program.** `test-popup-gui.py` checks `--copy` against the window's own
  order, so the two cannot drift.
- **`/list_sessions --text` matches the window's order, and is a separate copy
  of the rule.** It is `inventory()` / `byRecency()` in index.ts, TypeScript,
  and the popup is Python — so there is no constant to share, the same way
  `windowCommand()` is duplicated across the two repos rather than imported.
  The two are held together by tests instead: `menu.test.ts` asserts recency
  in both sections, and asserts the rows are **not** alphabetical.
- **`menu.test.ts`'s shared fixture cannot catch a name sort.** Its unarchived
  pair is Alpha 5000 / Beta 4000, which is alphabetical *and* newest-first at
  once, so a listing sorted by title passed that test unchanged. The fixture is
  left alone and the discriminating rows are hand-built in
  "does not fall back to alphabetical order". Worth remembering before trusting
  that fixture to prove anything about order.

**Transcript.md extracts images.** A pasted screenshot is ~200KB of base64 PNG
stored inline in the message's `files` list — not in a `part` row — so a reader
that only looks at `text` drops every image with no trace. That is what happened:
a transcript of a session with four screenshots in it contained none of them.
Each image is now decoded to `<title>-images/NNN-name.png` beside the .md and
referenced relatively, which is what makes it render. Capped at `MAX_IMAGES`
(50), and the `--text` callers get a visible placeholder instead of a file, so
something is always noted when something was there.

Hyprland floats and centres it via a rule in `~/.config/hypr/looknfeel.lua`.
**Do not add `pin = true` to that rule**: pinning means "show on all
workspaces", so the popup followed the user onto every workspace.

**"The session you are working in" arrives as `--current`, and that is the only
reliable source for it.** The window used to infer it from `time_suspended`,
which OpenCode writes and this plugin does not control — a guess, and a guess
that decides a safety rule. `is_live` gates three things: the Archive button's
sensitivity, `set_archived`'s refusal, and `delete_session`'s. All three were
derived from the same timestamp, so when the guess was wrong the window disabled
Archive on some *other* row, left it enabled on the session the user was
standing in, and the write path agreed — because it was the same wrong answer.
That is a live Archive button on the live session, which is exactly the accident
the rule exists to prevent.

`execute: async ({ sessionID })` already had the answer in hand and passed it
only to `say()`. It now goes to the window as `--current <id>`, and
`Store.current` is authoritative: `list()` marks it and `_is_live()` refuses it
without consulting the timestamp at all. The `time_suspended` heuristic remains
as the fallback for a bare hand-run `session-list-popup`, where there is no
caller to ask.

The refusal checks `--current` **before** asking whether the schema has
`time_suspended`, so a database without that column still refuses to archive the
session it was opened from.

`Store.current` is normalised with `or None` in `__init__`. It has two readers
and they disagreed about an empty string: `list()` asked `if not live_id`,
`_is_live()` asked `is not None`. An empty `--current` satisfied one and not the
other, so the window marked a row `THIS SESSION` while the write path refused
nothing — the button claimed a row could not be archived that it would have
archived. Collapsing it at the boundary means every input has one meaning for
both readers.

The test asserts an empty `--current` behaves **identically to no `--current`**,
comparing it against a bare `Store` rather than a fixed expectation. The block
above it deliberately stamps a `time_suspended`, so falling back to that
heuristic is correct and "marks nothing" would be the wrong assertion.

`test-popup-writes.py` asserts this by pointing `time_suspended` at the *wrong*
session and requiring `--current` to win — both in `list()` and in `_is_live()`.
Reverting either branch fails 6 checks, so the test is not vacuous.

Five things about it that are easy to get wrong:

- **The desktop app's session menu cannot be refreshed from here.** It caches
  its list and no event re-fetches it. A rename-based resync through the
  server's API was tried and verified twice against the running server: the
  server accepted it and the client never applied it. The window states the
  restart requirement in its own banner instead.
- **Do not reconnect `focus-in-event` to `reload()`.** `reload()` ends in
  `show_all()`, which can shift focus, which fires `focus-in-event` again. That
  feedback loop showed as continuous blinking. `_on_focus_in` is now a no-op
  and `test-popup-gui.py` asserts 20 focus-ins cause zero reloads.
- **Do not set `halign` on the button `Gtk.FlowBox`.** `halign` on a FlowBox
  means "don't expand me", and a FlowBox asked for its natural width computes a
  single column — six buttons stacked one per line, the last one below the fold.
  `child-alignment`, which is what actually expresses "right-align the
  children", is absent from this PyGObject binding and raises AttributeError.
- **`Export .json` shells out to the CLI rather than building the payload.** The
  import format is the CLI's to define and has changed between releases; a
  hand-assembled payload one field out imports to an empty session, which is
  worse than no export because it looks like it worked.
- **`delete_session()` checks its refusals before taking a snapshot.** Snapshot
  first meant every refused delete consumed one of the three retained backups,
  so three refusals evicted the very snapshot holding a real deletion.

### Popup tests
`popup/test-popup-{gui,writes,lifecycle}.py`, run by `npm test` (or
`npm run test:popup`). They default to testing the repo copy; set
`SESSION_POPUP` to point at an installed build instead.

They work on `VACUUM INTO` copies and assert the real database is unchanged.
Never point them at the real one. The GUI suite needs a display — it was
written for a Wayland session, so `WAYLAND_DISPLAY` must be set.

Two lessons from writing them, each of which cost a false failure:

- **Compare headings by their first word.** A check that restated the full
  heading sentence broke on any copy edit to wording it was not testing.
- **Never compare the window against the database mid-sequence.** Some blocks
  deliberately write to the database without reloading, so the window is stale
  on purpose. Reload first, then compare, or you are testing staleness.

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
| `test/menu.test.ts` | 27 | Numbered menus, prompt parsing, inventory rendering, picking by number |
| `test/markdown.test.ts` | 13 | `messageText`, `slug`, `toMarkdown` |
| `test/resolve.test.ts` | 9 | Store-backed resolver — the async form of `__resolve` |
| `test/namespacing.test.ts` | 5 | Guards tool namespacing / core-tool collisions |
| `test/naming.test.ts` | 4 | User-facing text names only registered commands |
| `test/range.test.ts` | 6 | Out-of-range numbers refused, not reinterpreted |
| `test/sessionlog.test.ts` | 7 | The running log appends, and trims to the cap |
| `test/status.test.ts` | 15 | `/list_sessions` reports are framed as status, not requests — the agent-loop guard |
| `test/retention.test.ts` | 4 | Bounded backup snapshots |
| `popup/test-popup-gui.py` | 138 | Widgets, buttons, strips, sort orders, search box, layout, delete dialog, export plumbing |
| `popup/test-popup-writes.py` | 60 | The write path: archive/restore guards, `--current` over the timestamp, delete, backups, ordering, images |
| `popup/test-popup-lifecycle.py` | 6 | Closing the window ends the process; no orphans |
| `popup/test-popup-scroll.py` | 6 | Many sessions stay reachable; the scrollbar is real |
| `popup/test-info-window.py` | 16 | Text sizing, the size preference, its fallbacks |
| `popup/test-info-save.py` | 23 | Save naming, timestamp collisions, markdown vs text output |
| `popup/test-copy-gesture.py` | 8 | Select-then-Ctrl+C survives the window closing |

Fixtures: each TypeScript test file builds its own throwaway DB in a temp dir
via the `OPENCODE_DB` env var. Run with `node --test test/` — no compilation
needed. The popup suites are Python and build their own copies with
`VACUUM INTO`; see "Popup tests" above.

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
**clicking a plugin command in the palette does nothing.**

**It is still VISIBLE there.** This was wrong in an earlier revision of this
file, which said the command was absent from the palette and sent a reader
looking for something missing. It is not missing. The client fetches
`GET /api/command` (`command.list`, *"Retrieve currently registered commands"*)
and receives a `command.updated` event when the set changes — so every plugin
command appears, listed and clickable-looking. Only the *execute* path is
enum-gated. Verified against `app.asar` on this build: the palette fetches the
list, the union of 18 literals is compiled into the renderer.

That is worse than invisible, and it explains the intermittent case below:
if the autocomplete dropdown is still open when Enter is pressed, the click path
runs, `tui.command.execute` is sent with a name the schema rejects, and nothing
happens — while typing the same name works.

Patching the enum is possible (`app.asar` is a file on disk) but it is
root-owned, replaced on every OpenCode update, and the receiving handler may
carry a second gate. Not worth it for one click.
must be typed. A plugin cannot register into the enum.

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

## The Palette Line Is Where A Removed Command Gets Advertised
`/archive_Put`, `/archive_Pull` and `/save` are gone, and their jobs are buttons
in the popup window. **A command that no longer exists has no way to tell the
person who used to type it where its job went** — so the one line they still see
for `/list_sessions` has to carry it:

```
Archive, Restore, Transcript.md, Export .json, Delete — right-click a row, nothing to type
```

It was 161 chars of layout ("Open the session popup window — unarchived first,
then archived, with … on each row"), which is what the window's own banner is
for, and which described a window instead of advertising what can be done in it.

Two constraints, because the palette truncates and the **front** is what
survives: the actions come first, and the line is ≤110 chars.
`test/status.test.ts` asserts both, plus that every action is named, that
"nothing to type" is present, and that no layout phrase crept back in.

`LIST_SESSIONS_DESCRIPTION` is a module constant rather than an inline literal so
`status.test.ts` can assert on it — the same reasoning as the report builders.

**Stale text is the predictable failure here, so the sort tooltip is checked
against the constant.** The flip to newest-first (`5758b7c`) changed
`DEFAULT_SORT` and left four sentences asserting the old behaviour: the sort
tooltip ("resets to Name"), `reload()`'s docstring ("Name is the default sort,
and stays it"), `_on_search_changed`'s ("No debounce" — written against
`changed`, and `search-changed` debounces by design), and `DEFAULT_SORT`'s own
comment, which still described `inventory()` as alphabetical after `895523f`
flipped that too.

`DEFAULT_SORT_LABEL` exists so the tooltip **derives** the name instead of
repeating it, and `test-popup-gui.py` checks every tooltip against it. Four
sentences went stale together because none of them read the constant; the ones
that do now cannot.

The dead `total_working` / `total_archived` locals went in the same pass. They
were computed under a comment explaining a mechanism, and the mechanism was
actually `len(shown) != len(data)`.

## Wording Is Tested Too, Not Just Behaviour
A footer reading "copy an id into `/archive_Put`, `/archive_Pull` or `/session`"
survived three commits after `/session` was removed, because every other test
asserts behaviour rather than text. It reached a working install and was caught
by a person reading the output.

`test/naming.test.ts` now reads index.ts, strips comments, and asserts every
backticked `/name` in user-facing text is a registered command. Comments are
excluded deliberately — they discuss removed commands and explain why, which is
history worth keeping but is not text a user reads.

Watch for the trap it walks into: `archive` and `unarchive` are removed
*commands* but live *tools* under `session_archive`. Separate registries, so
their presence says nothing about the command of the same name.

## A Synthetic Message Is A **User** Message — So Every Report Is Framed
`ctx.session.synthetic()` posts a **user** message. OpenCode's own plugin API
says so: the compaction autocontinue hook in `@opencode-ai/plugin` documents
"the synthetic user `continue` turn". The agent therefore reads a command's
output as something it was **asked to do**, not as something that happened.

That is invisible until a report describes something outside the conversation.
`/list_sessions` ended with "Right-click a session there to get its buttons:
Archive or Restore, Transcript.md, …" — and a fresh session's agent took that as
a task. It went looking for the popup window, and because **re-running the
command posts the same note again**, every attempt fed the next one. Observed as
an agent stuck in a loop on a command whose only job is to open a window.

So both branches now go through `statusNote()`, which leads with
`**Status — no action needed.**` and says plainly: not a request, reply to
nothing, run nothing, do not go looking for the session window. The window's
contents are described rather than instructed — "The user drives it with the
mouse" instead of "Right-click a session there" — because that sentence was
the trigger, and an unattributed imperative reads as a task no matter what
precedes it.

The failure branch needs the guard at least as much, and for a sharper reason:
**"could not open the window, here is why" is a message an agent tries to
*fix*** — install the missing binary, retry the launch — and the retry reports
failure again. The reason is still reported, because a person may want it.

**This is a text guard, not a mechanism.** There is no flag: a plugin cannot
post into a session without the model seeing it, and `TextPart` does carry an
`ignored` field but the plugin's `session.synthetic({sessionID, text})` wrapper
does not expose it. So the wording *is* the fix, which is why
`test/status.test.ts` asserts the guard sentences rather than the behaviour —
nothing else would catch a rewording. It also asserts the two branches are
actually **wired** to the builders, because a guarded helper nobody calls is not
a fix.

## Command Output Goes to Two Channels
Every command writes to `~/.local/share/opencode/session-log/<timestamp>.md`
**and** posts a synthetic message. Override with `OPENCODE_SESSION_LOG_DIR`.

Both channels get the same string, guard included, so they cannot drift. The
guard reads in the log as what it is — a note the command left behind.

**Corrected 2026-10-16.** This file previously claimed the desktop app "does not
reliably render synthetic messages", and treated the file as the load-bearing
channel. That was wrong, and it was wrong by repetition rather than evidence —
the claim came from an older note and got copied into the source comment, the
README and here without anyone re-testing it.

Tested on v2.0.24 against the desktop app: **every command rendered on screen**,
including both writes. `/list_sessions`, `/archive_Put` bare, `/archive_Put 3`
and `/archive_Pull 1` all displayed. So synthetic output is the normal case.

The file stays, because it is nearly free and a channel this plugin does not
control is worth not depending on. But it is insurance, not the primary path,
and should not be documented as though the primary path were broken.

Written first and synchronously, so if the synthetic call throws the output is
already on disk.

`latest.md` is **appended**, keeping the 20 most recent reports, and watched
with `tail -n +1 -F`. It was originally rewritten from scratch each run, which
showed the current report but left a follower nothing to scroll — the file was
always one report long, so the pane redrew in place. Two bugs in the trim are
worth not reintroducing: trimming to the cap and *then* appending leaves cap + 1,
and splitting on the report marker leaves an empty leading chunk that consumes a
slot if you filter after slicing rather than before.

`-n +1` matters as much as `-F`: plain `tail -f` prints only the last ten lines,
which on a 14-line report hides the header.

**Write `latest.md` in place. Do not use temp-file-plus-rename.** Renaming
replaces the inode, and a `tail` holding the original inode then follows a file
nothing writes to any more — the log grows correctly while the pane sits frozen.
That bug shipped, and no test caught it: the session-log tests assert order, the
cap, and that reports are never split, all of which hold under rename. Only a
live follower exposes it, because the failure belongs to the writer-reader
relationship rather than the writer.

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
1. `npm test` (plugin suite + popup suites) and `npm run check`
2. Start a throwaway server: `(setsid opencode serve --port NNNN > log 2>&1 < /dev/null &)`
   with `opencode.json` in the server's resolved project root.
3. Password comes from the `server password …` line in the log; all calls use
   basic auth `opencode:$PW`.
4. Confirm load: `GET /api/plugin` → `source.type == "local"`.
5. Confirm commands: `GET /api/command` → expect
   `list_sessions, popup` alongside `init, review`.
6. Confirm no shadowing: prompt a session to use the **core** `read` tool and
   check it still reads a file.
7. Confirm function: flip `time_archived` in `session_v2` via `/archive_Put`
   and `/archive_Pull`; write a Markdown file via the popup's Transcript.md.
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
test/naming.test.ts       # Text must not name a command that no longer exists
test/range.test.ts        # Out-of-range numbers refused, not reinterpreted
test/sessionlog.test.ts   # The running output log appends and trims
test/status.test.ts       # Reports framed as status — the agent-loop guard
test/retention.test.ts    # Bounded backups
popup/session-list-popup  # The GTK window — source of truth, symlinked into ~/.local/bin
popup/test-popup-gui.py   # Widgets, strips, layout, delete dialog, export
popup/test-popup-writes.py    # Write path: guards, delete, backups, ordering, images
popup/test-popup-lifecycle.py  # Closing ends the process; no orphans
popup/test-popup-scroll.py     # Many sessions stay reachable; the scrollbar is real
probe.ts                  # Headless driver — run commands, capture to a file
package.json           # main: "./index.ts", exports: ".": "./index.ts"
tsconfig.json          # noEmit, strict, include: src/** test/**
```

Test-only exports from `index.ts`: `__resolve`, `__menu`, `__pickByNumber`,
`__inventory`, `__parseArgs`, plus `slug` / `toMarkdown` / `ArchiveError`.

## Environment
- Default DB: `~/.local/share/opencode/opencode.db` (or `XDG_DATA_HOME/opencode/opencode.db`)
- Override with `OPENCODE_DB` env var (used by tests)
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

With the npm package loaded, expect exactly `['init', 'review', 'list_sessions',
'popup']`. Any
`list_sessions`, `archive_Put` or `archive_Pull` in that output means a local
checkout is live.
