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
│   ├── stream-handler.ts # SSE → Telegram message bridging
│   └── types.ts          # OpenCode-related types
├── orchestrator/
│   ├── index.ts          # Exports
│   ├── manager.ts        # Manages multiple instances
│   ├── instance.ts       # Single OpenCode instance lifecycle
│   ├── port-pool.ts      # Port allocation
│   └── state-store.ts    # SQLite persistence for instance state
├── types/
│   ├── forum.ts          # Forum/topic types
│   └── orchestrator.ts   # Orchestrator types
└── telegram-notify.ts    # Original plugin (standalone notifications)

plugin/
└── telegram-notify.ts    # OpenCode plugin for notifications

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
```
/session  - Show current topic's OpenCode session info
/topics   - List all active topics with sessions
/status   - Show orchestrator status
```

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
