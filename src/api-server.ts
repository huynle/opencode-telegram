/**
 * API Server for External OpenCode Instance Registration
 * 
 * Provides REST endpoints for:
 * - Registering external OpenCode instances (from plugin)
 * - Unregistering instances on shutdown
 * - Checking registration status
 * 
 * This enables any OpenCode instance (running anywhere) to link
 * to a Telegram topic for bidirectional communication.
 */

// Server type from Bun
import type { Bot } from "grammy"
import type { AppConfig } from "./config"
import { OpenCodeClient } from "./opencode/client"
import { StreamHandler } from "./opencode/stream-handler"
import type { TopicStore } from "./forum/topic-store"

// =============================================================================
// Types
// =============================================================================

/**
 * Request body for POST /api/register
 */
export interface RegisterRequest {
  /** Absolute path to the project directory */
  projectPath: string
  /** Human-readable project name (used as topic name) */
  projectName: string
  /** Port where OpenCode is serving (e.g., 4096) */
  opencodePort: number
  /** OpenCode session ID */
  sessionId: string
  /** Enable real-time streaming (default: true) */
  enableStreaming?: boolean
}

/**
 * Response from POST /api/register
 */
export interface RegisterResponse {
  success: boolean
  topicId?: number
  topicUrl?: string
  error?: string
}

/**
 * External instance tracking
 */
export interface ExternalInstance {
  projectPath: string
  projectName: string
  opencodePort: number
  sessionId: string
  topicId: number
  client: OpenCodeClient
  sseAbort: () => void
  registeredAt: Date
  lastActivityAt: Date
}

// =============================================================================
// API Server
// =============================================================================

export interface ApiServerConfig {
  port: number
  bot: Bot
  config: AppConfig
  topicStore: TopicStore
  streamHandler: StreamHandler
  /** Optional API key for authentication */
  apiKey?: string
}

export class ApiServer {
  private server?: ReturnType<typeof Bun.serve>
  private externalInstances = new Map<string, ExternalInstance>()
  private config: ApiServerConfig

  constructor(config: ApiServerConfig) {
    this.config = config
  }

  /**
   * Start the API server
   */
  start(): void {
    const { port, apiKey } = this.config

    this.server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url)

        // CORS headers for cross-origin requests
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
        }

        // Handle preflight
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders })
        }

        // API key authentication (if configured)
        if (apiKey) {
          const providedKey = req.headers.get("X-API-Key")
          if (providedKey !== apiKey) {
            return this.jsonResponse({ error: "Unauthorized" }, 401, corsHeaders)
          }
        }

        try {
          // Route requests
          if (url.pathname === "/api/health" && req.method === "GET") {
            return this.handleHealth(corsHeaders)
          }

          if (url.pathname === "/api/register" && req.method === "POST") {
            return this.handleRegister(req, corsHeaders)
          }

          if (url.pathname === "/api/unregister" && req.method === "POST") {
            return this.handleUnregister(req, corsHeaders)
          }

          if (url.pathname.startsWith("/api/status/") && req.method === "GET") {
            const projectPath = decodeURIComponent(url.pathname.slice("/api/status/".length))
            return this.handleStatus(projectPath, corsHeaders)
          }

          if (url.pathname === "/api/instances" && req.method === "GET") {
            return this.handleListInstances(corsHeaders)
          }

          return this.jsonResponse({ error: "Not found" }, 404, corsHeaders)
        } catch (error) {
          console.error("[ApiServer] Error:", error)
          return this.jsonResponse(
            { error: error instanceof Error ? error.message : "Internal error" },
            500,
            corsHeaders
          )
        }
      },
    })

    console.log(`[ApiServer] Listening on http://localhost:${port}`)
  }

  /**
   * Stop the API server
   */
  stop(): void {
    // Clean up all external instances
    for (const [key, instance] of this.externalInstances) {
      instance.sseAbort()
      instance.client.close()
    }
    this.externalInstances.clear()

    this.server?.stop()
    console.log("[ApiServer] Stopped")
  }

  // ===========================================================================
  // Handlers
  // ===========================================================================

  private handleHealth(headers: Record<string, string>): Response {
    return this.jsonResponse(
      {
        status: "ok",
        externalInstances: this.externalInstances.size,
        timestamp: new Date().toISOString(),
      },
      200,
      headers
    )
  }

  private async handleRegister(
    req: Request,
    headers: Record<string, string>
  ): Promise<Response> {
    const body = (await req.json()) as RegisterRequest

    // Validate required fields
    if (!body.projectPath || !body.projectName || !body.opencodePort || !body.sessionId) {
      return this.jsonResponse(
        { error: "Missing required fields: projectPath, projectName, opencodePort, sessionId" },
        400,
        headers
      )
    }

    const { projectPath, projectName, opencodePort, sessionId, enableStreaming = true } = body

    console.log(`[ApiServer] Register request: ${projectName} (${projectPath}) on port ${opencodePort}`)

    // Check if already registered
    if (this.externalInstances.has(projectPath)) {
      const existing = this.externalInstances.get(projectPath)!
      return this.jsonResponse(
        {
          success: true,
          topicId: existing.topicId,
          topicUrl: this.getTopicUrl(existing.topicId),
          message: "Already registered",
        },
        200,
        headers
      )
    }

    try {
      // Create Telegram forum topic
      const chatId = this.config.config.telegram.chatId
      const topic = await this.config.bot.api.createForumTopic(chatId, projectName)
      const topicId = topic.message_thread_id

      console.log(`[ApiServer] Created topic "${projectName}" (${topicId})`)

      // Send welcome message to the topic
      await this.config.bot.api.sendMessage(
        chatId,
        `*Session linked from external OpenCode instance*\n\n` +
          `*Project:* \`${projectPath}\`\n` +
          `*Session:* \`${sessionId.slice(0, 8)}...\`\n\n` +
          `_Messages sent here will be forwarded to OpenCode._`,
        {
          message_thread_id: topicId,
          parse_mode: "Markdown",
        }
      )

      // Create OpenCode client for this instance
      const client = new OpenCodeClient({
        baseUrl: `http://localhost:${opencodePort}`,
      })

      // Verify the instance is reachable
      const isHealthy = await client.isHealthy()
      if (!isHealthy) {
        // Clean up the topic we just created
        try {
          await this.config.bot.api.deleteForumTopic(chatId, topicId)
        } catch {
          // Ignore cleanup errors
        }
        return this.jsonResponse(
          { error: `Cannot connect to OpenCode at localhost:${opencodePort}` },
          400,
          headers
        )
      }

      // Register session with stream handler
      this.config.streamHandler.registerSession(sessionId, chatId, topicId, enableStreaming)

      // Subscribe to SSE events from the external instance
      const sseAbort = client.subscribe(
        (event) => {
          console.log(`[ApiServer] SSE event from ${projectName}:`, event.type)
          this.config.streamHandler.handleEvent(event)

          // Update last activity
          const instance = this.externalInstances.get(projectPath)
          if (instance) {
            instance.lastActivityAt = new Date()
          }
        },
        (error) => {
          console.error(`[ApiServer] SSE error for ${projectName}:`, error)
        }
      )

      // Store the external instance
      const instance: ExternalInstance = {
        projectPath,
        projectName,
        opencodePort,
        sessionId,
        topicId,
        client,
        sseAbort,
        registeredAt: new Date(),
        lastActivityAt: new Date(),
      }
      this.externalInstances.set(projectPath, instance)

      // Create topic mapping in store
      this.config.topicStore.createMapping(chatId, topicId, projectName, sessionId, {})
      this.config.topicStore.updateWorkDir(chatId, topicId, projectPath)
      if (enableStreaming) {
        this.config.topicStore.toggleStreaming(chatId, topicId, true)
      }

      console.log(`[ApiServer] Registered external instance: ${projectName}`)

      return this.jsonResponse(
        {
          success: true,
          topicId,
          topicUrl: this.getTopicUrl(topicId),
        },
        200,
        headers
      )
    } catch (error) {
      console.error("[ApiServer] Registration failed:", error)
      return this.jsonResponse(
        { error: error instanceof Error ? error.message : "Registration failed" },
        500,
        headers
      )
    }
  }

  private async handleUnregister(
    req: Request,
    headers: Record<string, string>
  ): Promise<Response> {
    const body = (await req.json()) as { projectPath: string }

    if (!body.projectPath) {
      return this.jsonResponse({ error: "Missing projectPath" }, 400, headers)
    }

    const instance = this.externalInstances.get(body.projectPath)
    if (!instance) {
      return this.jsonResponse({ error: "Not registered" }, 404, headers)
    }

    console.log(`[ApiServer] Unregistering: ${instance.projectName}`)

    // Clean up SSE subscription
    instance.sseAbort()
    instance.client.close()

    // Send goodbye message
    try {
      await this.config.bot.api.sendMessage(
        this.config.config.telegram.chatId,
        `*Session disconnected*\n\n_The OpenCode instance has been unlinked._`,
        {
          message_thread_id: instance.topicId,
          parse_mode: "Markdown",
        }
      )
    } catch {
      // Ignore send errors
    }

    // Remove from tracking
    this.externalInstances.delete(body.projectPath)

    // Update topic store
    this.config.topicStore.updateStatus(
      this.config.config.telegram.chatId,
      instance.topicId,
      "closed"
    )

    return this.jsonResponse({ success: true }, 200, headers)
  }

  private handleStatus(
    projectPath: string,
    headers: Record<string, string>
  ): Response {
    const instance = this.externalInstances.get(projectPath)

    if (!instance) {
      return this.jsonResponse({ registered: false }, 200, headers)
    }

    return this.jsonResponse(
      {
        registered: true,
        projectName: instance.projectName,
        topicId: instance.topicId,
        topicUrl: this.getTopicUrl(instance.topicId),
        registeredAt: instance.registeredAt.toISOString(),
        lastActivityAt: instance.lastActivityAt.toISOString(),
      },
      200,
      headers
    )
  }

  private handleListInstances(headers: Record<string, string>): Response {
    const instances = Array.from(this.externalInstances.values()).map((i) => ({
      projectPath: i.projectPath,
      projectName: i.projectName,
      topicId: i.topicId,
      registeredAt: i.registeredAt.toISOString(),
      lastActivityAt: i.lastActivityAt.toISOString(),
    }))

    return this.jsonResponse({ instances }, 200, headers)
  }

  // ===========================================================================
  // Message Routing (Telegram → External OpenCode)
  // ===========================================================================

  /**
   * Route a message from Telegram to an external OpenCode instance
   * Called by the bot when a message is received in a linked topic
   */
  async routeMessageToExternal(topicId: number, text: string): Promise<boolean> {
    // Find the external instance for this topic
    for (const instance of this.externalInstances.values()) {
      if (instance.topicId === topicId) {
        try {
          await instance.client.sendMessageAsync(instance.sessionId, text)
          instance.lastActivityAt = new Date()
          return true
        } catch (error) {
          console.error(`[ApiServer] Failed to route message to ${instance.projectName}:`, error)
          return false
        }
      }
    }
    return false
  }

  /**
   * Check if a topic is linked to an external instance
   */
  isExternalTopic(topicId: number): boolean {
    for (const instance of this.externalInstances.values()) {
      if (instance.topicId === topicId) {
        return true
      }
    }
    return false
  }

  /**
   * Get external instance by topic ID
   */
  getExternalByTopic(topicId: number): ExternalInstance | undefined {
    for (const instance of this.externalInstances.values()) {
      if (instance.topicId === topicId) {
        return instance
      }
    }
    return undefined
  }

  /**
   * Get all external instances (for session listing)
   */
  getExternalInstances(): Array<{
    projectPath: string
    projectName: string
    topicId: number
    sessionId: string
    opencodePort: number
    registeredAt: Date
    lastActivityAt: Date
  }> {
    return Array.from(this.externalInstances.values()).map((i) => ({
      projectPath: i.projectPath,
      projectName: i.projectName,
      topicId: i.topicId,
      sessionId: i.sessionId,
      opencodePort: i.opencodePort,
      registeredAt: i.registeredAt,
      lastActivityAt: i.lastActivityAt,
    }))
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private jsonResponse(
    data: unknown,
    status: number,
    headers: Record<string, string>
  ): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    })
  }

  private getTopicUrl(topicId: number): string {
    const chatId = this.config.config.telegram.chatId
    // Convert negative chat ID to positive for URL (remove -100 prefix)
    const positiveId = String(chatId).replace(/^-100/, "")
    return `https://t.me/c/${positiveId}/${topicId}`
  }
}

/**
 * Create and start the API server
 */
export function createApiServer(config: ApiServerConfig): ApiServer {
  const server = new ApiServer(config)
  server.start()
  return server
}
