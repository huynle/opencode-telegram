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
  type ActiveSessionInfo,
  type ConnectResult,
  type DisconnectResult,
  type StaleSessionInfo,
  type CreateTopicResult,
  type ManagedProjectInfo,
} from "./bot/handlers/forum"
import { 
  OpenCodeClient, 
  StreamHandler,
  discoverSessions,
  isPortAlive,
  findSession,
  type SSEEvent,
  type TelegramSendCallback,
  type TelegramDeleteCallback,
  type DiscoveredSession,
} from "./opencode"
import type { IOpenCodeClient, ResponseHandler, ForumMessageContext, MessageRouteResult } from "./types/forum"
import { ApiServer, createApiServer } from "./api-server"

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
  
  /** API server for external instance registration */
  apiServer: ApiServer
  
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

  // Stale topic cleanup timer
  let staleCleanupTimer: ReturnType<typeof setInterval> | null = null

  // Create Telegram send callback for stream handler with rate limit handling
  const sendCallback: TelegramSendCallback = async (chatId, topicId, text, options) => {
    // Check if we're currently rate limited
    const now = Date.now()
    if (now < rateLimitedUntil) {
      const waitTime = rateLimitedUntil - now
      // For edits, just throw immediately - stream handler will skip
      if (options?.editMessageId) {
        throw new Error(`Rate limited for ${waitTime}ms`)
      }
      console.log(`[Integration] Rate limited, waiting ${waitTime}ms`)
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }

    // Build reply markup if inline keyboard is provided
    const reply_markup = options?.inlineKeyboard
      ? { inline_keyboard: options.inlineKeyboard }
      : undefined

    try {
      if (options?.editMessageId) {
        // Edit existing message - no retries, just fail fast
        await bot.api.editMessageText(chatId, options.editMessageId, text, {
          parse_mode: options.parseMode,
          reply_markup,
        })
        return { messageId: options.editMessageId }
      } else {
        // Send new message - retry on rate limit
        const maxRetries = 3
        let lastError: Error | undefined
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            const result = await bot.api.sendMessage(chatId, text, {
              message_thread_id: topicId || undefined,
              parse_mode: options?.parseMode,
              reply_to_message_id: options?.replyToMessageId,
              reply_markup,
            })
            return { messageId: result.message_id }
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error))
            
            // Check for rate limit (429)
            if (lastError.message.includes('429') || lastError.message.includes('Too Many Requests')) {
              const retryMatch = lastError.message.match(/retry after (\d+)/i)
              const retryAfter = retryMatch ? parseInt(retryMatch[1], 10) : 3
              
              rateLimitedUntil = Date.now() + (retryAfter * 1000) + 500
              console.log(`[Integration] Rate limited on send, will retry after ${retryAfter}s (attempt ${attempt + 1}/${maxRetries})`)
              
              if (attempt < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + 500))
                continue
              }
            }
            
            // For non-rate-limit errors, don't retry
            throw lastError
          }
        }
        
        throw lastError
      }
    } catch (error) {
      const lastError = error instanceof Error ? error : new Error(String(error))
      
      // "message is not modified" is not a real error - return success
      if (lastError.message.includes('message is not modified')) {
        return { messageId: options?.editMessageId ?? 0 }
      }
      
      // Update rate limit state for 429 errors
      if (lastError.message.includes('429') || lastError.message.includes('Too Many Requests')) {
        const retryMatch = lastError.message.match(/retry after (\d+)/i)
        const retryAfter = retryMatch ? parseInt(retryMatch[1], 10) : 3
        rateLimitedUntil = Date.now() + (retryAfter * 1000) + 500
      }
      
      throw lastError
    }
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

  // API server will be created after bot setup (needs bot reference)
  let apiServer: ApiServer

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

  // Create topic manager (pass the shared topicStore)
  const topicManager = new TopicManager(
    openCodeAdapter,
    responseHandler,
    toTopicManagerConfig(config),
    topicStore  // Share the same store instance
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

        // Get the instance to find its working directory
        const instanceInfo = instanceManager.getInstance(event.instanceId)
        const instanceWorkDir = instanceInfo?.config.workDir

        // Get or create session - MUST match the instance's working directory
        const sessions = await client.listSessions()
        
        // Find a session that matches this instance's working directory
        // Sessions have a 'directory' field that indicates where they were created
        let sessionId: string | undefined
        
        if (instanceWorkDir) {
          // Look for a session in the same directory
          const matchingSession = sessions.find((s: any) => 
            s.directory === instanceWorkDir
          )
          sessionId = matchingSession?.id
          
          if (matchingSession) {
            console.log(`[Integration] Found existing session ${sessionId} for directory ${instanceWorkDir}`)
          } else {
            console.log(`[Integration] No session found for directory ${instanceWorkDir}, creating new one`)
          }
        }

        // If no matching session found, create a new one
        if (!sessionId) {
          const session = await client.createSession()
          sessionId = session.id
          console.log(`[Integration] Created new session ${sessionId}`)
        }

        // Track session → instance mapping
        sessionToInstance.set(sessionId, event.instanceId)
        
        // Update the instance's sessionId in the orchestrator
        // This is important so that createTopicWithInstance can wait for it
        instanceManager.updateSessionId(event.instanceId, sessionId)

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

    // Check if this topic is linked to an external OpenCode instance
    if (apiServer.isExternalTopic(effectiveTopicId)) {
      const external = apiServer.getExternalByTopic(effectiveTopicId)
      if (external?.sessionId) {
        // Mark this message as coming from Telegram so we don't echo it back
        streamHandler.markMessageFromTelegram(external.sessionId, text)
      }
      const success = await apiServer.routeMessageToExternal(effectiveTopicId, text)
      if (success) {
        return { success: true, sessionId: external?.sessionId }
      } else {
        await sendToTopic(bot, chatId, effectiveTopicId, "Failed to send message to external OpenCode instance.")
        return { success: false, error: "External instance not reachable" }
      }
    }

    // Check if this topic is linked to a discovered session
    const discoveredKey = `discovered_${effectiveTopicId}`
    const discoveredClient = clients.get(discoveredKey)
    if (discoveredClient) {
      // This topic is connected to a discovered session - use that client
      const mapping = topicStore.getMapping(chatId, effectiveTopicId)
      if (mapping?.sessionId) {
        try {
          // Mark this message as coming from Telegram so we don't echo it back
          streamHandler.markMessageFromTelegram(mapping.sessionId, text)
          await discoveredClient.sendMessageAsync(mapping.sessionId, text)
          console.log(`[Integration] Sent message to discovered session ${mapping.sessionId}`)
          return { success: true, sessionId: mapping.sessionId }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          console.error(`[Integration] Failed to send to discovered session:`, errorMsg)
          
          // Check if the session is still alive
          const isHealthy = await discoveredClient.isHealthy()
          if (!isHealthy) {
            // Clean up the dead discovered session
            const abort = sseSubscriptions.get(discoveredKey)
            if (abort) {
              abort()
              sseSubscriptions.delete(discoveredKey)
            }
            discoveredClient.close()
            clients.delete(discoveredKey)
            streamHandler.unregisterSession(mapping.sessionId)
            
            // Try to auto-reconnect: discover TUI sessions in the same directory
            console.log(`[Integration] Attempting to reconnect to TUI session in ${mapping.workDir}`)
            const discovered = await discoverSessions()
            // Only reconnect to TUI instances, not managed 'opencode serve' instances
            const reconnectSession = discovered.find(s => 
              s.instance.isTui && (s.directory === mapping.workDir || s.id === mapping.sessionId)
            )
            
            if (reconnectSession) {
              console.log(`[Integration] Found session to reconnect: ${reconnectSession.id} on port ${reconnectSession.instance.port}`)
              
              // Create new client for the reconnected session
              const newClient = new OpenCodeClient({
                baseUrl: `http://localhost:${reconnectSession.instance.port}`,
              })
              
              // Subscribe to SSE events
              const newAbort = newClient.subscribe(
                (sseEvent: SSEEvent) => {
                  console.log(`[Integration] SSE event from reconnected session:`, sseEvent.type)
                  streamHandler.handleEvent(sseEvent)
                },
                (error) => {
                  console.error(`[Integration] SSE error for reconnected session:`, error)
                }
              )
              
              // Store the new subscription
              sseSubscriptions.set(discoveredKey, newAbort)
              clients.set(discoveredKey, newClient)
              
              // Update the mapping if session ID changed
              if (reconnectSession.id !== mapping.sessionId) {
                topicStore.deleteMapping(chatId, effectiveTopicId)
                topicStore.createMapping(chatId, effectiveTopicId, mapping.topicName, reconnectSession.id, {
                  creatorUserId: mapping.creatorUserId,
                  iconColor: mapping.iconColor,
                  iconEmojiId: mapping.iconEmojiId,
                })
                topicStore.updateWorkDir(chatId, effectiveTopicId, mapping.workDir!)
                topicStore.toggleStreaming(chatId, effectiveTopicId, mapping.streamingEnabled ?? false)
              }
              
              // Re-register with stream handler
              streamHandler.registerSession(reconnectSession.id, chatId, effectiveTopicId, mapping.streamingEnabled ?? false)
              
              // Now send the message
              try {
                streamHandler.markMessageFromTelegram(reconnectSession.id, text)
                await newClient.sendMessageAsync(reconnectSession.id, text)
                console.log(`[Integration] Reconnected and sent message to session ${reconnectSession.id}`)
                
                // Notify user of successful reconnection
                await sendToTopic(bot, chatId, effectiveTopicId, 
                  "🔄 Reconnected to OpenCode session."
                )
                
                return { success: true, sessionId: reconnectSession.id }
              } catch (reconnectError) {
                console.error(`[Integration] Failed to send after reconnect:`, reconnectError)
                // Fall through to show error message
              }
            }
            
            await sendToTopic(bot, chatId, effectiveTopicId, 
              "⚠️ The discovered session is no longer available.\n\n" +
              "The OpenCode instance may have been closed. " +
              "Send another message to start a new managed instance, or use `/connect` to link to a different session."
            )
            return { success: false, error: "Discovered session no longer available" }
          }
          
          await sendToTopic(bot, chatId, effectiveTopicId, `Error: ${errorMsg}`)
          return { success: false, error: errorMsg }
        }
      }
    }

    // Get topic mapping from store
    const mapping = topicStore.getMapping(chatId, effectiveTopicId)
    const topicName = mapping?.topicName || (effectiveTopicId === 0 ? "General" : `topic-${effectiveTopicId}`)
    
    // Use custom workDir if linked, otherwise use default path
    // Special case: General topic (topicId=0) uses /tmp for direct OpenCode conversations
    const workDir = mapping?.workDir || (effectiveTopicId === 0 ? "/tmp" : `${config.project.basePath}/${topicName}`)

    // Before creating a managed instance, check if there's an existing TUI we can connect to
    // This handles the case where:
    // 1. User connected to a discovered session via /connect
    // 2. The TUI was closed
    // 3. User reopened the TUI
    // 4. We should reconnect to the TUI instead of creating a new managed instance
    if (mapping?.workDir) {
      console.log(`[Integration] Checking for existing TUI in ${workDir}`)
      const discovered = await discoverSessions()
      // Only connect to TUI instances, not managed 'opencode serve' instances
      const existingSession = discovered.find(s => s.directory === workDir && s.instance.isTui)
      
      if (existingSession) {
        console.log(`[Integration] Found existing TUI session: ${existingSession.id} on port ${existingSession.instance.port}`)
        
        // Connect to the existing TUI instead of creating a managed instance
        const newClient = new OpenCodeClient({
          baseUrl: `http://localhost:${existingSession.instance.port}`,
        })
        
        // Subscribe to SSE events
        const discoveredKey = `discovered_${effectiveTopicId}`
        const newAbort = newClient.subscribe(
          (sseEvent: SSEEvent) => {
            console.log(`[Integration] SSE event from reconnected TUI:`, sseEvent.type)
            streamHandler.handleEvent(sseEvent)
          },
          (error) => {
            console.error(`[Integration] SSE error for reconnected TUI:`, error)
          }
        )
        
        // Store the subscription
        sseSubscriptions.set(discoveredKey, newAbort)
        clients.set(discoveredKey, newClient)
        
        // Update the mapping if session ID changed
        if (existingSession.id !== mapping.sessionId) {
          topicStore.deleteMapping(chatId, effectiveTopicId)
          topicStore.createMapping(chatId, effectiveTopicId, mapping.topicName, existingSession.id, {
            creatorUserId: mapping.creatorUserId,
            iconColor: mapping.iconColor,
            iconEmojiId: mapping.iconEmojiId,
          })
          topicStore.updateWorkDir(chatId, effectiveTopicId, workDir)
          topicStore.toggleStreaming(chatId, effectiveTopicId, mapping.streamingEnabled ?? false)
        }
        
        // Register with stream handler
        streamHandler.registerSession(existingSession.id, chatId, effectiveTopicId, mapping.streamingEnabled ?? false)
        
        // Send the message
        try {
          streamHandler.markMessageFromTelegram(existingSession.id, text)
          await newClient.sendMessageAsync(existingSession.id, text)
          console.log(`[Integration] Connected to existing TUI and sent message to session ${existingSession.id}`)
          
          await sendToTopic(bot, chatId, effectiveTopicId, 
            "🔄 Reconnected to OpenCode TUI."
          )
          
          return { success: true, sessionId: existingSession.id }
        } catch (reconnectError) {
          console.error(`[Integration] Failed to send to existing TUI:`, reconnectError)
          // Fall through to create managed instance
        }
      }
    }

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
      // Mark this message as coming from Telegram so we don't echo it back
      streamHandler.markMessageFromTelegram(currentInstance.sessionId, text)
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

  // Helper to get all active sessions (managed + external + discovered)
  async function getActiveSessions(): Promise<ActiveSessionInfo[]> {
    const sessions: ActiveSessionInfo[] = []
    const knownSessionIds = new Set<string>()
    const knownPorts = new Set<number>()

    // Get managed instances from orchestrator
    const managedInstances = instanceManager.getAllInstances()
    for (const instance of managedInstances) {
      if (instance.state === "running" || instance.state === "starting") {
        if (instance.sessionId) knownSessionIds.add(instance.sessionId)
        knownPorts.add(instance.port)
        
        sessions.push({
          sessionId: instance.sessionId || `pending_${instance.config.instanceId}`,
          name: instance.config.name || `Topic ${instance.config.topicId}`,
          directory: instance.config.workDir,
          topicId: instance.config.topicId,
          isExternal: false,
          isDiscovered: false,
          port: instance.port,
          lastActivity: instance.lastActivityAt,
          status: instance.state === "running" ? "running" : "unknown",
        })
      }
    }

    // Get external instances from API server
    const externalInstances = apiServer.getExternalInstances()
    for (const ext of externalInstances) {
      knownSessionIds.add(ext.sessionId)
      knownPorts.add(ext.opencodePort)
      
      sessions.push({
        sessionId: ext.sessionId,
        name: ext.projectName,
        directory: ext.projectPath,
        topicId: ext.topicId,
        isExternal: true,
        isDiscovered: false,
        port: ext.opencodePort,
        lastActivity: ext.lastActivityAt,
        status: "running", // External instances are assumed running if registered
      })
    }

    // Discover other running OpenCode instances
    try {
      const discovered = await discoverSessions()
      
      for (const disc of discovered) {
        // Skip if we already know about this session or port
        if (knownSessionIds.has(disc.id) || knownPorts.has(disc.instance.port)) {
          continue
        }
        
        // Use directory basename as name, or title if available
        const name = disc.title || disc.directory.split('/').pop() || 'Unknown'
        
        sessions.push({
          sessionId: disc.id,
          name,
          directory: disc.directory,
          topicId: undefined, // Not linked to a topic yet
          isExternal: false,
          isDiscovered: true,
          port: disc.instance.port,
          lastActivity: disc.updatedAt,
          status: "running",
        })
      }
    } catch (error) {
      console.error('[Integration] Error discovering sessions:', error)
    }

    return sessions
  }

  // Helper to connect to an existing session from General topic
  async function connectToSession(chatId: number, sessionIdentifier: string): Promise<ConnectResult> {
    // First, get all sessions
    const sessions = await getActiveSessions()
    
    // Find matching session by name or session ID
    const normalizedId = sessionIdentifier.toLowerCase().trim()
    const matchingSession = sessions.find(s => 
      s.name.toLowerCase() === normalizedId ||
      s.sessionId.toLowerCase().startsWith(normalizedId) ||
      s.directory.toLowerCase().includes(normalizedId) ||
      s.directory.split('/').pop()?.toLowerCase() === normalizedId
    )

    if (!matchingSession) {
      return {
        success: false,
        error: `No session found matching "${sessionIdentifier}".\n\nUse \`/sessions\` to see available sessions.`,
      }
    }

    // If session already has a topic, return that
    if (matchingSession.topicId) {
      const positiveId = String(chatId).replace(/^-100/, "")
      return {
        success: true,
        sessionId: matchingSession.sessionId,
        topicId: matchingSession.topicId,
        topicUrl: `https://t.me/c/${positiveId}/${matchingSession.topicId}`,
      }
    }

    // Create a new topic for this session
    try {
      const newTopic = await bot.api.createForumTopic(chatId, matchingSession.name)
      const topicId = newTopic.message_thread_id

      // Register the session with the stream handler
      streamHandler.registerSession(matchingSession.sessionId, chatId, topicId, true)

      // Create topic mapping
      topicStore.createMapping(chatId, topicId, matchingSession.name, matchingSession.sessionId, {})
      topicStore.updateWorkDir(chatId, topicId, matchingSession.directory)
      topicStore.toggleStreaming(chatId, topicId, true)

      // For discovered sessions, we need to subscribe to SSE events
      if (matchingSession.isDiscovered && matchingSession.port) {
        const client = new OpenCodeClient({
          baseUrl: `http://localhost:${matchingSession.port}`,
        })

        // Subscribe to SSE events
        const abort = client.subscribe(
          (sseEvent: SSEEvent) => {
            console.log(`[Integration] SSE event from discovered session:`, sseEvent.type)
            streamHandler.handleEvent(sseEvent)
          },
          (error) => {
            console.error(`[Integration] SSE error for discovered session:`, error)
          }
        )

        // Store the subscription for cleanup (using topic ID as key)
        sseSubscriptions.set(`discovered_${topicId}`, abort)
        clients.set(`discovered_${topicId}`, client)
      }

      // Send welcome message
      const sessionType = matchingSession.isDiscovered ? "discovered" : "existing"
      await bot.api.sendMessage(
        chatId,
        `✅ *Connected to ${sessionType} session*\n\n` +
        `*Session:* \`${matchingSession.sessionId.slice(0, 12)}...\`\n` +
        `*Directory:* \`${matchingSession.directory}\`\n` +
        (matchingSession.port ? `*Port:* ${matchingSession.port}\n` : "") +
        `\n_Messages sent here will be forwarded to the OpenCode session._`,
        {
          message_thread_id: topicId,
          parse_mode: "Markdown",
        }
      )

      const positiveId = String(chatId).replace(/^-100/, "")
      return {
        success: true,
        sessionId: matchingSession.sessionId,
        topicId,
        topicUrl: `https://t.me/c/${positiveId}/${topicId}`,
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to create topic: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  // Helper to find stale sessions (topics linked to dead sessions)
  async function findStaleSessions(chatId: number): Promise<Array<{
    topicId: number
    topicName: string
    sessionId: string
    directory?: string
    reason: "port_dead" | "session_missing" | "instance_stopped"
  }>> {
    const staleSessions: Array<{
      topicId: number
      topicName: string
      sessionId: string
      directory?: string
      reason: "port_dead" | "session_missing" | "instance_stopped"
    }> = []

    // Get all topic mappings from the store
    const allMappings = topicStore.queryMappings({ chatId })

    for (const mapping of allMappings) {
      // Skip if no session ID or if it's a pending session
      if (!mapping.sessionId || mapping.sessionId.startsWith('pending_')) {
        continue
      }

      // Check if this is a managed instance
      const managedInstance = instanceManager.getInstanceByTopic(mapping.topicId)
      if (managedInstance) {
        // Check if the managed instance is stopped/crashed
        if (managedInstance.state === "stopped" || managedInstance.state === "crashed" || managedInstance.state === "failed") {
          staleSessions.push({
            topicId: mapping.topicId,
            topicName: mapping.topicName,
            sessionId: mapping.sessionId,
            directory: mapping.workDir,
            reason: "instance_stopped",
          })
        }
        continue
      }

      // Check if this is an external instance
      const externalInstance = apiServer.getExternalByTopic(mapping.topicId)
      if (externalInstance) {
        // Check if the external instance is still alive
        const alive = await isPortAlive(externalInstance.opencodePort)
        if (!alive) {
          staleSessions.push({
            topicId: mapping.topicId,
            topicName: mapping.topicName,
            sessionId: mapping.sessionId,
            directory: externalInstance.projectPath,
            reason: "port_dead",
          })
        }
        continue
      }

      // This mapping is not linked to any known instance - it's orphaned
      // Try to find if there's a port stored somewhere we can check
      // For now, mark as session_missing
      staleSessions.push({
        topicId: mapping.topicId,
        topicName: mapping.topicName,
        sessionId: mapping.sessionId,
        directory: mapping.workDir,
        reason: "session_missing",
      })
    }

    return staleSessions
  }

  // Helper to clean up a stale session
  async function cleanupStaleSession(chatId: number, topicId: number): Promise<boolean> {
    try {
      // Clean up SSE subscription if exists
      const discoveredKey = `discovered_${topicId}`
      const abort = sseSubscriptions.get(discoveredKey)
      if (abort) {
        abort()
        sseSubscriptions.delete(discoveredKey)
      }

      const client = clients.get(discoveredKey)
      if (client) {
        client.close()
        clients.delete(discoveredKey)
      }

      // Remove from stream handler
      const mapping = topicStore.getMapping(chatId, topicId)
      if (mapping?.sessionId) {
        streamHandler.unregisterSession(mapping.sessionId)
      }

      // Delete the topic mapping
      topicStore.deleteMapping(chatId, topicId)

      console.log(`[Integration] Cleaned up stale session for topic ${topicId}`)
      return true
    } catch (error) {
      console.error(`[Integration] Error cleaning up stale session:`, error)
      return false
    }
  }

  // Auto-cleanup stale topics based on timeout
  async function runStaleTopicCleanup(): Promise<void> {
    const chatId = config.telegram.chatId
    if (!chatId) return

    console.log(`[Integration] Running stale topic cleanup (timeout: ${config.opencode.staleTopicTimeoutMs / 1000 / 60} minutes)`)

    try {
      // Find stale topics using the topic store's built-in method
      const staleMappings = topicStore.findStaleSessions(config.opencode.staleTopicTimeoutMs)

      if (staleMappings.length === 0) {
        console.log(`[Integration] No stale topics found`)
        return
      }

      console.log(`[Integration] Found ${staleMappings.length} stale topic(s) to clean up`)

      const cleanedTopics: string[] = []
      const failedTopics: string[] = []

      for (const mapping of staleMappings) {
        try {
          // Clean up SSE subscription if exists
          const discoveredKey = `discovered_${mapping.topicId}`
          const abort = sseSubscriptions.get(discoveredKey)
          if (abort) {
            abort()
            sseSubscriptions.delete(discoveredKey)
          }

          const client = clients.get(discoveredKey)
          if (client) {
            client.close()
            clients.delete(discoveredKey)
          }

          // Unregister from stream handler
          streamHandler.unregisterSession(mapping.sessionId)

          // Stop managed instance if exists
          const managedInstance = instanceManager.getInstanceByTopic(mapping.topicId)
          if (managedInstance) {
            await instanceManager.stopInstance(managedInstance.config.instanceId)
          }

          // Delete the topic mapping
          topicStore.deleteMapping(chatId, mapping.topicId)

          // Try to delete the Telegram topic
          try {
            await bot.api.deleteForumTopic(chatId, mapping.topicId)
            console.log(`[Integration] Deleted stale topic ${mapping.topicId} (${mapping.topicName})`)
          } catch (error) {
            // Topic deletion might fail if it's already deleted
            console.warn(`[Integration] Could not delete Telegram topic ${mapping.topicId}:`, error)
          }

          cleanedTopics.push(mapping.topicName)
        } catch (error) {
          console.error(`[Integration] Failed to clean up topic ${mapping.topicId}:`, error)
          failedTopics.push(mapping.topicName)
        }
      }

      // Send summary to General topic (topicId = 0 means General)
      if (cleanedTopics.length > 0 || failedTopics.length > 0) {
        let message = `*Stale Topic Cleanup*\n\n`
        
        if (cleanedTopics.length > 0) {
          message += `*Cleaned up ${cleanedTopics.length} topic(s):*\n`
          for (const name of cleanedTopics) {
            message += `  - ${name}\n`
          }
        }
        
        if (failedTopics.length > 0) {
          message += `\n*Failed to clean up ${failedTopics.length} topic(s):*\n`
          for (const name of failedTopics) {
            message += `  - ${name}\n`
          }
        }

        message += `\n_Topics inactive for ${config.opencode.staleTopicTimeoutMs / 1000 / 60} minutes are automatically cleaned up._`

        try {
          await bot.api.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            // General topic has no message_thread_id
          })
        } catch (error) {
          console.error(`[Integration] Failed to send cleanup summary to General topic:`, error)
        }
      }
    } catch (error) {
      console.error(`[Integration] Error during stale topic cleanup:`, error)
    }
  }

  // Helper to disconnect a session and delete its topic
  async function disconnectSession(chatId: number, topicId: number): Promise<{
    success: boolean
    topicDeleted?: boolean
    error?: string
  }> {
    try {
      // Get the mapping first
      const mapping = topicStore.getMapping(chatId, topicId)
      if (!mapping) {
        return {
          success: false,
          error: "No session mapping found for this topic.",
        }
      }

      // Clean up SSE subscription if exists
      const discoveredKey = `discovered_${topicId}`
      const abort = sseSubscriptions.get(discoveredKey)
      if (abort) {
        abort()
        sseSubscriptions.delete(discoveredKey)
      }

      const client = clients.get(discoveredKey)
      if (client) {
        client.close()
        clients.delete(discoveredKey)
      }

      // Unregister from stream handler
      if (mapping.sessionId) {
        streamHandler.unregisterSession(mapping.sessionId)
      }

      // Delete the topic mapping
      topicStore.deleteMapping(chatId, topicId)

      // Stop managed instance if exists
      const managedInstance = instanceManager.getInstanceByTopic(topicId)
      if (managedInstance) {
        await instanceManager.stopInstance(managedInstance.config.instanceId)
      }

      // Try to delete the Telegram topic
      let topicDeleted = false
      try {
        await bot.api.deleteForumTopic(chatId, topicId)
        topicDeleted = true
        console.log(`[Integration] Deleted topic ${topicId}`)
      } catch (error) {
        // Topic deletion might fail if it's already deleted or we don't have permission
        console.warn(`[Integration] Could not delete topic ${topicId}:`, error)
      }

      console.log(`[Integration] Disconnected session for topic ${topicId}`)
      return {
        success: true,
        topicDeleted,
      }
    } catch (error) {
      console.error(`[Integration] Error disconnecting session:`, error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // Helper to create a new topic with directory and OpenCode instance
  async function createTopicWithInstance(chatId: number, topicName: string): Promise<CreateTopicResult> {
    try {
      // Create directory in PROJECT_BASE_PATH
      const workDir = `${config.project.basePath}/${topicName}`
      
      // Create the directory
      try {
        await Bun.$`mkdir -p ${workDir}`.quiet()
        console.log(`[Integration] Created directory: ${workDir}`)
      } catch (error) {
        return {
          success: false,
          error: `Failed to create directory: ${error instanceof Error ? error.message : String(error)}`,
        }
      }

      // Create the Telegram forum topic
      let newTopic
      try {
        newTopic = await bot.api.createForumTopic(chatId, topicName)
        console.log(`[Integration] Created topic: "${topicName}" (${newTopic.message_thread_id})`)
      } catch (error) {
        return {
          success: false,
          error: `Failed to create Telegram topic: ${error instanceof Error ? error.message : String(error)}`,
        }
      }

      const topicId = newTopic.message_thread_id

      // Create a placeholder mapping IMMEDIATELY to prevent the forum_topic_created
      // event handler from creating a duplicate mapping with a pending session
      topicStore.createMapping(chatId, topicId, topicName, `pending_${Date.now()}`, {})
      topicStore.updateWorkDir(chatId, topicId, workDir)

      // Start OpenCode instance for this topic
      const instance = await instanceManager.getOrCreateInstance(topicId, workDir, {
        name: topicName,
      })

      if (!instance) {
        return {
          success: false,
          error: "Failed to start OpenCode instance",
        }
      }

      // Wait for instance to be ready (up to 30 seconds)
      // The instance:ready event handler runs asynchronously and sets the sessionId
      const startTime = Date.now()
      let sessionId: string | undefined
      const instanceId = instance.config.instanceId
      
      while (Date.now() - startTime < 30000) {
        const current = instanceManager.getInstance(instanceId)
        if (current?.state === "running" && current.sessionId) {
          sessionId = current.sessionId
          break
        }
        if (current?.state === "failed" || current?.state === "crashed") {
          return {
            success: false,
            error: `Instance failed to start: ${current.lastError}`,
          }
        }
        await new Promise((r) => setTimeout(r, 500))
      }

      if (!sessionId) {
        return {
          success: false,
          error: "Instance did not become ready in time",
        }
      }

      // Update the placeholder mapping with the real session ID
      // We need to delete and recreate because there's no updateSessionId method
      topicStore.deleteMapping(chatId, topicId)
      topicStore.createMapping(chatId, topicId, topicName, sessionId, {})
      topicStore.updateWorkDir(chatId, topicId, workDir)
      topicStore.toggleStreaming(chatId, topicId, true) // Enable streaming by default

      // Send welcome message to the new topic
      await bot.api.sendMessage(
        chatId,
        `✅ *OpenCode session started*\n\n` +
        `*Directory:* \`${workDir}\`\n` +
        `*Session:* \`${sessionId.slice(0, 12)}...\`\n\n` +
        `_Send a message to start coding!_`,
        {
          message_thread_id: topicId,
          parse_mode: "Markdown",
        }
      )

      return {
        success: true,
        topicId,
        sessionId,
        directory: workDir,
      }
    } catch (error) {
      console.error(`[Integration] Error creating topic with instance:`, error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // Helper to list all managed project directories
  async function getManagedProjects(): Promise<ManagedProjectInfo[]> {
    const projects: ManagedProjectInfo[] = []
    const basePath = config.project.basePath

    try {
      // Read the project base directory
      const result = await Bun.$`ls -1 ${basePath} 2>/dev/null`.quiet()
      const dirNames = result.stdout.toString().trim().split('\n').filter(Boolean)

      // Get all active sessions for cross-referencing
      const activeSessions = await getActiveSessions()

      for (const name of dirNames) {
        const fullPath = `${basePath}/${name}`
        
        // Check if it's a directory
        try {
          const isDir = await Bun.$`test -d ${fullPath}`.quiet()
          if (isDir.exitCode !== 0) continue
        } catch {
          continue
        }

        // Check if there's an active session for this directory
        const matchingSession = activeSessions.find(s => 
          s.directory === fullPath || s.directory.endsWith(`/${name}`)
        )

        projects.push({
          name,
          path: fullPath,
          hasActiveSession: !!matchingSession,
          topicId: matchingSession?.topicId,
          sessionId: matchingSession?.sessionId,
        })
      }

      // Sort alphabetically by name
      projects.sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) {
      console.error('[Integration] Error listing managed projects:', error)
    }

    return projects
  }

  // Register forum commands FIRST (before text handlers so /commands are processed)
  bot.use(createForumCommands({ 
    topicManager, 
    generalAsControlPlane: true,
    topicStore,
    getActiveSessions,
    connectToSession,
    disconnectSession,
    findStaleSessions,
    cleanupStaleSession,
    createTopicWithInstance,
    getManagedProjects,
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
  // General topic is control plane only - use /new to create topics for OpenCode sessions
  bot.use(createForumHandlers({
    topicManager,
    handleGeneralTopic: true,
    generalAsControlPlane: true,  // General topic is control plane only (no OpenCode routing)
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
      // First try managed instances
      let client: OpenCodeClient | undefined
      const instanceId = sessionToInstance.get(pending.permission.sessionID)
      if (instanceId) {
        client = clients.get(instanceId)
      }
      
      // If not found, try discovered/reconnected sessions
      if (!client) {
        // Get the topic ID from the stream handler's session registration
        const destination = streamHandler.getTelegramDestination(pending.permission.sessionID)
        if (destination) {
          const discoveredKey = `discovered_${destination.topicId}`
          client = clients.get(discoveredKey)
          console.log(`[Integration] Looking for discovered client with key ${discoveredKey}: ${client ? 'found' : 'not found'}`)
        }
      }
      
      if (!client) {
        console.error(`[Integration] No client found for session ${pending.permission.sessionID}`)
        await ctx.answerCallbackQuery({ text: "Session not found" })
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

  // Create API server for external instance registration
  const apiPort = parseInt(process.env.API_PORT || "4200")
  apiServer = createApiServer({
    port: apiPort,
    bot,
    config,
    topicStore,
    streamHandler,
    apiKey: process.env.API_KEY,
  })

  console.log("[Integration] Components initialized")

  return {
    bot,
    topicManager,
    instanceManager,
    streamHandler,
    apiServer,

    async start() {
      console.log("[Integration] Starting application...")

      // Recover orchestrator state
      await instanceManager.recover()

      // Start stale topic cleanup timer
      if (config.opencode.staleTopicCleanupIntervalMs > 0) {
        console.log(`[Integration] Starting stale topic cleanup timer (interval: ${config.opencode.staleTopicCleanupIntervalMs / 1000 / 60} minutes)`)
        staleCleanupTimer = setInterval(
          () => runStaleTopicCleanup(),
          config.opencode.staleTopicCleanupIntervalMs
        )
      }

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

      // Stop stale topic cleanup timer
      if (staleCleanupTimer) {
        clearInterval(staleCleanupTimer)
        staleCleanupTimer = null
      }

      // Stop API server
      apiServer.stop()

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
