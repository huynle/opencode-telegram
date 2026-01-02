/**
 * Test Script: Simulate plugin behavior
 * 
 * Run with: bun run dev
 * 
 * This simulates the plugin events to test notifications without
 * running a full OpenCode instance.
 */

import { createTelegramClient, codeBlock } from "./telegram-api"

console.log(`
╔════════════════════════════════════════════════════════════╗
║           Plugin Simulation Test                            ║
╚════════════════════════════════════════════════════════════╝
`)

const telegram = createTelegramClient()

// Simulate session tracking
const sessionID = `test-${Date.now()}`
const startTime = Date.now()
let toolCalls = 0

// Helper to format session info
function formatSessionInfo(): string {
  const duration = Math.round((Date.now() - startTime) / 1000)
  const minutes = Math.floor(duration / 60)
  const seconds = duration % 60

  return `\n\n📊 *Session Stats*\n` +
    `• Duration: ${minutes}m ${seconds}s\n` +
    `• Tool calls: ${toolCalls}`
}

// Menu
console.log(`
Available simulations:
  1. Session idle (task complete)
  2. Session error
  3. Permission request (dangerous command)
  4. Progress update
  5. Ask question with buttons
  6. Exit

`)

// Interactive menu
const stdin = process.stdin
stdin.setRawMode(true)
stdin.resume()
stdin.setEncoding("utf8")

console.log("Press a number to simulate an event...\n")

stdin.on("data", async (key: string) => {
  // Ctrl+C to exit
  if (key === "\u0003") {
    console.log("\nExiting...")
    process.exit()
  }

  switch (key) {
    case "1":
      console.log("📤 Simulating: Session idle...")
      toolCalls += 5
      await telegram.sendWithButtons(
        `✅ *Task Complete!*\n\nYour OpenCode session is idle and ready for new tasks.${formatSessionInfo()}`,
        [
          [
            { text: "📋 View Details", callback_data: `view_${sessionID}` },
            { text: "🆕 New Task", callback_data: `new_${sessionID}` },
          ],
        ]
      )
      console.log("✓ Sent\n")
      break

    case "2":
      console.log("📤 Simulating: Session error...")
      const errorMessage = `Error: ENOENT: no such file or directory, open '/path/to/missing/file.ts'
    at Object.openSync (node:fs:603:3)
    at Object.readFileSync (node:fs:471:35)
    at processFile (/project/src/index.ts:42:18)`
      
      await telegram.sendMessage({
        text: `❌ *Session Error*\n\n${codeBlock(errorMessage)}${formatSessionInfo()}`,
      })
      console.log("✓ Sent\n")
      break

    case "3":
      console.log("📤 Simulating: Permission request...")
      toolCalls++
      const dangerousCommand = "rm -rf /tmp/old-cache/*"
      
      await telegram.sendWithButtons(
        `⚠️ *Permission Request*\n\n` +
        `*Tool:* \`bash\`\n` +
        `*Reason:* Dangerous pattern detected: rm -rf\n\n` +
        `*Command:*\n${codeBlock(dangerousCommand, "bash")}`,
        [
          [
            { text: "✅ Approve", callback_data: `approve_${Date.now()}` },
            { text: "❌ Deny", callback_data: `deny_${Date.now()}` },
          ],
        ]
      )
      console.log("✓ Sent\n")
      break

    case "4":
      console.log("📤 Simulating: Progress update...")
      toolCalls += 3
      
      await telegram.sendMessage({
        text: `⏱️ *Session Update*\n\n` +
          `Your session has been running for a while.\n` +
          `${formatSessionInfo()}\n\n` +
          `_Reply with a message to send a command to OpenCode_`,
      })
      console.log("✓ Sent\n")
      break

    case "5":
      console.log("📤 Simulating: Question with buttons...")
      
      await telegram.sendWithButtons(
        `❓ *Question*\n\nHow would you like to proceed with the deployment?`,
        [
          [
            { text: "🚀 Deploy to Production", callback_data: "deploy_prod" },
          ],
          [
            { text: "🧪 Deploy to Staging", callback_data: "deploy_staging" },
          ],
          [
            { text: "❌ Cancel", callback_data: "deploy_cancel" },
          ],
        ]
      )
      console.log("✓ Sent\n")
      break

    case "6":
      console.log("\nExiting...")
      process.exit()
      break

    default:
      console.log(`Unknown option: ${key}\n`)
  }
})
