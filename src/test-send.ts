/**
 * Test Script: Send a message to Telegram
 * 
 * Run with: bun run src/test-send.ts
 * 
 * This verifies your Telegram bot configuration is correct.
 */

import { createTelegramClient, codeBlock } from "./telegram-api"

console.log(`
╔════════════════════════════════════════════════════════════╗
║              Telegram Integration Test                      ║
╚════════════════════════════════════════════════════════════╝
`)

// Check environment
const botToken = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.TELEGRAM_CHAT_ID

console.log("Checking configuration...")
console.log("  TELEGRAM_BOT_TOKEN:", botToken ? `✓ (${botToken.slice(0, 10)}...)` : "✗ Missing")
console.log("  TELEGRAM_CHAT_ID:", chatId ? `✓ (${chatId})` : "✗ Missing")

if (!botToken || !chatId) {
  console.error("\n❌ Missing required environment variables!")
  console.error("\nTo fix:")
  console.error("  1. Copy .env.example to .env")
  console.error("  2. Get a bot token from @BotFather on Telegram")
  console.error("  3. Get your chat ID by messaging your bot and visiting:")
  console.error(`     https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`)
  process.exit(1)
}

// Create client
const telegram = createTelegramClient()

// Test 1: Get bot info
console.log("\n📡 Testing connection...")
const botInfo = await telegram.getMe()

if (!botInfo.ok) {
  console.error("❌ Failed to connect:", botInfo.description)
  process.exit(1)
}

console.log(`✓ Connected as @${botInfo.result.username}`)
console.log(`  Bot ID: ${botInfo.result.id}`)
console.log(`  Name: ${botInfo.result.first_name}`)

// Test 2: Send a simple message
console.log("\n📤 Sending test message...")
const simpleResult = await telegram.sendMessage({
  text: "🧪 *Test Message*\n\nThis is a test from the OpenCode Telegram integration.",
})

if (!simpleResult.ok) {
  console.error("❌ Failed to send message:", simpleResult.description)
  
  if (simpleResult.error_code === 400) {
    console.error("\n   This usually means the chat ID is wrong.")
    console.error("   Make sure you've messaged the bot first!")
  }
  process.exit(1)
}

console.log(`✓ Message sent (ID: ${simpleResult.result?.message_id})`)

// Test 3: Send a message with buttons
console.log("\n📤 Sending message with buttons...")
const buttonResult = await telegram.sendWithButtons(
  "🔘 *Button Test*\n\nClick a button to test the interaction:",
  [
    [
      { text: "✅ Approve", callback_data: "test_approve" },
      { text: "❌ Deny", callback_data: "test_deny" },
    ],
    [
      { text: "📋 View Details", callback_data: "test_details" },
    ],
  ]
)

if (!buttonResult.ok) {
  console.error("❌ Failed to send button message:", buttonResult.description)
  process.exit(1)
}

console.log(`✓ Button message sent (ID: ${buttonResult.result?.message_id})`)

// Test 4: Send a code block
console.log("\n📤 Sending code block...")
const codeResult = await telegram.sendMessage({
  text: `📝 *Code Block Test*\n\n${codeBlock(`{
  "status": "success",
  "timestamp": "${new Date().toISOString()}",
  "test": "opencode-telegram"
}`, "json")}`,
})

if (!codeResult.ok) {
  console.error("❌ Failed to send code block:", codeResult.description)
  process.exit(1)
}

console.log(`✓ Code block sent (ID: ${codeResult.result?.message_id})`)

// Summary
console.log(`
╔════════════════════════════════════════════════════════════╗
║                    All Tests Passed! ✓                      ║
╠════════════════════════════════════════════════════════════╣
║  Your Telegram bot is configured correctly.                 ║
║                                                             ║
║  Next steps:                                                ║
║  1. Start the webhook server: bun run test:webhook          ║
║  2. Use ngrok to expose it: ngrok http 4200                 ║
║  3. Set TELEGRAM_WEBHOOK_URL in .env                        ║
║  4. Symlink the plugin to your OpenCode config              ║
╚════════════════════════════════════════════════════════════╝
`)
