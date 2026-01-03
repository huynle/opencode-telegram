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
} from "./types"
import { DEFAULT_STREAM_HANDLER_CONFIG } from "./types"

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
  registerSession(sessionId: string, chatId: number, topicId: number): void {
    this.sessionToTelegram.set(sessionId, { chatId, topicId })
  }

  /**
   * Unregister a session
   */
  unregisterSession(sessionId: string): void {
    this.sessionToTelegram.delete(sessionId)
    this.states.delete(sessionId)
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
    const props = event.properties as {
      sessionID: string
      messageID: string
      partIndex: number
      part: Part
    }

    let state = this.states.get(sessionId)
    if (!state) {
      state = this.createState(sessionId)
      this.states.set(sessionId, state)
    }

    state.messageId = props.messageID
    state.isProcessing = true

    // Handle text parts
    if (props.part.type === "text") {
      const textPart = props.part as TextPart
      state.currentText = textPart.text
    }

    // Handle tool invocation parts
    if (props.part.type === "tool-invocation") {
      const toolPart = props.part as ToolInvocationPart
      const { toolInvocation } = toolPart

      if (toolInvocation.state === "call") {
        // Tool is being called
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
        // Tool completed
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
      try {
        if (state.telegramMessageId) {
          // Edit the progress message to show final response
          await this.sendCallback(
            destination.chatId,
            destination.topicId,
            state.currentText,
            { 
              parseMode: "Markdown",
              editMessageId: state.telegramMessageId,
            }
          )
        } else {
          // No progress message, send new one
          await this.sendCallback(
            destination.chatId,
            destination.topicId,
            state.currentText,
            { parseMode: "Markdown" }
          )
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        
        // Ignore "message is not modified" - content is already correct
        if (errorMsg.includes('message is not modified')) {
          // Already showing the right content, nothing to do
        } else if (state.telegramMessageId) {
          // Edit failed for other reason, send as new message
          console.log(`[StreamHandler] Final edit failed, sending new message`)
          try {
            await this.sendCallback(
              destination.chatId,
              destination.topicId,
              state.currentText,
              { parseMode: "Markdown" }
            )
          } catch {
            // Give up
          }
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
    
    if (now - lastUpdate >= this.config.updateIntervalMs) {
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
    const progressText = this.formatProgressMessage(state)
    
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
      
      // If edit fails for other reasons (message deleted, too old, etc.), try sending new message
      if (state.telegramMessageId) {
        console.log(`[StreamHandler] Edit failed (${errorMsg.slice(0, 50)}...), sending new message`)
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
      }
    }
  }

  /**
   * Format a progress message for Telegram
   */
  private formatProgressMessage(state: StreamingState): string {
    const parts: string[] = []

    // Current tool status
    const runningTools = state.toolsInvoked.filter((t) => !t.completedAt)
    const completedTools = state.toolsInvoked.filter((t) => t.completedAt)

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
