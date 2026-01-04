/**
 * OpenCode REST API and SSE Types
 * 
 * Type definitions for interacting with OpenCode's REST API and SSE events.
 * Based on OpenCode's server documentation.
 */

// =============================================================================
// REST API Response Types
// =============================================================================

/**
 * Health check response from /global/health
 */
export interface HealthResponse {
  healthy: boolean
  version: string
}

/**
 * Session object from OpenCode API
 */
export interface Session {
  id: string
  title?: string
  path: string
  createdAt: string
  updatedAt: string
  status?: "idle" | "running" | "error"
}

/**
 * Message part types
 */
export type PartType = "text" | "tool-invocation" | "tool-result" | "file" | "reasoning"

/**
 * Base message part
 */
export interface BasePart {
  type: PartType
}

/**
 * Text part in a message
 */
export interface TextPart extends BasePart {
  type: "text"
  text: string
}

/**
 * Tool invocation part
 */
export interface ToolInvocationPart extends BasePart {
  type: "tool-invocation"
  toolInvocation: {
    state: "partial-call" | "call" | "result"
    toolCallId: string
    toolName: string
    args?: Record<string, unknown>
    result?: unknown
  }
}

/**
 * Tool result part
 */
export interface ToolResultPart extends BasePart {
  type: "tool-result"
  toolResult: {
    toolCallId: string
    result: unknown
  }
}

/**
 * File part
 */
export interface FilePart extends BasePart {
  type: "file"
  file: {
    path: string
    content?: string
  }
}

/**
 * Reasoning part (for models that support it)
 */
export interface ReasoningPart extends BasePart {
  type: "reasoning"
  reasoning: string
}

/**
 * Union of all part types
 */
export type Part = TextPart | ToolInvocationPart | ToolResultPart | FilePart | ReasoningPart

/**
 * Message info
 */
export interface MessageInfo {
  id: string
  sessionID: string
  role: "user" | "assistant"
  createdAt: string
  model?: {
    providerID: string
    modelID: string
  }
  tokens?: {
    input: number
    output: number
    reasoning?: number
    cache?: {
      read: number
      write: number
    }
  }
  system?: string
  time?: {
    start: string
    end?: string
  }
}

/**
 * Full message with parts
 */
export interface Message {
  info: MessageInfo
  parts: Part[]
}

/**
 * Response from GET /session/:id/message
 */
export interface MessagesResponse {
  data: Message[]
}

/**
 * Request body for POST /session/:id/message
 */
export interface SendMessageRequest {
  parts: Array<{ type: "text"; text: string }>
  model?: {
    providerID: string
    modelID: string
  }
  agent?: string
  noReply?: boolean
}

/**
 * Request body for POST /session
 */
export interface CreateSessionRequest {
  title?: string
  path?: string
}

// =============================================================================
// SSE Event Types
// =============================================================================

/**
 * Base SSE event structure
 */
export interface BaseSSEEvent {
  type: string
  properties: Record<string, unknown>
}

/**
 * Session idle event - session finished processing
 */
export interface SessionIdleEvent extends BaseSSEEvent {
  type: "session.idle"
  properties: {
    sessionID: string
  }
}

/**
 * Session updated event
 */
export interface SessionUpdatedEvent extends BaseSSEEvent {
  type: "session.updated"
  properties: {
    sessionID: string
    status: "idle" | "running" | "error"
  }
}

/**
 * Session error event
 */
export interface SessionErrorEvent extends BaseSSEEvent {
  type: "session.error"
  properties: {
    sessionID: string
    error: string
  }
}

/**
 * Message updated event - streaming text updates
 */
export interface MessageUpdatedEvent extends BaseSSEEvent {
  type: "message.updated"
  properties: {
    sessionID: string
    messageID: string
    info: MessageInfo
  }
}

/**
 * Message part updated event - individual part changes
 */
export interface MessagePartUpdatedEvent extends BaseSSEEvent {
  type: "message.part.updated"
  properties: {
    sessionID: string
    messageID: string
    partIndex: number
    part: Part
  }
}

/**
 * Tool execute event - tool started
 */
export interface ToolExecuteEvent extends BaseSSEEvent {
  type: "tool.execute"
  properties: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
  }
}

/**
 * Tool result event - tool completed
 */
export interface ToolResultEvent extends BaseSSEEvent {
  type: "tool.result"
  properties: {
    sessionID: string
    tool: string
    callID: string
    title?: string
    metadata?: Record<string, unknown>
  }
}

/**
 * File edited event
 */
export interface FileEditedEvent extends BaseSSEEvent {
  type: "file.edited"
  properties: {
    sessionID: string
    path: string
  }
}

/**
 * Permission object from OpenCode API
 */
export interface Permission {
  id: string
  type: string
  pattern?: string | string[]
  sessionID: string
  messageID: string
  callID?: string
  title: string
  metadata: Record<string, unknown>
  time: {
    created: number
  }
  [key: string]: unknown // Allow index signature for compatibility
}

/**
 * Permission updated event - permission request from OpenCode
 */
export interface PermissionUpdatedEvent {
  type: "permission.updated"
  properties: Permission
}

/**
 * Permission replied event - confirmation that permission was processed
 */
export interface PermissionRepliedEvent {
  type: "permission.replied"
  properties: {
    sessionID: string
    permissionID: string
    response: string
    [key: string]: unknown
  }
}

/**
 * Union of all SSE event types
 */
export type SSEEvent =
  | SessionIdleEvent
  | SessionUpdatedEvent
  | SessionErrorEvent
  | MessageUpdatedEvent
  | MessagePartUpdatedEvent
  | ToolExecuteEvent
  | ToolResultEvent
  | FileEditedEvent
  | PermissionUpdatedEvent
  | PermissionRepliedEvent
  | BaseSSEEvent // Fallback for unknown events

// =============================================================================
// Client Configuration
// =============================================================================

/**
 * Configuration for OpenCodeClient
 */
export interface OpenCodeClientConfig {
  /** Base URL of the OpenCode server (e.g., http://localhost:4100) */
  baseUrl: string
  
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number
  
  /** Retry configuration */
  retry?: {
    /** Maximum number of retries (default: 3) */
    maxRetries: number
    /** Base delay between retries in ms (default: 1000) */
    baseDelayMs: number
    /** Maximum delay between retries in ms (default: 10000) */
    maxDelayMs: number
  }
}

/**
 * Default client configuration
 */
export const DEFAULT_CLIENT_CONFIG: Required<OpenCodeClientConfig> = {
  baseUrl: "http://localhost:4096",
  timeoutMs: 30_000,
  retry: {
    maxRetries: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 10_000,
  },
}

// =============================================================================
// Stream Handler Types
// =============================================================================

/**
 * Token usage info
 */
export interface TokenUsage {
  input: number
  output: number
  reasoning?: number
  cache?: {
    read: number
    write: number
  }
}

/**
 * Streaming state for a session
 */
export interface StreamingState {
  sessionId: string
  messageId?: string
  
  /** Telegram message ID for progress updates */
  telegramMessageId?: number
  
  /** Current accumulated text */
  currentText: string
  
  /** Tools that have been invoked */
  toolsInvoked: Array<{
    name: string
    callId: string
    startedAt: Date
    completedAt?: Date
    title?: string
  }>
  
  /** When streaming started */
  startedAt: Date
  
  /** Last time we updated Telegram */
  lastTelegramUpdateAt?: Date
  
  /** Whether we're currently processing */
  isProcessing: boolean
  
  /** Error if any */
  error?: string
  
  /** Token usage from message.updated events */
  tokens?: TokenUsage
  
  /** Model info */
  model?: {
    providerID: string
    modelID: string
  }
  
  /** Flag to prevent duplicate message sends */
  pendingSend?: boolean
}

/**
 * Inline keyboard button for Telegram
 */
export interface InlineKeyboardButton {
  text: string
  callback_data: string
}

/**
 * Callback for sending Telegram messages
 */
export type TelegramSendCallback = (
  chatId: number,
  topicId: number,
  text: string,
  options?: {
    parseMode?: "HTML" | "Markdown" | "MarkdownV2"
    replyToMessageId?: number
    editMessageId?: number
    inlineKeyboard?: InlineKeyboardButton[][]
  }
) => Promise<{ messageId: number }>

/**
 * Callback for deleting Telegram messages
 */
export type TelegramDeleteCallback = (
  chatId: number,
  messageId: number
) => Promise<void>

/**
 * Configuration for StreamHandler
 */
export interface StreamHandlerConfig {
  /** Minimum interval between Telegram updates in ms (default: 500) */
  updateIntervalMs: number
  
  /** Maximum text length before truncating in progress messages */
  maxProgressTextLength: number
  
  /** Whether to show tool names in progress */
  showToolNames: boolean
  
  /** Whether to delete progress message on completion */
  deleteProgressOnComplete: boolean
}

/**
 * Default stream handler configuration
 * Note: updateIntervalMs defaults to 2000ms to stay within Telegram rate limits
 * Telegram rate limits edits more aggressively than new messages
 */
export const DEFAULT_STREAM_HANDLER_CONFIG: StreamHandlerConfig = {
  updateIntervalMs: 2000,
  maxProgressTextLength: 200,
  showToolNames: true,
  deleteProgressOnComplete: true,
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * OpenCode client error
 */
export class OpenCodeClientError extends Error {
  constructor(
    message: string,
    public readonly code: OpenCodeErrorCode,
    public readonly statusCode?: number,
    public readonly cause?: Error
  ) {
    super(message)
    this.name = "OpenCodeClientError"
  }
}

export type OpenCodeErrorCode =
  | "CONNECTION_FAILED"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "SERVER_ERROR"
  | "INVALID_RESPONSE"
  | "SSE_ERROR"
  | "ABORTED"
