---
description: Link this OpenCode session to a Telegram topic for remote monitoring and control
---

# Telegram Link Command

Link the current OpenCode session to a Telegram forum topic. This enables:
- Real-time streaming of responses to Telegram
- Sending messages from Telegram back to this session
- Monitoring progress from your phone

## Usage

```bash
/telegram-link                    # Link with default project name
/telegram-link my-project         # Link with custom topic name
```

## Execution Steps

### 1. Check Configuration

First, determine the bot API URL. Check in order:
1. `TELEGRAM_BOT_API_URL` environment variable
2. Default to `http://localhost:4200`

```bash
echo "${TELEGRAM_BOT_API_URL:-http://localhost:4200}"
```

### 2. Check Bot Health

Verify the bot service is running:

```bash
curl -sf "${TELEGRAM_BOT_API_URL:-http://localhost:4200}/api/health"
```

If this fails, show error:
```
Cannot connect to Telegram bot service at <url>

Make sure the bot is running:
  cd /path/to/opencode-telegram
  bun run dev
```

### 3. Get Session Information

Gather the required information for registration:

**Project Path** (current working directory):
```bash
pwd
```

**Project Name** (from $ARGUMENTS or directory basename):
- If `$ARGUMENTS` is provided and not empty, use it as the topic name
- Otherwise, use the basename of the current directory

**OpenCode Port**:
- Check `OPENCODE_PORT` env var, default to 4096

**Session ID**:
- Use the current session ID from context

### 4. Check Existing Registration

```bash
curl -sf "${TELEGRAM_BOT_API_URL:-http://localhost:4200}/api/status/$(pwd | sed 's|/|%2F|g')"
```

If already registered, show:
```
Already linked to Telegram!

Topic: <name>
URL: <url>

To unlink first: /telegram-unlink
```

### 5. Register with Bot

Make the registration API call:

```bash
curl -sf -X POST "${TELEGRAM_BOT_API_URL:-http://localhost:4200}/api/register" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${TELEGRAM_BOT_API_KEY:-}" \
  -d '{
    "projectPath": "<pwd output>",
    "projectName": "<topic name>",
    "opencodePort": <port number>,
    "sessionId": "<session id>",
    "enableStreaming": true
  }'
```

### 6. Show Result

On success, display:
```
Linked to Telegram!

Topic: <project name>
URL: <topic url from response>

You can now:
- Continue this conversation from Telegram
- Receive real-time updates on your phone  
- Send messages back to this session

To unlink: /telegram-unlink
```

On failure, show the error message from the API.

## Arguments

$ARGUMENTS - Optional topic name. If not provided, uses directory basename.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_API_URL` | Bot service URL | `http://localhost:4200` |
| `TELEGRAM_BOT_API_KEY` | Optional API key | (none) |
| `OPENCODE_PORT` | This OpenCode's port | `4096` |
