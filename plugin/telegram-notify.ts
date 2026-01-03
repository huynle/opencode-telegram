/**
 * Telegram Notification Plugin for OpenCode
 * 
 * Provides:
 * - Session completion notifications
 * - Error alerts
 * - Permission request handling (with inline buttons)
 * - Session tracking
 * - Custom notification tools
 * - Two-way communication (receive button clicks and text responses)
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// ============================================================================
// Telegram API Client (inline to avoid import issues)
// ============================================================================

interface SendMessageOptions {
  text: string
  chatId?: string
  parseMode?: "Markdown" | "MarkdownV2" | "HTML"
  disableNotification?: boolean
  replyToMessageId?: number
  replyMarkup?: {
    inline_keyboard: { text: string; callback_data?: string; url?: string }[][]
  }
}

interface TelegramResponse<T = any> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number }
    text?: string
    date: number
  }
  callback_query?: {
    id: string
    from: { id: number; first_name: string }
    message?: { message_id: number; chat: { id: number } }
    data?: string
  }
}

class TelegramClient {
  private baseUrl: string
  private defaultChatId: string
  private lastUpdateId: number = 0

  constructor(botToken: string, chatId: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`
    this.defaultChatId = chatId
  }

  async sendMessage(options: SendMessageOptions): Promise<TelegramResponse> {
    const body: Record<string, any> = {
      chat_id: options.chatId || this.defaultChatId,
      text: options.text,
      parse_mode: options.parseMode || "Markdown",
    }

    if (options.disableNotification) {
      body.disable_notification = true
    }

    if (options.replyToMessageId) {
      body.reply_to_message_id = options.replyToMessageId
    }

    if (options.replyMarkup) {
      body.reply_markup = JSON.stringify(options.replyMarkup)
    }

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    return response.json() as Promise<TelegramResponse>
  }

  async sendWithButtons(
    text: string,
    buttons: { text: string; callback_data?: string }[][],
    options?: Partial<SendMessageOptions>
  ): Promise<TelegramResponse> {
    return this.sendMessage({
      text,
      replyMarkup: { inline_keyboard: buttons },
      ...options,
    })
  }

  async getMe(): Promise<TelegramResponse> {
    const response = await fetch(`${this.baseUrl}/getMe`)
    return response.json() as Promise<TelegramResponse>
  }

  async getUpdates(timeout: number = 0): Promise<TelegramResponse<TelegramUpdate[]>> {
    const params = new URLSearchParams({
      offset: String(this.lastUpdateId + 1),
      timeout: String(timeout),
      allowed_updates: JSON.stringify(["message", "callback_query"]),
    })
    
    const response = await fetch(`${this.baseUrl}/getUpdates?${params}`)
    const result = await response.json() as TelegramResponse<TelegramUpdate[]>
    
    // NOTE: Don't auto-advance offset here - call acknowledgeUpdate() explicitly
    // after successfully processing an update
    
    return result
  }

  // Call this after successfully processing an update to prevent re-processing
  acknowledgeUpdate(updateId: number): void {
    if (updateId > this.lastUpdateId) {
      this.lastUpdateId = updateId
    }
  }

  // Acknowledge all updates up to and including the highest ID in the batch
  acknowledgeUpdates(updates: TelegramUpdate[]): void {
    if (updates.length > 0) {
      this.lastUpdateId = Math.max(...updates.map(u => u.update_id))
    }
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    options?: { text?: string; showAlert?: boolean }
  ): Promise<TelegramResponse<boolean>> {
    const body: Record<string, any> = {
      callback_query_id: callbackQueryId,
    }

    if (options?.text) body.text = options.text
    if (options?.showAlert) body.show_alert = true

    const response = await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    return response.json() as Promise<TelegramResponse<boolean>>
  }

  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    parseMode?: string
  ): Promise<TelegramResponse> {
    const body: Record<string, any> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode || "Markdown",
    }

    const response = await fetch(`${this.baseUrl}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    return response.json() as Promise<TelegramResponse>
  }
}

function codeBlock(code: string, language?: string): string {
  if (language) {
    return `\`\`\`${language}\n${code}\n\`\`\``
  }
  return `\`\`\`\n${code}\n\`\`\``
}

// ============================================================================
// Plugin State
// ============================================================================

// Task tracking for explicit task mode
interface TrackedTask {
  name: string
  sessionID: string
  startTime: number
  lastUpdate: number
  toolCalls: number
  threadMessageId: number  // The initial message that starts the reply thread
  status: "running" | "complete" | "error"
  lastProgressUpdate?: number  // For throttling progress updates
}

// Active tasks (by sessionID)
const activeTasks = new Map<string, TrackedTask>()

// Session tracking (for non-task mode)
const sessionTracker = new Map<string, {
  startTime: number
  lastActivity: number
  toolCalls: number
  status: "active" | "waiting" | "idle" | "error"
  lastNotification?: number
}>()

// Pending questions waiting for responses
interface PendingQuestion {
  messageId: number
  question: string
  options: string[]
  callbackPrefix: string
  createdAt: number
  resolved: boolean
  response?: string
}

const pendingQuestions = new Map<string, PendingQuestion>()

// Configuration
const CONFIG = {
  // Minimum time between status notifications (5 minutes)
  notificationCooldown: 5 * 60 * 1000,
  // Minimum time between progress updates in task mode (30 seconds)
  progressUpdateInterval: 30 * 1000,
  // Tools that might need approval
  dangerousTools: ["bash", "write", "edit"],
  // Patterns that trigger approval requests
  dangerousPatterns: [
    /rm\s+-rf/i,
    /sudo/i,
    /chmod\s+777/i,
    />\s*\/etc\//i,
  ],
  // Polling settings
  pollInterval: 500, // 500ms between polls
  pollTimeout: 120000, // 2 minutes max wait
  // Tools that are waiting for user input (suppress idle notifications)
  waitingTools: ["telegram_prompt", "telegram_ask", "telegram_confirm"],
}

// Track if we're currently waiting for user input
let waitingForInput = false

/**
 * Check if a tool call needs approval
 */
function needsApproval(toolName: string, args: any): { needs: boolean; reason?: string } {
  if (!CONFIG.dangerousTools.includes(toolName)) {
    return { needs: false }
  }

  if (toolName === "bash" && args.command) {
    for (const pattern of CONFIG.dangerousPatterns) {
      if (pattern.test(args.command)) {
        return { needs: true, reason: `Dangerous pattern: ${pattern}` }
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

// ============================================================================
// Main Plugin
// ============================================================================

export const TelegramNotify: Plugin = async ({ client, directory, $ }) => {
  // Check if Telegram is configured
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!botToken || !chatId) {
    return {}
  }

  // Initialize Telegram client
  const telegram = new TelegramClient(botToken, chatId)
  
  try {
    const me = await telegram.getMe()
    if (!me.ok) {
      return {}
    }
  } catch (err) {
    return {}
  }

  return {
    // =========================================================================
    // Event Handlers
    // =========================================================================

    async event({ event }) {
      // Session idle - task complete
      if (event.type === "session.idle") {
        // Don't send idle notification if we're waiting for user input
        if (waitingForInput) {
          return
        }

        const props = event.properties as any
        const sessionID = props?.id || props?.sessionID || "unknown"
        
        // Check if this session has an active task
        const task = activeTasks.get(sessionID)
        if (task && task.status === "running") {
          // Complete the task with a reply to the thread
          const duration = Math.round((Date.now() - task.startTime) / 1000)
          const minutes = Math.floor(duration / 60)
          const seconds = duration % 60
          
          await telegram.sendMessage({
            text: `✅ *Complete!*\n\n` +
              `• Duration: ${minutes}m ${seconds}s\n` +
              `• Tool calls: ${task.toolCalls}`,
            replyToMessageId: task.threadMessageId,
            disableNotification: true,
          })
          
          task.status = "complete"
          activeTasks.delete(sessionID)
          return
        }

        // Non-task mode: check cooldown and send standalone notification
        const session = sessionTracker.get(sessionID)
        if (session?.lastNotification) {
          const timeSince = Date.now() - session.lastNotification
          if (timeSince < CONFIG.notificationCooldown) {
            return
          }
        }

        // Only send if no active task (explicit task mode disables auto-notifications)
        if (!task) {
          await telegram.sendWithButtons(
            `✅ *Task Complete!*\n\nYour OpenCode session is idle.${formatSessionInfo(sessionID)}`,
            [
              [
                { text: "📋 View Details", callback_data: `view_${sessionID}` },
                { text: "🆕 New Task", callback_data: `new_${sessionID}` },
              ],
            ]
          )

          if (session) {
            session.status = "idle"
            session.lastNotification = Date.now()
          }
        }
      }

      // Session error
      if (event.type === "session.error") {
        const props = event.properties as any
        const sessionID = props?.id || props?.sessionID || "unknown"
        const errorProp = props?.error
        const errorMessage = typeof errorProp === "string" 
          ? errorProp 
          : errorProp?.message || "Unknown error"

        // Check if this session has an active task
        const task = activeTasks.get(sessionID)
        if (task) {
          // Send error as reply to task thread
          await telegram.sendMessage({
            text: `❌ *Error*\n\n${codeBlock(errorMessage.slice(0, 500))}`,
            replyToMessageId: task.threadMessageId,
          })
          task.status = "error"
          activeTasks.delete(sessionID)
        } else {
          // Standalone error notification
          await telegram.sendMessage({
            text: `❌ *Session Error*\n\n${codeBlock(errorMessage.slice(0, 500))}${formatSessionInfo(sessionID)}`,
          })
        }

        const session = sessionTracker.get(sessionID)
        if (session) {
          session.status = "error"
        }
      }

      // Track session creation
      if (event.type === "session.created") {
        const props = event.properties as any
        const sessionID = props?.id || props?.sessionID || props?.info?.id
        if (sessionID) {
          sessionTracker.set(sessionID, {
            startTime: Date.now(),
            lastActivity: Date.now(),
            toolCalls: 0,
            status: "active",
          })
        }
      }
    },

    // =========================================================================
    // Tool Execution Hooks
    // =========================================================================

    "tool.execute.before": async (input, output) => {
      const { tool: toolName, sessionID } = input

      // Update session tracker
      const session = sessionTracker.get(sessionID)
      if (session) {
        session.lastActivity = Date.now()
        session.toolCalls++
        session.status = "active"
      }

      // Update task tracker if active
      const task = activeTasks.get(sessionID)
      if (task) {
        task.toolCalls++
        task.lastUpdate = Date.now()
        
        // Send progress update if enough time has passed
        if (!task.lastProgressUpdate || 
            Date.now() - task.lastProgressUpdate > CONFIG.progressUpdateInterval) {
          const duration = Math.round((Date.now() - task.startTime) / 1000)
          const minutes = Math.floor(duration / 60)
          const seconds = duration % 60
          
          await telegram.sendMessage({
            text: `⏳ *Progress*: ${task.toolCalls} tool calls, ${minutes}m ${seconds}s`,
            replyToMessageId: task.threadMessageId,
            disableNotification: true,
          })
          task.lastProgressUpdate = Date.now()
        }
      }

      // Check if this tool needs approval (just log for now, don't block)
      const approval = needsApproval(toolName, output.args)
      if (approval.needs) {
        const argsPreview = JSON.stringify(output.args, null, 2).slice(0, 300)
        const replyTo = task?.threadMessageId
        await telegram.sendWithButtons(
          `⚠️ *Dangerous Operation Detected*\n\n` +
          `*Tool:* \`${toolName}\`\n` +
          `*Reason:* ${approval.reason}\n\n` +
          `*Args:*\n${codeBlock(argsPreview, "json")}`,
          [
            [
              { text: "👀 Acknowledged", callback_data: `ack_${Date.now()}` },
            ],
          ],
          replyTo ? { replyToMessageId: replyTo } : undefined
        )
      }
    },

    "tool.execute.after": async (input, output) => {
      const { sessionID } = input
      const session = sessionTracker.get(sessionID)
      if (session) {
        session.lastActivity = Date.now()
      }
    },

    // =========================================================================
    // Custom Tools
    // =========================================================================

    tool: {
      telegram_send: tool({
        description: "Send a notification message to Telegram. Use this to notify the user about important events.",
        args: {
          message: tool.schema.string().describe("The message to send (supports Markdown)"),
          silent: tool.schema.boolean().optional().describe("Send without notification sound"),
        },
        async execute(args) {
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

      telegram_start_task: tool({
        description: "Start tracking a task with Telegram notifications. Use this when the user asks to be notified, wants updates on Telegram, says 'track this', 'notify me when done', 'let me know on telegram', or similar phrases. All updates will be grouped in a reply thread. The task auto-completes when the session goes idle.",
        args: {
          name: tool.schema.string().describe("Short name/description of the task being tracked"),
        },
        async execute(args, context) {
          const { sessionID } = context
          
          // Check if there's already an active task for this session
          if (activeTasks.has(sessionID)) {
            return `⚠️ Task already active for this session. Complete it first or use telegram_end_task.`
          }
          
          // Send the initial message that starts the thread
          const result = await telegram.sendMessage({
            text: `📋 *Task Started*\n\n*${args.name}*\n\n_Updates will appear as replies..._`,
          })
          
          if (!result.ok) {
            return `❌ Failed to start task: ${result.description}`
          }
          
          const threadMessageId = result.result?.message_id
          if (!threadMessageId) {
            return `❌ Failed to get message ID for thread`
          }
          
          // Create the task tracker
          const task: TrackedTask = {
            name: args.name,
            sessionID,
            startTime: Date.now(),
            lastUpdate: Date.now(),
            toolCalls: 0,
            threadMessageId,
            status: "running",
          }
          
          activeTasks.set(sessionID, task)
          
          return `✅ Task "${args.name}" started. All updates will be grouped in a thread. Task will auto-complete when session goes idle.`
        },
      }),

      telegram_task_update: tool({
        description: "Send a progress update for the current task. Use this to report significant milestones.",
        args: {
          message: tool.schema.string().describe("Progress update message"),
        },
        async execute(args, context) {
          const { sessionID } = context
          const task = activeTasks.get(sessionID)
          
          if (!task) {
            return `⚠️ No active task. Use telegram_start_task first.`
          }
          
          const duration = Math.round((Date.now() - task.startTime) / 1000)
          const minutes = Math.floor(duration / 60)
          const seconds = duration % 60
          
          const result = await telegram.sendMessage({
            text: `📝 *Update*\n\n${args.message}\n\n_${minutes}m ${seconds}s elapsed, ${task.toolCalls} tool calls_`,
            replyToMessageId: task.threadMessageId,
            disableNotification: true,
          })
          
          if (result.ok) {
            task.lastUpdate = Date.now()
            return `✅ Update sent to task thread`
          } else {
            return `❌ Failed to send update: ${result.description}`
          }
        },
      }),

      telegram_end_task: tool({
        description: "Manually end the current task with a final message. Use this if you want to end a task before the session goes idle.",
        args: {
          message: tool.schema.string().optional().describe("Optional final message/summary"),
        },
        async execute(args, context) {
          const { sessionID } = context
          const task = activeTasks.get(sessionID)
          
          if (!task) {
            return `⚠️ No active task to end.`
          }
          
          const duration = Math.round((Date.now() - task.startTime) / 1000)
          const minutes = Math.floor(duration / 60)
          const seconds = duration % 60
          
          const finalMessage = args.message 
            ? `✅ *Complete!*\n\n${args.message}\n\n• Duration: ${minutes}m ${seconds}s\n• Tool calls: ${task.toolCalls}`
            : `✅ *Complete!*\n\n• Duration: ${minutes}m ${seconds}s\n• Tool calls: ${task.toolCalls}`
          
          const result = await telegram.sendMessage({
            text: finalMessage,
            replyToMessageId: task.threadMessageId,
          })
          
          task.status = "complete"
          activeTasks.delete(sessionID)
          
          if (result.ok) {
            return `✅ Task "${task.name}" completed`
          } else {
            return `⚠️ Task ended but failed to send final message: ${result.description}`
          }
        },
      }),

      telegram_ask: tool({
        description: "Ask the user a question via Telegram with button options. Waits for and returns the user's response.",
        args: {
          question: tool.schema.string().describe("The question to ask"),
          options: tool.schema.string().describe("Comma-separated list of options"),
        },
        async execute(args) {
          waitingForInput = true
          const options = args.options.split(",").map(o => o.trim())
          const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          
          const buttons = options.map((opt, idx) => [
            { text: opt, callback_data: `${questionId}_${idx}` }
          ])

          const result = await telegram.sendWithButtons(
            `❓ *Question*\n\n${args.question}\n\n_Waiting for your response..._`,
            buttons
          )

          if (!result.ok) {
            waitingForInput = false
            return `❌ Failed to send: ${result.description}`
          }

          // Track this pending question
          const pending: PendingQuestion = {
            messageId: result.result?.message_id || 0,
            question: args.question,
            options,
            callbackPrefix: questionId,
            createdAt: Date.now(),
            resolved: false,
          }
          pendingQuestions.set(questionId, pending)

          // Poll for response
          const startTime = Date.now()
          while (Date.now() - startTime < CONFIG.pollTimeout) {
            // Check if already resolved by background polling
            if (pending.resolved && pending.response !== undefined) {
              waitingForInput = false
              return `User selected: ${pending.response}`
            }

            // Poll for updates
            const updates = await telegram.getUpdates(0) // Non-blocking poll
            if (updates.ok && updates.result) {
              for (const update of updates.result) {
                if (update.callback_query?.data?.startsWith(questionId)) {
                  const optionIdx = parseInt(update.callback_query.data.split("_").pop() || "0")
                  const selectedOption = options[optionIdx] || "Unknown"
                  
                  // Acknowledge this update
                  telegram.acknowledgeUpdate(update.update_id)
                  
                  // Answer the callback to remove loading state
                  await telegram.answerCallbackQuery(update.callback_query.id, {
                    text: `Selected: ${selectedOption}`,
                  })

                  // Update the message to show selection
                  if (result.result?.message_id) {
                    await telegram.editMessageText(
                      update.callback_query.message?.chat.id || "",
                      result.result.message_id,
                      `❓ *Question*\n\n${args.question}\n\n✅ *Selected:* ${selectedOption}`
                    )
                  }

                  // Mark as resolved
                  pending.resolved = true
                  pending.response = selectedOption
                  pendingQuestions.delete(questionId)

                  waitingForInput = false
                  return `User selected: ${selectedOption}`
                }
              }
              // Acknowledge all updates we've seen
              telegram.acknowledgeUpdates(updates.result)
            }

            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, CONFIG.pollInterval))
          }

          // Timeout - clean up
          waitingForInput = false
          pendingQuestions.delete(questionId)
          
          // Update message to show timeout
          if (result.result?.message_id) {
            await telegram.editMessageText(
              result.result.message_id,
              result.result.message_id,
              `❓ *Question*\n\n${args.question}\n\n⏰ _Response timed out_`
            )
          }

          return `⏰ No response received within ${CONFIG.pollTimeout / 1000} seconds`
        },
      }),

      telegram_status: tool({
        description: "Get the current session status",
        args: {},
        async execute(args, context) {
          const session = sessionTracker.get(context.sessionID)
          if (!session) {
            return "No session tracking data available"
          }

          const duration = Math.round((Date.now() - session.startTime) / 1000)
          return JSON.stringify({
            sessionID: context.sessionID.slice(0, 8),
            status: session.status,
            duration: `${Math.floor(duration / 60)}m ${duration % 60}s`,
            toolCalls: session.toolCalls,
            pendingQuestions: pendingQuestions.size,
          }, null, 2)
        },
      }),

      telegram_prompt: tool({
        description: "Send a prompt to Telegram and wait for the user to type a text response. Use this when you need free-form text input from the user.",
        args: {
          prompt: tool.schema.string().describe("The prompt/question to send"),
          timeout: tool.schema.number().optional().describe("Timeout in seconds (default: 120)"),
        },
        async execute(args) {
          waitingForInput = true
          try {
            const timeoutMs = (args.timeout || 120) * 1000
            
            // Record the timestamp BEFORE sending (Unix timestamp in seconds)
            const sentAtTimestamp = Math.floor(Date.now() / 1000)
            
            const result = await telegram.sendMessage({
              text: `💬 *Input Requested*\n\n${args.prompt}\n\n_Please type your response..._`,
            })

            if (!result.ok) {
              waitingForInput = false
              return `❌ Failed to send: ${result.description}`
            }

            // Poll for text message response
            const startTime = Date.now()

            while (Date.now() - startTime < timeoutMs) {
              try {
                const updates = await telegram.getUpdates(0) // Non-blocking poll
                if (updates.ok && updates.result && updates.result.length > 0) {
                  for (const update of updates.result) {
                    // Look for text messages (not callback queries) that arrived AFTER we sent
                    // Use Telegram's message.date (Unix timestamp) to compare
                    if (update.message?.text && update.message.date >= sentAtTimestamp) {
                      const response = update.message.text
                      
                      // Acknowledge this update so we don't process it again
                      telegram.acknowledgeUpdate(update.update_id)
                      
                      // Confirm receipt
                      await telegram.sendMessage({
                        text: `✅ Received: _${response.slice(0, 50)}${response.length > 50 ? "..." : ""}_`,
                        disableNotification: true,
                      })

                      waitingForInput = false
                      return `User responded: ${response}`
                    }
                  }
                  // Acknowledge all updates we've seen (even if not matching our criteria)
                  // to avoid re-processing old messages
                  telegram.acknowledgeUpdates(updates.result)
                }
              } catch (pollError) {
                // Continue polling despite errors
              }

              await new Promise(resolve => setTimeout(resolve, CONFIG.pollInterval))
            }

            waitingForInput = false
            return `⏰ No response received within ${timeoutMs / 1000} seconds`
          } catch (error) {
            waitingForInput = false
            const errMsg = error instanceof Error ? error.message : String(error)
            return `❌ Error: ${errMsg}`
          }
        },
      }),

      telegram_confirm: tool({
        description: "Ask for a simple Yes/No confirmation via Telegram. Returns true if confirmed, false if denied.",
        args: {
          message: tool.schema.string().describe("The confirmation message"),
        },
        async execute(args) {
          waitingForInput = true
          const confirmId = `confirm_${Date.now()}`
          
          const result = await telegram.sendWithButtons(
            `⚠️ *Confirmation Required*\n\n${args.message}`,
            [
              [
                { text: "✅ Yes", callback_data: `${confirmId}_yes` },
                { text: "❌ No", callback_data: `${confirmId}_no` },
              ],
            ]
          )

          if (!result.ok) {
            waitingForInput = false
            return `❌ Failed to send: ${result.description}`
          }

          // Poll for response
          const startTime = Date.now()
          while (Date.now() - startTime < CONFIG.pollTimeout) {
            const updates = await telegram.getUpdates(0) // Non-blocking poll
            if (updates.ok && updates.result) {
              for (const update of updates.result) {
                if (update.callback_query?.data?.startsWith(confirmId)) {
                  const confirmed = update.callback_query.data.endsWith("_yes")
                  
                  // Acknowledge this update
                  telegram.acknowledgeUpdate(update.update_id)
                  
                  await telegram.answerCallbackQuery(update.callback_query.id, {
                    text: confirmed ? "Confirmed!" : "Declined",
                  })

                  if (result.result?.message_id) {
                    await telegram.editMessageText(
                      update.callback_query.message?.chat.id || "",
                      result.result.message_id,
                      `⚠️ *Confirmation Required*\n\n${args.message}\n\n${confirmed ? "✅ *Confirmed*" : "❌ *Declined*"}`
                    )
                  }

                  waitingForInput = false
                  return confirmed ? "User confirmed: Yes" : "User declined: No"
                }
              }
              // Acknowledge all updates we've seen
              telegram.acknowledgeUpdates(updates.result)
            }

            await new Promise(resolve => setTimeout(resolve, CONFIG.pollInterval))
          }

          waitingForInput = false
          return `⏰ No response received within ${CONFIG.pollTimeout / 1000} seconds`
        },
      }),
    },
  }
}

export default TelegramNotify
