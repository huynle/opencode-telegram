/**
 * Telegram Webhook Server
 * 
 * Receives updates from Telegram and handles:
 * - Button clicks (approval responses)
 * - Text messages (command injection)
 * 
 * Run with: bun run src/webhook-server.ts
 */

import { handleTelegramUpdate } from "./telegram-notify"
import { createTelegramClient } from "./telegram-api"

const PORT = parseInt(process.env.WEBHOOK_PORT || "4200")

console.log(`
╔════════════════════════════════════════════════════════════╗
║           Telegram Webhook Server for OpenCode             ║
╠════════════════════════════════════════════════════════════╣
║  This server receives Telegram updates and:                ║
║  • Handles button clicks (approve/deny)                    ║
║  • Injects text messages as OpenCode commands              ║
╚════════════════════════════════════════════════════════════╝
`)

// Verify configuration
const botToken = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.TELEGRAM_CHAT_ID
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL

if (!botToken || !chatId) {
  console.error("❌ Missing required environment variables:")
  console.error("   TELEGRAM_BOT_TOKEN:", botToken ? "✓" : "✗")
  console.error("   TELEGRAM_CHAT_ID:", chatId ? "✓" : "✗")
  console.error("\nCopy .env.example to .env and fill in your values")
  process.exit(1)
}

// Initialize Telegram client
const telegram = createTelegramClient()

// Check bot info
const botInfo = await telegram.getMe()
if (botInfo.ok) {
  console.log(`✓ Connected to Telegram as @${botInfo.result.username}`)
} else {
  console.error("❌ Failed to connect to Telegram:", botInfo.description)
  process.exit(1)
}

// Set up webhook if URL provided
if (webhookUrl) {
  const fullWebhookUrl = `${webhookUrl}/webhook`
  console.log(`\n📡 Setting webhook to: ${fullWebhookUrl}`)
  
  const result = await telegram.setWebhook(fullWebhookUrl)
  if (result.ok) {
    console.log("✓ Webhook configured successfully")
  } else {
    console.error("❌ Failed to set webhook:", result.description)
  }
} else {
  console.log("\n⚠️  No TELEGRAM_WEBHOOK_URL set - running in local mode")
  console.log("   Use ngrok or similar to expose this server:")
  console.log(`   ngrok http ${PORT}`)
  console.log("   Then set TELEGRAM_WEBHOOK_URL to the ngrok URL")
}

// Start server
const server = Bun.serve({
  port: PORT,
  
  async fetch(req) {
    const url = new URL(req.url)
    
    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        bot: botInfo.result?.username,
        timestamp: new Date().toISOString(),
      }), {
        headers: { "Content-Type": "application/json" },
      })
    }
    
    // Webhook endpoint
    if (url.pathname === "/webhook" && req.method === "POST") {
      try {
        const update = await req.json()
        console.log("\n📥 Received update:", JSON.stringify(update, null, 2).slice(0, 500))
        
        // Handle the update
        handleTelegramUpdate(update)
        
        return new Response("OK")
      } catch (err) {
        console.error("❌ Error processing webhook:", err)
        return new Response("Error", { status: 500 })
      }
    }
    
    // Manual trigger for testing
    if (url.pathname === "/test" && req.method === "POST") {
      try {
        const body = await req.json()
        const message = body.message || "Test notification from webhook server"
        
        const result = await telegram.sendMessage({ text: message })
        
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        })
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      }
    }
    
    return new Response("Not Found", { status: 404 })
  },
})

console.log(`
✓ Webhook server running on http://localhost:${PORT}

Endpoints:
  GET  /           - Health check
  GET  /health     - Health check
  POST /webhook    - Telegram webhook endpoint
  POST /test       - Send test message

Waiting for Telegram updates...
`)

// Keep the server running
process.on("SIGINT", () => {
  console.log("\n\nShutting down...")
  server.stop()
  process.exit(0)
})
