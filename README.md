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

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-archive-session"]
}
```

Or point at a local checkout:

```json
{ "plugins": ["/absolute/path/to/opencode-archive-session"] }
```

No dependencies are installed at runtime. The plugin uses whichever SQLite
driver the host provides (`bun:sqlite` under Bun, `node:sqlite` under Node 22+).

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

### Numbered menus, and why `/list_sessions` has no numbers

`/list_sessions` shows **everything** on one screen — working sessions first,
then archived — with each session's full id on its own line so it can be selected
and pasted straight into another command. It is deliberately **unnumbered**.

The numbers live in the two write commands instead. Run either with no argument
and it prints a numbered menu over the half it acts on:

```
/archive_Put        →  Current sessions
                       1. Diagnosing 2TB external drive
                       2. Fix missing scroll bar in Okular
/archive_Put 2      →  Archived 1 session(s).

/archive_Pull       →  Archived sessions
                       1. ZZ fix verify
/archive_Pull 1     →  Restored 1 session(s).
```

The two menus count **disjoint halves** of the database — `/archive_Put` is
scoped to `time_archived IS NULL`, `/archive_Pull` to `IS NOT NULL`. Number 3
means "third current session" in one and "third archived session" in the other.
They can never collide, because the row sets do not overlap.

That is exactly why `/list_sessions` carries no numbers: a single shared
numbering would match neither menu once either group changed size.

A number is only valid against the menu you were just shown. Archiving or
restoring something in between shifts the positions, so a number that worked a
moment ago can fall out of range. An out-of-range number is **refused, never
reinterpreted** — `/archive_Put 99` does not fall through to a title search, so
it can never archive a session whose title merely contains "99". Re-run the
command with no argument to see the current menu.

Passing no argument prints the menu rather than acting, because opening a command
is never a request to archive the session you are currently in.

An ambiguous term resolves to **nothing** rather than guessing: a title fragment
matching two sessions asks you to be more specific instead of picking one. This
matters more for `/archive_Pull`, which is a write.

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
npm test          # node --test test/, no install required
npm run check     # confirms index.ts and src/db.ts load
npm run typecheck # requires TypeScript
```

The test suite builds throwaway databases in **both** schemas and runs the shared
suite against each, so v1 and v2 support are exercised rather than assumed.

See [AGENTS.md](AGENTS.md) for the architecture notes, the resolver contract, and
the traps that have already cost time here.

## Licence

MIT
