/**
 * OpenCode Client Module
 * 
 * Public API for interacting with OpenCode instances.
 * Provides REST client, SSE handling, and stream-to-Telegram bridging.
 */

// Types
export type {
  // REST API types
  HealthResponse,
  Session,
  Message,
  MessageInfo,
  Part,
  TextPart,
  ToolInvocationPart,
  ToolResultPart,
  FilePart,
  ReasoningPart,
  MessagesResponse,
  SendMessageRequest,
  CreateSessionRequest,
  
  // SSE types
  SSEEvent,
  SessionIdleEvent,
  SessionUpdatedEvent,
  SessionErrorEvent,
  MessageUpdatedEvent,
  MessagePartUpdatedEvent,
  ToolExecuteEvent,
  ToolResultEvent,
  FileEditedEvent,
  PermissionUpdatedEvent,
  PermissionRepliedEvent,
  Permission,
  
  // Configuration types
  OpenCodeClientConfig,
  StreamHandlerConfig,
  StreamingState,
  
  // Callback types
  TelegramSendCallback,
  TelegramDeleteCallback,
  InlineKeyboardButton,
} from "./types"

export {
  DEFAULT_CLIENT_CONFIG,
  DEFAULT_STREAM_HANDLER_CONFIG,
  OpenCodeClientError,
} from "./types"

// Client
export { OpenCodeClient, createClient } from "./client"

// Stream Handler
export { StreamHandler, createStreamHandler } from "./stream-handler"
export type { PendingPermission } from "./stream-handler"

// Markdown utilities
export { 
  markdownToTelegramHtml, 
  truncateForTelegram, 
  containsMarkdown 
} from "./telegram-markdown"

// Discovery
export {
  discoverInstances,
  discoverSessions,
  isSessionAlive,
  isPortAlive,
  findSession,
} from "./discovery"

export type {
  DiscoveredInstance,
  DiscoveredSession,
} from "./discovery"
