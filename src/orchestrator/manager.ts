/**
 * Multi-Instance Orchestrator Manager
 * 
 * Central coordinator for all OpenCode instances. Handles:
 * - Instance lifecycle management (start, stop, restart)
 * - Port allocation
 * - State persistence and recovery
 * - Resource limits enforcement
 * - Event distribution
 * 
 * Design decisions:
 * - Single point of control for all instances
 * - Automatic restart on crash (with backoff)
 * - Graceful shutdown of all instances
 * - State persistence for recovery
 */

import { OpenCodeInstance, type InstanceEventCallback } from "./instance"
import { PortPool } from "./port-pool"
import { StateStore } from "./state-store"
import type {
  InstanceConfig,
  InstanceInfo,
  ManagerConfig,
  OrchestratorEvent,
  EventCallback,
  DEFAULT_MANAGER_CONFIG,
  InstanceState,
  PersistedInstanceState,
} from "../types/orchestrator"

// Re-export default config for convenience
export { DEFAULT_MANAGER_CONFIG } from "../types/orchestrator"

export class InstanceManager {
  private config: ManagerConfig
  private portPool: PortPool
  private stateStore: StateStore
  private instances: Map<string, OpenCodeInstance> = new Map()
  private topicToInstance: Map<number, string> = new Map()
  private eventListeners: EventCallback[] = []
  private shuttingDown: boolean = false
  
  constructor(config: Partial<ManagerConfig> = {}) {
    // Merge with defaults
    const defaults: ManagerConfig = {
      maxInstances: 10,
      portPool: { startPort: 4100, poolSize: 100 },
      healthCheckIntervalMs: 30_000,
      healthCheckTimeoutMs: 5_000,
      startupTimeoutMs: 60_000,
      defaultIdleTimeoutMs: 30 * 60 * 1000,
      maxRestartAttempts: 3,
      restartDelayMs: 5_000,
      statePath: ".opencode-orchestrator.db",
      opencodePath: "opencode",
    }
    
    this.config = { ...defaults, ...config }
    
    // Initialize components
    this.portPool = new PortPool(this.config.portPool)
    this.stateStore = new StateStore(this.config.statePath)
    
    console.log("[Manager] Initialized with config:", {
      maxInstances: this.config.maxInstances,
      portRange: `${this.config.portPool.startPort}-${this.config.portPool.startPort + this.config.portPool.poolSize - 1}`,
      idleTimeout: `${this.config.defaultIdleTimeoutMs / 1000 / 60} min`,
    })
    
    // Set up graceful shutdown handlers
    this.setupShutdownHandlers()
  }
  
  // ===========================================================================
  // Public API
  // ===========================================================================
  
  /**
   * Start or get an instance for a Telegram topic
   * 
   * @param topicId - Telegram forum topic ID
   * @param workDir - Working directory for OpenCode
   * @param options - Additional instance options
   * @returns Instance info, or null if failed
   */
  async getOrCreateInstance(
    topicId: number,
    workDir: string,
    options: { name?: string; env?: Record<string, string>; idleTimeoutMs?: number } = {}
  ): Promise<InstanceInfo | null> {
    // Check if instance already exists for this topic
    const existingId = this.topicToInstance.get(topicId)
    if (existingId) {
      const instance = this.instances.get(existingId)
      if (instance) {
        // Check if workDir has changed (topic was linked to different directory)
        if (instance.info.config.workDir !== workDir) {
          console.log(`[Manager] WorkDir changed for topic ${topicId}: ${instance.info.config.workDir} -> ${workDir}`)
          console.log(`[Manager] Stopping and removing instance to restart with new workDir`)
          await this.stopInstance(existingId)
          // Remove the old instance so we can create a new one with the new workDir
          this.instances.delete(existingId)
          this.topicToInstance.delete(topicId)
          // Fall through to create new instance with new workDir
        } else {
          // If running, just return it
          if (instance.isHealthy) {
            console.log(`[Manager] Returning existing instance for topic ${topicId}`)
            instance.recordActivity()
            return instance.info
          }
          
          // If crashed or failed, try to restart
          if (instance.state === "crashed" || instance.state === "failed") {
            console.log(`[Manager] Restarting crashed instance for topic ${topicId}`)
            return this.restartInstance(existingId)
          }
          
          // If starting, wait for it
          if (instance.state === "starting") {
            console.log(`[Manager] Instance for topic ${topicId} is starting, waiting...`)
            // Wait up to startup timeout
            const waitStart = Date.now()
            while (instance.state === "starting" && Date.now() - waitStart < this.config.startupTimeoutMs) {
              await new Promise(resolve => setTimeout(resolve, 500))
            }
            return instance.isHealthy ? instance.info : null
          }
          
          // If stopped, start it
          if (instance.state === "stopped") {
            console.log(`[Manager] Starting stopped instance for topic ${topicId}`)
            const success = await instance.start()
            return success ? instance.info : null
          }
        }
      }
    }
    
    // Create new instance
    return this.createInstance({
      instanceId: `topic-${topicId}`,
      topicId,
      workDir,
      name: options.name,
      env: options.env,
      idleTimeoutMs: options.idleTimeoutMs,
    })
  }
  
  /**
   * Create a new instance
   */
  async createInstance(config: InstanceConfig): Promise<InstanceInfo | null> {
    const { instanceId, topicId } = config
    
    // Check resource limits
    const runningCount = this.getRunningCount()
    if (runningCount >= this.config.maxInstances) {
      console.log(`[Manager] Cannot create instance: at max capacity (${runningCount}/${this.config.maxInstances})`)
      this.emit({ 
        type: "port-exhausted", 
        requested: runningCount + 1, 
        available: this.config.maxInstances - runningCount 
      })
      return null
    }
    
    // Check if instance ID already exists
    if (this.instances.has(instanceId)) {
      console.log(`[Manager] Instance ${instanceId} already exists`)
      return this.instances.get(instanceId)!.info
    }
    
    // Allocate port
    const port = this.portPool.allocate(instanceId)
    if (port === null) {
      console.log(`[Manager] Cannot create instance: no ports available`)
      this.emit({ 
        type: "port-exhausted", 
        requested: 1, 
        available: 0 
      })
      return null
    }
    
    console.log(`[Manager] Creating instance ${instanceId} for topic ${topicId} on port ${port}`)
    
    // Create instance
    const instance = new OpenCodeInstance(
      config,
      port,
      this.config,
      this.handleInstanceStateChange.bind(this)
    )
    
    // Register instance
    this.instances.set(instanceId, instance)
    this.topicToInstance.set(topicId, instanceId)
    
    // Persist initial state
    this.persistInstanceState(instance)
    
    // Emit starting event
    this.emit({ type: "instance:starting", instanceId, port })
    
    // Start instance
    const success = await instance.start()
    
    if (success) {
      this.emit({ 
        type: "instance:ready", 
        instanceId, 
        port, 
        sessionId: instance.info.sessionId 
      })
      return instance.info
    } else {
      // Clean up on failure
      this.emit({ 
        type: "instance:failed", 
        instanceId, 
        error: instance.info.lastError || "Failed to start" 
      })
      return null
    }
  }
  
  /**
   * Stop an instance
   */
  async stopInstance(instanceId: string, reason: string = "requested"): Promise<void> {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      console.log(`[Manager] Instance ${instanceId} not found`)
      return
    }
    
    console.log(`[Manager] Stopping instance ${instanceId}: ${reason}`)
    
    await instance.stop()
    
    // Release port
    this.portPool.release(instance.port)
    
    // Update persistence
    this.persistInstanceState(instance)
    
    this.emit({ type: "instance:stopped", instanceId, reason })
  }
  
  /**
   * Stop instance by topic ID
   */
  async stopInstanceByTopic(topicId: number, reason: string = "requested"): Promise<void> {
    const instanceId = this.topicToInstance.get(topicId)
    if (instanceId) {
      await this.stopInstance(instanceId, reason)
    }
  }
  
  /**
   * Restart an instance
   */
  async restartInstance(instanceId: string): Promise<InstanceInfo | null> {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      console.log(`[Manager] Instance ${instanceId} not found for restart`)
      return null
    }
    
    const restartCount = instance.incrementRestartCount()
    
    if (restartCount > this.config.maxRestartAttempts) {
      console.log(`[Manager] Instance ${instanceId} exceeded max restart attempts (${restartCount}/${this.config.maxRestartAttempts})`)
      this.emit({ 
        type: "instance:failed", 
        instanceId, 
        error: `Exceeded max restart attempts (${this.config.maxRestartAttempts})` 
      })
      return null
    }
    
    console.log(`[Manager] Restarting instance ${instanceId} (attempt ${restartCount}/${this.config.maxRestartAttempts})`)
    
    // Wait before restart (backoff)
    const delay = this.config.restartDelayMs * restartCount
    console.log(`[Manager] Waiting ${delay}ms before restart...`)
    await new Promise(resolve => setTimeout(resolve, delay))
    
    // Stop if running
    if (instance.state !== "stopped" && instance.state !== "crashed" && instance.state !== "failed") {
      await instance.stop()
    }
    
    // Start again
    const success = await instance.start()
    
    if (success) {
      instance.resetRestartCount()
      this.persistInstanceState(instance)
      
      // Emit instance:ready so integration layer can re-establish SSE subscription
      this.emit({ 
        type: "instance:ready", 
        instanceId, 
        port: instance.port,
        sessionId: instance.info.sessionId,
      })
      
      return instance.info
    }
    
    return null
  }
  
  /**
   * Get instance info by ID
   */
  getInstance(instanceId: string): InstanceInfo | null {
    return this.instances.get(instanceId)?.info ?? null
  }
  
  /**
   * Get instance by topic ID
   */
  getInstanceByTopic(topicId: number): InstanceInfo | null {
    const instanceId = this.topicToInstance.get(topicId)
    return instanceId ? this.getInstance(instanceId) : null
  }
  
  /**
   * Get all instances
   */
  getAllInstances(): InstanceInfo[] {
    return Array.from(this.instances.values()).map(i => i.info)
  }
  
  /**
   * Get running instance count
   */
  getRunningCount(): number {
    return Array.from(this.instances.values()).filter(i => 
      i.state === "running" || i.state === "starting"
    ).length
  }
  
  /**
   * Record activity for an instance (resets idle timer)
   */
  recordActivity(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (instance) {
      instance.recordActivity()
      this.stateStore.updateLastActivity(instanceId)
    }
  }
  
  /**
   * Record activity by topic
   */
  recordActivityByTopic(topicId: number): void {
    const instanceId = this.topicToInstance.get(topicId)
    if (instanceId) {
      this.recordActivity(instanceId)
    }
  }
  
  /**
   * Subscribe to orchestrator events
   */
  on(callback: EventCallback): () => void {
    this.eventListeners.push(callback)
    
    // Return unsubscribe function
    return () => {
      const index = this.eventListeners.indexOf(callback)
      if (index !== -1) {
        this.eventListeners.splice(index, 1)
      }
    }
  }
  
  /**
   * Get manager status
   */
  getStatus(): {
    instances: { total: number; running: number; stopped: number; crashed: number }
    ports: { allocated: number; available: number; total: number }
    config: { maxInstances: number; idleTimeoutMin: number }
  } {
    const states = Array.from(this.instances.values()).map(i => i.state)
    
    return {
      instances: {
        total: this.instances.size,
        running: states.filter(s => s === "running").length,
        stopped: states.filter(s => s === "stopped").length,
        crashed: states.filter(s => s === "crashed" || s === "failed").length,
      },
      ports: this.portPool.getStatus(),
      config: {
        maxInstances: this.config.maxInstances,
        idleTimeoutMin: this.config.defaultIdleTimeoutMs / 1000 / 60,
      },
    }
  }
  
  /**
   * Recover state from persistence (call on startup)
   * 
   * This attempts to reconnect to instances that were running before
   * the orchestrator was shut down.
   */
  async recover(): Promise<{ recovered: number; failed: number }> {
    console.log("[Manager] Starting state recovery...")
    
    // Mark stale instances (ones that claim to be running but we just started)
    this.stateStore.markStaleInstancesAsCrashed()
    
    // Get all crashed instances (they may still be running as processes)
    const crashedInstances = this.stateStore.getInstancesByState(["crashed"])
    
    let recovered = 0
    let failed = 0
    
    for (const state of crashedInstances) {
      console.log(`[Manager] Attempting to recover instance ${state.instanceId}...`)
      
      // Reserve the port if still available
      if (!this.portPool.reserve(state.port, state.instanceId)) {
        console.log(`[Manager] Cannot reserve port ${state.port} for ${state.instanceId}`)
        failed++
        continue
      }
      
      // Create instance wrapper (don't start yet)
      const instance = new OpenCodeInstance(
        {
          instanceId: state.instanceId,
          topicId: state.topicId,
          workDir: state.workDir,
          name: state.name,
          env: state.env ? JSON.parse(state.env) : undefined,
        },
        state.port,
        this.config,
        this.handleInstanceStateChange.bind(this)
      )
      
      // Register
      this.instances.set(state.instanceId, instance)
      this.topicToInstance.set(state.topicId, state.instanceId)
      
      // Try to start
      const success = await instance.start()
      
      if (success) {
        recovered++
        console.log(`[Manager] Recovered instance ${state.instanceId}`)
        this.emit({ 
          type: "instance:ready", 
          instanceId: state.instanceId, 
          port: state.port,
          sessionId: instance.info.sessionId,
        })
      } else {
        failed++
        console.log(`[Manager] Failed to recover instance ${state.instanceId}`)
        this.emit({ 
          type: "instance:failed", 
          instanceId: state.instanceId, 
          error: "Recovery failed" 
        })
      }
    }
    
    console.log(`[Manager] Recovery complete: ${recovered} recovered, ${failed} failed`)
    return { recovered, failed }
  }
  
  /**
   * Graceful shutdown of all instances
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      console.log("[Manager] Shutdown already in progress")
      return
    }
    
    this.shuttingDown = true
    console.log("[Manager] Shutting down all instances...")
    
    const instances = Array.from(this.instances.values())
    
    // Stop all instances in parallel
    await Promise.all(
      instances.map(instance => 
        instance.stop().catch(err => 
          console.error(`[Manager] Error stopping ${instance.instanceId}:`, err)
        )
      )
    )
    
    // Clear all state
    this.portPool.clear()
    this.stateStore.clearPortAllocations()
    
    // Close database
    this.stateStore.close()
    
    console.log("[Manager] Shutdown complete")
  }
  
  /**
   * Remove an instance completely (including persistence)
   */
  async removeInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId)
    
    if (instance) {
      await instance.stop()
      this.portPool.release(instance.port)
      this.topicToInstance.delete(instance.info.config.topicId)
    }
    
    this.instances.delete(instanceId)
    this.stateStore.deleteInstance(instanceId)
    
    console.log(`[Manager] Removed instance ${instanceId}`)
  }
  
  // ===========================================================================
  // Private Methods
  // ===========================================================================
  
  /**
   * Handle state changes from instances
   */
  private handleInstanceStateChange: InstanceEventCallback = (
    instanceId,
    state,
    info
  ) => {
    const instance = this.instances.get(instanceId)
    if (!instance) return
    
    // Persist state change
    this.persistInstanceState(instance)
    
    // Handle specific state transitions
    switch (state) {
      case "crashed":
        console.log(`[Manager] Instance ${instanceId} crashed: ${info?.error}`)
        
        // Check if we should auto-restart
        const willRestart = instance.info.restartCount < this.config.maxRestartAttempts
        
        this.emit({ 
          type: "instance:crashed", 
          instanceId, 
          error: info?.error || "Unknown error",
          willRestart,
        })
        
        if (willRestart && !this.shuttingDown) {
          // Schedule restart
          setTimeout(() => {
            this.restartInstance(instanceId).catch(err => 
              console.error(`[Manager] Auto-restart failed for ${instanceId}:`, err)
            )
          }, this.config.restartDelayMs)
        }
        break
        
      case "stopped":
        // Check if this is an idle timeout
        if (info?.error === "idle-timeout") {
          this.emit({ type: "instance:idle-timeout", instanceId })
        }
        break
    }
  }
  
  /**
   * Persist instance state to database
   */
  private persistInstanceState(instance: OpenCodeInstance): void {
    const info = instance.info
    
    this.stateStore.saveInstance({
      instanceId: info.config.instanceId,
      topicId: info.config.topicId,
      port: info.port,
      workDir: info.config.workDir,
      name: info.config.name,
      sessionId: info.sessionId,
      state: info.state,
      pid: info.pid,
      startedAt: info.startedAt?.toISOString(),
      lastActivityAt: info.lastActivityAt?.toISOString(),
      restartCount: info.restartCount,
      env: info.config.env ? JSON.stringify(info.config.env) : undefined,
    })
  }
  
  /**
   * Emit event to all listeners
   */
  private emit(event: OrchestratorEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch (err) {
        console.error("[Manager] Event listener error:", err)
      }
    }
  }
  
  /**
   * Set up process signal handlers for graceful shutdown
   */
  private setupShutdownHandlers(): void {
    const handler = async (signal: string) => {
      console.log(`\n[Manager] Received ${signal}, initiating graceful shutdown...`)
      await this.shutdown()
      process.exit(0)
    }
    
    process.on("SIGINT", () => handler("SIGINT"))
    process.on("SIGTERM", () => handler("SIGTERM"))
    
    // Handle uncaught errors
    process.on("uncaughtException", (err) => {
      console.error("[Manager] Uncaught exception:", err)
      this.shutdown().then(() => process.exit(1))
    })
    
    process.on("unhandledRejection", (reason, promise) => {
      console.error("[Manager] Unhandled rejection at:", promise, "reason:", reason)
    })
  }
}
