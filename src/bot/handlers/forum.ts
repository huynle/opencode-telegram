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
  
  // If true, General topic acts as control plane (no OpenCode instance)
  // Users can create new topics with /new or by just typing a topic name
  generalAsControlPlane?: boolean
  
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
  const { topicManager, handleGeneralTopic = true, generalAsControlPlane = false, allowedChatIds, allowedUserIds } = options

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

    // If General topic is control plane, don't route to OpenCode
    // Only /new command creates topics (handled by command handler)
    if (forumCtx.isGeneralTopic() && generalAsControlPlane) {
      // Skip if it's a command (let command handlers process it)
      if (msgContext.text.startsWith("/")) {
        console.log(`[ForumHandlers] Skipping command in General (will be handled by command handler): ${msgContext.text}`)
        return
      }
      
      // Don't auto-create topics from plain messages - just show help
      console.log(`[ForumHandlers] Ignoring non-command message in General: "${msgContext.text.slice(0, 30)}..."`)
      await ctx.reply(
        "This is the control topic. Use `/new <name>` to create a new topic, or `/help` for more options.",
        { parse_mode: "Markdown" }
      )
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
 * Result of creating a new topic with OpenCode instance
 */
export interface CreateTopicResult {
  success: boolean
  topicId?: number
  sessionId?: string
  directory?: string
  error?: string
}

/**
 * Options for forum commands
 */
export interface ForumCommandOptions {
  topicManager: TopicManager
  /** If true, General topic acts as control plane for creating new topics */
  generalAsControlPlane?: boolean
  /** Topic store for direct access (needed for streaming toggle) */
  topicStore?: import("../../forum/topic-store").TopicStore
  /** Callback when streaming preference changes */
  onStreamingToggle?: (chatId: number, topicId: number, enabled: boolean) => void
  /** Callback to get all active sessions (managed + external) */
  getActiveSessions?: () => Promise<ActiveSessionInfo[]>
  /** Callback to connect General topic to an existing session */
  connectToSession?: (chatId: number, sessionIdentifier: string) => Promise<ConnectResult>
  /** Callback to disconnect/delete a topic linked to a session */
  disconnectSession?: (chatId: number, topicId: number) => Promise<DisconnectResult>
  /** Callback to find and clean up stale topic mappings */
  findStaleSessions?: (chatId: number) => Promise<StaleSessionInfo[]>
  /** Callback to clean up a stale session */
  cleanupStaleSession?: (chatId: number, topicId: number) => Promise<boolean>
  /** Callback to create a new topic with directory and OpenCode instance */
  createTopicWithInstance?: (chatId: number, topicName: string) => Promise<CreateTopicResult>
}

/**
 * Result of disconnecting a session
 */
export interface DisconnectResult {
  success: boolean
  topicDeleted?: boolean
  error?: string
}

/**
 * Information about a stale session (topic linked to dead session)
 */
export interface StaleSessionInfo {
  topicId: number
  topicName: string
  sessionId: string
  directory?: string
  reason: "port_dead" | "session_missing" | "instance_stopped"
}

/**
 * Information about an active session
 */
export interface ActiveSessionInfo {
  /** Session ID */
  sessionId: string
  /** Project/topic name */
  name: string
  /** Working directory */
  directory: string
  /** Topic ID if linked to a topic */
  topicId?: number
  /** Whether this is an external instance (registered via API) */
  isExternal: boolean
  /** Whether this was discovered (not managed or registered) */
  isDiscovered?: boolean
  /** Port number */
  port?: number
  /** Last activity timestamp */
  lastActivity?: Date
  /** Session status */
  status: "running" | "idle" | "stopped" | "unknown"
}

/**
 * Result of connecting to a session
 */
export interface ConnectResult {
  success: boolean
  sessionId?: string
  topicId?: number
  topicUrl?: string
  error?: string
}

/**
 * Create command handlers for forum management
 */
export function createForumCommands(topicManagerOrOptions: TopicManager | ForumCommandOptions): Composer<Context> {
  const composer = new Composer<Context>()
  
  // Handle both old and new API
  const options: ForumCommandOptions = 'topicManager' in topicManagerOrOptions 
    ? topicManagerOrOptions 
    : { topicManager: topicManagerOrOptions }
  const { 
    topicManager, 
    generalAsControlPlane = false, 
    topicStore, 
    onStreamingToggle,
    getActiveSessions,
    connectToSession,
    disconnectSession,
    findStaleSessions,
    cleanupStaleSession,
    createTopicWithInstance,
  } = options
  
  // Cache for session list (used by /connect with numbers)
  let lastSessionList: ActiveSessionInfo[] = []

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
   * /sessions - List all active OpenCode sessions (managed + external)
   * Shows numbered sessions that can be connected to with /connect <number>
   */
  composer.command("sessions", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      return ctx.reply("This command only works in supergroups with forum topics enabled.")
    }

    if (!getActiveSessions) {
      return ctx.reply("Session listing not available.")
    }

    try {
      const sessions = await getActiveSessions()
      
      // Cache for /connect command
      lastSessionList = sessions

      if (sessions.length === 0) {
        return ctx.reply(
          "*No Active Sessions*\n\n" +
          "No OpenCode sessions are currently running.\n\n" +
          "• Use `/new <name>` to create a new topic\n" +
          "• Or link an external OpenCode with `/telegram-link`",
          { parse_mode: "Markdown" }
        )
      }

      const lines: string[] = []
      lines.push(`*Active Sessions (${sessions.length})*`)
      lines.push("")

      // Helper to format a session entry with number
      const formatSession = (s: ActiveSessionInfo, index: number) => {
        const statusIcon = s.status === "running" ? "🟢" : s.status === "idle" ? "🟡" : "⚪"
        const projectName = s.directory.split("/").pop() || s.name
        const sessionTitle = s.name !== projectName ? ` _(${s.name})_` : ""
        const linkedIcon = s.topicId ? " 🔗" : ""
        const typeIcon = s.isDiscovered ? "🔍" : s.isExternal ? "🔗" : "📦"
        
        const result: string[] = []
        result.push(`*${index}.* ${statusIcon} ${typeIcon} *${projectName}*${sessionTitle}${linkedIcon}`)
        result.push(`    📁 \`${s.directory}\``)
        if (s.port) {
          result.push(`    🔌 Port ${s.port}`)
        }
        return result
      }

      // Show all sessions with numbers
      let index = 1
      for (const s of sessions) {
        lines.push(...formatSession(s, index))
        index++
      }
      lines.push("")

      // Legend
      lines.push("_Icons: 📦 managed | 🔗 external | 🔍 discovered_")
      lines.push("")
      lines.push("*Commands:*")
      lines.push("`/connect <#>` - Link session to new topic")
      lines.push("`/disconnect` - Unlink current topic (run in topic)")

      // Safety check: Telegram has 4096 char limit
      let message = lines.join("\n")
      if (message.length > 4000) {
        // Truncate and add indicator
        message = message.slice(0, 3900) + "\n\n_...truncated (too many sessions)_"
      }

      return ctx.reply(message, { parse_mode: "Markdown" })
    } catch (error) {
      console.error("[ForumCommands] Error listing sessions:", error)
      return ctx.reply(`Error listing sessions: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  /**
   * /connect <number-or-name> - Connect to an existing session from General topic
   * Creates a new topic linked to the session
   */
  composer.command("connect", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      return ctx.reply("This command only works in supergroups with forum topics enabled.")
    }

    const topicId = ctx.message?.message_thread_id ?? 0
    
    // Only allow in General topic
    if (topicId !== 0) {
      return ctx.reply(
        "Use `/connect` in the General topic to connect to existing sessions.",
        { 
          parse_mode: "Markdown",
          message_thread_id: topicId 
        }
      )
    }

    if (!connectToSession) {
      return ctx.reply("Session connection not available.")
    }

    // Get session identifier from command arguments
    const args = ctx.message?.text?.split(/\s+/).slice(1).join(" ").trim()
    if (!args) {
      return ctx.reply(
        "*Connect to a session*\n\n" +
        "Usage: `/connect <number>` or `/connect <name>`\n\n" +
        "Examples:\n" +
        "• `/connect 1` - Connect to session #1\n" +
        "• `/connect my-project` - Connect by name\n\n" +
        "_Run `/sessions` first to see the list_",
        { parse_mode: "Markdown" }
      )
    }

    try {
      let sessionIdentifier = args
      
      // Check if it's a number (index from /sessions list)
      const num = parseInt(args, 10)
      if (!isNaN(num) && num > 0) {
        // Refresh session list if empty
        if (lastSessionList.length === 0 && getActiveSessions) {
          lastSessionList = await getActiveSessions()
        }
        
        if (num > lastSessionList.length) {
          return ctx.reply(
            `❌ Invalid number. Run \`/sessions\` to see available sessions (1-${lastSessionList.length}).`,
            { parse_mode: "Markdown" }
          )
        }
        
        const session = lastSessionList[num - 1]
        sessionIdentifier = session.sessionId
        
        // Show what we're connecting to
        const projectName = session.directory.split("/").pop() || session.name
        await ctx.reply(
          `Connecting to *${projectName}*...`,
          { parse_mode: "Markdown" }
        )
      }

      const result = await connectToSession(ctx.chat.id, sessionIdentifier)

      if (!result.success) {
        return ctx.reply(
          `❌ *Connection Failed*\n\n${result.error}`,
          { parse_mode: "Markdown" }
        )
      }

      return ctx.reply(
        `✅ *Connected!*\n\n` +
        (result.topicUrl 
          ? `[Open Topic](${result.topicUrl})`
          : `Topic ID: ${result.topicId}`),
        { 
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true }
        }
      )
    } catch (error) {
      console.error("[ForumCommands] Error connecting to session:", error)
      return ctx.reply(`Error: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  /**
   * /disconnect - Disconnect current topic from its session and delete the topic
   * Must be run from within a topic (not General)
   */
  composer.command("disconnect", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      return ctx.reply("This command only works in supergroups with forum topics enabled.")
    }

    const topicId = ctx.message?.message_thread_id ?? 0
    
    // Must be in a topic, not General
    if (topicId === 0) {
      return ctx.reply(
        "Run `/disconnect` from within a topic to unlink and delete it.",
        { parse_mode: "Markdown" }
      )
    }

    if (!disconnectSession) {
      return ctx.reply(
        "Disconnect not available.",
        { message_thread_id: topicId }
      )
    }

    // Check if topic has a session
    const mapping = topicManager.getMapping(ctx.chat.id, topicId)
    if (!mapping) {
      return ctx.reply(
        "This topic is not linked to any session.",
        { message_thread_id: topicId }
      )
    }

    try {
      // Confirm action
      await ctx.reply(
        `⚠️ *Disconnecting...*\n\nUnlinking session and deleting this topic.`,
        { 
          parse_mode: "Markdown",
          message_thread_id: topicId 
        }
      )

      const result = await disconnectSession(ctx.chat.id, topicId)

      if (!result.success) {
        return ctx.reply(
          `❌ *Disconnect Failed*\n\n${result.error}`,
          { 
            parse_mode: "Markdown",
            message_thread_id: topicId 
          }
        )
      }

      // If topic was deleted, we can't reply to it
      // The success message will be in General topic or just logged
      if (!result.topicDeleted) {
        return ctx.reply(
          `✅ Session unlinked. Topic kept.`,
          { message_thread_id: topicId }
        )
      }
      
      // Topic deleted - no reply possible, but we could notify General
      console.log(`[ForumCommands] Topic ${topicId} disconnected and deleted`)
    } catch (error) {
      console.error("[ForumCommands] Error disconnecting session:", error)
      return ctx.reply(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
        { message_thread_id: topicId }
      )
    }
  })

  /**
   * /clear - Find and clean up stale topic mappings (topics linked to dead sessions)
   */
  composer.command("clear", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      return ctx.reply("This command only works in supergroups with forum topics enabled.")
    }

    const topicId = ctx.message?.message_thread_id ?? 0
    
    // Only allow in General topic
    if (topicId !== 0) {
      return ctx.reply(
        "Use `/clear` in the General topic to clean up stale sessions.",
        { 
          parse_mode: "Markdown",
          message_thread_id: topicId 
        }
      )
    }

    if (!findStaleSessions || !cleanupStaleSession) {
      return ctx.reply("Stale session cleanup not available.")
    }

    try {
      // Find stale sessions
      const staleSessions = await findStaleSessions(ctx.chat.id)

      if (staleSessions.length === 0) {
        return ctx.reply(
          "✅ *No stale sessions found*\n\n" +
          "All topic mappings are connected to active sessions.",
          { parse_mode: "Markdown" }
        )
      }

      // Show what will be cleaned up
      const lines: string[] = []
      lines.push(`🧹 *Found ${staleSessions.length} stale session(s)*`)
      lines.push("")

      for (const stale of staleSessions) {
        const reasonText = {
          port_dead: "Port not responding",
          session_missing: "Session no longer exists",
          instance_stopped: "Instance stopped",
        }[stale.reason]
        
        lines.push(`• *${stale.topicName}* (Topic ${stale.topicId})`)
        lines.push(`  Reason: ${reasonText}`)
        if (stale.directory) {
          lines.push(`  Dir: \`${stale.directory}\``)
        }
      }

      lines.push("")
      lines.push("_Cleaning up..._")

      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })

      // Clean up each stale session
      let cleaned = 0
      let failed = 0

      for (const stale of staleSessions) {
        try {
          const success = await cleanupStaleSession(ctx.chat.id, stale.topicId)
          if (success) {
            cleaned++
          } else {
            failed++
          }
        } catch {
          failed++
        }
      }

      return ctx.reply(
        `✅ *Cleanup Complete*\n\n` +
        `Cleaned: ${cleaned}\n` +
        (failed > 0 ? `Failed: ${failed}` : ""),
        { parse_mode: "Markdown" }
      )
    } catch (error) {
      console.error("[ForumCommands] Error cleaning stale sessions:", error)
      return ctx.reply(`Error: ${error instanceof Error ? error.message : String(error)}`)
    }
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

  /**
   * /new <name> - Create a new forum topic with directory and OpenCode instance
   * (only works in General topic when generalAsControlPlane is true)
   */
  composer.command("new", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      return ctx.reply("This command only works in supergroups with forum topics enabled.")
    }

    const topicId = ctx.message?.message_thread_id ?? 0
    
    // Only allow in General topic if control plane mode is enabled
    if (!generalAsControlPlane) {
      return ctx.reply("Topic creation from General is not enabled.")
    }
    
    if (topicId !== 0) {
      return ctx.reply("Use /new in the General topic to create new topics.")
    }

    // Get topic name from command arguments
    const args = ctx.message?.text?.split(/\s+/).slice(1).join(" ").trim()
    if (!args) {
      return ctx.reply(
        "*Create a new topic*\n\n" +
        "Usage: `/new <topic-name>`\n\n" +
        "Example: `/new my-project`\n\n" +
        "_This will create a new folder and start an OpenCode instance._",
        { parse_mode: "Markdown" }
      )
    }

    const topicName = args

    // Use the callback if available (creates directory + starts instance)
    if (createTopicWithInstance) {
      try {
        await ctx.reply(`Creating topic *${topicName}*...`, { parse_mode: "Markdown" })
        
        const result = await createTopicWithInstance(ctx.chat.id, topicName)
        
        if (!result.success) {
          return ctx.reply(
            `❌ *Failed to create topic*\n\n${result.error}`,
            { parse_mode: "Markdown" }
          )
        }

        const positiveId = String(ctx.chat.id).replace(/^-100/, "")
        const topicUrl = `https://t.me/c/${positiveId}/${result.topicId}`

        return ctx.reply(
          `✅ *Topic created!*\n\n` +
          `*Name:* ${topicName}\n` +
          `*Directory:* \`${result.directory}\`\n` +
          `*Session:* \`${result.sessionId?.slice(0, 12)}...\`\n\n` +
          `[Open Topic](${topicUrl})`,
          { 
            parse_mode: "Markdown",
            link_preview_options: { is_disabled: true }
          }
        )
      } catch (error) {
        console.error(`[ForumCommands] Failed to create topic with instance: ${error}`)
        return ctx.reply(`Failed to create topic: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Fallback: just create the topic (old behavior)
    try {
      const newTopic = await ctx.api.createForumTopic(ctx.chat.id, topicName)
      
      console.log(`[ForumCommands] Created new topic: "${topicName}" (${newTopic.message_thread_id})`)

      return ctx.reply(
        `Created topic *${topicName}*\n\n` +
        `Send a message there to start your OpenCode session.`,
        { parse_mode: "Markdown" }
      )
    } catch (error) {
      console.error(`[ForumCommands] Failed to create topic: ${error}`)
      return ctx.reply(`Failed to create topic: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  /**
   * /stream - Toggle streaming responses on/off for this topic
   */
  composer.command("stream", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      return ctx.reply("This command only works in supergroups with forum topics enabled.")
    }

    const topicId = ctx.message?.message_thread_id ?? 0
    
    // Don't allow in General topic
    if (topicId === 0) {
      return ctx.reply(
        "Streaming settings are per-topic. Go to a specific topic to toggle streaming.",
        { parse_mode: "Markdown" }
      )
    }

    if (!topicStore) {
      return ctx.reply(
        "Streaming toggle not available.",
        { message_thread_id: topicId }
      )
    }

    // Get current mapping
    const mapping = topicStore.getMapping(ctx.chat.id, topicId)
    if (!mapping) {
      return ctx.reply(
        "No session exists for this topic. Send a message first to create one.",
        { message_thread_id: topicId }
      )
    }

    // Toggle streaming
    const newValue = !mapping.streamingEnabled
    const updated = topicStore.toggleStreaming(ctx.chat.id, topicId, newValue, ctx.from?.id)

    if (!updated) {
      return ctx.reply(
        "Failed to update streaming preference.",
        { message_thread_id: topicId }
      )
    }

    // Notify callback if provided
    if (onStreamingToggle) {
      onStreamingToggle(ctx.chat.id, topicId, newValue)
    }

    const status = newValue ? "enabled ✅" : "disabled ❌"
    return ctx.reply(
      `*Streaming ${status}*\n\n` +
      (newValue 
        ? "Responses will now stream in real-time as they're generated."
        : "Responses will show progress indicator, then final result."),
      { 
        parse_mode: "Markdown",
        message_thread_id: topicId 
      }
    )
  })

  /**
   * /link <path> - Link this topic to an existing project directory
   */
  composer.command("link", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      return ctx.reply("This command only works in supergroups with forum topics enabled.")
    }

    const topicId = ctx.message?.message_thread_id ?? 0
    
    // Don't allow linking General topic
    if (topicId === 0) {
      return ctx.reply(
        "Cannot link the General topic. Create or use a specific topic first.",
        { parse_mode: "Markdown" }
      )
    }

    // Get path from command arguments
    const args = ctx.message?.text?.split(/\s+/).slice(1).join(" ").trim()
    if (!args) {
      return ctx.reply(
        "*Link to an existing project*\n\n" +
        "Usage: `/link <path>`\n\n" +
        "Example: `/link /Users/huy/code/my-project`\n\n" +
        "_This will restart the OpenCode instance with the new working directory._",
        { 
          parse_mode: "Markdown",
          message_thread_id: topicId 
        }
      )
    }

    const workDir = args

    // Verify the path exists
    try {
      const stat = await Bun.file(workDir).exists()
      // For directories, check with trailing slash or use different method
      const dirExists = await (async () => {
        try {
          const proc = Bun.spawn(["test", "-d", workDir])
          await proc.exited
          return proc.exitCode === 0
        } catch {
          return false
        }
      })()

      if (!dirExists) {
        return ctx.reply(
          `Directory not found: \`${workDir}\`\n\n` +
          `Make sure the path exists and is accessible.`,
          { 
            parse_mode: "Markdown",
            message_thread_id: topicId 
          }
        )
      }
    } catch (error) {
      return ctx.reply(
        `Error checking path: ${error instanceof Error ? error.message : String(error)}`,
        { message_thread_id: topicId }
      )
    }

    // Update the mapping
    const result = topicManager.linkToDirectory(
      ctx.chat.id,
      topicId,
      workDir,
      ctx.from?.id
    )

    if (!result.success) {
      return ctx.reply(
        `Failed to link: ${result.error}`,
        { message_thread_id: topicId }
      )
    }

    return ctx.reply(
      `✅ *Linked to project*\n\n` +
      `Path: \`${workDir}\`\n\n` +
      `_The OpenCode instance needs to restart to use this directory. ` +
      `Send a message to restart with the new path._`,
      { 
        parse_mode: "Markdown",
        message_thread_id: topicId 
      }
    )
  })

  /**
   * /help - Show comprehensive help menu (context-aware for General vs other topics)
   */
  composer.command("help", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      return ctx.reply("This bot works in supergroups with forum topics enabled.")
    }

    const topicId = ctx.message?.message_thread_id ?? 0
    const isGeneral = topicId === 0

    if (isGeneral && generalAsControlPlane) {
      // Comprehensive help for General topic (control plane)
      const helpText = [
        "📚 *OpenCode Bot - Command Reference*",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "📁 *CREATE NEW PROJECT*",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "`/new <name>` - Create folder + topic + start OpenCode",
        "`/topics` - List all active topics in this chat",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "🔗 *ATTACH TO EXISTING SESSION*",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "`/sessions` - List all sessions (numbered)",
        "`/connect <#>` - Attach to session by number (no folder)",
        "`/disconnect` - Unlink & delete topic (run in topic)",
        "`/clear` - Clean up stale topic mappings",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "🖥️ *SYSTEM*",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "`/status` - Show orchestrator status",
        "`/help` - Show this help menu",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "💡 *HOW IT WORKS*",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "• `/new myproject` creates ~/oc-bot/myproject + starts OpenCode",
        "• `/connect 1` attaches to existing session #1 (no folder)",
        "• `/disconnect` (in topic) unlinks and deletes the topic",
        "• Sessions persist until idle timeout (30 min)",
        "",
        "_Go to any topic and send a message to start coding!_",
      ].join("\n")

      return ctx.reply(helpText, { parse_mode: "Markdown" })
    } else {
      // Comprehensive help for regular topics (inside a session)
      const helpText = [
        "📚 *OpenCode Session - Command Reference*",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "📊 *SESSION*",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "`/session` - Show current session details",
        "`/disconnect` - Unlink & delete this topic",
        "`/link <path>` - Link to project directory",
        "`/stream` - Toggle real-time streaming",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "📁 *NAVIGATION*",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "`/topics` - List all active topics",
        "`/help` - Show this help menu",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "💬 *USAGE*",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "• Just type your message - no command needed!",
        "• Tool calls are displayed as they happen",
        "• Session auto-stops after 30 min of inactivity",
      ].join("\n")

      return ctx.reply(helpText, { 
        parse_mode: "Markdown",
        message_thread_id: topicId || undefined 
      })
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
