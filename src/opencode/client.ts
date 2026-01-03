/**
 * OpenCode REST API Client
 * 
 * Client for interacting with OpenCode instances via their REST API.
 * Handles health checks, session management, message sending, and SSE subscriptions.
 */

import {
  type OpenCodeClientConfig,
  type HealthResponse,
  type Session,
  type Message,
  type MessagesResponse,
  type SendMessageRequest,
  type CreateSessionRequest,
  type SSEEvent,
  DEFAULT_CLIENT_CONFIG,
  OpenCodeClientError,
} from "./types"

/**
 * OpenCode REST API client
 */
export class OpenCodeClient {
  private readonly config: Required<OpenCodeClientConfig>
  private sseAbortController?: AbortController

  constructor(config: OpenCodeClientConfig) {
    this.config = {
      ...DEFAULT_CLIENT_CONFIG,
      ...config,
      retry: {
        ...DEFAULT_CLIENT_CONFIG.retry,
        ...config.retry,
      },
    }
  }

  // ===========================================================================
  // Health & Status
  // ===========================================================================

  /**
   * Check if the OpenCode instance is healthy
   */
  async health(): Promise<HealthResponse> {
    const response = await this.fetch("/global/health")
    return response.json()
  }

  /**
   * Check if the instance is reachable and healthy
   * Returns true/false instead of throwing
   */
  async isHealthy(): Promise<boolean> {
    try {
      const health = await this.health()
      return health.healthy === true
    } catch {
      return false
    }
  }

  // ===========================================================================
  // Session Management
  // ===========================================================================

  /**
   * List all sessions
   */
  async listSessions(): Promise<Session[]> {
    const response = await this.fetch("/session")
    const data = await response.json()
    return data as Session[]
  }

  /**
   * Get a specific session by ID
   */
  async getSession(sessionId: string): Promise<Session | null> {
    try {
      const response = await this.fetch(`/session/${sessionId}`)
      return response.json()
    } catch (error) {
      if (error instanceof OpenCodeClientError && error.code === "NOT_FOUND") {
        return null
      }
      throw error
    }
  }

  /**
   * Create a new session
   */
  async createSession(options?: CreateSessionRequest): Promise<Session> {
    const response = await this.fetch("/session", {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    })
    return response.json()
  }

  /**
   * Abort a running session
   */
  async abortSession(sessionId: string): Promise<void> {
    await this.fetch(`/session/${sessionId}/abort`, {
      method: "POST",
    })
  }

  // ===========================================================================
  // Messages
  // ===========================================================================

  /**
   * Get all messages in a session
   */
  async getMessages(sessionId: string): Promise<Message[]> {
    const response = await this.fetch(`/session/${sessionId}/message`)
    const data: MessagesResponse = await response.json()
    return data.data
  }

  /**
   * Send a message to a session (synchronous - waits for response)
   */
  async sendMessage(
    sessionId: string,
    text: string,
    options?: {
      model?: { providerID: string; modelID: string }
      agent?: string
    }
  ): Promise<Message[]> {
    const body: SendMessageRequest = {
      parts: [{ type: "text", text }],
      ...options,
    }

    const response = await this.fetch(`/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify(body),
    })

    return response.json()
  }

  /**
   * Send a message asynchronously (returns immediately, use SSE for updates)
   */
  async sendMessageAsync(
    sessionId: string,
    text: string,
    options?: {
      model?: { providerID: string; modelID: string }
      agent?: string
    }
  ): Promise<void> {
    const body: SendMessageRequest = {
      parts: [{ type: "text", text }],
      ...options,
    }

    await this.fetch(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  /**
   * Execute a slash command in a session
   */
  async executeCommand(sessionId: string, command: string): Promise<void> {
    await this.fetch(`/session/${sessionId}/command`, {
      method: "POST",
      body: JSON.stringify({ command }),
    })
  }

  // ===========================================================================
  // Permissions
  // ===========================================================================

  /**
   * Respond to a permission request
   * 
   * @param sessionId The session ID
   * @param permissionId The permission request ID
   * @param response The response: "once" (accept this time), "always" (accept and remember), or "reject" (deny)
   */
  async respondToPermission(
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject"
  ): Promise<boolean> {
    const res = await this.fetch(`/session/${sessionId}/permissions/${permissionId}`, {
      method: "POST",
      body: JSON.stringify({ response }),
    })
    return res.json()
  }

  // ===========================================================================
  // TUI Control (for instances running with TUI)
  // ===========================================================================

  /**
   * Append text to the TUI prompt
   */
  async appendPrompt(text: string): Promise<void> {
    await this.fetch("/tui/append-prompt", {
      method: "POST",
      body: JSON.stringify({ text }),
    })
  }

  /**
   * Submit the current TUI prompt
   */
  async submitPrompt(): Promise<void> {
    await this.fetch("/tui/submit-prompt", {
      method: "POST",
    })
  }

  /**
   * Clear the TUI prompt
   */
  async clearPrompt(): Promise<void> {
    await this.fetch("/tui/clear-prompt", {
      method: "POST",
    })
  }

  /**
   * Execute a command via TUI
   */
  async tuiExecuteCommand(command: string): Promise<void> {
    await this.fetch("/tui/execute-command", {
      method: "POST",
      body: JSON.stringify({ command }),
    })
  }

  /**
   * Show a toast notification in the TUI
   */
  async showToast(
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info"
  ): Promise<void> {
    await this.fetch("/tui/show-toast", {
      method: "POST",
      body: JSON.stringify({ message, variant }),
    })
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Search file contents using regex
   */
  async findInFiles(pattern: string): Promise<Array<{ path: string; line: number; match: string }>> {
    const response = await this.fetch(`/find?pattern=${encodeURIComponent(pattern)}`)
    return response.json()
  }

  /**
   * Find files by name pattern
   */
  async findFiles(query: string): Promise<string[]> {
    const response = await this.fetch(`/find/file?query=${encodeURIComponent(query)}`)
    return response.json()
  }

  /**
   * Read file content
   */
  async readFile(path: string): Promise<string> {
    const response = await this.fetch(`/file/content?path=${encodeURIComponent(path)}`)
    return response.text()
  }

  // ===========================================================================
  // SSE Subscription
  // ===========================================================================

  /**
   * Subscribe to SSE events from the OpenCode instance
   * 
   * @param onEvent Callback for each event
   * @param onError Callback for errors
   * @returns Abort function to stop the subscription
   */
  subscribe(
    onEvent: (event: SSEEvent) => void,
    onError?: (error: Error) => void
  ): () => void {
    // Abort any existing subscription
    this.sseAbortController?.abort()
    this.sseAbortController = new AbortController()

    const url = `${this.config.baseUrl}/event`
    
    // Start the SSE connection
    this.startSSE(url, onEvent, onError, this.sseAbortController.signal)

    // Return abort function
    return () => {
      this.sseAbortController?.abort()
      this.sseAbortController = undefined
    }
  }

  /**
   * Internal SSE connection handler
   */
  private async startSSE(
    url: string,
    onEvent: (event: SSEEvent) => void,
    onError?: (error: Error) => void,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
        signal,
      })

      if (!response.ok) {
        throw new OpenCodeClientError(
          `SSE connection failed: ${response.status}`,
          "SSE_ERROR",
          response.status
        )
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new OpenCodeClientError("No response body", "SSE_ERROR")
      }

      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })
        
        // Process complete events (separated by double newlines)
        const events = buffer.split("\n\n")
        buffer = events.pop() ?? "" // Keep incomplete event in buffer

        for (const eventStr of events) {
          if (!eventStr.trim()) continue
          
          const event = this.parseSSEEvent(eventStr)
          if (event) {
            onEvent(event)
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        // Normal abort, don't report as error
        return
      }
      
      const clientError = error instanceof OpenCodeClientError
        ? error
        : new OpenCodeClientError(
            `SSE error: ${error instanceof Error ? error.message : String(error)}`,
            "SSE_ERROR",
            undefined,
            error instanceof Error ? error : undefined
          )
      
      onError?.(clientError)
    }
  }

  /**
   * Parse an SSE event string into an event object
   */
  private parseSSEEvent(eventStr: string): SSEEvent | null {
    const lines = eventStr.split("\n")
    let eventType = ""
    let data = ""

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        data = line.slice(5).trim()
      }
    }

    if (!data) {
      return null
    }

    try {
      const parsed = JSON.parse(data)
      return {
        type: eventType || parsed.type || "unknown",
        properties: parsed.properties ?? parsed,
      } as SSEEvent
    } catch {
      // If JSON parsing fails, return raw data
      return {
        type: eventType || "unknown",
        properties: { raw: data },
      }
    }
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  /**
   * Make a fetch request with retry logic
   */
  private async fetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`
    const { maxRetries, baseDelayMs, maxDelayMs } = this.config.retry

    let lastError: Error | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.config.timeoutMs
        )

        const response = await fetch(url, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            ...options?.headers,
          },
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (response.ok) {
          return response
        }

        // Handle specific error codes
        if (response.status === 404) {
          throw new OpenCodeClientError(
            `Not found: ${path}`,
            "NOT_FOUND",
            404
          )
        }

        if (response.status >= 500) {
          throw new OpenCodeClientError(
            `Server error: ${response.status}`,
            "SERVER_ERROR",
            response.status
          )
        }

        // For other errors, don't retry
        throw new OpenCodeClientError(
          `Request failed: ${response.status}`,
          "INVALID_RESPONSE",
          response.status
        )
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        // Don't retry on abort or non-retryable errors
        if (
          error instanceof OpenCodeClientError &&
          (error.code === "NOT_FOUND" || error.code === "INVALID_RESPONSE")
        ) {
          throw error
        }

        if (lastError.name === "AbortError") {
          throw new OpenCodeClientError(
            `Request timeout after ${this.config.timeoutMs}ms`,
            "TIMEOUT"
          )
        }

        // Retry with exponential backoff
        if (attempt < maxRetries) {
          const delay = Math.min(
            baseDelayMs * Math.pow(2, attempt),
            maxDelayMs
          )
          await this.sleep(delay)
        }
      }
    }

    throw new OpenCodeClientError(
      `Connection failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
      "CONNECTION_FAILED",
      undefined,
      lastError
    )
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Get the base URL of this client
   */
  get baseUrl(): string {
    return this.config.baseUrl
  }

  /**
   * Close any active connections
   */
  close(): void {
    this.sseAbortController?.abort()
    this.sseAbortController = undefined
  }
}

/**
 * Create an OpenCode client for a specific port
 */
export function createClient(port: number): OpenCodeClient {
  return new OpenCodeClient({
    baseUrl: `http://localhost:${port}`,
  })
}
