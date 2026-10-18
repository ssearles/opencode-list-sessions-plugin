# opencode-archive-session

Archive, list, read and restore OpenCode sessions — including sessions
OpenCode itself can no longer bring back.

Forked from
[`opencode-session-transcript`](https://github.com/ssearles/opencode-session-transcript),
which had dropped archiving when it pivoted to Markdown export. That work is
restored here, and a session window ships alongside it rather than instead of it.

## Why this exists

**Archiving is one-way.** OpenCode's API ignores `time_archived` changes, so an
archived session cannot be restored through it. This plugin writes directly to
SQLite, and is the only way back.

**Export truncates.** The TUI `/export` writes only the messages currently loaded
in the window
([#50732](https://github.com/anomalyco/opencode/issues/50732),
[#50014](https://github.com/anomalyco/opencode/issues/50014)) — nothing warns you,
so the file looks complete. The window's **Transcript.md** button reads every
message for the session straight out of SQLite, and also writes out any
screenshots pasted into the conversation.

> **Not a backup.** `/export` writes JSON, which `opencode import` can read back.
> Markdown cannot be re-imported, and it drops assistant reasoning to do it. If
> you want a restorable archive, keep using `/export`, or the window's
> **Export.json** button, which produces the same importable format.

## Install

**Not published to npm** — the name below does not resolve. Point the config at
a checkout instead:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-archive-session"]
}
```

The **entry point must be at the package root.** OpenCode resolves local
plugins but does not honour `main` or `exports` pointing into a subdirectory,
so `index.ts` lives at `/` and `src/db.ts` and `src/markdown.ts` are internal.

Zero runtime dependencies. It declares `@opencode/plugin` as an *optional*
peerDependency and never imports it — the types are local and structural, so
the plugin loads under Bun, Node 22+, or neither.

The SQLite driver is whichever the host provides: `bun:sqlite` under Bun,
`node:sqlite` under Node 22+. The schema is discovered, not assumed — it finds
`session_v2` or `session` and introspects the columns.

**Editing `index.ts` reloads the plugin on every save**, and each reload
re-registers every command, which visibly re-renders the palette. Commit before
testing a batch of edits.

## Commands

| Command | Effect |
| --- | --- |
| `/list_sessions` | Opens the session popup window |

**`/archive_Put`, `/archive_Pull` and `/save` were removed.** Archiving,
restoring, deleting, transcripts and JSON export are all buttons in the popup
window now, because they are click targets rather than things worth typing.
The `session_archive` tools below are unchanged — archive and restore are still
agent-callable.

## Stats

Two **read-only** reports, both in their own window. Neither writes anything.

| Where | Button | Reports |
| --- | --- | --- |
| Any session row | **Stats** | That session alone: size, cost, tokens, activity, models, tools, and every file it touched |
| The window's footer | **Database** | The whole store, plus the machine: sessions, messages, cost, largest sessions, and this machine's environment |

Sections are foldable and folded by default when long, so a report is not a
scrollbar of file paths. **Copy** puts the whole report — folded sections
included — on the clipboard.

### Getting to a session's buttons

**Click a row.** Rows light up under the mouse so it is clear they are
clickable; the right mouse button works too, but a left click is the one that
opens and closes the strip.

### Text size

**A-**, **A+** and **Reset size** in the footer, also `Ctrl+minus`,
`Ctrl+plus` and `Ctrl+0`. Same controls as the `/popup` info window, and the
size is remembered at `~/.config/session-list-popup/font-size` so the next
window starts there. Both report windows honour it.

`Database` also carries the machine, because "why is this slow on this laptop"
is a question the per-session figures cannot answer:

```
machine                LENOVO Lenovo ideapad FLEX 4-1470
                       notebook   type 80SA   bios 0VCN22WW(V1.06)
cpu                    Intel(R) Pentium(R) CPU 4405U @ 2.10GHz
                       2 cores / 4 threads   2.10 GHz   cache 2048 KB
memory                 3,760 MB total   1,342 MB available   swap 11,383 MB
usb ports, at the speed they actually negotiated:
  2-2     5,000 Mbps  USB 3.0 / 3.2 Gen1  USB 3.2.1 FD  →  sdb1 at /run/media/...
```

Two figures there are worth knowing are honest: **core count is physical, not
logical** (`os.cpu_count()` returns hyperthreads and would report this 2-core
chip as 4), and **USB speed is what the port negotiated**, not what the device
advertises. A drive on a 480 Mbps port is a dozen times slower than the same
drive on a 5 Gbps one, and nothing else in the report tells them apart.

Serial numbers and UUIDs are deliberately not collected.

### Files touched

Grouped by **directory on its own line, in full**, with filenames indented
beneath it and **every** file listed. The earlier form — one truncated path per
line — was unreadable, because `_short` keeps the tail, so the part naming which
project it was got eaten and two rows both reading `…fault Project/` were
indistinguishable.

### Why `/list_sessions` has no numbers

It used to. Two write commands printed numbered menus — `/archive_Put` over
working sessions, `/archive_Pull` over archived — and `/list_sessions` stayed
unnumbered because a single shared numbering would match neither menu once
either group changed size.

**Both commands are gone.** Archiving, restoring, deleting, transcripts and JSON
export are buttons in the popup window now, because they are click targets
rather than things worth typing. With every action being a click, a number in
front of a row became a position the reader had to hold in their head and had
no way to use — and one that archiving immediately invalidated, since the
session jumps sections.

So `/list_sessions` shows everything, newest-first, unarchived then archived,
with **each session's full id printed under its title**. That id is what the
`session_archive` tools take, so it is the one piece of information that has to
be readable rather than clickable.

The ambiguity and out-of-range rules that used to govern typed arguments moved
with the commands. The tools now take explicit ids, and resolve nothing on your
behalf — an agent that passes `ses_abc123` gets that session or an error, never
a nearby one.

### Transcripts

`/save` is gone — the popup window's **Transcript.md** button does it, and does
it better. It writes `~/Downloads/<session title>.md` and decodes the ~200KB
base64 blobs of pasted screenshots into real PNGs beside the file, which
`/save` never did. `OPENCODE_TRANSCRIPT_DIR` went with the command.

## Where the output goes

Commands report on two channels: a synthetic message in the session, and a file
under `~/.local/share/opencode/session-log/`, one per run, timestamped.

Output normally appears in the session, and the file is a backup for when it
doesn't. Both receive identical text. To watch output live in a second
terminal:

```sh
tail -n +1 -F ~/.local/share/opencode/session-log/latest.md
```

`-n +1` prints from the first line, so you see a whole report rather than just
its last ten. `-F` (capital) keeps following across the rewrite.

`latest.md` is a running log of the last 20 reports, so the pane scrolls as
commands run. The timestamped files beside it are the unbounded per-run history.
Override the directory with `OPENCODE_SESSION_LOG_DIR`.

## Tools (agent-callable)

Namespaced `session_archive.*`, so they cannot shadow a core tool:

| Tool | Purpose |
| --- | --- |
| `list_sessions` | List working sessions (shares its name with the `/list_sessions` command — different namespaces, no collision) |
| `list_archived` | List archived sessions, optional `search` |
| `archive` | Archive by `session_ids[]` |
| `read_transcript` | Read a transcript by id or search |
| `unarchive` | Restore by `session_ids[]` |

## Safety

- `/list_sessions`, the **Stats** and **Database** reports, and transcript
  reading are **read-only**.
- Archiving, restoring and deleting **do** write — from the popup window, and
  agent-callably through the `session_archive` tools. They take a `VACUUM INTO`
  snapshot first, which is consistent while OpenCode holds the database open in
  WAL mode. They only ever set `time_archived` and `time_updated` — never a
  message. The three most recent snapshots are kept and older ones pruned.
- The window refuses to archive or delete the session it was opened from, which
  arrives as `--current` and is authoritative over the `time_suspended`
  timestamp.
- Schema-agnostic: discovers `session_v2` (v2.x) or `session` (v1.x) and
  introspects its columns rather than hardcoding either.

## Commands are type-only

The desktop command palette dispatches through a fixed enum of built-in names.
No plugin command appears in it, so **these must be typed** — clicking one in the
palette does nothing. A missing command from the palette is not a bug in it.

## Development

```bash
npm test              # 158 plugin tests + 428 popup checks
npm run test:plugin   # the TypeScript suite alone
npm run test:popup    # the popup suites alone (needs WAYLAND_DISPLAY)
npm run install:popup # symlink ~/.local/bin/session-list-popup at the repo copy
npm run check         # confirms index.ts and src/db.ts load
npm run typecheck     # requires TypeScript
```

No install step and no dependencies — the TypeScript tests build throwaway
databases in **both** schemas and run the shared suite against each, so v1 and
v2 support are exercised rather than assumed.

The popup suites are Python. They work on `VACUUM INTO` copies and assert the
real database is unchanged, so they are safe to run against your own data.
**Never point them at the live database.** They default to the repo copy; set
`SESSION_POPUP` to test an installed build instead. The GUI suite needs a
display — it was written for Wayland, so `WAYLAND_DISPLAY` must be set.

The repo copy is the source of truth for the window. Edit
`popup/session-list-popup`, never the copy in `~/.local/bin`.

See [AGENTS.md](AGENTS.md) for the architecture notes, the resolver contract, and
the traps that have already cost time here.

## Licence

MIT
