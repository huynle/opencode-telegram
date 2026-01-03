/**
 * Integration Layer
 * 
 * Wires together all components:
 * - Telegram bot (grammY)
 * - Forum topic manager
 * - OpenCode instance orchestrator
 * - SSE stream handler
 */

import { Bot, type Context } from "grammy"
import type { AppConfig } from "./config"
import { toManagerConfig, toTopicManagerConfig } from "./config"
import { InstanceManager, type OrchestratorEvent, type InstanceInfo } from "./orchestrator"
import { TopicManager } from "./forum/topic-manager"
import { TopicStore } from "./forum/topic-store"
import { 
  createForumHandlers, 
  createForumCommands,
  sendToTopic,
} from "./bot/handlers/forum"
import { 
  OpenCodeClient, 
  StreamHandler,
  type SSEEvent,
  type TelegramSendCallback,
  type TelegramDeleteCallback,
} from "./opencode"
import type { IOpenCodeClient, ResponseHandler, ForumMessageContext, MessageRouteResult } from "./types/forum"

// =============================================================================
// Types
// =============================================================================

/**
 * Integrated application instance
 */
export interface IntegratedApp {
  /** grammY bot instance */
  bot: Bot
  
  /** Topic manager for forum topic → session mapping */
  topicManager: TopicManager
  
  /** Instance manager for OpenCode processes */
  instanceManager: InstanceManager
  
  /** Stream handler for SSE → Telegram bridging */
  streamHandler: StreamHandler
  
  /** Start the application */
  start(): Promise<void>
  
  /** Stop the application gracefully */
  stop(): Promise<void>
  
  /** Get instance for a topic */
  getInstance(topicId: number): InstanceInfo | null
  
  /** Get OpenCode client for an instance */
  getClient(instanceId: string): OpenCodeClient | undefined
}

// =============================================================================
// Integration
// =============================================================================

/**
 * Create the fully integrated application
 */
export async function createIntegratedApp(config: AppConfig): Promise<IntegratedApp> {
  console.log("[Integration] Initializing components...")

  // Create the grammY bot
  const bot = new Bot(config.telegram.botToken)

  // Create instance manager (orchestrator)
  const instanceManager = new InstanceManager(toManagerConfig(config))

  // Map of instanceId → OpenCodeClient
  const clients = new Map<string, OpenCodeClient>()

  // Map of instanceId → SSE abort function
  const sseSubscriptions = new Map<string, () => void>()

  // Map of sessionId → instanceId for reverse lookup
  const sessionToInstance = new Map<string, string>()

  // Rate limit state for Telegram API
  let rateLimitedUntil = 0

  // Create Telegram send callback for stream handler with rate limit handling
  const sendCallback: TelegramSendCallback = async (chatId, topicId, text, options) => {
    // Check if we're currently rate limited
    const now = Date.now()
    if (now < rateLimitedUntil) {
      const waitTime = rateLimitedUntil - now
      console.log(`[Integration] Rate limited, waiting ${waitTime}ms`)
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }

    const maxRetries = 3
    let lastError: Error | undefined

    // Build reply markup if inline keyboard is provided
    const reply_markup = options?.inlineKeyboard
      ? { inline_keyboard: options.inlineKeyboard }
      : undefined

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (options?.editMessageId) {
          // Edit existing message
          await bot.api.editMessageText(chatId, options.editMessageId, text, {
            parse_mode: options.parseMode,
            reply_markup,
          })
          return { messageId: options.editMessageId }
        } else {
          // Send new message
          const result = await bot.api.sendMessage(chatId, text, {
            message_thread_id: topicId || undefined,
            parse_mode: options?.parseMode,
            reply_to_message_id: options?.replyToMessageId,
            reply_markup,
          })
          return { messageId: result.message_id }
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        
        // "message is not modified" is not a real error - return success
        if (lastError.message.includes('message is not modified')) {
          return { messageId: options?.editMessageId ?? 0 }
        }
        
        // Check for rate limit (429)
        if (lastError.message.includes('429') || lastError.message.includes('Too Many Requests')) {
          // Extract retry_after from error if available
          const retryMatch = lastError.message.match(/retry after (\d+)/i)
          const retryAfter = retryMatch ? parseInt(retryMatch[1], 10) : 3
          
          rateLimitedUntil = Date.now() + (retryAfter * 1000) + 500 // Add 500ms buffer
          console.log(`[Integration] Rate limited, will retry after ${retryAfter}s (attempt ${attempt + 1}/${maxRetries})`)
          
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + 500))
            continue
          }
        }
        
        // For non-rate-limit errors, don't retry - throw immediately
        console.error("[Integration] Telegram API error:", lastError.message.slice(0, 100))
        throw lastError
      }
    }
    
    throw lastError
  }

  // Create Telegram delete callback
  const deleteCallback: TelegramDeleteCallback = async (chatId, messageId) => {
    try {
      await bot.api.deleteMessage(chatId, messageId)
    } catch (error) {
      // Ignore delete errors (message may already be deleted)
      console.warn("[Integration] Failed to delete message:", error)
    }
  }

  // Create stream handler
  // Note: updateIntervalMs set to 2000ms to stay well within Telegram's rate limits
  // Telegram allows ~30 messages/second to a group, but edits to same message are more restricted
  const streamHandler = new StreamHandler(sendCallback, deleteCallback, {
    updateIntervalMs: 2000,
    showToolNames: true,
    deleteProgressOnComplete: true,
  })

  // Create topic store for direct access
  const topicStore = new TopicStore(config.storage.topicDbPath)

  // Helper to find instance by session ID
  function findInstanceBySession(sessionId: string): InstanceInfo | null {
    const instanceId = sessionToInstance.get(sessionId)
    if (instanceId) {
      return instanceManager.getInstance(instanceId)
    }
    // Fallback: search all instances
    for (const instance of instanceManager.getAllInstances()) {
      if (instance.sessionId === sessionId) {
        return instance
      }
    }
    return null
  }

  // Create OpenCode client adapter for TopicManager
  const openCodeAdapter: IOpenCodeClient = {
    async createSession(sessionConfig) {
      // This is called when a new topic is created
      // We don't create sessions here - we create instances
      // Return a placeholder that will be replaced when instance is ready
      const id = `pending_${Date.now()}`
      return { id }
    },

    async sendMessage(sessionId, message) {
      // Find the instance for this session
      const instance = findInstanceBySession(sessionId)
      if (!instance) {
        console.error(`[Integration] No instance found for session ${sessionId}`)
        return
      }

      const client = clients.get(instance.config.instanceId)
      if (!client) {
        console.error(`[Integration] No client for instance ${instance.config.instanceId}`)
        return
      }

      // Send message asynchronously (SSE will handle response)
      await client.sendMessageAsync(sessionId, message)
    },

    async getSession(sessionId) {
      const instance = findInstanceBySession(sessionId)
      if (!instance) return null
      return { id: sessionId, status: instance.state }
    },

    async closeSession(sessionId) {
      const instance = findInstanceBySession(sessionId)
      if (instance) {
        await instanceManager.stopInstance(instance.config.instanceId)
      }
    },
  }

  // Response handler that sends to Telegram topics
  const responseHandler: ResponseHandler = async (chatId, topicId, response) => {
    await sendToTopic(bot, chatId, topicId, response)
  }

  // Create topic manager
  const topicManager = new TopicManager(
    openCodeAdapter,
    responseHandler,
    toTopicManagerConfig(config)
  )

  // Handle orchestrator events
  instanceManager.on(async (event: OrchestratorEvent) => {
    console.log(`[Integration] Orchestrator event: ${event.type}`)

    switch (event.type) {
      case "instance:ready": {
        // Clean up any existing client/subscription for this instance first
        const existingAbort = sseSubscriptions.get(event.instanceId)
        if (existingAbort) {
          existingAbort()
          sseSubscriptions.delete(event.instanceId)
        }
        const existingClient = clients.get(event.instanceId)
        if (existingClient) {
          existingClient.close()
          clients.delete(event.instanceId)
        }
        
        // Instance is ready - create client and subscribe to SSE
        const client = new OpenCodeClient({
          baseUrl: `http://localhost:${event.port}`,
        })
        clients.set(event.instanceId, client)

        // Get or create session
        const sessions = await client.listSessions()
        let sessionId = sessions[0]?.id

        if (!sessionId) {
          const session = await client.createSession()
          sessionId = session.id
        }

        // Track session → instance mapping
        sessionToInstance.set(sessionId, event.instanceId)

        // Update instance with session ID
        const instance = instanceManager.getInstance(event.instanceId)
        if (instance) {
          // Get topic mapping to check streaming preference
          const topicId = instance.config.topicId
          const mapping = topicStore.getMapping(config.telegram.chatId, topicId)
          const streamingEnabled = mapping?.streamingEnabled ?? false

          // Register session with stream handler (include streaming preference)
          streamHandler.registerSession(sessionId, config.telegram.chatId, topicId, streamingEnabled)

          // Update topic mapping with real session ID
          // Note: We recreate the mapping with the new session ID
          if (mapping && mapping.sessionId.startsWith("pending_")) {
            // Delete old mapping and create new one with real session ID
            topicStore.deleteMapping(config.telegram.chatId, topicId)
            topicStore.createMapping(
              config.telegram.chatId,
              topicId,
              mapping.topicName,
              sessionId,
              {
                creatorUserId: mapping.creatorUserId,
                iconColor: mapping.iconColor,
                iconEmojiId: mapping.iconEmojiId,
              }
            )
            // Preserve streaming preference if it was set
            if (streamingEnabled) {
              topicStore.toggleStreaming(config.telegram.chatId, topicId, true)
            }
          }
        }

        // Subscribe to SSE events
        const abort = client.subscribe(
          (sseEvent: SSEEvent) => {
            console.log(`[Integration] SSE event: ${sseEvent.type}`, JSON.stringify(sseEvent.properties).slice(0, 200))
            streamHandler.handleEvent(sseEvent)
            
            // Record activity on any event
            instanceManager.recordActivity(event.instanceId)
          },
          (error) => {
            console.error(`[Integration] SSE error for ${event.instanceId}:`, error)
          }
        )
        sseSubscriptions.set(event.instanceId, abort)

        console.log(`[Integration] Instance ${event.instanceId} ready with session ${sessionId}`)
        break
      }

      case "instance:stopped":
      case "instance:crashed":
      case "instance:failed": {
        // Clean up client and SSE subscription
        const abort = sseSubscriptions.get(event.instanceId)
        if (abort) {
          abort()
          sseSubscriptions.delete(event.instanceId)
        }

        const client = clients.get(event.instanceId)
        if (client) {
          client.close()
          clients.delete(event.instanceId)
        }

        // Clean up session mapping
        for (const [sessionId, instId] of sessionToInstance) {
          if (instId === event.instanceId) {
            sessionToInstance.delete(sessionId)
            break
          }
        }

        // Notify in Telegram if crashed
        if (event.type === "instance:crashed") {
          const instance = instanceManager.getInstance(event.instanceId)
          if (instance) {
            const crashEvent = event as { error: string; willRestart: boolean }
            const message = crashEvent.willRestart
              ? `Instance crashed, restarting... (${crashEvent.error})`
              : `Instance crashed: ${crashEvent.error}`
            
            await sendToTopic(
              bot,
              config.telegram.chatId,
              instance.config.topicId,
              message
            )
          }
        }
        break
      }

      case "instance:idle-timeout": {
        const instance = instanceManager.getInstance(event.instanceId)
        if (instance) {
          await sendToTopic(
            bot,
            config.telegram.chatId,
            instance.config.topicId,
            "Session stopped due to inactivity. Send a message to restart."
          )
        }
        break
      }
    }
  })

  // Custom message router that uses our instances
  async function routeMessageToInstance(
    context: ForumMessageContext
  ): Promise<MessageRouteResult> {
    const { chatId, topicId, text } = context
    const effectiveTopicId = context.isGeneralTopic ? 0 : topicId

    // Get topic mapping from store
    const mapping = topicStore.getMapping(chatId, effectiveTopicId)
    const topicName = mapping?.topicName || (effectiveTopicId === 0 ? "General" : `topic-${effectiveTopicId}`)
    
    // Use custom workDir if linked, otherwise use default path
    // Special case: General topic (topicId=0) uses /tmp for direct OpenCode conversations
    const workDir = mapping?.workDir || (effectiveTopicId === 0 ? "/tmp" : `${config.project.basePath}/${topicName}`)

    // Ensure directory exists (only for non-linked directories)
    if (!mapping?.workDir && config.project.autoCreateDirs) {
      try {
        await Bun.$`mkdir -p ${workDir}`.quiet()
      } catch {
        // Ignore errors
      }
    }

    const instance = await instanceManager.getOrCreateInstance(effectiveTopicId, workDir, {
      name: topicName,
    })

    if (!instance) {
      await sendToTopic(bot, chatId, effectiveTopicId, "Failed to start OpenCode instance. Please try again.")
      return { success: false, error: "Failed to create instance" }
    }

    // Wait for instance to be ready
    if (instance.state !== "running") {
      await sendToTopic(bot, chatId, effectiveTopicId, "Starting OpenCode instance...")
      
      // Wait up to 30 seconds for instance to be ready
      const startTime = Date.now()
      while (Date.now() - startTime < 30000) {
        const current = instanceManager.getInstance(instance.config.instanceId)
        if (current?.state === "running" && current.sessionId) {
          break
        }
        if (current?.state === "failed" || current?.state === "crashed") {
          await sendToTopic(bot, chatId, effectiveTopicId, `Failed to start instance: ${current.lastError}`)
          return { success: false, error: current.lastError }
        }
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    // Get the client and send message
    const client = clients.get(instance.config.instanceId)
    const currentInstance = instanceManager.getInstance(instance.config.instanceId)
    
    if (!client || !currentInstance?.sessionId) {
      await sendToTopic(bot, chatId, effectiveTopicId, "Instance not ready. Please try again.")
      return { success: false, error: "Instance not ready" }
    }

    // Record activity
    instanceManager.recordActivity(instance.config.instanceId)

    // Send message asynchronously
    try {
      await client.sendMessageAsync(currentInstance.sessionId, text)
      return { success: true, sessionId: currentInstance.sessionId }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      await sendToTopic(bot, chatId, effectiveTopicId, `Error: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  // Override topic manager's routeMessage to use our custom router
  // We need to monkey-patch this since the original expects ForumMessageContext
  const originalRouteMessage = topicManager.routeMessage.bind(topicManager)
  topicManager.routeMessage = async (context: ForumMessageContext): Promise<MessageRouteResult> => {
    return routeMessageToInstance(context)
  }

  // Register forum commands FIRST (before text handlers so /commands are processed)
  bot.use(createForumCommands({ 
    topicManager, 
    generalAsControlPlane: true,
    topicStore,
    onStreamingToggle: (chatId, topicId, enabled) => {
      // Find the session for this topic and update streaming preference
      const mapping = topicStore.getMapping(chatId, topicId)
      console.log(`[Integration] onStreamingToggle called: chatId=${chatId}, topicId=${topicId}, enabled=${enabled}`)
      console.log(`[Integration] Mapping sessionId: ${mapping?.sessionId}`)
      
      if (mapping?.sessionId) {
        // Also try to find session by looking at all registered sessions
        const destination = streamHandler.getTelegramDestination(mapping.sessionId)
        console.log(`[Integration] Session destination: ${JSON.stringify(destination)}`)
        
        streamHandler.setStreamingEnabled(mapping.sessionId, enabled)
        console.log(`[Integration] Streaming ${enabled ? 'enabled' : 'disabled'} for session ${mapping.sessionId}`)
      } else {
        // Fallback: try to find session by topicId in the sessionToInstance map
        for (const [sessionId, instanceId] of sessionToInstance.entries()) {
          const instance = instanceManager.getInstance(instanceId)
          if (instance?.config.topicId === topicId) {
            streamHandler.setStreamingEnabled(sessionId, enabled)
            console.log(`[Integration] Streaming ${enabled ? 'enabled' : 'disabled'} for session ${sessionId} (fallback)`)
            break
          }
        }
      }
    }
  }))

  // Register forum handlers
  // General topic connects to OpenCode instance at /tmp for direct conversations
  bot.use(createForumHandlers({
    topicManager,
    handleGeneralTopic: true,
    generalAsControlPlane: false,  // General topic routes to OpenCode (at /tmp)
    allowedChatIds: config.telegram.chatId ? [config.telegram.chatId] : undefined,
    allowedUserIds: config.telegram.allowedUserIds.length > 0 ? config.telegram.allowedUserIds : undefined,
  }))

  // Handle permission callback queries (inline button presses)
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data

    // Parse permission callback data: perm:<response>:<permissionId>
    if (data.startsWith("perm:")) {
      const parts = data.split(":")
      if (parts.length !== 3) {
        await ctx.answerCallbackQuery({ text: "Invalid callback data" })
        return
      }

      const [, response, permissionId] = parts
      
      // Validate response type
      if (!["once", "always", "reject"].includes(response)) {
        await ctx.answerCallbackQuery({ text: "Invalid response type" })
        return
      }

      // Find the pending permission
      const pending = streamHandler.getPendingPermission(permissionId)
      if (!pending) {
        await ctx.answerCallbackQuery({ text: "Permission request expired or already handled" })
        return
      }

      // Find the client for this session
      const instanceId = sessionToInstance.get(pending.permission.sessionID)
      if (!instanceId) {
        await ctx.answerCallbackQuery({ text: "Session not found" })
        return
      }

      const client = clients.get(instanceId)
      if (!client) {
        await ctx.answerCallbackQuery({ text: "Instance not available" })
        return
      }

      try {
        // Send response to OpenCode
        await client.respondToPermission(
          pending.permission.sessionID,
          permissionId,
          response as "once" | "always" | "reject"
        )

        // Update the message to show it was handled
        const responseText = response === "reject" 
          ? "❌ Permission denied" 
          : response === "always"
            ? "✅ Permission granted (always)"
            : "✅ Permission granted (once)"

        try {
          await ctx.editMessageText(
            `${responseText}\n\n<i>${pending.permission.title}</i>`,
            { parse_mode: "HTML" }
          )
        } catch {
          // Ignore edit errors
        }

        // Clean up
        streamHandler.removePendingPermission(permissionId)

        await ctx.answerCallbackQuery({ text: responseText })
      } catch (error) {
        console.error("[Integration] Failed to respond to permission:", error)
        await ctx.answerCallbackQuery({ 
          text: "Failed to process permission response",
          show_alert: true 
        })
      }

      return
    }

    // Unknown callback - ignore
    await ctx.answerCallbackQuery()
  })

  // Add status command
  bot.command("status", async (ctx) => {
    const instances = instanceManager.getAllInstances()
    const running = instances.filter((i) => i.state === "running")
    
    let status = `**OpenCode Orchestrator Status**\n\n`
    status += `Running instances: ${running.length}/${config.opencode.maxInstances}\n`
    status += `Active SSE subscriptions: ${sseSubscriptions.size}\n\n`

    if (running.length > 0) {
      status += `**Active Instances:**\n`
      for (const instance of running) {
        const elapsed = instance.startedAt 
          ? Math.round((Date.now() - instance.startedAt.getTime()) / 1000 / 60)
          : 0
        status += `- Topic ${instance.config.topicId}: Port ${instance.port} (${elapsed}m)\n`
      }
    }

    await ctx.reply(status, { parse_mode: "Markdown" })
  })

  // Error handler
  bot.catch((err) => {
    console.error("[Integration] Bot error:", err)
  })

  console.log("[Integration] Components initialized")

  return {
    bot,
    topicManager,
    instanceManager,
    streamHandler,

    async start() {
      console.log("[Integration] Starting application...")

      // Recover orchestrator state
      await instanceManager.recover()

      // Start bot
      await bot.start({
        allowed_updates: ["message", "edited_message", "callback_query"],
        onStart: (info) => {
          console.log(`[Integration] Bot started as @${info.username}`)
        },
      })
    },

    async stop() {
      console.log("[Integration] Stopping application...")

      // Stop SSE subscriptions
      for (const [id, abort] of sseSubscriptions) {
        abort()
      }
      sseSubscriptions.clear()

      // Close clients
      for (const [id, client] of clients) {
        client.close()
      }
      clients.clear()

      // Clear stream handler
      streamHandler.clear()

      // Stop orchestrator
      await instanceManager.shutdown()

      // Close topic store
      topicStore.close()

      // Stop bot
      await bot.stop()

      console.log("[Integration] Application stopped")
    },

    getInstance(topicId: number) {
      return instanceManager.getInstanceByTopic(topicId)
    },

    getClient(instanceId: string) {
      return clients.get(instanceId)
    },
  }
}
