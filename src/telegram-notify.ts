/**
 * Telegram Notification Plugin for OpenCode
 * 
 * Provides:
 * - Session completion notifications
 * - Error alerts
 * - Permission request handling (with inline buttons)
 * - Session tracking
 * - Custom notification tools
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { TelegramClient, createTelegramClient, codeBlock } from "./telegram-api"

// Pending approval requests (for permission handling)
const pendingApprovals = new Map<string, {
  resolve: (approved: boolean) => void
  reject: (error: Error) => void
  messageId: number
  timeout: NodeJS.Timeout
}>()

// Session tracking
const sessionTracker = new Map<string, {
  startTime: number
  lastActivity: number
  toolCalls: number
  status: "active" | "waiting" | "idle" | "error"
  lastNotification?: number
}>()

// Configuration
const CONFIG = {
  // Minimum time between status notifications (5 minutes)
  notificationCooldown: 5 * 60 * 1000,
  // Time to wait for approval response (2 minutes)
  approvalTimeout: 2 * 60 * 1000,
  // Tools that might need approval
  dangerousTools: ["bash", "write", "edit"],
  // Patterns that trigger approval requests
  dangerousPatterns: [
    /rm\s+-rf/i,
    /sudo/i,
    /chmod\s+777/i,
    />\s*\/etc\//i,
    /dd\s+if=/i,
    /mkfs/i,
    /format/i,
  ],
}

/**
 * Check if a tool call needs approval
 */
function needsApproval(tool: string, args: any): { needs: boolean; reason?: string } {
  if (!CONFIG.dangerousTools.includes(tool)) {
    return { needs: false }
  }

  // Check bash commands
  if (tool === "bash" && args.command) {
    for (const pattern of CONFIG.dangerousPatterns) {
      if (pattern.test(args.command)) {
        return { needs: true, reason: `Dangerous pattern detected: ${pattern}` }
      }
    }
  }

  // Check file writes to sensitive locations
  if ((tool === "write" || tool === "edit") && args.filePath) {
    const sensitiveLocations = ["/etc/", "/usr/", "/bin/", "/sbin/", "~/.ssh/", "~/.bashrc", "~/.zshrc"]
    for (const loc of sensitiveLocations) {
      if (args.filePath.includes(loc)) {
        return { needs: true, reason: `Writing to sensitive location: ${loc}` }
      }
    }
  }

  return { needs: false }
}

/**
 * Format session info for notification
 */
function formatSessionInfo(sessionID: string): string {
  const session = sessionTracker.get(sessionID)
  if (!session) return ""

  const duration = Math.round((Date.now() - session.startTime) / 1000)
  const minutes = Math.floor(duration / 60)
  const seconds = duration % 60

  return `\n\n📊 *Session Stats*\n` +
    `• Duration: ${minutes}m ${seconds}s\n` +
    `• Tool calls: ${session.toolCalls}`
}

/**
 * Main Telegram Notification Plugin
 */
export const TelegramNotify: Plugin = async ({ client, directory, $ }) => {
  // Check if Telegram is configured
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!botToken || !chatId) {
    console.log("[TelegramNotify] Not configured - set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID")
    return {}
  }

  // Initialize Telegram client
  let telegram: TelegramClient
  try {
    telegram = createTelegramClient()
    const me = await telegram.getMe()
    if (me.ok) {
      console.log(`[TelegramNotify] Connected as @${me.result.username}`)
    }
  } catch (err) {
    console.error("[TelegramNotify] Failed to initialize:", err)
    return {}
  }

  return {
    // =========================================================================
    // Event Handlers
    // =========================================================================

    async event({ event }) {
      // Session idle - task complete
      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID as string
        const session = sessionTracker.get(sessionID)

        // Check cooldown
        if (session?.lastNotification) {
          const timeSince = Date.now() - session.lastNotification
          if (timeSince < CONFIG.notificationCooldown) {
            return // Skip notification
          }
        }

        await telegram.sendWithButtons(
          `✅ *Task Complete!*\n\nYour OpenCode session is idle and ready for new tasks.${formatSessionInfo(sessionID)}`,
          [
            [
              { text: "📋 View Details", callback_data: `view_${sessionID}` },
              { text: "🆕 New Task", callback_data: `new_${sessionID}` },
            ],
          ]
        )

        // Update tracker
        if (session) {
          session.status = "idle"
          session.lastNotification = Date.now()
        }
      }

      // Session error
      if (event.type === "session.error") {
        const sessionID = event.properties?.sessionID as string
        const error = event.properties?.error as string

        await telegram.sendMessage({
          text: `❌ *Session Error*\n\n${codeBlock(error?.slice(0, 500) || "Unknown error")}${formatSessionInfo(sessionID)}`,
        })

        const session = sessionTracker.get(sessionID)
        if (session) {
          session.status = "error"
        }
      }

      // Track session creation
      if (event.type === "session.created") {
        const sessionID = event.properties?.sessionID as string
        sessionTracker.set(sessionID, {
          startTime: Date.now(),
          lastActivity: Date.now(),
          toolCalls: 0,
          status: "active",
        })
      }
    },

    // =========================================================================
    // Tool Execution Hooks
    // =========================================================================

    "tool.execute.before": async (input, output) => {
      const { tool: toolName, sessionID, callID } = input

      // Update session tracker
      const session = sessionTracker.get(sessionID)
      if (session) {
        session.lastActivity = Date.now()
        session.toolCalls++
        session.status = "active"
      }

      // Check if this tool needs approval
      const approval = needsApproval(toolName, output.args)
      if (!approval.needs) return

      // Send approval request
      const argsPreview = JSON.stringify(output.args, null, 2).slice(0, 300)
      const result = await telegram.sendWithButtons(
        `⚠️ *Permission Request*\n\n` +
        `*Tool:* \`${toolName}\`\n` +
        `*Reason:* ${approval.reason}\n\n` +
        `*Arguments:*\n${codeBlock(argsPreview, "json")}`,
        [
          [
            { text: "✅ Approve", callback_data: `approve_${callID}` },
            { text: "❌ Deny", callback_data: `deny_${callID}` },
          ],
        ]
      )

      if (!result.ok || !result.result) {
        console.error("[TelegramNotify] Failed to send approval request:", result.description)
        return // Allow operation to proceed if we can't send notification
      }

      // Wait for approval
      const approved = await new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingApprovals.delete(callID)
          // Auto-deny on timeout
          telegram.editMessage(
            result.result!.message_id,
            `⏰ *Permission Request Expired*\n\nOperation was denied due to timeout.`
          )
          resolve(false)
        }, CONFIG.approvalTimeout)

        pendingApprovals.set(callID, {
          resolve,
          reject,
          messageId: result.result!.message_id,
          timeout,
        })
      })

      if (!approved) {
        throw new Error(`Operation denied by user via Telegram: ${toolName}`)
      }
    },

    "tool.execute.after": async (input, output) => {
      const { tool: toolName, sessionID } = input

      // Update session tracker
      const session = sessionTracker.get(sessionID)
      if (session) {
        session.lastActivity = Date.now()
      }
    },

    // =========================================================================
    // Custom Tools
    // =========================================================================

    tool: {
      /**
       * Send a notification to Telegram
       */
      telegram_send: tool({
        description: "Send a notification message to Telegram. Use this to notify the user about important events, completions, or when you need their attention.",
        args: {
          message: tool.schema.string().describe("The message to send (supports Markdown)"),
          silent: tool.schema.boolean().optional().describe("Send without notification sound"),
        },
        async execute(args, context) {
          const result = await telegram.sendMessage({
            text: args.message,
            disableNotification: args.silent,
          })

          if (result.ok) {
            return `✅ Message sent to Telegram (ID: ${result.result?.message_id})`
          } else {
            return `❌ Failed to send: ${result.description}`
          }
        },
      }),

      /**
       * Ask a question with buttons
       */
      telegram_ask: tool({
        description: "Ask the user a question via Telegram with button options. Returns the selected option.",
        args: {
          question: tool.schema.string().describe("The question to ask"),
          options: tool.schema.string().describe("Comma-separated list of options (e.g., 'Yes,No,Maybe')"),
          timeout: tool.schema.number().optional().describe("Timeout in seconds (default: 120)"),
        },
        async execute(args, context) {
          const options = args.options.split(",").map(o => o.trim())
          const callID = `ask_${Date.now()}`
          const timeoutMs = (args.timeout || 120) * 1000

          // Create button rows (max 3 per row)
          const buttons: { text: string; callback_data: string }[][] = []
          for (let i = 0; i < options.length; i += 3) {
            buttons.push(
              options.slice(i, i + 3).map((opt, idx) => ({
                text: opt,
                callback_data: `${callID}_${i + idx}`,
              }))
            )
          }

          const result = await telegram.sendWithButtons(
            `❓ *Question*\n\n${args.question}`,
            buttons
          )

          if (!result.ok || !result.result) {
            return `❌ Failed to send question: ${result.description}`
          }

          // Wait for response
          const response = await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
              pendingApprovals.delete(callID)
              telegram.editMessage(
                result.result!.message_id,
                `⏰ *Question Expired*\n\n${args.question}\n\n_No response received_`
              )
              resolve("TIMEOUT")
            }, timeoutMs)

            // Store with special handling for multi-option
            pendingApprovals.set(callID, {
              resolve: (approved) => {
                // This will be called with the option index
                resolve(approved ? "approved" : "denied")
              },
              reject,
              messageId: result.result!.message_id,
              timeout,
            })

            // Also store option resolver
            for (let i = 0; i < options.length; i++) {
              pendingApprovals.set(`${callID}_${i}`, {
                resolve: () => {
                  clearTimeout(timeout)
                  pendingApprovals.delete(callID)
                  for (let j = 0; j < options.length; j++) {
                    pendingApprovals.delete(`${callID}_${j}`)
                  }
                  telegram.editMessage(
                    result.result!.message_id,
                    `✅ *Answered*\n\n${args.question}\n\n*Selected:* ${options[i]}`
                  )
                  resolve(options[i])
                },
                reject,
                messageId: result.result!.message_id,
                timeout,
              })
            }
          })

          return response
        },
      }),

      /**
       * Get session status
       */
      telegram_session_status: tool({
        description: "Get the current session status and statistics",
        args: {},
        async execute(args, context) {
          const session = sessionTracker.get(context.sessionID)
          if (!session) {
            return "No session tracking data available"
          }

          const duration = Math.round((Date.now() - session.startTime) / 1000)
          const minutes = Math.floor(duration / 60)
          const seconds = duration % 60

          return JSON.stringify({
            sessionID: context.sessionID.slice(0, 8),
            status: session.status,
            duration: `${minutes}m ${seconds}s`,
            toolCalls: session.toolCalls,
            lastActivity: new Date(session.lastActivity).toISOString(),
          }, null, 2)
        },
      }),
    },
  }
}

/**
 * Handle incoming webhook updates from Telegram
 * This should be called by the webhook server
 */
export function handleTelegramUpdate(update: any): void {
  // Handle callback queries (button clicks)
  if (update.callback_query) {
    const callbackData = update.callback_query.data
    const callbackId = update.callback_query.id

    // Find pending approval
    const pending = pendingApprovals.get(callbackData.split("_").slice(0, 2).join("_")) ||
                   pendingApprovals.get(callbackData)

    if (pending) {
      clearTimeout(pending.timeout)
      
      if (callbackData.startsWith("approve_")) {
        pending.resolve(true)
        pendingApprovals.delete(callbackData.replace("approve_", ""))
      } else if (callbackData.startsWith("deny_")) {
        pending.resolve(false)
        pendingApprovals.delete(callbackData.replace("deny_", ""))
      } else {
        // Multi-option response
        pending.resolve(true)
      }
    }

    // Acknowledge the callback
    const telegram = createTelegramClient()
    telegram.answerCallbackQuery(callbackId, { text: "Received!" })
  }

  // Handle text messages (command injection)
  if (update.message?.text) {
    const text = update.message.text
    const chatId = update.message.chat.id

    // Verify it's from the authorized chat
    if (String(chatId) !== process.env.TELEGRAM_CHAT_ID) {
      console.log(`[TelegramNotify] Ignoring message from unauthorized chat: ${chatId}`)
      return
    }

    // Inject command into OpenCode via REST API
    const opencodePort = process.env.OPENCODE_PORT || "4096"
    
    fetch(`http://localhost:${opencodePort}/tui/append-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
      .then(() => fetch(`http://localhost:${opencodePort}/tui/submit-prompt`, { method: "POST" }))
      .then(() => {
        const telegram = createTelegramClient()
        telegram.sendMessage({ text: `📤 Command sent to OpenCode:\n\`${text.slice(0, 100)}\`` })
      })
      .catch((err) => {
        console.error("[TelegramNotify] Failed to inject command:", err)
        const telegram = createTelegramClient()
        telegram.sendMessage({ text: `❌ Failed to send command: ${err.message}` })
      })
  }
}

export default TelegramNotify
