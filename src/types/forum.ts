/**
 * Forum Topic Support Types
 * 
 * Type definitions for mapping Telegram forum topics to OpenCode sessions.
 * Each forum topic in a supergroup maps 1:1 to an OpenCode session.
 */

/**
 * Represents a forum topic's lifecycle state
 */
export type TopicStatus = "active" | "closed" | "deleted"

/**
 * Core mapping between a Telegram forum topic and an OpenCode session
 */
export interface TopicMapping {
  // Telegram identifiers
  chatId: number                    // The supergroup chat ID
  topicId: number                   // message_thread_id (0 for General topic)
  topicName: string                 // Human-readable topic name
  
  // OpenCode session
  sessionId: string                 // OpenCode session ID
  
  // Lifecycle tracking
  status: TopicStatus               // Current topic state
  createdAt: number                 // Unix timestamp when mapping was created
  updatedAt: number                 // Unix timestamp of last update
  closedAt?: number                 // Unix timestamp when topic was closed
  
  // Optional metadata
  creatorUserId?: number            // Telegram user who created the topic
  iconColor?: number                // Topic icon color (from Telegram)
  iconEmojiId?: string              // Custom emoji ID for topic icon
}

/**
 * Result of creating a new topic mapping
 */
export interface TopicMappingResult {
  success: boolean
  mapping?: TopicMapping
  error?: string
  isExisting?: boolean              // True if mapping already existed
}

/**
 * Options for querying topic mappings
 */
export interface TopicQueryOptions {
  chatId?: number                   // Filter by chat
  status?: TopicStatus              // Filter by status
  limit?: number                    // Max results to return
  offset?: number                   // Pagination offset
}

/**
 * Topic event types for lifecycle tracking
 */
export type TopicEventType = 
  | "created"                       // New topic created
  | "closed"                        // Topic was closed
  | "reopened"                      // Topic was reopened
  | "renamed"                       // Topic name changed
  | "deleted"                       // Topic was deleted
  | "message"                       // Message received in topic

/**
 * Record of a topic lifecycle event
 */
export interface TopicEvent {
  id: string                        // Unique event ID
  topicId: number                   // The forum topic ID
  chatId: number                    // The supergroup chat ID
  eventType: TopicEventType         // Type of event
  timestamp: number                 // When the event occurred
  userId?: number                   // User who triggered the event
  metadata?: Record<string, unknown> // Additional event data
}

/**
 * Statistics for a topic's OpenCode session
 */
export interface TopicSessionStats {
  messageCount: number              // Total messages in topic
  lastMessageAt?: number            // Timestamp of last message
  toolCalls: number                 // Total tool calls in session
  errorCount: number                // Number of errors encountered
  isProcessing: boolean             // Currently processing a message
}

/**
 * Extended mapping with session statistics
 */
export interface TopicMappingWithStats extends TopicMapping {
  stats: TopicSessionStats
}

/**
 * Configuration for the topic manager
 */
export interface TopicManagerConfig {
  // Database path for SQLite persistence
  databasePath: string
  
  // Whether to auto-create sessions for new topics
  autoCreateSessions: boolean
  
  // Default session configuration for new topics
  defaultSessionConfig?: {
    model?: string
    systemPrompt?: string
  }
  
  // General topic handling (message_thread_id = undefined)
  handleGeneralTopic: boolean
  
  // Session cleanup
  sessionTimeoutMs?: number         // Auto-close sessions after inactivity
  cleanupIntervalMs?: number        // How often to check for stale sessions
}

/**
 * Message context from a forum topic
 */
export interface ForumMessageContext {
  // Telegram message info
  messageId: number
  chatId: number
  topicId: number                   // 0 for General topic
  userId: number
  username?: string
  text: string
  replyToMessageId?: number
  
  // Derived info
  isGeneralTopic: boolean
  isReply: boolean
}

/**
 * Result of routing a message to OpenCode
 */
export interface MessageRouteResult {
  success: boolean
  sessionId?: string
  error?: string
  isNewSession?: boolean            // True if this created a new session
}

/**
 * Interface for the OpenCode client (already exists in codebase)
 * This is a minimal interface to avoid tight coupling
 */
export interface IOpenCodeClient {
  createSession(config?: { model?: string; systemPrompt?: string }): Promise<{ id: string }>
  sendMessage(sessionId: string, message: string): Promise<void>
  getSession(sessionId: string): Promise<{ id: string; status: string } | null>
  closeSession(sessionId: string): Promise<void>
}

/**
 * Callback for handling OpenCode responses
 */
export type ResponseHandler = (
  chatId: number,
  topicId: number,
  response: string
) => Promise<void>

/**
 * Error types specific to forum topic operations
 */
export class TopicError extends Error {
  constructor(
    message: string,
    public readonly code: TopicErrorCode,
    public readonly topicId?: number,
    public readonly chatId?: number
  ) {
    super(message)
    this.name = "TopicError"
  }
}

export type TopicErrorCode =
  | "TOPIC_NOT_FOUND"               // Topic doesn't exist in database
  | "SESSION_NOT_FOUND"             // OpenCode session doesn't exist
  | "SESSION_CREATE_FAILED"         // Failed to create OpenCode session
  | "DATABASE_ERROR"                // SQLite operation failed
  | "INVALID_TOPIC_ID"              // Invalid topic ID provided
  | "TOPIC_CLOSED"                  // Topic is closed, can't send messages
  | "DUPLICATE_MAPPING"             // Mapping already exists
