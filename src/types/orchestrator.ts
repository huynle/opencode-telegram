/**
 * Type definitions for the OpenCode multi-instance orchestrator
 * 
 * These types define the core data structures used throughout the orchestrator system
 * for managing multiple OpenCode instances controlled via Telegram forum topics.
 */

// =============================================================================
// Instance Types
// =============================================================================

/**
 * Possible states of an OpenCode instance
 * 
 * State transitions:
 * - starting -> running (after health check passes)
 * - starting -> failed (if health check times out)
 * - running -> stopping (when shutdown requested)
 * - running -> crashed (if process exits unexpectedly)
 * - stopping -> stopped (after graceful shutdown)
 * - crashed -> starting (on auto-restart)
 * - stopped -> starting (on manual start)
 */
export type InstanceState = 
  | "starting"  // Process spawned, waiting for health check
  | "running"   // Healthy and accepting requests
  | "stopping"  // Graceful shutdown in progress
  | "stopped"   // Cleanly terminated
  | "crashed"   // Unexpected termination
  | "failed"    // Failed to start (health check timeout)

/**
 * Configuration for spawning a new OpenCode instance
 */
export interface InstanceConfig {
  /** Unique identifier for this instance (typically matches topicId) */
  instanceId: string
  
  /** Telegram forum topic ID this instance serves */
  topicId: number
  
  /** Working directory for OpenCode (project path) */
  workDir: string
  
  /** Display name for logging/UI purposes */
  name?: string
  
  /** Environment variables to pass to the instance */
  env?: Record<string, string>
  
  /** Idle timeout in milliseconds (default: 30 minutes) */
  idleTimeoutMs?: number
}

/**
 * Runtime information about an OpenCode instance
 */
export interface InstanceInfo {
  /** Instance configuration */
  config: InstanceConfig
  
  /** Assigned port number */
  port: number
  
  /** Current state of the instance */
  state: InstanceState
  
  /** Process ID (if running) */
  pid?: number
  
  /** Timestamp when instance was started */
  startedAt?: Date
  
  /** Timestamp of last activity (message sent/received) */
  lastActivityAt?: Date
  
  /** Number of restart attempts */
  restartCount: number
  
  /** Error message if in failed/crashed state */
  lastError?: string
  
  /** Session ID from OpenCode (for API calls) */
  sessionId?: string
}

/**
 * Internal instance structure with process handle
 * This extends InstanceInfo with runtime process management details
 */
export interface ManagedInstance extends InstanceInfo {
  /** Bun subprocess handle */
  process?: ReturnType<typeof Bun.spawn>
  
  /** Health check interval timer */
  healthCheckTimer?: Timer
  
  /** Idle timeout timer */
  idleTimer?: Timer
  
  /** SSE connection abort controller */
  sseAbortController?: AbortController
}

// =============================================================================
// Event Types
// =============================================================================

/**
 * Events emitted by the orchestrator for external consumers
 */
export type OrchestratorEvent = 
  | { type: "instance:starting"; instanceId: string; port: number }
  | { type: "instance:ready"; instanceId: string; port: number; sessionId?: string }
  | { type: "instance:stopped"; instanceId: string; reason: string }
  | { type: "instance:crashed"; instanceId: string; error: string; willRestart: boolean }
  | { type: "instance:failed"; instanceId: string; error: string }
  | { type: "instance:idle-timeout"; instanceId: string }
  | { type: "port-exhausted"; requested: number; available: number }

/**
 * Callback type for event listeners
 */
export type EventCallback = (event: OrchestratorEvent) => void

// =============================================================================
// Port Pool Types
// =============================================================================

/**
 * Configuration for the port pool
 */
export interface PortPoolConfig {
  /** First port in the range (default: 4100) */
  startPort: number
  
  /** Number of ports in the pool (default: 100) */
  poolSize: number
}

/**
 * Port allocation result
 */
export interface PortAllocation {
  port: number
  allocatedAt: Date
  instanceId: string
}

// =============================================================================
// State Store Types
// =============================================================================

/**
 * Persisted instance state for recovery after orchestrator restart
 */
export interface PersistedInstanceState {
  instanceId: string
  topicId: number
  port: number
  workDir: string
  name?: string
  sessionId?: string
  state: InstanceState
  pid?: number
  startedAt?: string  // ISO string
  lastActivityAt?: string  // ISO string
  restartCount: number
  env?: string  // JSON stringified
}

/**
 * Port allocation record for persistence
 */
export interface PersistedPortAllocation {
  port: number
  instanceId: string
  allocatedAt: string  // ISO string
}

// =============================================================================
// Manager Configuration
// =============================================================================

/**
 * Configuration for the instance manager
 */
export interface ManagerConfig {
  /** Maximum number of concurrent instances (default: 10) */
  maxInstances: number
  
  /** Port pool configuration */
  portPool: PortPoolConfig
  
  /** Health check interval in milliseconds (default: 30000) */
  healthCheckIntervalMs: number
  
  /** Health check timeout in milliseconds (default: 5000) */
  healthCheckTimeoutMs: number
  
  /** Startup timeout in milliseconds (default: 60000) */
  startupTimeoutMs: number
  
  /** Default idle timeout in milliseconds (default: 1800000 = 30 min) */
  defaultIdleTimeoutMs: number
  
  /** Maximum restart attempts before giving up (default: 3) */
  maxRestartAttempts: number
  
  /** Delay between restart attempts in milliseconds (default: 5000) */
  restartDelayMs: number
  
  /** Path to SQLite database for state persistence */
  statePath: string
  
  /** OpenCode binary path (default: "opencode") */
  opencodePath: string
}

/**
 * Default manager configuration values
 */
export const DEFAULT_MANAGER_CONFIG: ManagerConfig = {
  maxInstances: 10,
  portPool: {
    startPort: 4100,
    poolSize: 100,
  },
  healthCheckIntervalMs: 30_000,
  healthCheckTimeoutMs: 5_000,
  startupTimeoutMs: 60_000,
  defaultIdleTimeoutMs: 30 * 60 * 1000, // 30 minutes
  maxRestartAttempts: 3,
  restartDelayMs: 5_000,
  statePath: ".opencode-orchestrator.db",
  opencodePath: "opencode",
}

// =============================================================================
// Health Check Types
// =============================================================================

/**
 * Result of a health check
 */
export interface HealthCheckResult {
  healthy: boolean
  responseTimeMs?: number
  sessionId?: string
  error?: string
}

// =============================================================================
// API Response Types (from OpenCode REST API)
// =============================================================================

/**
 * Session info response from OpenCode API
 */
export interface OpenCodeSessionInfo {
  id: string
  path: string
  createdAt: string
  updatedAt: string
}

/**
 * Response from /session/list endpoint
 */
export interface SessionListResponse {
  sessions: OpenCodeSessionInfo[]
}
