/**
 * Stream Handler
 * 
 * Bridges OpenCode SSE events to Telegram progress messages.
 * Handles throttling, formatting, and state management for streaming responses.
 */

import type {
  SSEEvent,
  StreamingState,
  StreamHandlerConfig,
  TelegramSendCallback,
  TelegramDeleteCallback,
  Part,
  TextPart,
  ToolInvocationPart,
  Permission,
  InlineKeyboardButton,
} from "./types"
import { DEFAULT_STREAM_HANDLER_CONFIG } from "./types"
import { markdownToTelegramHtml, truncateForTelegram } from "./telegram-markdown"

/**
 * Pending permission request info
 */
export interface PendingPermission {
  permission: Permission
  telegramMessageId?: number
  chatId: number
  topicId: number
}

/**
 * Manages streaming state and Telegram updates for OpenCode sessions
 */
export class StreamHandler {
  private readonly config: StreamHandlerConfig
  private readonly states: Map<string, StreamingState> = new Map()
  private readonly sendCallback: TelegramSendCallback
  private readonly deleteCallback?: TelegramDeleteCallback

  /** Mapping from sessionId to Telegram chat/topic info */
  private readonly sessionToTelegram: Map<string, { chatId: number; topicId: number }> = new Map()

  /** Mapping from sessionId to streaming enabled state */
  private readonly sessionStreamingEnabled: Map<string, boolean> = new Map()

  /** Pending permission requests - keyed by permissionId */
  private readonly pendingPermissions: Map<string, PendingPermission> = new Map()

  constructor(
    sendCallback: TelegramSendCallback,
    deleteCallback?: TelegramDeleteCallback,
    config?: Partial<StreamHandlerConfig>
  ) {
    this.sendCallback = sendCallback
    this.deleteCallback = deleteCallback
    this.config = { ...DEFAULT_STREAM_HANDLER_CONFIG, ...config }
  }

  // ===========================================================================
  // Session Registration
  // ===========================================================================

  /**
   * Register a session with its Telegram destination
   */
  registerSession(sessionId: string, chatId: number, topicId: number, streamingEnabled = false): void {
    this.sessionToTelegram.set(sessionId, { chatId, topicId })
    this.sessionStreamingEnabled.set(sessionId, streamingEnabled)
  }

  /**
   * Unregister a session
   */
  unregisterSession(sessionId: string): void {
    this.sessionToTelegram.delete(sessionId)
    this.sessionStreamingEnabled.delete(sessionId)
    this.states.delete(sessionId)
  }

  /**
   * Update streaming preference for a session
   */
  setStreamingEnabled(sessionId: string, enabled: boolean): void {
    this.sessionStreamingEnabled.set(sessionId, enabled)
  }

  /**
   * Check if streaming is enabled for a session
   */
  isStreamingEnabled(sessionId: string): boolean {
    return this.sessionStreamingEnabled.get(sessionId) ?? false
  }

  /**
   * Get Telegram destination for a session
   */
  getTelegramDestination(sessionId: string): { chatId: number; topicId: number } | undefined {
    return this.sessionToTelegram.get(sessionId)
  }

  // ===========================================================================
  // Event Handling
  // ===========================================================================

  /**
   * Handle an SSE event from OpenCode
   */
  async handleEvent(event: SSEEvent): Promise<void> {
    // Extract sessionID from various possible locations in the event
    const props = event.properties as Record<string, any>
    const sessionId = 
      props.sessionID ||                    // session.idle, session.status, session.diff
      props.info?.sessionID ||              // message.updated
      props.part?.sessionID ||              // message.part.updated
      (event.type === 'session.updated' ? props.info?.id : null) ||  // session.updated has id not sessionID
      null
    
    if (!sessionId) {
      // Only log for events that should have sessionID (skip heartbeat, server.connected)
      if (!['server.heartbeat', 'server.connected'].includes(event.type)) {
        console.log(`[StreamHandler] Event ${event.type} has no sessionID`)
      }
      return
    }

    const destination = this.sessionToTelegram.get(sessionId)
    if (!destination) {
      console.log(`[StreamHandler] Session ${sessionId} not registered, registered sessions:`, Array.from(this.sessionToTelegram.keys()))
      return // Session not registered with us
    }

    switch (event.type) {
      case "message.part.updated":
        await this.handlePartUpdated(sessionId, event, destination)
        break

      case "tool.execute":
        await this.handleToolExecute(sessionId, event, destination)
        break

      case "tool.result":
        await this.handleToolResult(sessionId, event, destination)
        break

      case "session.idle":
        await this.handleSessionIdle(sessionId, destination)
        break

      case "session.error":
        await this.handleSessionError(sessionId, event, destination)
        break

      case "session.updated":
        await this.handleSessionUpdated(sessionId, event, destination)
        break

      case "permission.updated":
        await this.handlePermissionUpdated(event, destination)
        break

      case "permission.replied":
        await this.handlePermissionReplied(event)
        break
    }
  }

  /**
   * Handle message part updates (streaming text)
   */
  private async handlePartUpdated(
    sessionId: string,
    event: SSEEvent,
    destination: { chatId: number; topicId: number }
  ): Promise<void> {
    const props = event.properties as Record<string, any>
    const part = props.part as Record<string, any>

    let state = this.states.get(sessionId)
    if (!state) {
      state = this.createState(sessionId)
      this.states.set(sessionId, state)
    }

    state.messageId = part.messageID || props.messageID
    state.isProcessing = true

    // Handle text parts (type: "text")
    if (part.type === "text" && part.text) {
      state.currentText = part.text
    }

    // Handle tool parts (type: "tool") - OpenCode uses "tool" not "tool-invocation"
    if (part.type === "tool" && part.callID && part.tool) {
      const existingTool = state.toolsInvoked.find(t => t.callId === part.callID)
      if (!existingTool) {
        state.toolsInvoked.push({
          name: part.tool,
          callId: part.callID,
          startedAt: new Date(),
        })
      }
      // Check if tool has result (state field or result field)
      if (part.state === "result" || part.result !== undefined) {
        const tool = state.toolsInvoked.find(t => t.callId === part.callID)
        if (tool && !tool.completedAt) {
          tool.completedAt = new Date()
        }
      }
    }

    // Handle step-finish (marks end of a tool execution step)
    if (part.type === "step-finish") {
      // Mark all running tools as completed
      for (const tool of state.toolsInvoked) {
        if (!tool.completedAt) {
          tool.completedAt = new Date()
        }
      }
    }

    // Handle legacy tool-invocation format (in case it's still used)
    if (part.type === "tool-invocation" && part.toolInvocation) {
      const { toolInvocation } = part
      if (toolInvocation.state === "call") {
        const existingTool = state.toolsInvoked.find(
          (t) => t.callId === toolInvocation.toolCallId
        )
        if (!existingTool) {
          state.toolsInvoked.push({
            name: toolInvocation.toolName,
            callId: toolInvocation.toolCallId,
            startedAt: new Date(),
          })
        }
      } else if (toolInvocation.state === "result") {
        const tool = state.toolsInvoked.find(
          (t) => t.callId === toolInvocation.toolCallId
        )
        if (tool) {
          tool.completedAt = new Date()
        }
      }
    }

    // Throttled update to Telegram
    await this.maybeUpdateTelegram(sessionId, state, destination)
  }

  /**
   * Handle tool execution start
   */
  private async handleToolExecute(
    sessionId: string,
    event: SSEEvent,
    destination: { chatId: number; topicId: number }
  ): Promise<void> {
    const props = event.properties as {
      sessionID: string
      tool: string
      callID: string
      args: Record<string, unknown>
    }

    let state = this.states.get(sessionId)
    if (!state) {
      state = this.createState(sessionId)
      this.states.set(sessionId, state)
    }

    state.isProcessing = true

    // Add tool to list if not already there
    const existingTool = state.toolsInvoked.find((t) => t.callId === props.callID)
    if (!existingTool) {
      state.toolsInvoked.push({
        name: props.tool,
        callId: props.callID,
        startedAt: new Date(),
      })
    }

    // Force update to show tool is running
    await this.updateTelegram(sessionId, state, destination, true)
  }

  /**
   * Handle tool result
   */
  private async handleToolResult(
    sessionId: string,
    event: SSEEvent,
    destination: { chatId: number; topicId: number }
  ): Promise<void> {
    const props = event.properties as {
      sessionID: string
      tool: string
      callID: string
      title?: string
      metadata?: Record<string, unknown>
    }

    const state = this.states.get(sessionId)
    if (!state) return

    // Mark tool as completed
    const tool = state.toolsInvoked.find((t) => t.callId === props.callID)
    if (tool) {
      tool.completedAt = new Date()
      tool.title = props.title
    }

    // Update Telegram to show tool completed
    await this.maybeUpdateTelegram(sessionId, state, destination)
  }

  /**
   * Handle session becoming idle (response complete)
   */
  private async handleSessionIdle(
    sessionId: string,
    destination: { chatId: number; topicId: number }
  ): Promise<void> {
    const state = this.states.get(sessionId)
    if (!state) return

    state.isProcessing = false

    // Send final response - edit the progress message if we have one
    if (state.currentText.trim()) {
      // Convert Markdown to Telegram HTML for proper rendering
      const htmlContent = markdownToTelegramHtml(state.currentText.trim())
      const finalContent = truncateForTelegram(htmlContent)
      
      try {
        if (state.telegramMessageId) {
          // Edit the progress message to show final response
          await this.sendCallback(
            destination.chatId,
            destination.topicId,
            finalContent,
            { 
              parseMode: "HTML",
              editMessageId: state.telegramMessageId,
            }
          )
        } else {
          // No progress message, send new one
          await this.sendCallback(
            destination.chatId,
            destination.topicId,
            finalContent,
            { parseMode: "HTML" }
          )
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        
        // Ignore "message is not modified" - content is already correct
        if (errorMsg.includes('message is not modified')) {
          // Already showing the right content, nothing to do
        } else if (state.telegramMessageId && errorMsg.includes('message to edit not found')) {
          // Original message was deleted, send as new message
          console.log(`[StreamHandler] Original message deleted, sending final as new message`)
          try {
            await this.sendCallback(
              destination.chatId,
              destination.topicId,
              finalContent,
              { parseMode: "HTML" }
            )
          } catch {
            // Give up
          }
        } else if (errorMsg.includes("can't parse entities")) {
          // HTML parsing failed, try sending as plain text
          console.log(`[StreamHandler] HTML parsing failed, falling back to plain text`)
          try {
            await this.sendCallback(
              destination.chatId,
              destination.topicId,
              state.currentText.trim(),
              { editMessageId: state.telegramMessageId }
            )
          } catch {
            // Give up
          }
        } else {
          // For other errors (rate limit, etc.), just log - the progress message already has content
          console.log(`[StreamHandler] Final edit failed (${errorMsg.slice(0, 80)}), keeping progress message`)
        }
      }
    } else if (this.config.deleteProgressOnComplete && state.telegramMessageId && this.deleteCallback) {
      // No text but we have a progress message - delete it
      try {
        await this.deleteCallback(destination.chatId, state.telegramMessageId)
      } catch {
        // Ignore delete errors
      }
    }

    // Clean up state
    this.states.delete(sessionId)
  }

  /**
   * Handle session error
   */
  private async handleSessionError(
    sessionId: string,
    event: SSEEvent,
    destination: { chatId: number; topicId: number }
  ): Promise<void> {
    const props = event.properties as {
      sessionID: string
      error: string
    }

    const state = this.states.get(sessionId)
    if (state) {
      state.isProcessing = false
      state.error = props.error
    }

    // Delete progress message
    if (
      state?.telegramMessageId &&
      this.deleteCallback
    ) {
      try {
        await this.deleteCallback(destination.chatId, state.telegramMessageId)
      } catch {
        // Ignore delete errors
      }
    }

    // Send error message
    await this.sendCallback(
      destination.chatId,
      destination.topicId,
      `Error: ${props.error}`,
      { parseMode: "HTML" }
    )

    // Clean up state
    this.states.delete(sessionId)
  }

  /**
   * Handle session status update
   */
  private async handleSessionUpdated(
    sessionId: string,
    event: SSEEvent,
    destination: { chatId: number; topicId: number }
  ): Promise<void> {
    const props = event.properties as {
      sessionID: string
      status: "idle" | "running" | "error"
    }

    if (props.status === "running") {
      // Session started processing
      let state = this.states.get(sessionId)
      if (!state) {
        state = this.createState(sessionId)
        this.states.set(sessionId, state)
      }
      state.isProcessing = true
    }
  }

  /**
   * Handle permission request from OpenCode
   */
  private async handlePermissionUpdated(
    event: SSEEvent,
    destination: { chatId: number; topicId: number }
  ): Promise<void> {
    const permission = event.properties as Permission

    console.log(`[StreamHandler] Permission request: ${permission.type} - ${permission.title}`)

    // Format permission message
    const messageText = this.formatPermissionMessage(permission)

    // Create inline keyboard with approve/deny buttons
    const keyboard: InlineKeyboardButton[][] = [
      [
        { text: "✅ Allow Once", callback_data: `perm:once:${permission.id}` },
        { text: "✅ Always Allow", callback_data: `perm:always:${permission.id}` },
      ],
      [
        { text: "❌ Deny", callback_data: `perm:reject:${permission.id}` },
      ],
    ]

    try {
      const result = await this.sendCallback(
        destination.chatId,
        destination.topicId,
        messageText,
        {
          parseMode: "HTML",
          inlineKeyboard: keyboard,
        }
      )

      // Store pending permission for later resolution
      this.pendingPermissions.set(permission.id, {
        permission,
        telegramMessageId: result.messageId,
        chatId: destination.chatId,
        topicId: destination.topicId,
      })
    } catch (error) {
      console.error(`[StreamHandler] Failed to send permission prompt:`, error)
    }
  }

  /**
   * Handle permission reply confirmation
   */
  private async handlePermissionReplied(event: SSEEvent): Promise<void> {
    const props = event.properties as {
      sessionID: string
      permissionID: string
      response: string
    }

    console.log(`[StreamHandler] Permission ${props.permissionID} replied: ${props.response}`)

    // Clean up pending permission
    const pending = this.pendingPermissions.get(props.permissionID)
    if (pending) {
      // Optionally update or delete the permission message
      if (pending.telegramMessageId && this.deleteCallback) {
        try {
          // Edit the message to show it was handled
          const responseText = props.response === "reject" ? "Denied" : "Approved"
          await this.sendCallback(
            pending.chatId,
            pending.topicId,
            `<i>Permission ${responseText}</i>`,
            {
              parseMode: "HTML",
              editMessageId: pending.telegramMessageId,
            }
          )
        } catch {
          // Ignore edit errors
        }
      }
      this.pendingPermissions.delete(props.permissionID)
    }
  }

  /**
   * Format a permission request message for Telegram
   */
  private formatPermissionMessage(permission: Permission): string {
    const parts: string[] = []

    parts.push(`<b>🔐 Permission Required</b>`)
    parts.push("")
    parts.push(`<b>Type:</b> <code>${this.escapeHtml(permission.type)}</code>`)
    parts.push(`<b>Action:</b> ${this.escapeHtml(permission.title)}`)

    // Show pattern if available (e.g., for bash commands)
    if (permission.pattern) {
      const pattern = Array.isArray(permission.pattern) 
        ? permission.pattern.join(", ") 
        : permission.pattern
      parts.push(`<b>Pattern:</b> <code>${this.escapeHtml(pattern)}</code>`)
    }

    // Show relevant metadata
    if (permission.metadata) {
      const { command, args, path } = permission.metadata as {
        command?: string
        args?: Record<string, unknown>
        path?: string
      }

      if (command) {
        parts.push("")
        parts.push(`<pre>${this.escapeHtml(String(command))}</pre>`)
      }

      if (path) {
        parts.push(`<b>Path:</b> <code>${this.escapeHtml(String(path))}</code>`)
      }
    }

    return parts.join("\n")
  }

  /**
   * Get a pending permission by ID
   */
  getPendingPermission(permissionId: string): PendingPermission | undefined {
    return this.pendingPermissions.get(permissionId)
  }

  /**
   * Remove a pending permission (after it's been handled)
   */
  removePendingPermission(permissionId: string): void {
    this.pendingPermissions.delete(permissionId)
  }

  /**
   * Get all pending permissions
   */
  getAllPendingPermissions(): Map<string, PendingPermission> {
    return this.pendingPermissions
  }

  // ===========================================================================
  // Telegram Updates
  // ===========================================================================

  /**
   * Update Telegram if enough time has passed since last update
   */
  private async maybeUpdateTelegram(
    sessionId: string,
    state: StreamingState,
    destination: { chatId: number; topicId: number }
  ): Promise<void> {
    const now = Date.now()
    const lastUpdate = state.lastTelegramUpdateAt?.getTime() ?? 0
    
    // Use longer interval for streaming mode to avoid rate limits
    // Telegram is strict about message edits - max ~20/minute
    const streamingEnabled = this.isStreamingEnabled(sessionId)
    const updateInterval = streamingEnabled ? 3000 : this.config.updateIntervalMs  // 3s for streaming
    
    if (now - lastUpdate >= updateInterval) {
      await this.updateTelegram(sessionId, state, destination, false)
    }
  }

  /**
   * Send/update progress message in Telegram
   */
  private async updateTelegram(
    sessionId: string,
    state: StreamingState,
    destination: { chatId: number; topicId: number },
    force: boolean
  ): Promise<void> {
    const progressText = this.formatProgressMessage(state, sessionId)
    
    try {
      if (state.telegramMessageId) {
        // Edit existing message
        await this.sendCallback(
          destination.chatId,
          destination.topicId,
          progressText,
          {
            parseMode: "HTML",
            editMessageId: state.telegramMessageId,
          }
        )
      } else {
        // Send new message
        const result = await this.sendCallback(
          destination.chatId,
          destination.topicId,
          progressText,
          { parseMode: "HTML" }
        )
        state.telegramMessageId = result.messageId
      }
      
      state.lastTelegramUpdateAt = new Date()
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      
      // Ignore "message is not modified" errors - this just means content is the same
      if (errorMsg.includes('message is not modified')) {
        state.lastTelegramUpdateAt = new Date()
        return
      }
      
      // For rate limit errors, just skip this update - don't send new message
      if (errorMsg.includes('429') || errorMsg.includes('Too Many Requests')) {
        console.log(`[StreamHandler] Rate limited, skipping update`)
        return
      }
      
      // Only send new message if the original was deleted (not for other errors)
      // Check for "message to edit not found" or similar
      if (state.telegramMessageId && errorMsg.includes('message to edit not found')) {
        console.log(`[StreamHandler] Original message deleted, sending new one`)
        try {
          const result = await this.sendCallback(
            destination.chatId,
            destination.topicId,
            progressText,
            { parseMode: "HTML" }
          )
          state.telegramMessageId = result.messageId
          state.lastTelegramUpdateAt = new Date()
        } catch {
          // Give up on this update
        }
      } else {
        // For other errors, just log and skip
        console.log(`[StreamHandler] Edit failed (${errorMsg.slice(0, 80)}), skipping`)
      }
    }
  }

  /**
   * Format a progress message for Telegram
   */
  private formatProgressMessage(state: StreamingState, sessionId: string): string {
    const streamingEnabled = this.isStreamingEnabled(sessionId)
    const parts: string[] = []

    // Current tool status
    const runningTools = state.toolsInvoked.filter((t) => !t.completedAt)
    const completedTools = state.toolsInvoked.filter((t) => t.completedAt)

    // In streaming mode, show status on one line at top
    if (streamingEnabled) {
      const statusParts: string[] = []
      if (runningTools.length > 0 && this.config.showToolNames) {
        const toolName = runningTools[runningTools.length - 1].name
        statusParts.push(`🔧 ${toolName}`)
      } else if (state.isProcessing && !state.currentText.trim()) {
        statusParts.push("💭 Thinking...")
      }
      
      const elapsed = Math.round((Date.now() - state.startedAt.getTime()) / 1000)
      if (elapsed > 0) {
        statusParts.push(`${elapsed}s`)
      }
      
      if (statusParts.length > 0) {
        parts.push(`<i>${statusParts.join(" | ")}</i>`)
        parts.push("")
      }

      // In streaming mode, show full text converted to HTML (truncated to Telegram limit)
      if (state.currentText.trim()) {
        let text = state.currentText.trim()
        // Telegram message limit is ~4096 chars, leave room for status
        const maxLength = 3600
        if (text.length > maxLength) {
          text = text.slice(-maxLength) // Show the END (most recent) text
          text = "..." + text
        }
        // Convert markdown to HTML for proper rendering during streaming
        const htmlText = markdownToTelegramHtml(text)
        parts.push(truncateForTelegram(htmlText, 3800))
      }
    } else {
      // Non-streaming mode: show status and preview
      if (runningTools.length > 0 && this.config.showToolNames) {
        const toolName = runningTools[runningTools.length - 1].name
        parts.push(`<b>Running:</b> <code>${this.escapeHtml(toolName)}</code>`)
      } else if (state.isProcessing) {
        parts.push("<b>Thinking...</b>")
      }

      // Tool count and elapsed time
      const elapsed = Math.round((Date.now() - state.startedAt.getTime()) / 1000)
      const toolCount = state.toolsInvoked.length
      
      if (toolCount > 0 || elapsed > 0) {
        const stats: string[] = []
        if (toolCount > 0) {
          stats.push(`${completedTools.length}/${toolCount} tools`)
        }
        if (elapsed > 0) {
          stats.push(`${elapsed}s`)
        }
        parts.push(`<i>${stats.join(" | ")}</i>`)
      }

      // Preview of current text (truncated)
      if (state.currentText.trim()) {
        let preview = state.currentText.trim()
        if (preview.length > this.config.maxProgressTextLength) {
          preview = preview.slice(0, this.config.maxProgressTextLength) + "..."
        }
        // Only show preview if we have substantial content
        if (preview.length > 20) {
          parts.push("")
          parts.push(`<blockquote>${this.escapeHtml(preview)}</blockquote>`)
        }
      }
    }

    return parts.join("\n") || "<i>Processing...</i>"
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  }

  // ===========================================================================
  // State Management
  // ===========================================================================

  /**
   * Create initial streaming state for a session
   */
  private createState(sessionId: string): StreamingState {
    return {
      sessionId,
      currentText: "",
      toolsInvoked: [],
      startedAt: new Date(),
      isProcessing: false,
    }
  }

  /**
   * Get current state for a session
   */
  getState(sessionId: string): StreamingState | undefined {
    return this.states.get(sessionId)
  }

  /**
   * Check if a session is currently processing
   */
  isProcessing(sessionId: string): boolean {
    return this.states.get(sessionId)?.isProcessing ?? false
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): string[] {
    return Array.from(this.states.keys())
  }

  /**
   * Clear all state (for shutdown)
   */
  clear(): void {
    this.states.clear()
    this.sessionToTelegram.clear()
    this.sessionStreamingEnabled.clear()
    this.pendingPermissions.clear()
  }
}

/**
 * Create a stream handler with the given callbacks
 */
export function createStreamHandler(
  sendCallback: TelegramSendCallback,
  deleteCallback?: TelegramDeleteCallback,
  config?: Partial<StreamHandlerConfig>
): StreamHandler {
  return new StreamHandler(sendCallback, deleteCallback, config)
}
