# opencode-session-transcript

A correct `/export` for OpenCode, in plugin form.

> **This is a stopgap** for bugs in `/export`
> ([#50732](https://github.com/anomalyco/opencode/issues/50732),
> [#50014](https://github.com/anomalyco/opencode/issues/50014)) that are being
> fixed upstream. Once those land, this should be retired in favour of a
> correct `/export`.

## The problem

OpenCode can export a session, but `/export` has three separate shortcomings:

**It silently truncates.** [#50732](https://github.com/anomalyco/opencode/issues/50732)
and [#50014](https://github.com/anomalyco/opencode/issues/50014) both report
that `/export` writes only the messages currently loaded in the TUI, not the
full transcript. In a long session, early prompts and responses are simply
absent — and nothing warns you, so the file looks complete. This is the worst
possible failure mode for an export tool, because you only find out when you go
looking for something that isn't there.

**It means different things in different clients.**
[#48105](https://github.com/anomalyco/opencode/issues/48105) documents that
`/export` in the TUI produces human-readable Markdown while `opencode export`
on the CLI produces JSON for re-import. The desktop app's `/export` follows the
JSON behaviour, so there is no Markdown export there at all.

**There is no CLI equivalent that reads well.** `opencode session export` gives
you a multi-megabyte JSON file — correct and complete, but not something you
would ever read end to end.

## What this does

One command. It reads every message for the current session straight out of
OpenCode's SQLite store and writes them to a Markdown file you can actually
read.

```
/save
```

```
/home/steven/Documents/archiving-older-ai-conversations.md

835 messages · 234 KB
```

The output is the same conversation you'd expect to read, with tool calls kept
inline and assistant reasoning dropped:

```markdown
# Archiving older AI conversations

**Started:** 2026-10-13 11:43
**Directory:** `/home/steven/Documents/Default Project`
**Session id:** `ses_ec96bff81ffdMzlHLBZmD0r2Nj`

### You · 11:43
can I archive older AI conversations to free up session space...

### Assistant · 11:43
I'll check the OpenCode docs on sessions and CLI settings.

**[tool]** `webfetch` — completed
```

Because it reads the database rather than the UI's loaded window, the output is
complete regardless of how much of the thread you have scrolled.

## Install

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-session-transcript"]
}
```

Or point at a local checkout:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-session-transcript"] }
```

No dependencies are installed at runtime. The plugin uses whichever SQLite
driver the host provides (`bun:sqlite` under Bun, `node:sqlite` under Node 22+).

## Usage

| Command | Effect |
| --- | --- |
| `/save` | Write to `~/Documents/<session title>.md` |
| `/save ~/Desktop/today.md` | Write wherever you say |

Set `OPENCODE_TRANSCRIPT_DIR` to change the default folder.

The filename comes from the session's own title, read at run time. Two sessions
sharing a title will overwrite each other — pass an explicit path to keep both.

## Safety

- **Read-only.** The plugin never writes to OpenCode's database. It only reads
  `session_v2` and `session_message` and writes one Markdown file of its own.
- No archiving, no deletion, no backups, no state. Nothing to undo.
- Schema-agnostic: discovers `session_v2` (v2.x) or `session` (v1.x) and
  introspects its columns rather than hardcoding either.

## Development

```bash
npm test          # node --test, no install required
npm run check     # confirms both modules load
npm run typecheck # requires typescript
```

The test suite builds throwaway databases in **both** schemas and runs the
shared suite against each, so v1 and v2 support is exercised rather than
assumed.

## Upstream

Once `/export` is correct — desktop parity plus the truncation fix — this
plugin should be retired. The goal is for `/export` to work properly, not for
this to become infrastructure anyone depends on.

## Licence

MIT