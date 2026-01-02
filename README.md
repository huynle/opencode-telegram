# OpenCode Telegram Integration

Telegram notifications, permission handling, and two-way communication for OpenCode.

## Features

- 📱 **Session Notifications** - Get notified when tasks complete or errors occur
- ⚠️ **Permission Requests** - Approve/deny dangerous operations from your phone
- 💬 **Two-way Communication** - Send commands to OpenCode via Telegram
- 📊 **Session Tracking** - Monitor long-running sessions

## Quick Start

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Get Your Chat ID

1. Message your new bot (send any message)
2. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Find `"chat":{"id":123456789}` in the response

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your bot token and chat ID
```

### 4. Test the Connection

```bash
bun install
bun run test:send
```

You should receive test messages in Telegram!

## Usage

### As an OpenCode Plugin

Symlink the plugin to your OpenCode config:

```bash
# Create symlink
ln -s ~/experiments/2025-01-02-opencode-telegram/src/telegram-notify.ts \
      ~/dot/config/opencode/plugin/telegram-notify.ts

# Set environment variables (add to ~/.zshrc or ~/.bashrc)
export TELEGRAM_BOT_TOKEN="your-token"
export TELEGRAM_CHAT_ID="your-chat-id"
```

Then restart OpenCode. You'll receive notifications when:
- Sessions become idle (task complete)
- Errors occur
- Dangerous operations need approval

### Webhook Server (Two-way Communication)

For receiving messages and button clicks:

```bash
# Start the webhook server
bun run test:webhook

# In another terminal, expose with ngrok
ngrok http 4200

# Set the webhook URL in .env
TELEGRAM_WEBHOOK_URL=https://abc123.ngrok.io
```

Now you can:
- Click buttons to approve/deny operations
- Send text messages to inject commands into OpenCode

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenCode Instance                        │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              telegram-notify.ts (Plugin)              │   │
│  │                                                       │   │
│  │  Hooks:                                               │   │
│  │    • session.idle → Send completion notification      │   │
│  │    • session.error → Send error alert                 │   │
│  │    • tool.execute.before → Check for dangerous ops    │   │
│  │                                                       │   │
│  │  Tools:                                               │   │
│  │    • telegram_send → Send message                     │   │
│  │    • telegram_ask → Send with buttons, wait response  │   │
│  │    • telegram_session_status → Get session stats      │   │
│  └──────────────────────────────────────────────────────┘   │
│                            │                                 │
└────────────────────────────┼─────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    Telegram Bot API                          │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    Your Phone/Desktop                        │
│                                                              │
│  • Receive notifications                                     │
│  • Click approve/deny buttons                                │
│  • Send commands via text                                    │
└─────────────────────────────────────────────────────────────┘
```

## Files

```
src/
├── telegram-api.ts      # Telegram Bot API client
├── telegram-notify.ts   # OpenCode plugin (main)
├── webhook-server.ts    # Webhook server for two-way comms
├── test-send.ts         # Test: send messages
└── test-plugin.ts       # Test: simulate plugin events
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Your Telegram chat ID |
| `TELEGRAM_WEBHOOK_URL` | No | Public URL for webhook (for two-way) |
| `WEBHOOK_PORT` | No | Webhook server port (default: 4200) |
| `OPENCODE_PORT` | No | OpenCode REST API port (default: 4096) |

## Dangerous Operation Detection

The plugin automatically requests approval for:

- `rm -rf` commands
- `sudo` commands
- `chmod 777` commands
- Writes to `/etc/`, `/usr/`, etc.
- Other potentially destructive operations

You can customize this in `telegram-notify.ts`:

```typescript
const CONFIG = {
  dangerousPatterns: [
    /rm\s+-rf/i,
    /sudo/i,
    // Add your own patterns
  ],
}
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun run test:send      # Test sending messages
bun run dev            # Interactive plugin simulation
bun run test:webhook   # Start webhook server

# Type check
bun run typecheck
```

## License

MIT
