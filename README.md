# OpenCode Telegram Integration

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-%23000000.svg?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![grammY](https://img.shields.io/badge/grammY-Bot%20Framework-blue)](https://grammy.dev/)

A Telegram bot that orchestrates multiple [OpenCode](https://opencode.ai) instances through forum topics. Each forum topic in a Telegram supergroup gets its own dedicated OpenCode instance, enabling multi-user/multi-project AI assistance.

## Features

- **Forum Topic to OpenCode Instance**: Each topic gets a dedicated OpenCode session
- **Real-time Streaming**: SSE events from OpenCode are streamed to Telegram as editable messages
- **Session Discovery**: Connect to any running OpenCode instance on your machine
- **Instance Lifecycle Management**: Auto-start, health checks, crash recovery, idle timeout
- **Persistent State**: SQLite databases track topic mappings and instance state across restarts
- **Permission Handling**: Approve/deny dangerous operations via inline buttons

## Table of Contents

- [Quick Start](#quick-start)
- [Running with Docker](#running-with-docker)
- [Usage](#usage)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- [OpenCode](https://opencode.ai) CLI installed
- Telegram account

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Create a Supergroup with Topics

1. Create a new Telegram group
2. Convert it to a supergroup (Settings → Group Type → Supergroup)
3. Enable Topics (Settings → Topics → Enable)
4. Add your bot as an **admin** with permissions to manage topics

### 3. Get Your Chat ID

The chat ID for supergroups starts with `-100`. You can find it by:

1. Adding [@RawDataBot](https://t.me/RawDataBot) to your group temporarily
2. It will show the chat ID in its message
3. Remove the bot after getting the ID

### 4. Install and Configure

```bash
# Clone the repository
git clone https://github.com/huynle/opencode-telegram.git
cd opencode-telegram

# Install dependencies
bun install

# Configure environment
cp .env.example .env
# Edit .env with your bot token and chat ID
```

### 5. Run the Bot

```bash
# Development with hot reload
bun run dev

# Production
bun run start
```

## Running with Docker

> **Important**: Running natively with Bun is recommended for full functionality. Docker has significant limitations for this project's use case.

### Why Native is Recommended

The bot's session discovery feature uses `ps` and `lsof` to find OpenCode instances running on your machine. Docker containers have isolated process namespaces, meaning **the bot cannot discover OpenCode sessions running on your host**.

| Feature | Native (Bun) | Docker | Docker + `--pid=host` |
|---------|--------------|--------|----------------------|
| `/new` - create managed instances | Works | Works | Works |
| `/sessions` - discover host sessions | Works | **No** | Linux only |
| `/connect` - attach to discovered sessions | Works | **No** | Linux only |
| External API registration | Works | Works | Works |
| Stream responses to Telegram | Works | Works | Works |

### When Docker Makes Sense

- You only need **managed instances** (created via `/new` command)
- You're on Linux and can use `--pid=host`
- You want to use the **External API** to manually register instances

### Build the Image

```bash
docker build -t opencode-telegram .
```

### Option 1: Managed Instances Only

If you only use `/new` to create instances (no discovery of external sessions):

```bash
docker run -d --name opencode-telegram \
  --network=host \
  -v $(pwd)/data:/app/data \
  -v ~/oc-bot:/root/oc-bot \
  --env-file .env \
  opencode-telegram
```

**Volume Mounts:**
| Mount | Purpose |
|-------|---------|
| `./data:/app/data` | SQLite databases for persistent state |
| `~/oc-bot:/root/oc-bot` | Project directories created by `/new` command |

### Option 2: With Discovery (Linux Only)

On Linux, you can share the host's process namespace to enable discovery:

```bash
docker run -d --name opencode-telegram \
  --network=host \
  --pid=host \
  -v $(pwd)/data:/app/data \
  -v ~/oc-bot:/root/oc-bot \
  --env-file .env \
  opencode-telegram
```

> **Warning**: `--pid=host` shares the host's process namespace with the container. The container can see all host processes.

### Option 3: External API Registration

Run the bot in Docker and manually register OpenCode instances via the API:

```bash
# Start the bot
docker run -d --name opencode-telegram \
  --network=host \
  -v $(pwd)/data:/app/data \
  -v ~/oc-bot:/root/oc-bot \
  --env-file .env \
  opencode-telegram

# Register an OpenCode instance running on the host
curl -X POST http://localhost:4200/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "projectPath": "/path/to/project",
    "projectName": "my-project", 
    "opencodePort": 4096,
    "sessionId": "ses_abc123"
  }'
```

### macOS/Windows Note

On macOS and Windows, Docker Desktop runs containers in a Linux VM:
- `--network=host` doesn't provide true host networking
- `--pid=host` is not available
- **Discovery will not work** - use native Bun or the External API

### Docker Compose

```yaml
version: '3.8'

services:
  opencode-telegram:
    build: .
    container_name: opencode-telegram
    network_mode: host
    # Uncomment for discovery (Linux only):
    # pid: host
    volumes:
      - ./data:/app/data
      - ~/oc-bot:/root/oc-bot
    env_file:
      - .env
    restart: unless-stopped
```

```bash
docker compose up -d
docker compose logs -f
```

### Useful Docker Commands

```bash
# View logs
docker logs -f opencode-telegram

# Check container status
docker ps -a --filter name=opencode-telegram

# Stop the bot
docker stop opencode-telegram

# Remove container
docker rm opencode-telegram

# Rebuild after code changes
docker build -t opencode-telegram . && docker compose up -d
```

## Usage

### General Topic Commands (Control Plane)

These commands work in the General topic of your supergroup:

| Command | Description |
|---------|-------------|
| `/new <name>` | Create folder + topic + start OpenCode instance |
| `/sessions` | List all OpenCode sessions (managed + discovered) |
| `/connect <name>` | Connect to an existing session by name or ID |
| `/clear` | Clean up stale topic mappings |
| `/status` | Show orchestrator status |
| `/help` | Show context-aware help |

### Topic Commands (Inside a Session)

These commands work inside individual topic threads:

| Command | Description |
|---------|-------------|
| `/session` | Show current topic's OpenCode session info |
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

Discovered sessions show with a magnifying glass icon in `/sessions` output.

> **Note**: Discovery requires the bot to run natively (not in Docker) or with `--pid=host` on Linux. See [Running with Docker](#running-with-docker) for details.

### Topic Naming Convention

Topics follow the `<project>-<session title>` naming convention:

1. **On `/new <project>`**: Topic is created with just `<project>` name initially
2. **After first message**: Once OpenCode generates a session title, the topic is automatically renamed to `<project>-<session title>`
3. **On `/connect`**: If the session already has a title, the topic is created with `<project>-<session title>` immediately

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

### Directory Structure

```
src/
├── index.ts              # Entry point
├── config.ts             # Configuration from environment
├── integration.ts        # Wires all components together
├── api-server.ts         # External instance registration API
├── bot/
│   └── handlers/
│       └── forum.ts      # Telegram message/command handlers
├── forum/
│   ├── topic-manager.ts  # Topic → Session mapping logic
│   └── topic-store.ts    # SQLite persistence for topic mappings
├── opencode/
│   ├── client.ts         # OpenCode REST API client
│   ├── discovery.ts      # Discover running OpenCode instances
│   ├── stream-handler.ts # SSE → Telegram message bridging
│   └── telegram-markdown.ts # Markdown conversion for Telegram
├── orchestrator/
│   ├── manager.ts        # Manages multiple instances
│   ├── instance.ts       # Single OpenCode instance lifecycle
│   ├── port-pool.ts      # Port allocation
│   └── state-store.ts    # SQLite persistence for instance state
└── types/
    ├── forum.ts          # Forum/topic types
    └── orchestrator.ts   # Orchestrator types
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | - | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | - | Supergroup ID (starts with -100) |
| `PROJECT_BASE_PATH` | No | `~/oc-bot` | Where topic directories are created |
| `OPENCODE_PATH` | No | `opencode` | Path to opencode binary |
| `OPENCODE_MAX_INSTANCES` | No | `10` | Max concurrent instances |
| `OPENCODE_PORT_START` | No | `4100` | Starting port for instances |
| `OPENCODE_IDLE_TIMEOUT_MS` | No | `1800000` | Idle timeout (30 min) |
| `API_PORT` | No | `4200` | External API server port |

See [.env.example](.env.example) for all available options.

## API Reference

### External Instance API

The bot exposes an API on port 4200 for external OpenCode instances to register. This is useful when running the bot in Docker without process discovery.

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

# Unregister
curl -X POST http://localhost:4200/api/unregister \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/path/to/project"}'

# Check status
curl http://localhost:4200/api/status/$(echo -n "/path/to/project" | base64)

# List all instances
curl http://localhost:4200/api/instances

# Health check
curl http://localhost:4200/api/health
```

### OpenCode REST API (per instance)

Each OpenCode instance exposes:

```
GET  /global/health           # Health check
GET  /session                 # List sessions
POST /session                 # Create session
GET  /session/:id/message     # Get messages
POST /session/:id/message     # Send message (sync)
POST /session/:id/prompt_async # Send message (async)
GET  /event                   # SSE event stream
```

## Development

```bash
# Install dependencies
bun install

# Start with hot reload
bun run dev

# Type check
bun run typecheck

# Format code (if prettier configured)
bun run format
```

### Key Patterns

- **Event-driven**: Orchestrator emits events, integration layer handles them
- **State recovery**: Both orchestrator and topic manager recover state on restart
- **Graceful degradation**: Errors are logged but don't crash the bot

### Adding New Features

1. **New bot commands**: Add to `src/bot/handlers/forum.ts` in `createForumCommands()`
2. **New SSE event handling**: Modify `src/opencode/stream-handler.ts`
3. **New instance lifecycle events**: Modify `src/orchestrator/instance.ts`

## Troubleshooting

### Port Conflicts

**Symptom**: Instance crashes with "Failed to start server on port 4100"

**Solution**: The code auto-cleans ports before starting. For manual cleanup:

```bash
lsof -ti:4100 | xargs kill
```

### Duplicate Messages

**Symptom**: Multiple "Thinking..." or response messages

**Cause**: Multiple SSE subscriptions or improper error handling

**Solution**: Fixed in current version by cleaning up subscriptions on `instance:ready`

### Session Not Forwarding

**Symptom**: SSE events received but not forwarded to Telegram

**Solution**: Check that the topic is properly linked with `/session` command

### Discovery Not Working in Docker

**Symptom**: `/sessions` only shows managed instances, not host OpenCode sessions

**Cause**: Docker containers have isolated process namespaces - `ps` and `lsof` can only see container processes

**Solutions** (in order of recommendation):
1. **Run natively**: `bun run start` (recommended)
2. **Linux with `--pid=host`**: Shares host process namespace
3. **External API**: Manually register instances via `/api/register`

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [OpenCode](https://opencode.ai) - The AI coding assistant this bot integrates with
- [grammY](https://grammy.dev/) - The Telegram Bot framework
- [Bun](https://bun.sh) - The JavaScript runtime
