---
description: Unlink this OpenCode session from Telegram
---

# Telegram Unlink Command

Disconnect the current OpenCode session from its linked Telegram topic.

## Usage

```bash
/telegram-unlink
```

## What Happens

- SSE event forwarding stops immediately
- Messages from Telegram will no longer reach this session
- The Telegram topic remains (not deleted) but shows "disconnected" message
- You can re-link later with `/telegram-link`

## Execution Steps

### 1. Check Configuration

Determine the bot API URL:

```bash
echo "${TELEGRAM_BOT_API_URL:-http://localhost:4200}"
```

### 2. Check Current Registration

```bash
curl -sf "${TELEGRAM_BOT_API_URL:-http://localhost:4200}/api/status/$(pwd | sed 's|/|%2F|g')"
```

If not registered, show:
```
Not currently linked to Telegram.

To link: /telegram-link
```

### 3. Unregister from Bot

```bash
curl -sf -X POST "${TELEGRAM_BOT_API_URL:-http://localhost:4200}/api/unregister" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${TELEGRAM_BOT_API_KEY:-}" \
  -d '{
    "projectPath": "<pwd output>"
  }'
```

### 4. Show Result

On success:
```
Unlinked from Telegram.

The topic remains in Telegram but messages will no longer be forwarded.

To re-link: /telegram-link
```

On failure, show the error message.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_API_URL` | Bot service URL | `http://localhost:4200` |
| `TELEGRAM_BOT_API_KEY` | Optional API key | (none) |
