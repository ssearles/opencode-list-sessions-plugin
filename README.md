# opencode-archive-session

Archive, list, read, save and restore OpenCode sessions — including sessions
OpenCode itself can no longer bring back.

Forked from
[`opencode-session-transcript`](https://github.com/ssearles/opencode-session-transcript),
which had dropped archiving when it pivoted to Markdown export. That work is
restored here, and `/save` ships alongside it rather than instead of it.

## Why this exists

**Archiving is one-way.** OpenCode's API ignores `time_archived` changes, so an
archived session cannot be restored through it. This plugin writes directly to
SQLite, and is the only way back.

**Export truncates.** The TUI `/export` writes only the messages currently loaded
in the window
([#50732](https://github.com/anomalyco/opencode/issues/50732),
[#50014](https://github.com/anomalyco/opencode/issues/50014)) — nothing warns you,
so the file looks complete. `/save` reads every message for the session straight
out of SQLite.

> **Not a backup.** `/export` writes JSON, which `opencode import` can read back.
> `/save` writes Markdown, which cannot be re-imported, and it drops assistant
> reasoning to do it. If you want a restorable archive, keep using `/export`.

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
| `/list_sessions` | List every session — working first, then archived |
| `/archive_Put [num \| id \| title]` | Archive a current session |
| `/archive_Pull [num \| id \| title]` | Restore an archived session |
| `/session <num \| id \| title>` | Print a transcript, archived included |
| `/save [path.md]` | Write the session to Markdown |

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
restoring something in between shifts the positions, so if a number suddenly
refuses to match, re-run the command with no argument first.

Passing no argument prints the menu rather than acting, because opening a command
is never a request to archive the session you are currently in.

An ambiguous term resolves to **nothing** rather than guessing: a title fragment
matching two sessions asks you to be more specific instead of picking one. This
matters more for `/archive_Pull`, which is a write.

### `/save`

Output defaults to `~/Documents/<session title>.md`, named from the session's own
title read at run time. Set `OPENCODE_TRANSCRIPT_DIR` to change the folder.

```
/save                  →  ~/Documents/archiving-older-ai-conversations.md
/save ~/Desktop/today.md
```

Filenames come from the title, so two sessions sharing a title will overwrite
each other — pass an explicit path to keep both.

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

- `/save`, `/list_sessions` and `/session` are **read-only**.
- `/archive_Put` and `/archive_Pull` **do** write, and take a `VACUUM INTO`
  snapshot first, which is consistent while OpenCode holds the database open in
  WAL mode. They only ever set `time_archived` and `time_updated` — never a
  message. The three most recent snapshots are kept and older ones pruned.
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
