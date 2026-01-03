/**
 * grammY Forum Topic Handlers
 * 
 * Provides middleware and handlers for forum topic events in a Telegram supergroup.
 * Uses grammY's built-in forum topic support to:
 * - Detect new topics being created
 * - Handle topic lifecycle events (closed, reopened, edited)
 * - Route messages to the correct OpenCode sessions
 */

import { Bot, Composer, Context, Filter } from "grammy"
import type { ForumMessageContext } from "../../types/forum"
import type { TopicManager } from "../../forum/topic-manager"

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Extended context with forum helper methods
 */
export interface ForumContext extends Context {
  // Convenience method to get the topic ID (0 for General topic)
  getTopicId: () => number
  // Check if this message is in the General topic
  isGeneralTopic: () => boolean
  // Get the forum message context for routing
  getForumContext: () => ForumMessageContext | null
}

/**
 * Create a forum-aware context with helper methods
 */
export function withForumContext<C extends Context>(ctx: C): C & ForumContext {
  const extended = ctx as C & ForumContext

  extended.getTopicId = () => {
    // message_thread_id is undefined for General topic, we use 0 to represent it
    return ctx.message?.message_thread_id ?? 0
  }

  extended.isGeneralTopic = () => {
    return ctx.message?.message_thread_id === undefined
  }

  extended.getForumContext = () => {
    const message = ctx.message
    if (!message || !message.text) return null

    return {
      messageId: message.message_id,
      chatId: message.chat.id,
      topicId: message.message_thread_id ?? 0,
      userId: message.from?.id ?? 0,
      username: message.from?.username,
      text: message.text,
      replyToMessageId: message.reply_to_message?.message_id,
      isGeneralTopic: message.message_thread_id === undefined,
      isReply: message.reply_to_message !== undefined,
    }
  }

  return extended
}

// ============================================================================
// Handler Factory
// ============================================================================

/**
 * Options for creating forum handlers
 */
export interface ForumHandlerOptions {
  // The topic manager instance
  topicManager: TopicManager
  
  // Whether to handle the General topic (message_thread_id = undefined)
  handleGeneralTopic?: boolean
  
  // Chats to accept messages from (undefined = all supergroups)
  allowedChatIds?: number[]
  
  // User IDs allowed to interact (undefined = all users)
  allowedUserIds?: number[]
  
  // Callback when a response should be sent to a topic
  onResponse?: (chatId: number, topicId: number, response: string) => Promise<void>
  
  // Callback when an error occurs
  onError?: (error: Error, ctx: Context) => Promise<void>
}

/**
 * Create forum topic handlers for a grammY bot
 * 
 * Returns a Composer with all forum-related middleware configured.
 */
export function createForumHandlers(options: ForumHandlerOptions): Composer<Context> {
  const composer = new Composer<Context>()
  const { topicManager, handleGeneralTopic = true, allowedChatIds, allowedUserIds } = options

  // =========================================================================
  // Middleware: Authorization Filter
  // =========================================================================
  
  composer.use(async (ctx, next) => {
    // Only process messages from supergroups
    if (ctx.chat?.type !== "supergroup") {
      return next()
    }

    // Check if chat is allowed
    if (allowedChatIds && allowedChatIds.length > 0) {
      if (!allowedChatIds.includes(ctx.chat.id)) {
        console.log(`[ForumHandlers] Ignoring message from unauthorized chat: ${ctx.chat.id}`)
        return
      }
    }

    // Check if user is allowed
    if (allowedUserIds && allowedUserIds.length > 0) {
      const userId = ctx.from?.id
      if (!userId || !allowedUserIds.includes(userId)) {
        console.log(`[ForumHandlers] Ignoring message from unauthorized user: ${userId}`)
        return
      }
    }

    return next()
  })

  // =========================================================================
  // Handler: Forum Topic Created
  // =========================================================================
  
  // grammY filter for forum_topic_created service message
  composer.on("message:forum_topic_created", async (ctx) => {
    const chat = ctx.chat
    const topicCreated = ctx.message.forum_topic_created
    const topicId = ctx.message.message_thread_id

    if (!topicCreated || topicId === undefined) {
      console.log("[ForumHandlers] Received forum_topic_created but missing data")
      return
    }

    console.log(`[ForumHandlers] Topic created: "${topicCreated.name}" (${topicId})`)

    try {
      const result = await topicManager.handleTopicCreated(
        chat.id,
        topicId,
        topicCreated.name,
        ctx.from?.id,
        topicCreated.icon_color,
        topicCreated.icon_custom_emoji_id
      )

      if (result.success && result.mapping && !result.isExisting) {
        // Send welcome message to the new topic
        await ctx.reply(
          `OpenCode session started for this topic.\n\n` +
          `Session ID: \`${result.mapping.sessionId.slice(0, 8)}...\`\n` +
          `Send a message to start coding!`,
          { 
            parse_mode: "Markdown",
            message_thread_id: topicId 
          }
        )
      }
    } catch (error) {
      console.error(`[ForumHandlers] Error handling topic created: ${error}`)
      if (options.onError) {
        await options.onError(error as Error, ctx)
      }
    }
  })

  // =========================================================================
  // Handler: Forum Topic Closed
  // =========================================================================
  
  composer.on("message:forum_topic_closed", async (ctx) => {
    const topicId = ctx.message.message_thread_id
    if (topicId === undefined) return

    console.log(`[ForumHandlers] Topic closed: ${topicId}`)

    try {
      await topicManager.handleTopicClosed(ctx.chat.id, topicId, ctx.from?.id)
    } catch (error) {
      console.error(`[ForumHandlers] Error handling topic closed: ${error}`)
      if (options.onError) {
        await options.onError(error as Error, ctx)
      }
    }
  })

  // =========================================================================
  // Handler: Forum Topic Reopened
  // =========================================================================
  
  composer.on("message:forum_topic_reopened", async (ctx) => {
    const topicId = ctx.message.message_thread_id
    if (topicId === undefined) return

    console.log(`[ForumHandlers] Topic reopened: ${topicId}`)

    try {
      const reopened = await topicManager.handleTopicReopened(ctx.chat.id, topicId, ctx.from?.id)
      
      if (reopened) {
        const mapping = topicManager.getMapping(ctx.chat.id, topicId)
        if (mapping) {
          await ctx.reply(
            `Topic reopened. OpenCode session restored.\n` +
            `Session ID: \`${mapping.sessionId.slice(0, 8)}...\``,
            { 
              parse_mode: "Markdown",
              message_thread_id: topicId 
            }
          )
        }
      }
    } catch (error) {
      console.error(`[ForumHandlers] Error handling topic reopened: ${error}`)
      if (options.onError) {
        await options.onError(error as Error, ctx)
      }
    }
  })

  // =========================================================================
  // Handler: Forum Topic Edited
  // =========================================================================
  
  composer.on("message:forum_topic_edited", async (ctx) => {
    const topicId = ctx.message.message_thread_id
    const edited = ctx.message.forum_topic_edited
    
    if (topicId === undefined || !edited) return

    // Only handle name changes
    if (edited.name) {
      console.log(`[ForumHandlers] Topic renamed: ${topicId} -> "${edited.name}"`)
      topicManager.handleTopicEdited(ctx.chat.id, topicId, edited.name, ctx.from?.id)
    }
  })

  // =========================================================================
  // Handler: Text Messages (Route to OpenCode)
  // =========================================================================
  
  composer.on("message:text", async (ctx) => {
    console.log(`[ForumHandlers] Received text message in chat ${ctx.chat.id} (type: ${ctx.chat.type})`)
    
    // Skip service messages (already handled above)
    if (ctx.message.forum_topic_created ||
        ctx.message.forum_topic_closed ||
        ctx.message.forum_topic_reopened ||
        ctx.message.forum_topic_edited) {
      console.log(`[ForumHandlers] Skipping service message`)
      return
    }

    // Must be in a supergroup
    if (ctx.chat.type !== "supergroup") {
      console.log(`[ForumHandlers] Skipping non-supergroup message`)
      return
    }

    const forumCtx = withForumContext(ctx)
    
    // Skip General topic if not configured
    if (forumCtx.isGeneralTopic() && !handleGeneralTopic) {
      return
    }

    const msgContext = forumCtx.getForumContext()
    if (!msgContext) {
      console.log("[ForumHandlers] Could not build forum context")
      return
    }

    console.log(`[ForumHandlers] Message in topic ${msgContext.topicId}: "${msgContext.text.slice(0, 50)}..."`)

    try {
      // Route message to OpenCode
      const result = await topicManager.routeMessage(msgContext)

      if (!result.success) {
        // Send error message back to topic
        await ctx.reply(
          `Error: ${result.error}`,
          { message_thread_id: msgContext.topicId || undefined }
        )
        return
      }

      if (result.isNewSession) {
        // First message in topic, send session info
        await ctx.reply(
          `New OpenCode session started.\nSession ID: \`${result.sessionId?.slice(0, 8)}...\``,
          { 
            parse_mode: "Markdown",
            message_thread_id: msgContext.topicId || undefined 
          }
        )
      }

      // Note: The actual OpenCode response will come through SSE events
      // and be handled by the responseHandler callback
    } catch (error) {
      console.error(`[ForumHandlers] Error routing message: ${error}`)
      if (options.onError) {
        await options.onError(error as Error, ctx)
      }
    }
  })

  return composer
}

// ============================================================================
// Bot Commands for Forum Management
// ============================================================================

/**
 * Create command handlers for forum management
 */
export function createForumCommands(topicManager: TopicManager): Composer<Context> {
  const composer = new Composer<Context>()

  /**
   * /session - Get info about the current topic's session
   */
  composer.command("session", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      return ctx.reply("This command only works in supergroups with forum topics enabled.")
    }

    const topicId = ctx.message?.message_thread_id ?? 0
    const mapping = topicManager.getTopicWithStats(ctx.chat.id, topicId)

    if (!mapping) {
      return ctx.reply(
        "No session exists for this topic. Send a message to create one.",
        { message_thread_id: topicId || undefined }
      )
    }

    const stats = mapping.stats
    const status = mapping.status === "active" 
      ? (stats.isProcessing ? "Processing..." : "Active")
      : mapping.status

    const info = [
      `*Session Info*`,
      ``,
      `Topic: ${mapping.topicName}`,
      `Session: \`${mapping.sessionId.slice(0, 12)}...\``,
      `Status: ${status}`,
      ``,
      `*Stats*`,
      `Messages: ${stats.messageCount}`,
      `Tool calls: ${stats.toolCalls}`,
      `Errors: ${stats.errorCount}`,
      stats.lastMessageAt 
        ? `Last activity: ${new Date(stats.lastMessageAt).toLocaleString()}`
        : `Last activity: Never`,
    ].join("\n")

    return ctx.reply(info, { 
      parse_mode: "Markdown",
      message_thread_id: topicId || undefined 
    })
  })

  /**
   * /topics - List all active topics in this chat
   */
  composer.command("topics", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      return ctx.reply("This command only works in supergroups with forum topics enabled.")
    }

    const topics = topicManager.getActiveTopics(ctx.chat.id)

    if (topics.length === 0) {
      return ctx.reply("No active OpenCode sessions in this chat.")
    }

    const lines = topics.map((t, i) => 
      `${i + 1}. *${t.topicName}* - \`${t.sessionId.slice(0, 8)}...\``
    )

    return ctx.reply(
      `*Active Topics (${topics.length})*\n\n${lines.join("\n")}`,
      { parse_mode: "Markdown" }
    )
  })

  /**
   * /newsession - Force create a new session for this topic
   */
  composer.command("newsession", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      return ctx.reply("This command only works in supergroups with forum topics enabled.")
    }

    const topicId = ctx.message?.message_thread_id ?? 0
    const existing = topicManager.getMapping(ctx.chat.id, topicId)

    if (existing) {
      return ctx.reply(
        `A session already exists for this topic.\n` +
        `Session ID: \`${existing.sessionId.slice(0, 8)}...\`\n\n` +
        `Close and reopen the topic to create a new session.`,
        { 
          parse_mode: "Markdown",
          message_thread_id: topicId || undefined 
        }
      )
    }

    const topicName = topicId === 0 ? "General" : `Topic ${topicId}`
    const result = await topicManager.createSessionForTopic(ctx.chat.id, topicId, topicName)

    if (result.success && result.mapping) {
      return ctx.reply(
        `New session created!\n` +
        `Session ID: \`${result.mapping.sessionId.slice(0, 8)}...\``,
        { 
          parse_mode: "Markdown",
          message_thread_id: topicId || undefined 
        }
      )
    } else {
      return ctx.reply(
        `Failed to create session: ${result.error}`,
        { message_thread_id: topicId || undefined }
      )
    }
  })

  return composer
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a chat has forum topics enabled
 */
export async function isForumEnabled(bot: Bot, chatId: number): Promise<boolean> {
  try {
    const chat = await bot.api.getChat(chatId)
    return chat.type === "supergroup" && (chat as any).is_forum === true
  } catch (error) {
    console.error(`[ForumHandlers] Error checking forum status: ${error}`)
    return false
  }
}

/**
 * Send a message to a specific forum topic
 */
export async function sendToTopic(
  bot: Bot,
  chatId: number,
  topicId: number,
  text: string,
  parseMode?: "Markdown" | "MarkdownV2" | "HTML"
): Promise<void> {
  await bot.api.sendMessage(chatId, text, {
    message_thread_id: topicId || undefined,
    parse_mode: parseMode,
  })
}

/**
 * Create a response handler that sends OpenCode responses to forum topics
 */
export function createTopicResponseHandler(bot: Bot) {
  return async (chatId: number, topicId: number, response: string): Promise<void> => {
    // Split long responses into chunks (Telegram has a 4096 char limit)
    const MAX_LENGTH = 4000
    
    if (response.length <= MAX_LENGTH) {
      await sendToTopic(bot, chatId, topicId, response, "Markdown")
      return
    }

    // Split into chunks at line boundaries
    const lines = response.split("\n")
    let chunk = ""

    for (const line of lines) {
      if (chunk.length + line.length + 1 > MAX_LENGTH) {
        await sendToTopic(bot, chatId, topicId, chunk, "Markdown")
        chunk = line
      } else {
        chunk += (chunk ? "\n" : "") + line
      }
    }

    if (chunk) {
      await sendToTopic(bot, chatId, topicId, chunk, "Markdown")
    }
  }
}
