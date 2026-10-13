# opencode-session-archive

Archive, list, **read**, and restore OpenCode sessions — including sessions
OpenCode itself can no longer bring back.

## The problem

OpenCode can archive a session, but there is no supported way to un-archive one:

- The HTTP API ignores changes to `time_archived`. `PATCH /api/session/{id}`
  with `{"time":{"archived":null}}` returns `204` and does nothing.
- The CLI offers only `session list`, `export`, `import`, and `delete`.
- Archived sessions are not offered anywhere in the UI, and global session
  search is not scoped by directory, so they still show up in searches.

Net effect: **archiving is effectively one-way.** If you archive something by
mistake there is no supported recovery, which is why several people have asked
for this upstream ([#24153], [#6680]).

This plugin closes that gap.

## Install

Add it to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-session-archive"]
}
```

Or point at a local checkout, which is how you run it from source:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-session-archive"] }
```

Then restart OpenCode. No dependencies are installed at runtime; the plugin
uses whichever SQLite driver the host provides (`bun:sqlite` under Bun,
`node:sqlite` under Node 22+).

## Commands

These appear in the TUI prompt and in the desktop command palette.

| Command | What it does |
| --- | --- |
| `/list` | Every session — working first, then archived — with copyable ids. |
| `/archive` | List open sessions as a numbered menu. |
| `/archive <n \| id \| title>` | Archive that session. |
| `/unarchive` | List archived sessions as a numbered menu. |
| `/unarchive <n \| id \| title>` | Restore that session. |
| `/session` | List all sessions as a numbered menu. |
| `/session <n \| id \| title>` | Print a transcript — archived ones work too. |

Run a command with no argument and it prints a numbered list; run it again
with the number to act. Typing an id or part of a title works too.

OpenCode offers plugins no way to show a real picker — the TUI event bus
carries only `command.execute`, `prompt.append`, `session.select` and
`toast.show`, and a plugin's context exposes `event.subscribe` but no
publish. Numbered menus are the closest equivalent available from a plugin.

```text
/unarchive
**Archived sessions**

1. ses_ee288811cffe4ffi…    499 msg  2026-10-09  Diagnosing 2TB external drive
2. ses_eddd5348bffezT7…    284 msg  2026-10-09  Delete outdated GitHub repositories

Restore one with `/unarchive <number>`, or name it directly.
```

## Tools

The agent can call these directly:

- `session_archive.list_archived` — list, optionally filtered by text
- `session_archive.read_transcript` — read a transcript, archived or not
- `session_archive.archive` — archive by id
- `session_archive.unarchive` — restore by id

Tools are namespaced by passing `options: { namespace: "session_archive" }` on
each one. That is not cosmetic. The host derives a tool's id from
`options.namespace` and falls back to the bare name when it is absent, so a
tool registered without it shares a flat registry with the built-ins and a name
like `read` silently replaces the host's own. Calling `namespace()` on the
editor only records a display description and does not namespace anything.

## Safety

- The database is **never deleted from**. Messages are never touched. Only
  `time_archived` and `time_updated` are written.
- Every write takes a consistent snapshot first, via `VACUUM INTO`, which is
  safe while OpenCode holds the database open in WAL mode. Snapshots land in
  `~/.local/share/opencode/backups/`.
- Writes are transactional and per-session, so one bad id does not abort the
  rest.
- Unknown ids are reported, not thrown.

## How restoring works

Clearing the flag alone is not enough. OpenCode orders sessions by
`time_updated DESC` and pages per directory, so a session archived weeks ago
stays buried below the page limit and still cannot be opened. Restoring
therefore clears `time_archived` **and** refreshes `time_updated`, which
surfaces it at the top of its original project folder.

Because the write happens outside the server, OpenCode emits no `session.updated`
event, so the window needs a reload before the change appears.

## Compatibility

| OpenCode | Status |
| --- | --- |
| v2.x (`session_v2` table) | Supported, tested |
| v1.x (`session` table) | Supported, tested |

The plugin discovers which table exists and introspects its columns rather than
hardcoding either schema.

## Development

```bash
npm test          # node --test, no install required
npm run typecheck # requires typescript
```

The test suite builds throwaway databases in **both** schemas and runs the
entire shared suite against each, so v1 and v2 support is exercised rather than
assumed.

## Licence

MIT

[#24153]: https://github.com/anomalyco/opencode/issues/24153
[#6680]: https://github.com/anomalyco/opencode/issues/6680