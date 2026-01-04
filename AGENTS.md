# AGENTS.md - OpenCode Telegram Integration

## Project Overview

This project creates a **Telegram bot that orchestrates multiple OpenCode instances** through forum topics. Each forum topic in a Telegram supergroup gets its own dedicated OpenCode instance, enabling multi-user/multi-project AI assistance.

### Key Capabilities
- **Forum Topic → OpenCode Instance**: Each topic gets a dedicated OpenCode session
- **Real-time Streaming**: SSE events from OpenCode are streamed to Telegram as editable messages
- **Instance Lifecycle Management**: Auto-start, health checks, crash recovery, idle timeout
- **Persistent State**: SQLite databases track topic mappings and instance state across restarts

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Telegram Supergroup (Forum)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                          │
│  │ Topic #1 │  │ Topic #2 │  │ Topic #3 │  ...                     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                          │
└───────┼─────────────┼─────────────┼─────────────────────────────────┘
        │             │             │
        ▼             ▼             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Integration Layer                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │ grammY Bot  │  │TopicManager │  │StreamHandler│                 │
│  └─────────────┘  └─────────────┘  └─────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
        │             │             │
        ▼             ▼             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Instance Manager (Orchestrator)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Instance #1  │  │ Instance #2  │  │ Instance #3  │  ...         │
│  │ Port 4100    │  │ Port 4101    │  │ Port 4102    │              │
│  │ opencode     │  │ opencode     │  │ opencode     │              │
│  │ serve        │  │ serve        │  │ serve        │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/
├── index.ts              # Entry point - starts the bot
├── config.ts             # Configuration from environment variables
├── integration.ts        # Wires all components together
├── api-server.ts         # External instance registration API
├── bot/
│   └── handlers/
│       └── forum.ts      # Telegram message/command handlers
├── forum/
│   ├── index.ts          # Exports
│   ├── topic-manager.ts  # Topic → Session mapping logic
│   └── topic-store.ts    # SQLite persistence for topic mappings
├── opencode/
│   ├── index.ts          # Exports
│   ├── client.ts         # OpenCode REST API client
│   ├── discovery.ts      # Discover running OpenCode instances
│   ├── stream-handler.ts # SSE → Telegram message bridging
│   ├── telegram-markdown.ts # Markdown conversion for Telegram
│   └── types.ts          # OpenCode-related types
├── orchestrator/
│   ├── index.ts          # Exports
│   ├── manager.ts        # Manages multiple instances
│   ├── instance.ts       # Single OpenCode instance lifecycle
│   ├── port-pool.ts      # Port allocation
│   └── state-store.ts    # SQLite persistence for instance state
└── types/
    ├── forum.ts          # Forum/topic types
    └── orchestrator.ts   # Orchestrator types

data/                     # Runtime data (gitignored)
├── orchestrator.db       # Instance state
└── topics.db             # Topic mappings
```

## Key Components

### 1. Integration Layer (`src/integration.ts`)
The main orchestration point that:
- Creates and configures the grammY bot
- Sets up event handlers for orchestrator events
- Manages OpenCode clients and SSE subscriptions
- Routes messages between Telegram and OpenCode

### 2. Instance Manager (`src/orchestrator/manager.ts`)
Manages the lifecycle of OpenCode instances:
- Creates instances on-demand for new topics
- Handles health checks and crash recovery
- Implements idle timeout for resource cleanup
- Persists state to SQLite for restart recovery

### 3. Stream Handler (`src/opencode/stream-handler.ts`)
Bridges SSE events from OpenCode to Telegram:
- Shows "Thinking..." progress messages
- Streams text responses with throttling
- Handles tool execution status
- Edits messages in-place for clean UX

### 4. Topic Manager (`src/forum/topic-manager.ts`)
Maps forum topics to OpenCode sessions:
- Creates sessions for new topics automatically
- Routes messages to correct instances
- Handles both new and existing topics

## Running the Bot

### Prerequisites
1. Telegram bot token from @BotFather
2. Telegram supergroup with **Topics enabled**
3. Bot added as **admin** to the supergroup
4. Bun runtime installed

### Environment Variables
```bash
# Required
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=-100xxxxxxxxxx  # Supergroup ID (negative number)

# Optional
PROJECT_BASE_PATH=/path/to/projects  # Where topic directories are created
OPENCODE_PATH=opencode               # Path to opencode binary
OPENCODE_MAX_INSTANCES=10            # Max concurrent instances
OPENCODE_PORT_START=4100             # Starting port for instances
```

### Commands
```bash
bun install          # Install dependencies
bun run dev          # Start with hot reload (--watch)
bun run start        # Start production
```

## Common Issues & Solutions

### Port Conflicts
**Symptom**: Instance crashes with "Failed to start server on port 4100"
**Cause**: Stale opencode process from previous run
**Solution**: The code now auto-cleans ports before starting. If manual cleanup needed:
```bash
lsof -ti:4100 | xargs kill
```

### Duplicate Messages
**Symptom**: Multiple "Thinking..." or response messages
**Cause**: Multiple SSE subscriptions or improper error handling
**Solution**: Fixed by cleaning up subscriptions on `instance:ready` and ignoring "message is not modified" errors

### Session Not Registered
**Symptom**: SSE events received but not forwarded to Telegram
**Cause**: SessionID extraction from nested event properties
**Solution**: Extract from `props.sessionID`, `props.info?.sessionID`, or `props.part?.sessionID`

## Development Notes

### Adding New Features
1. **New bot commands**: Add to `src/bot/handlers/forum.ts` in `createForumCommands()`
2. **New SSE event handling**: Modify `src/opencode/stream-handler.ts`
3. **New instance lifecycle events**: Modify `src/orchestrator/instance.ts`

### Testing
- Send messages in Telegram topics to test the full flow
- Monitor logs in the terminal running `bun run dev`
- Check SQLite databases in `data/` for state inspection

### Key Patterns
- **Event-driven**: Orchestrator emits events, integration layer handles them
- **State recovery**: Both orchestrator and topic manager recover state on restart
- **Graceful degradation**: Errors are logged but don't crash the bot

## API Reference

### OpenCode REST API (per instance)
```
GET  /global/health           # Health check
GET  /session                 # List sessions
POST /session                 # Create session
GET  /session/:id/message     # Get messages
POST /session/:id/message     # Send message (sync)
POST /session/:id/prompt_async # Send message (async)
GET  /event                   # SSE event stream
```

### Telegram Bot Commands

#### General Topic (Control Plane)
```
/new <name>         - Create folder in oc-bot/ + topic + start OpenCode
/managed_projects   - List all project directories in oc-bot/
/sessions           - List all OpenCode sessions (managed + discovered)
/connect <#>        - Attach to existing session by number
/clear              - Clean up stale topic mappings
/status             - Show orchestrator status
/help               - Show context-aware help
```

**Key difference:**
- `/new myproject` → Creates `~/oc-bot/myproject/`, creates topic, starts OpenCode instance
- `/connect 1` → Just attaches to existing session #1, no directory created

### Topic Naming Convention

Topics follow the `<project>-<session title>` naming convention:

1. **On `/new <project>`**: Topic is created with just `<project>` name initially
2. **After first message**: Once OpenCode generates a session title, the topic is automatically renamed to `<project>-<session title>`
3. **On `/connect`**: If the session already has a title, the topic is created with `<project>-<session title>` immediately

**Examples:**
- `/new my-app` → Topic: "my-app" → After first message: "my-app-implement user auth"
- `/connect hindsight` (session titled "fix memory leak") → Topic: "hindsight-fix memory leak"

#### Inside a Topic (Session)
```
/session         - Show current topic's OpenCode session info
/disconnect      - Unlink & delete this topic
/link <path>     - Link topic to existing project directory
/stream          - Toggle real-time streaming on/off
/help            - Show context-aware help
```

### External Instance API (Port 4200)
```
GET  /api/health              # API server health check
POST /api/register            # Register external OpenCode instance
POST /api/unregister          # Unregister instance
GET  /api/status/:projectPath # Check registration status
GET  /api/instances           # List all external instances
```

### Linking External OpenCode Sessions

External OpenCode instances can register with the bot via the API server (port 4200).

#### Via API

```bash
# Register an external instance
curl -X POST http://localhost:4200/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "projectPath": "/path/to/project",
    "projectName": "my-project",
    "opencodePort": 4096,
    "sessionId": "ses_abc123"
  }'
```

#### What Happens

1. Creates a new Telegram forum topic named after your project
2. Subscribes to your session's SSE events  
3. Forwards all responses to Telegram in real-time
4. Routes Telegram messages back to your session

#### To Unlink

```bash
curl -X POST http://localhost:4200/api/unregister \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/path/to/project"}'
```

### Session Discovery

The bot can automatically discover all running OpenCode instances on the local machine, even if they weren't started by the bot.

#### How Discovery Works

1. Scans for `opencode` processes using `ps`
2. Gets their listening ports via `lsof`
3. Queries each instance's REST API for session info
4. Filters out already-known sessions (managed + registered)

#### Using Discovery

```
# In General topic:
/sessions              # Lists all sessions including discovered ones
/connect hindsight     # Connect to a discovered session by name
/connect ses_abc123    # Connect by session ID prefix
```

Discovered sessions show with a 🔍 icon in `/sessions` output.

#### Cleaning Up Stale Sessions

When sessions die but their topic mappings remain:

```
/clear                 # Find and remove stale mappings
```

This checks if each mapped session is still alive and removes dead ones.

## Tmux Development Environment

The bot runs in a tmux pane within the `dev` session, window `telegram-exp`.

### Pane Layout

| Pane | ID | Target | Command | Purpose |
|------|----|--------|---------|---------|
| 0 | `%363` | `dev:telegram-exp.0` | opencode | OpenCode TUI session |
| 1 | `%368` | `dev:telegram-exp.1` | bun | **Bot process** |
| 2 | `%359` | `dev:telegram-exp.2` | nvim | Editor |

### Bot Pane Management (Pane `%368`)

**Check logs/status:**
```
tmux capture-pane -t %368 -p -S -100
```

**Stop the bot:**
```
tmux send-keys -t %368 C-c
```

**Start the bot:**
```
tmux send-keys -t %368 'bun run dev' Enter
```

**Restart the bot:**
```
tmux send-keys -t %368 C-c && sleep 1 && tmux send-keys -t %368 'bun run dev' Enter
```

### OpenCode Tool Access

When running inside OpenCode, use the tmux tools directly:
- `tool_tmux_capture(target: "%368")` - Check logs
- `tool_tmux_send_keys(target: "%368", keys: "C-c")` - Stop
- `tool_tmux_send_keys(target: "%368", keys: "bun run dev")` + `Enter` - Start

## Recent Changes (Latest Session)

1. **Port cleanup on start** - Kills stale processes before binding
2. **SSE subscription cleanup** - Prevents duplicate subscriptions on restart
3. **SessionID extraction fix** - Handles nested properties in SSE events
4. **Duplicate message fix** - Ignores "message is not modified" errors
5. **Instance ready on restart** - Emits event after successful restart
6. **Final response editing** - Edits progress message instead of sending new one

## Cleanup Changes (Code Simplification)

1. **Removed `/topics` command** - Redundant with `/sessions` which shows more info
2. **Removed `/newsession` command** - Sessions are auto-created, this was confusing
3. **Consolidated TopicStore** - Single shared instance instead of two separate ones
4. **Removed duplicate cleanup timer** - TopicManager no longer has its own cleanup
5. **Simplified General topic** - Now purely control plane (no OpenCode routing)
6. **Removed unused methods** - `recoverState()` and `createSessionForTopic()` from TopicManager
