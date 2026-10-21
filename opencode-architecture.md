# OpenCode architecture

How the pieces fit together on a machine running OpenCode
with this plugin. Paths are the conventional ones.

This file is the generic diagram that ships with the repo. A
machine-specific one overrides it: put an
opencode-architecture.md in ~/Documents/Default Project (the
Omarchy workspace) or in ~/Documents, and the Architecture
button shows that instead. The search order is workspace,
~/Documents, working directory, then this checkout.

```
┌──────────────────────────────────────────────────────────┐
│ Hyprland  (Wayland compositor)                           │
│   rule: session-list-popup → float + center              │
└──────────────────────────────────────────────────────────┘
                             │
          ┌──────────────────┴──────────────────┐
          ▼                                     ▼
┌────────────────────┐                ┌────────────────────┐
│ OpenCode Desktop   │                │ Terminal TUI       │
│ Electron shell     │                │ opencode CLI       │
│ bundled CLI        │                │ ~/.opencode/bin    │
└────────────────────┘                └────────────────────┘
          │                                     │
          └──────────────────┬──────────────────┘
                             ▼
┌──────────────────────────────────────────────────────────┐
│ OpenCode server: opencode-cli serve                      │
│   127.0.0.1:<port>  sessions, config,                    │
│   providers, permissions, tool execution                 │
│                                                          │
│   plugin host: opencode-list-sessions-plugin             │
│     /list_sessions, session_archive.*                    │
└──────────────────────────────────────────────────────────┘
                             │ spawns (detached)
                             ▼
┌──────────────────────────────────────────────────────────┐
│ Python 3 + GTK3: session-list-popup                      │
│   Archive / Restore / Stats / Database                   │
│   reads SQLite directly (writes only time_archived)      │
└──────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ ~/.local/share/opencode/opencode.db   (SQLite, WAL)      │
└──────────────────────────────────────────────────────────┘
```

- The desktop app and the terminal TUI both talk to one local server.
- The plugin host runs inside the server: /list_sessions and the
  session_archive.* tools are registered there.
- The popup is a separate Python/GTK3 process. It reads the SQLite store
  directly and writes exactly one column, time_archived, because the API
  cannot restore an archived session.
- The provider is reached over HTTPS by the server, never by the popup.

Where things live:

```
CLI              ~/.opencode/bin/opencode
Config           ~/.config/opencode/opencode.json
Plugin checkout  checkout added to "plugin" in that config
Popup launcher   ~/.local/bin/session-list-popup -> repo popup/
Database         ~/.local/share/opencode/opencode.db
Reports          ~/.local/share/opencode/session-log/
Transcripts      ~/Downloads/<title>.md (+ <title>-images/)
```
