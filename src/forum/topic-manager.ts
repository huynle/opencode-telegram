/**
 * Topic Manager - Orchestrates Forum Topics and OpenCode Sessions
 * 
 * Manages the lifecycle of forum topics and their associated OpenCode sessions:
 * - Creates sessions when new topics are detected
 * - Routes messages from topics to correct sessions
 * - Handles topic lifecycle events (created, closed, reopened)
 * - Recovers state after bot restarts
 */

import type {
  TopicMapping,
  TopicMappingResult,
  TopicManagerConfig,
  ForumMessageContext,
  MessageRouteResult,
  IOpenCodeClient,
  ResponseHandler,
  TopicStatus,
  TopicSessionStats,
  TopicMappingWithStats,
} from "../types/forum"
import { TopicError } from "../types/forum"
import { TopicStore } from "./topic-store"

/**
 * Default configuration for the topic manager
 */
const DEFAULT_CONFIG: TopicManagerConfig = {
  databasePath: "./data/topics.db",
  autoCreateSessions: true,
  handleGeneralTopic: true,
  sessionTimeoutMs: 30 * 60 * 1000,     // 30 minutes
  cleanupIntervalMs: 5 * 60 * 1000,     // 5 minutes
}

/**
 * Topic Manager - Coordinates forum topics with OpenCode sessions
 */
export class TopicManager {
  private store: TopicStore
  private config: TopicManagerConfig
  private opencode: IOpenCodeClient
  private responseHandler: ResponseHandler
  private cleanupTimer?: ReturnType<typeof setInterval>
  
  // Track which sessions are currently processing messages
  private processingMessages = new Map<string, boolean>()

  constructor(
    opencode: IOpenCodeClient,
    responseHandler: ResponseHandler,
    config: Partial<TopicManagerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.opencode = opencode
    this.responseHandler = responseHandler
    
    // Initialize store
    this.store = new TopicStore(this.config.databasePath)
    
    // Start cleanup timer if configured
    if (this.config.sessionTimeoutMs && this.config.cleanupIntervalMs) {
      this.startCleanupTimer()
    }
    
    console.log("[TopicManager] Initialized")
  }

  /**
   * Handle a new forum topic being created
   * 
   * This is called when grammY receives a forum_topic_created service message.
   * Creates a new OpenCode session and maps it to the topic.
   */
  async handleTopicCreated(
    chatId: number,
    topicId: number,
    topicName: string,
    creatorUserId?: number,
    iconColor?: number,
    iconEmojiId?: string
  ): Promise<TopicMappingResult> {
    console.log(`[TopicManager] New topic created: "${topicName}" (${topicId}) in chat ${chatId}`)

    // Check if mapping already exists (might happen on restart)
    const existing = this.store.getMapping(chatId, topicId)
    if (existing) {
      console.log(`[TopicManager] Mapping already exists for topic ${topicId}`)
      return {
        success: true,
        mapping: existing,
        isExisting: true,
      }
    }

    // Create new OpenCode session
    if (!this.config.autoCreateSessions) {
      return {
        success: false,
        error: "Auto-create sessions is disabled",
      }
    }

    try {
      const session = await this.opencode.createSession(this.config.defaultSessionConfig)
      console.log(`[TopicManager] Created OpenCode session: ${session.id}`)

      // Create mapping
      const result = this.store.createMapping(
        chatId,
        topicId,
        topicName,
        session.id,
        { creatorUserId, iconColor, iconEmojiId }
      )

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[TopicManager] Failed to create session: ${message}`)
      return {
        success: false,
        error: `Failed to create OpenCode session: ${message}`,
      }
    }
  }

  /**
   * Handle a forum topic being closed
   */
  async handleTopicClosed(chatId: number, topicId: number, userId?: number): Promise<boolean> {
    console.log(`[TopicManager] Topic closed: ${topicId} in chat ${chatId}`)

    const mapping = this.store.getMapping(chatId, topicId)
    if (!mapping) {
      console.log(`[TopicManager] No mapping found for closed topic ${topicId}`)
      return false
    }

    // Update status in store
    const updated = this.store.updateStatus(chatId, topicId, "closed", userId)
    
    // Optionally close the OpenCode session
    try {
      await this.opencode.closeSession(mapping.sessionId)
      console.log(`[TopicManager] Closed OpenCode session ${mapping.sessionId}`)
    } catch (error) {
      console.error(`[TopicManager] Failed to close session: ${error}`)
      // Don't fail the status update just because session close failed
    }

    return updated
  }

  /**
   * Handle a forum topic being reopened
   */
  async handleTopicReopened(chatId: number, topicId: number, userId?: number): Promise<boolean> {
    console.log(`[TopicManager] Topic reopened: ${topicId} in chat ${chatId}`)

    const mapping = this.store.getMapping(chatId, topicId)
    if (!mapping) {
      console.log(`[TopicManager] No mapping found for reopened topic ${topicId}`)
      return false
    }

    // Check if the session still exists
    const session = await this.opencode.getSession(mapping.sessionId)
    
    if (!session) {
      // Session was deleted, create a new one
      console.log(`[TopicManager] Session ${mapping.sessionId} no longer exists, creating new one`)
      try {
        const newSession = await this.opencode.createSession(this.config.defaultSessionConfig)
        
        // Update the mapping with new session ID
        // We need to delete and recreate since session_id isn't easily updatable
        this.store.deleteMapping(chatId, topicId)
        this.store.createMapping(chatId, topicId, mapping.topicName, newSession.id, {
          creatorUserId: mapping.creatorUserId,
          iconColor: mapping.iconColor,
          iconEmojiId: mapping.iconEmojiId,
        })
        
        console.log(`[TopicManager] Created new session ${newSession.id} for reopened topic`)
      } catch (error) {
        console.error(`[TopicManager] Failed to create new session: ${error}`)
        return false
      }
    }

    // Update status to active
    return this.store.updateStatus(chatId, topicId, "active", userId)
  }

  /**
   * Handle a forum topic being renamed/edited
   */
  handleTopicEdited(
    chatId: number,
    topicId: number,
    newName: string,
    userId?: number
  ): boolean {
    console.log(`[TopicManager] Topic renamed: ${topicId} -> "${newName}"`)
    return this.store.updateName(chatId, topicId, newName, userId)
  }

  /**
   * Route a message from a forum topic to its OpenCode session
   * 
   * This is the main entry point for handling user messages.
   */
  async routeMessage(context: ForumMessageContext): Promise<MessageRouteResult> {
    const { chatId, topicId, text, userId } = context
    
    console.log(`[TopicManager] Routing message from topic ${topicId}: "${text.slice(0, 50)}..."`)

    // Handle General topic (topicId = 0)
    const effectiveTopicId = context.isGeneralTopic ? 0 : topicId

    // Skip General topic if not configured
    if (context.isGeneralTopic && !this.config.handleGeneralTopic) {
      return {
        success: false,
        error: "General topic handling is disabled",
      }
    }

    // Get or create mapping
    let mapping = this.store.getMapping(chatId, effectiveTopicId)
    let isNewSession = false

    if (!mapping) {
      // First message in this topic - create mapping
      console.log(`[TopicManager] No mapping found, creating session for topic ${effectiveTopicId}`)
      
      if (!this.config.autoCreateSessions) {
        return {
          success: false,
          error: "No session exists for this topic and auto-create is disabled",
        }
      }

      try {
        const session = await this.opencode.createSession(this.config.defaultSessionConfig)
        const topicName = context.isGeneralTopic ? "General" : `Topic ${effectiveTopicId}`
        
        const result = this.store.createMapping(
          chatId,
          effectiveTopicId,
          topicName,
          session.id,
          { creatorUserId: userId }
        )

        if (!result.success || !result.mapping) {
          return {
            success: false,
            error: result.error || "Failed to create mapping",
          }
        }

        mapping = result.mapping
        isNewSession = true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          error: `Failed to create session: ${message}`,
        }
      }
    }

    // Check if topic is closed
    if (mapping.status === "closed") {
      return {
        success: false,
        error: "Topic is closed. Reopen it to send messages.",
      }
    }

    // Check if already processing a message for this session
    if (this.processingMessages.get(mapping.sessionId)) {
      console.log(`[TopicManager] Session ${mapping.sessionId} is busy, queuing message`)
      // In a production system, you might want to queue messages
      // For now, we'll just indicate the session is busy
    }

    // Mark as processing
    this.processingMessages.set(mapping.sessionId, true)

    try {
      // Record the message in stats
      this.store.recordMessage(chatId, effectiveTopicId)
      this.store.logEvent(chatId, effectiveTopicId, "message", userId)

      // Send to OpenCode
      await this.opencode.sendMessage(mapping.sessionId, text)

      return {
        success: true,
        sessionId: mapping.sessionId,
        isNewSession,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.recordError(chatId, effectiveTopicId)
      console.error(`[TopicManager] Failed to send message: ${message}`)
      
      return {
        success: false,
        sessionId: mapping.sessionId,
        error: message,
      }
    } finally {
      // Clear processing flag
      this.processingMessages.set(mapping.sessionId, false)
    }
  }

  /**
   * Get the mapping for a topic
   */
  getMapping(chatId: number, topicId: number): TopicMapping | null {
    return this.store.getMapping(chatId, topicId)
  }

  /**
   * Get mapping by session ID (useful for routing responses back)
   */
  getMappingBySession(sessionId: string): TopicMapping | null {
    return this.store.getMappingBySession(sessionId)
  }

  /**
   * Get all active topics for a chat
   */
  getActiveTopics(chatId: number): TopicMapping[] {
    return this.store.getActiveMappings(chatId)
  }

  /**
   * Get topic with full stats
   */
  getTopicWithStats(chatId: number, topicId: number): TopicMappingWithStats | null {
    const mapping = this.store.getMapping(chatId, topicId)
    if (!mapping) return null

    const stats = this.store.getStats(chatId, topicId)
    const isProcessing = this.processingMessages.get(mapping.sessionId) ?? false

    return {
      ...mapping,
      stats: {
        messageCount: stats?.messageCount ?? 0,
        lastMessageAt: stats?.lastMessageAt,
        toolCalls: stats?.toolCalls ?? 0,
        errorCount: stats?.errorCount ?? 0,
        isProcessing,
      },
    }
  }

  /**
   * Record a tool call for stats tracking
   */
  recordToolCall(sessionId: string): void {
    const mapping = this.store.getMappingBySession(sessionId)
    if (mapping) {
      this.store.recordToolCall(mapping.chatId, mapping.topicId)
    }
  }

  /**
   * Recover state after bot restart
   * 
   * Validates that all stored sessions still exist in OpenCode.
   */
  async recoverState(): Promise<{ recovered: number; cleaned: number }> {
    console.log("[TopicManager] Recovering state after restart...")

    const sessionIds = this.store.getAllSessionIds()
    let recovered = 0
    let cleaned = 0

    for (const sessionId of sessionIds) {
      try {
        const session = await this.opencode.getSession(sessionId)
        
        if (session) {
          recovered++
        } else {
          // Session no longer exists, mark mapping as closed
          const mapping = this.store.getMappingBySession(sessionId)
          if (mapping) {
            this.store.updateStatus(mapping.chatId, mapping.topicId, "closed")
            cleaned++
          }
        }
      } catch (error) {
        console.error(`[TopicManager] Error checking session ${sessionId}: ${error}`)
      }
    }

    console.log(`[TopicManager] Recovery complete: ${recovered} active, ${cleaned} cleaned`)
    return { recovered, cleaned }
  }

  /**
   * Start the cleanup timer for stale sessions
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleSessions()
    }, this.config.cleanupIntervalMs!)

    console.log(`[TopicManager] Cleanup timer started (interval: ${this.config.cleanupIntervalMs}ms)`)
  }

  /**
   * Clean up sessions that have been inactive
   */
  private async cleanupStaleSessions(): Promise<void> {
    if (!this.config.sessionTimeoutMs) return

    const staleMappings = this.store.findStaleSessions(this.config.sessionTimeoutMs)
    
    if (staleMappings.length === 0) return

    console.log(`[TopicManager] Found ${staleMappings.length} stale sessions to clean up`)

    for (const mapping of staleMappings) {
      try {
        // Close the OpenCode session
        await this.opencode.closeSession(mapping.sessionId)
        
        // Mark as closed in store
        this.store.updateStatus(mapping.chatId, mapping.topicId, "closed")
        
        console.log(`[TopicManager] Cleaned up stale session ${mapping.sessionId}`)
      } catch (error) {
        console.error(`[TopicManager] Failed to cleanup session: ${error}`)
      }
    }
  }

  /**
   * Link a topic to an existing project directory
   * 
   * This updates the workDir for the topic and requires restarting the instance.
   * Returns the updated mapping if successful.
   */
  linkToDirectory(
    chatId: number,
    topicId: number,
    workDir: string,
    userId?: number
  ): { success: boolean; mapping?: TopicMapping; error?: string } {
    // Verify the mapping exists
    const mapping = this.store.getMapping(chatId, topicId)
    if (!mapping) {
      return {
        success: false,
        error: "No session exists for this topic. Send a message first to create one.",
      }
    }

    // Update the workDir
    const updated = this.store.updateWorkDir(chatId, topicId, workDir, userId)
    if (!updated) {
      return {
        success: false,
        error: "Failed to update working directory",
      }
    }

    // Return updated mapping
    const updatedMapping = this.store.getMapping(chatId, topicId)
    return {
      success: true,
      mapping: updatedMapping ?? undefined,
    }
  }

  /**
   * Manually create a session for a topic (bypasses auto-create check)
   */
  async createSessionForTopic(
    chatId: number,
    topicId: number,
    topicName: string
  ): Promise<TopicMappingResult> {
    // Check if already exists
    const existing = this.store.getMapping(chatId, topicId)
    if (existing) {
      return {
        success: true,
        mapping: existing,
        isExisting: true,
      }
    }

    try {
      const session = await this.opencode.createSession(this.config.defaultSessionConfig)
      return this.store.createMapping(chatId, topicId, topicName, session.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: message,
      }
    }
  }

  /**
   * Close and cleanup
   */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
    
    this.store.close()
    console.log("[TopicManager] Closed")
  }
}

/**
 * Create a topic manager instance
 */
export function createTopicManager(
  opencode: IOpenCodeClient,
  responseHandler: ResponseHandler,
  config?: Partial<TopicManagerConfig>
): TopicManager {
  return new TopicManager(opencode, responseHandler, config)
}
