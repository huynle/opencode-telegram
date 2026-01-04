# OpenCode Telegram Integration

A Telegram bot that orchestrates multiple OpenCode instances through forum topics. Each forum topic in a Telegram supergroup gets its own dedicated OpenCode instance, enabling multi-user/multi-project AI assistance.

## Features

- **Forum Topic → OpenCode Instance**: Each topic gets a dedicated OpenCode session
- **Real-time Streaming**: SSE events from OpenCode are streamed to Telegram as editable messages
- **Session Discovery**: Connect to any running OpenCode instance on your machine
- **Instance Lifecycle Management**: Auto-start, health checks, crash recovery, idle timeout
- **Persistent State**: SQLite databases track topic mappings and instance state across restarts
- **Permission Handling**: Approve/deny dangerous operations via inline buttons

## Quick Start

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Create a Supergroup with Topics

1. Create a new Telegram group
2. Convert it to a supergroup (Settings → Group Type → Supergroup)
3. Enable Topics (Settings → Topics → Enable)
4. Add your bot as an **admin**

### 3. Get Your Chat ID

The chat ID for supergroups starts with `-100`. You can find it by:
1. Adding [@RawDataBot](https://t.me/RawDataBot) to your group temporarily
2. It will show the chat ID in its message

### 4. Configure Environment

```bash
cp .env.example .env
# Edit .env with your bot token and chat ID
```

### 5. Run the Bot

```bash
bun install
bun run dev    # Development with hot reload
bun run start  # Production
```

## Usage

### General Topic Commands (Control Plane)

| Command | Description |
|---------|-------------|
| `/new <name>` | Create folder + topic + start OpenCode instance |
| `/sessions` | List all OpenCode sessions (managed + discovered) |
| `/connect <name>` | Connect to an existing session by name or ID |
| `/topics` | List all active topics in this chat |
| `/clear` | Clean up stale topic mappings |
| `/status` | Show orchestrator status |
| `/help` | Show context-aware help |

### Topic Commands (Inside a Session)

| Command | Description |
|---------|-------------|
| `/session` | Show current topic's OpenCode session info |
| `/newsession` | Force create a new session |
| `/link <path>` | Link topic to existing project directory |
| `/stream` | Toggle real-time streaming on/off |
| `/disconnect` | Disconnect session and delete topic |
| `/help` | Show context-aware help |

### Session Discovery

The bot can discover any running OpenCode instance on your machine:

```
/sessions              # Lists all sessions including discovered ones
/connect myproject     # Connect to a discovered session by name
/connect ses_abc123    # Connect by session ID prefix
```

Discovered sessions show with a 🔍 icon in `/sessions` output.

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

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Supergroup ID (starts with -100) |
| `PROJECT_BASE_PATH` | No | Where topic directories are created (default: ~/oc-bot) |
| `OPENCODE_PATH` | No | Path to opencode binary (default: opencode) |
| `OPENCODE_MAX_INSTANCES` | No | Max concurrent instances (default: 10) |
| `OPENCODE_PORT_START` | No | Starting port for instances (default: 4100) |
| `API_PORT` | No | External API server port (default: 4200) |

## External Instance API

The bot exposes an API for external OpenCode instances to register:

```
GET  /api/health              # API server health check
POST /api/register            # Register external OpenCode instance
POST /api/unregister          # Unregister instance
GET  /api/status/:projectPath # Check registration status
GET  /api/instances           # List all external instances
```

## Development

```bash
bun install        # Install dependencies
bun run dev        # Start with hot reload
bun run typecheck  # Type check
```

## License

MIT
