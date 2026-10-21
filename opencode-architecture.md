# OpenCode on Your Laptop — Interaction Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         YOUR LAPTOP (Linux)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                 │
│  │   HYPRLAND   │     │  TERMINAL    │     │   BROWSER    │                 │
│  │(WM/Composito)│     │   (GNome)    │     │ (for links)  │                 │
│  └──────┬───────┘     └──────┬───────┘     └──────┬───────┘                 │
│         │                    │                    │                         │
│         ▼                    ▼                    │                         │
│  ┌──────────────────────────────────────────────┐ │                         │
│  │           OPENCODE DESKTOP APP               │ │                         │
│  │  (Electron/Tauri wrapper around OpenCode)    │ │                         │
│  │  ┌────────────────────────────────────────┐  │ │                         │
│  │  │          OPENCODE SERVER (Rust)        │  │ │                         │
│  │  │  • HTTP API on 127.0.0.1:49374         │  │ │                         │
│  │  │  • Session management                  │  │ │                         │
│  │  │  • Plugin loading                      │  │ │                         │
│  │  │  • SQLite database (~/.local/share/    │  │ │                         │
│  │  │    opencode/opencode.db)               │  │ │                         │
│  │  └──────────────┬─────────────────────────┘  │ │                         │
│  │                 │                            │ │                         │
│  │  ┌──────────────▼─────────────────────────┐  │ │                         │
│  │  │           PLUGIN HOST (Node.js)        │  │ │                         │
│  │  │  • Loads plugins from opencode.json    │  │ │                         │
│  │  │  • Registers commands & tools          │  │ │                         │
│  │  │                                        │  │ │                         │
│  │  │  ┌─────────────────────────────────┐   │  │ │                         │
│  │  │  │ opencode-archive-session        │   │  │ │                         │
│  │  │  │  • /list_sessions command       │   │  │ │                         │
│  │  │  │  • session_archive tools        │   │  │ │                         │
│  │  │  │  • Spawns session-list-popup    │   │  │ │                         │
│  │  │  └─────────────────────────────────┘   │  │ │                         │
│  │  │                                        │  │ │                         │
│  │  │  ┌─────────────────────────────────┐   │  │ │                         │
│  │  │  │ opencode-popup-window           │   │  │ │                         │
│  │  │  │  • /popup command (no args)     │   │  │ │                         │
│  │  │  │  • Delegates to agent           │   │  │ │                         │
│  │  │  └─────────────────────────────────┘   │  │ │                         │
│  │  └──────────────┬─────────────────────────┘  │ │                         │
│  └─────────────────│────────────────────────────┘ │                         │
│                    │                              │                         │
│         ┌──────────┴──────────┐                   │                         │
│         ▼                     ▼                   │                         │
│  ┌─────────────┐     ┌─────────────┐              │                         │
│  │  GTK WINDOW │     │   AGENT     │              │                         │
│  │  (Python)   │     │ (LLM)       │              │                         │
│  │             │     │             │              │                         │
│  │ session-    │     │ I am here   │              │                         │
│  │ list-popup  │     │ ◄────────── │              │                         │
│  │             │     │   talks to  │              │                         │
│  │ info-window │     │   me via    │              │                         │
│  │             │     │   synthetic │              │                         │
│  └──────┬──────┘     │   messages  │              │                         │
│         │            └──────┬──────┘              │                         │
│         │                   │                     │                         │
│         ▼                   ▼                     │                         │
│  ┌─────────────┐    ┌─────────────┐               │                         │
│  │   YOUR      │    │  OPENCODE   │               │                         │
│  │   MOUSE     │    │   SERVER    │               │                         │
│  │   CLICKS    │    │   (Rust)    │               │                         │
│  └─────────────┘    └─────────────┘               │                         │
│                                                   │                         │
└──────────────────────────────────────────────────-│─────────────────────────┘
                                                    │
                                                    ▼
                                    ┌─────────────────────────────┐
                                    │      LLM PROVIDERS          │
                                    │  • OpenAI (GPT-4o, etc.)    │
                                    │  • Anthropic (Claude)       │
                                    │  • Local (Ollama, llama.cpp)│
                                    │  • OpenCode's own (free)    │
                                    └─────────────────────────────┘
```

## Key Flows

### 1. You Type `/list_sessions`

```
You → Terminal → OpenCode Desktop → Server → Plugin (archive-session)
                                                         ↓
                                                Spawns session-list-popup (GTK)
                                                         ↓
                                                You click row → Archive/Stats/Transcript.md
```

### 2. You Type `/popup`

```
You → Terminal → Server → Plugin (popup-window) → Posts instruction to agent
                                                         ↓
                                                Agent chooses what to show
                                                         ↓
                                                Agent runs: setsid info-window --title "X" <path>
                                                         ↓
                                                GTK window opens (separate process)
```

### 3. Agent ↔ Me (This Conversation)

```
You type → OpenCode sends to LLM provider → I respond →
         → Response posted as synthetic message to session
         → You see it in Desktop app / Terminal
```

### 4. Transcript.md Button Click

```
You click Transcript.md in popup → Python reads SQLite directly
                                                         ↓
                                                Extracts messages + images
                                                         ↓
                                                Writes ~/Downloads/Title.md + Title-images/
                                                         ↓
                                                You open in Obsidian/Okular/VS Code → images render
```

## What Each Piece Does

| Component | Role |
| - | - |
| **Hyprland** | Tiles/floats windows, applies rules (float+center for popups) |
| **OpenCode Desktop** | UI wrapper, shows sessions, renders messages |
| **OpenCode Server (Rust)** | Core logic, HTTP API, session/db management |
| **Plugin Host (Node)** | Loads plugins, exposes `ctx.command`, `ctx.tool`, `ctx.session.synthetic` |
| **opencode-archive-session** | `/list_sessions`, archive/restore tools, spawns session-list-popup |
| **opencode-popup-window** | `/popup` (delegates to agent), agent spawns info-window |
| **session-list-popup (Python/GTK)** | Session list window, right-click → Archive/Stats/Transcript/Export/Delete |
| **info-window (Python/GTK)** | Generic document viewer (logs, markdown, images, URLs) |
| **SQLite Database** | Single source of truth for sessions, messages, costs, tokens |
| **LLM Provider** | Where I (the model) actually run — could be local or cloud |


## Data Flow for "Who Am I" (Provider Info)

```
Message created by LLM → metadata.model = {id: "...", providerID: "..."}
                                              ↓
                                    Stored in session_message.data (JSON)
                                              ↓
                                    session-list-popup reads it
                                              ↓
                                    Stats window: "MODELS" + "PROVIDERS" sections
                                    Database window: aggregate PROVIDERS across all sessions
```
