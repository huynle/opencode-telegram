/**
 * Single OpenCode Instance Manager
 * 
 * Manages the lifecycle of a single OpenCode instance:
 * - Spawning the process
 * - Health checking
 * - Graceful shutdown
 * - Crash detection and recovery
 * 
 * Design decisions:
 * - Uses Bun.spawn for subprocess management
 * - Health check via HTTP to /session/list endpoint
 * - Pipes stdout/stderr for debugging
 * - Emits events for state changes
 */

import type {
  InstanceConfig,
  ManagedInstance,
  InstanceState,
  HealthCheckResult,
  ManagerConfig,
} from "../types/orchestrator"

/**
 * Callback for instance state changes
 */
export type InstanceEventCallback = (
  instanceId: string,
  state: InstanceState,
  info?: { error?: string; sessionId?: string }
) => void

export class OpenCodeInstance {
  private instance: ManagedInstance
  private config: ManagerConfig
  private onStateChange: InstanceEventCallback
  private startupPromise: Promise<boolean> | null = null
  private shuttingDown: boolean = false
  
  constructor(
    instanceConfig: InstanceConfig,
    port: number,
    managerConfig: ManagerConfig,
    onStateChange: InstanceEventCallback
  ) {
    this.config = managerConfig
    this.onStateChange = onStateChange
    
    // Initialize instance info
    this.instance = {
      config: instanceConfig,
      port,
      state: "stopped",
      restartCount: 0,
    }
    
    console.log(`[Instance:${instanceConfig.instanceId}] Created (port: ${port}, workDir: ${instanceConfig.workDir})`)
  }
  
  /**
   * Get current instance info
   */
  get info(): ManagedInstance {
    return { ...this.instance }
  }
  
  /**
   * Set the session ID for this instance
   * This is needed because the info getter returns a copy
   */
  setSessionId(sessionId: string): void {
    this.instance.sessionId = sessionId
  }
  
  /**
   * Get instance ID
   */
  get instanceId(): string {
    return this.instance.config.instanceId
  }
  
  /**
   * Get assigned port
   */
  get port(): number {
    return this.instance.port
  }
  
  /**
   * Get current state
   */
  get state(): InstanceState {
    return this.instance.state
  }
  
  /**
   * Check if instance is in a healthy running state
   */
  get isHealthy(): boolean {
    return this.instance.state === "running"
  }
  
  /**
   * Start the OpenCode instance
   * 
   * @returns Promise that resolves to true if started successfully
   */
  async start(): Promise<boolean> {
    // Prevent concurrent starts
    if (this.startupPromise) {
      console.log(`[Instance:${this.instanceId}] Start already in progress`)
      return this.startupPromise
    }
    
    if (this.instance.state === "running") {
      console.log(`[Instance:${this.instanceId}] Already running`)
      return true
    }
    
    this.startupPromise = this._doStart()
    const result = await this.startupPromise
    this.startupPromise = null
    return result
  }
  
  private async _doStart(): Promise<boolean> {
    const id = this.instanceId
    
    console.log(`[Instance:${id}] Starting on port ${this.instance.port}...`)
    this.setState("starting")
    
    try {
      // Clean up any stale process on this port before starting
      await this.cleanupPort()
      
      // Build command and args
      const command = this.config.opencodePath
      const args = ["serve", "--port", String(this.instance.port)]
      
      console.log(`[Instance:${id}] Spawning: ${command} ${args.join(" ")}`)
      console.log(`[Instance:${id}] Working directory: ${this.instance.config.workDir}`)
      
      // Spawn the process
      const proc = Bun.spawn([command, ...args], {
        cwd: this.instance.config.workDir,
        env: {
          ...process.env,
          ...this.instance.config.env,
        },
        stdout: "pipe",
        stderr: "pipe",
        // Don't use onExit - we'll handle process termination ourselves
      })
      
      this.instance.process = proc
      this.instance.pid = proc.pid
      this.instance.startedAt = new Date()
      this.instance.lastActivityAt = new Date()
      
      console.log(`[Instance:${id}] Process spawned with PID ${proc.pid}`)
      
      // Set up output logging (async, non-blocking)
      this.pipeOutput(proc)
      
      // Monitor process exit
      this.monitorProcess(proc)
      
      // Wait for health check with timeout
      const healthy = await this.waitForHealthy()
      
      if (healthy) {
        console.log(`[Instance:${id}] Started successfully`)
        this.startHealthCheckTimer()
        this.startIdleTimer()
        return true
      } else {
        console.log(`[Instance:${id}] Failed health check during startup`)
        this.setState("failed", { error: "Health check timeout during startup" })
        await this.stop()
        return false
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`[Instance:${id}] Failed to start: ${errorMsg}`)
      this.setState("failed", { error: errorMsg })
      return false
    }
  }
  
  /**
   * Stop the instance gracefully
   */
  async stop(): Promise<void> {
    const id = this.instanceId
    
    if (this.instance.state === "stopped" || this.shuttingDown) {
      console.log(`[Instance:${id}] Already stopped or stopping`)
      return
    }
    
    this.shuttingDown = true
    console.log(`[Instance:${id}] Stopping...`)
    this.setState("stopping")
    
    // Clear timers
    this.clearTimers()
    
    // Abort any SSE connection
    if (this.instance.sseAbortController) {
      this.instance.sseAbortController.abort()
      this.instance.sseAbortController = undefined
    }
    
    const proc = this.instance.process
    if (proc) {
      try {
        // First, try graceful shutdown via SIGTERM
        proc.kill("SIGTERM")
        
        // Wait up to 5 seconds for graceful shutdown
        const gracefulTimeout = 5000
        const exited = await Promise.race([
          proc.exited.then(() => true),
          new Promise<false>(resolve => setTimeout(() => resolve(false), gracefulTimeout)),
        ])
        
        if (!exited) {
          console.log(`[Instance:${id}] Graceful shutdown timeout, sending SIGKILL`)
          proc.kill("SIGKILL")
          await proc.exited
        }
        
        console.log(`[Instance:${id}] Process terminated with exit code ${proc.exitCode}`)
        
      } catch (error) {
        console.error(`[Instance:${id}] Error during shutdown:`, error)
      }
    }
    
    this.instance.process = undefined
    this.instance.pid = undefined
    this.shuttingDown = false
    this.setState("stopped")
    console.log(`[Instance:${id}] Stopped`)
  }
  
  /**
   * Perform a health check on the instance
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const id = this.instanceId
    const url = `http://localhost:${this.instance.port}/session`
    const start = Date.now()
    
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.config.healthCheckTimeoutMs)
      
      const response = await fetch(url, {
        signal: controller.signal,
      })
      
      clearTimeout(timeout)
      
      if (!response.ok) {
        return {
          healthy: false,
          responseTimeMs: Date.now() - start,
          error: `HTTP ${response.status}`,
        }
      }
      
      // OpenCode returns an array of sessions directly
      const data = await response.json() as Array<{ id: string }>
      const sessionId = data[0]?.id
      
      return {
        healthy: true,
        responseTimeMs: Date.now() - start,
        sessionId,
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      
      // Don't log AbortError as it's expected during shutdown
      if (!errorMsg.includes("abort")) {
        console.log(`[Instance:${id}] Health check failed: ${errorMsg}`)
      }
      
      return {
        healthy: false,
        responseTimeMs: Date.now() - start,
        error: errorMsg,
      }
    }
  }
  
  /**
   * Update last activity timestamp (call when message sent/received)
   */
  recordActivity(): void {
    this.instance.lastActivityAt = new Date()
    this.resetIdleTimer()
  }
  
  /**
   * Increment restart count
   */
  incrementRestartCount(): number {
    this.instance.restartCount++
    return this.instance.restartCount
  }
  
  /**
   * Reset restart count (after successful recovery)
   */
  resetRestartCount(): void {
    this.instance.restartCount = 0
  }
  
  // ===========================================================================
  // Private Methods
  // ===========================================================================
  
  /**
   * Wait for the instance to become healthy
   */
  private async waitForHealthy(): Promise<boolean> {
    const id = this.instanceId
    const startTime = Date.now()
    const timeout = this.config.startupTimeoutMs
    const checkInterval = 500 // Check every 500ms
    
    console.log(`[Instance:${id}] Waiting for health check (timeout: ${timeout}ms)...`)
    
    while (Date.now() - startTime < timeout) {
      // Check if process is still running
      if (!this.instance.process || this.instance.process.exitCode !== null) {
        console.log(`[Instance:${id}] Process exited during startup`)
        return false
      }
      
      const result = await this.healthCheck()
      
      if (result.healthy) {
        console.log(`[Instance:${id}] Health check passed (${result.responseTimeMs}ms)`)
        
        // NOTE: We intentionally do NOT set sessionId here.
        // The integration layer is responsible for finding/creating the correct session
        // that matches the instance's working directory. The health check just returns
        // the first session it finds, which may be from a different directory.
        
        this.setState("running")
        return true
      }
      
      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, checkInterval))
    }
    
    console.log(`[Instance:${id}] Health check timeout after ${timeout}ms`)
    return false
  }
  
  /**
   * Monitor process for unexpected exits
   */
  private monitorProcess(proc: ReturnType<typeof Bun.spawn>): void {
    const id = this.instanceId
    
    proc.exited.then((exitCode) => {
      // Only handle if we didn't initiate the shutdown
      if (!this.shuttingDown && this.instance.state !== "stopping") {
        console.log(`[Instance:${id}] Process exited unexpectedly with code ${exitCode}`)
        this.instance.process = undefined
        this.instance.pid = undefined
        this.clearTimers()
        this.setState("crashed", { error: `Exit code: ${exitCode}` })
      }
    }).catch((error) => {
      console.error(`[Instance:${id}] Error monitoring process:`, error)
    })
  }
  
  /**
   * Pipe process output to console
   */
  private pipeOutput(proc: ReturnType<typeof Bun.spawn>): void {
    const id = this.instanceId
    
    // Stream stdout - check it's a ReadableStream, not a file descriptor
    const stdout = proc.stdout
    if (stdout && typeof stdout !== "number") {
      (async () => {
        const reader = stdout.getReader()
        const decoder = new TextDecoder()
        
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            
            const text = decoder.decode(value)
            for (const line of text.split("\n")) {
              if (line.trim()) {
                console.log(`[Instance:${id}:stdout] ${line}`)
              }
            }
          }
        } catch {
          // Stream closed, ignore
        }
      })()
    }
    
    // Stream stderr - check it's a ReadableStream, not a file descriptor
    const stderr = proc.stderr
    if (stderr && typeof stderr !== "number") {
      (async () => {
        const reader = stderr.getReader()
        const decoder = new TextDecoder()
        
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            
            const text = decoder.decode(value)
            for (const line of text.split("\n")) {
              if (line.trim()) {
                console.error(`[Instance:${id}:stderr] ${line}`)
              }
            }
          }
        } catch {
          // Stream closed, ignore
        }
      })()
    }
  }
  
  /**
   * Start periodic health check timer
   */
  private startHealthCheckTimer(): void {
    const id = this.instanceId
    
    this.instance.healthCheckTimer = setInterval(async () => {
      if (this.instance.state !== "running") return
      
      const result = await this.healthCheck()
      
      if (!result.healthy) {
        console.log(`[Instance:${id}] Health check failed while running`)
        this.clearTimers()
        this.setState("crashed", { error: result.error })
      }
      // NOTE: We intentionally do NOT update sessionId from health checks.
      // The integration layer is responsible for managing sessionId to ensure
      // it matches the instance's working directory.
    }, this.config.healthCheckIntervalMs)
    
    console.log(`[Instance:${id}] Health check timer started (interval: ${this.config.healthCheckIntervalMs}ms)`)
  }
  
  /**
   * Start idle timeout timer
   */
  private startIdleTimer(): void {
    const timeoutMs = this.instance.config.idleTimeoutMs ?? this.config.defaultIdleTimeoutMs
    
    if (timeoutMs <= 0) {
      console.log(`[Instance:${this.instanceId}] Idle timeout disabled`)
      return
    }
    
    this.resetIdleTimer()
  }
  
  /**
   * Reset idle timer (called on activity)
   */
  private resetIdleTimer(): void {
    const id = this.instanceId
    const timeoutMs = this.instance.config.idleTimeoutMs ?? this.config.defaultIdleTimeoutMs
    
    if (timeoutMs <= 0) return
    
    if (this.instance.idleTimer) {
      clearTimeout(this.instance.idleTimer)
    }
    
    this.instance.idleTimer = setTimeout(() => {
      if (this.instance.state === "running") {
        console.log(`[Instance:${id}] Idle timeout (${timeoutMs}ms), stopping...`)
        // Emit event before stopping so manager can clean up
        this.onStateChange(id, "stopped", { error: "idle-timeout" })
        this.stop()
      }
    }, timeoutMs)
  }
  
  /**
   * Clear all timers
   */
  private clearTimers(): void {
    if (this.instance.healthCheckTimer) {
      clearInterval(this.instance.healthCheckTimer)
      this.instance.healthCheckTimer = undefined
    }
    
    if (this.instance.idleTimer) {
      clearTimeout(this.instance.idleTimer)
      this.instance.idleTimer = undefined
    }
  }
  
  /**
   * Clean up any stale process on the port before starting
   */
  private async cleanupPort(): Promise<void> {
    const id = this.instanceId
    const port = this.instance.port
    
    try {
      // Use lsof to find process on port (macOS/Linux)
      const result = await Bun.$`lsof -ti:${port} 2>/dev/null`.text()
      const pids = result.trim().split('\n').filter(p => p)
      
      if (pids.length > 0) {
        console.log(`[Instance:${id}] Found stale process(es) on port ${port}: ${pids.join(', ')}`)
        
        for (const pid of pids) {
          try {
            await Bun.$`kill ${pid} 2>/dev/null`
            console.log(`[Instance:${id}] Killed stale process ${pid}`)
          } catch {
            // Process may have already exited
          }
        }
        
        // Wait a moment for port to be released
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    } catch {
      // lsof command failed or no process found - that's fine
    }
  }
  
  /**
   * Update state and notify callback
   */
  private setState(state: InstanceState, info?: { error?: string; sessionId?: string }): void {
    const prevState = this.instance.state
    this.instance.state = state
    
    if (info?.error) {
      this.instance.lastError = info.error
    }
    
    if (info?.sessionId) {
      this.instance.sessionId = info.sessionId
    }
    
    console.log(`[Instance:${this.instanceId}] State: ${prevState} -> ${state}`)
    this.onStateChange(this.instanceId, state, info)
  }
}
