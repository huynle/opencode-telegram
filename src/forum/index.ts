/**
 * Forum Topic Support - Public API
 * 
 * This module provides the complete forum topic support layer for integrating
 * a Telegram supergroup with OpenCode. Each forum topic maps to one OpenCode session.
 * 
 * ## Quick Start
 * 
 * ```typescript
 * import { Bot } from "grammy"
 * import { createForumBot } from "./forum"
 * 
 * // Your OpenCode client implementation
 * const opencode: IOpenCodeClient = { ... }
 * 
 * // Create the bot with forum support
 * const bot = await createForumBot({
 *   botToken: process.env.TELEGRAM_BOT_TOKEN!,
 *   opencode,
 *   databasePath: "./data/topics.db",
 *   allowedChatIds: [Number(process.env.TELEGRAM_CHAT_ID)],
 * })
 * 
 * // Start the bot
 * bot.start()
 * ```
 * 
 * ## Architecture
 * 
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    Telegram Supergroup                       │
 * │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
 * │  │ Topic A  │  │ Topic B  │  │ Topic C  │  │ General  │     │
 * │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
 * └───────┼─────────────┼─────────────┼─────────────┼───────────┘
 *         │             │             │             │
 *         ▼             ▼             ▼             ▼
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    grammY Bot + Handlers                     │
 * │  • Detects forum_topic_created/closed/reopened              │
 * │  • Routes messages to correct session                        │
 * │  • Sends responses back to topics                            │
 * └────────────────────────────┬────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      TopicManager                            │
 * │  • Creates OpenCode sessions for new topics                  │
 * │  • Maintains topic→session mapping                           │
 * │  • Handles topic lifecycle                                   │
 * └────────────────────────────┬────────────────────────────────┘
 *                              │
 *         ┌────────────────────┴────────────────────┐
 *         ▼                                         ▼
 * ┌───────────────┐                     ┌───────────────────────┐
 * │  TopicStore   │                     │   OpenCode Sessions   │
 * │  (SQLite)     │                     │  ┌─────┐ ┌─────┐      │
 * │               │                     │  │Sess │ │Sess │ ...  │
 * │ topic→session │                     │  │  A  │ │  B  │      │
 * │   mappings    │                     │  └─────┘ └─────┘      │
 * └───────────────┘                     └───────────────────────┘
 * ```
 */

// Re-export all public APIs
export { TopicStore, createTopicStore } from "./topic-store"
export { TopicManager, createTopicManager } from "./topic-manager"
export {
  createForumHandlers,
  createForumCommands,
  createTopicResponseHandler,
  sendToTopic,
  isForumEnabled,
  withForumContext,
  type ForumHandlerOptions,
  type ForumContext,
} from "../bot/handlers/forum"
export * from "../types/forum"

// ============================================================================
// Integration Example
// ============================================================================

import { Bot } from "grammy"
import type { IOpenCodeClient, ResponseHandler, TopicManagerConfig } from "../types/forum"
import { TopicManager } from "./topic-manager"
import { 
  createForumHandlers, 
  createForumCommands,
  createTopicResponseHandler,
} from "../bot/handlers/forum"

/**
 * Options for creating a forum-enabled bot
 */
export interface ForumBotOptions {
  // Telegram bot token
  botToken: string
  
  // OpenCode client for session management
  opencode: IOpenCodeClient
  
  // SQLite database path for persistence
  databasePath?: string
  
  // Allowed chat IDs (undefined = all supergroups)
  allowedChatIds?: number[]
  
  // Allowed user IDs (undefined = all users)
  allowedUserIds?: number[]
  
  // Handle the General topic (message_thread_id = undefined)
  handleGeneralTopic?: boolean
  
  // Additional topic manager configuration
  topicManagerConfig?: Partial<TopicManagerConfig>
  
  // Custom error handler
  onError?: (error: Error, chatId: number, topicId: number) => Promise<void>
}

/**
 * Create a grammY bot with full forum topic support
 * 
 * This is the main entry point for setting up a forum-enabled Telegram bot
 * that integrates with OpenCode.
 * 
 * @example
 * ```typescript
 * const bot = await createForumBot({
 *   botToken: process.env.TELEGRAM_BOT_TOKEN!,
 *   opencode: myOpenCodeClient,
 *   allowedChatIds: [-1001234567890],
 * })
 * 
 * // Add custom handlers if needed
 * bot.bot.command("help", (ctx) => ctx.reply("Help message"))
 * 
 * // Start the bot
 * bot.start()
 * ```
 */
export async function createForumBot(options: ForumBotOptions) {
  const {
    botToken,
    opencode,
    databasePath = "./data/topics.db",
    allowedChatIds,
    allowedUserIds,
    handleGeneralTopic = true,
    topicManagerConfig,
    onError,
  } = options

  // Create the grammY bot
  const bot = new Bot(botToken)

  // Create response handler that sends messages to topics
  const responseHandler: ResponseHandler = createTopicResponseHandler(bot)

  // Create the topic manager
  const topicManager = new TopicManager(opencode, responseHandler, {
    databasePath,
    handleGeneralTopic,
    autoCreateSessions: true,
    ...topicManagerConfig,
  })

  // Register forum handlers
  bot.use(createForumHandlers({
    topicManager,
    handleGeneralTopic,
    allowedChatIds,
    allowedUserIds,
    onError: onError ? async (error, ctx) => {
      const chatId = ctx.chat?.id ?? 0
      const topicId = ctx.message?.message_thread_id ?? 0
      await onError(error, chatId, topicId)
    } : undefined,
  }))

  // Register forum commands
  bot.use(createForumCommands(topicManager))

  // Error handler
  bot.catch((err) => {
    console.error("[ForumBot] Unhandled error:", err)
  })

  return {
    bot,
    topicManager,
    responseHandler,
    
    /**
     * Start the bot (long polling mode)
     */
    start: () => {
      console.log("[ForumBot] Starting in long polling mode...")
      return bot.start({
        allowed_updates: [
          "message",
          "edited_message",
          "callback_query",
        ],
        onStart: (info) => {
          console.log(`[ForumBot] Started as @${info.username}`)
        },
      })
    },

    /**
     * Stop the bot gracefully
     */
    stop: () => {
      console.log("[ForumBot] Stopping...")
      topicManager.close()
      return bot.stop()
    },

    /**
     * Handle a webhook update
     */
    handleUpdate: (update: unknown) => {
      return bot.handleUpdate(update as any)
    },

    /**
     * Get mapping for a topic (useful for sending responses)
     */
    getMapping: (chatId: number, topicId: number) => {
      return topicManager.getMapping(chatId, topicId)
    },

    /**
     * Send a response to a specific topic
     */
    sendResponse: async (chatId: number, topicId: number, text: string) => {
      await responseHandler(chatId, topicId, text)
    },
  }
}

// ============================================================================
// Example OpenCode Client Mock (for testing)
// ============================================================================

/**
 * Mock OpenCode client for testing
 * 
 * Replace this with your actual OpenCodeClient implementation.
 */
export function createMockOpenCodeClient(): IOpenCodeClient {
  const sessions = new Map<string, { id: string; status: string }>()

  return {
    async createSession(config) {
      const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      sessions.set(id, { id, status: "active" })
      console.log(`[MockOpenCode] Created session: ${id}`)
      return { id }
    },

    async sendMessage(sessionId, message) {
      console.log(`[MockOpenCode] Message to ${sessionId}: ${message.slice(0, 50)}...`)
      // In real implementation, this would send to OpenCode and handle SSE responses
    },

    async getSession(sessionId) {
      return sessions.get(sessionId) ?? null
    },

    async closeSession(sessionId) {
      sessions.delete(sessionId)
      console.log(`[MockOpenCode] Closed session: ${sessionId}`)
    },
  }
}
