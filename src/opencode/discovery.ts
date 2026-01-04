/**
 * OpenCode Instance Discovery
 * 
 * Discovers running OpenCode instances on the local machine by:
 * 1. Finding opencode processes via `ps`
 * 2. Getting their listening ports via `lsof`
 * 3. Querying their REST API for session info
 */

import { $ } from "bun"

// =============================================================================
// Types
// =============================================================================

/**
 * A discovered OpenCode instance
 */
export interface DiscoveredInstance {
  /** Process ID */
  pid: number
  /** HTTP port the instance is listening on */
  port: number
  /** Working directory of the process */
  workDir: string
  /** Whether this is a TUI instance (vs serve mode) */
  isTui: boolean
  /** Sessions available on this instance */
  sessions: DiscoveredSession[]
}

/**
 * A session discovered from an OpenCode instance
 */
export interface DiscoveredSession {
  /** Session ID */
  id: string
  /** Session title (if available) */
  title?: string
  /** Project directory */
  directory: string
  /** Project ID */
  projectId?: string
  /** Last updated timestamp */
  updatedAt?: Date
  /** The instance this session belongs to */
  instance: {
    pid: number
    port: number
    workDir: string
    /** Whether this is a TUI instance (vs opencode serve) */
    isTui: boolean
  }
}

// =============================================================================
// Discovery Functions
// =============================================================================

/**
 * Discover all running OpenCode instances on the local machine
 */
export async function discoverInstances(): Promise<DiscoveredInstance[]> {
  const instances: DiscoveredInstance[] = []

  try {
    // Find all opencode processes
    const psResult = await $`ps aux`.text()
    const lines = psResult.split('\n')

    for (const line of lines) {
      // Match opencode processes (both TUI and serve mode)
      // Skip: grep, run (language server wrapper)
      if (!line.includes('opencode') || 
          line.includes('grep') || 
          line.includes('opencode run')) {
        continue
      }

      // Extract PID (second column)
      const parts = line.trim().split(/\s+/)
      if (parts.length < 2) continue
      
      const pid = parseInt(parts[1], 10)
      if (isNaN(pid)) continue

      // Check if this is a serve or TUI instance
      const isTui = !line.includes('opencode serve')

      // Get the listening port using lsof
      const port = await getListeningPort(pid)
      if (!port) continue

      // Get working directory
      const workDir = await getWorkingDirectory(pid)
      if (!workDir) continue

      // Get sessions from the API
      const sessions = await getSessionsFromApi(port, pid, workDir, isTui)

      instances.push({
        pid,
        port,
        workDir,
        isTui,
        sessions,
      })
    }
  } catch (error) {
    console.error('[Discovery] Error discovering instances:', error)
  }

  return instances
}

/**
 * Discover all sessions across all running OpenCode instances
 * 
 * By default, returns only the most recent (active) session per instance.
 * Each running OpenCode instance typically has one "active" session that the user
 * is currently working with.
 * 
 * @param options.onlyActive - If true, only return the most recent session per instance (default: true)
 */
export async function discoverSessions(options?: {
  onlyActive?: boolean
}): Promise<DiscoveredSession[]> {
  const { onlyActive = true } = options ?? {}
  const instances = await discoverInstances()
  const sessions: DiscoveredSession[] = []

  for (const instance of instances) {
    let instanceSessions = instance.sessions

    if (onlyActive && instanceSessions.length > 0) {
      // Sort by updatedAt descending and take the most recent (active) session
      const sorted = [...instanceSessions].sort((a, b) => {
        const aTime = a.updatedAt?.getTime() ?? 0
        const bTime = b.updatedAt?.getTime() ?? 0
        return bTime - aTime
      })
      instanceSessions = sorted.slice(0, 1)
    }

    sessions.push(...instanceSessions)
  }

  // Deduplicate sessions by ID (same session may appear on multiple instances)
  const seen = new Set<string>()
  return sessions.filter(s => {
    if (seen.has(s.id)) return false
    seen.add(s.id)
    return true
  })
}

/**
 * Check if a session is still alive (its instance is running and responsive)
 */
export async function isSessionAlive(port: number, sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/session`, {
      signal: AbortSignal.timeout(2000),
    })
    
    if (!response.ok) return false
    
    const sessions = await response.json() as Array<{ id: string }>
    return sessions.some(s => s.id === sessionId)
  } catch {
    return false
  }
}

/**
 * Check if a port has a running OpenCode instance
 */
export async function isPortAlive(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/global/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the listening port for a process
 */
async function getListeningPort(pid: number): Promise<number | null> {
  try {
    const result = await $`lsof -p ${pid} 2>/dev/null`.text()
    
    // Look for TCP LISTEN entries
    for (const line of result.split('\n')) {
      if (line.includes('TCP') && line.includes('LISTEN')) {
        // Extract port from "localhost:PORT" or "*:PORT"
        const match = line.match(/(?:localhost|127\.0\.0\.1|\*):(\d+)/)
        if (match) {
          return parseInt(match[1], 10)
        }
      }
    }
  } catch {
    // Process may have exited
  }
  
  return null
}

/**
 * Get the working directory for a process
 */
async function getWorkingDirectory(pid: number): Promise<string | null> {
  try {
    const result = await $`lsof -p ${pid} 2>/dev/null`.text()
    
    // Look for cwd entry
    for (const line of result.split('\n')) {
      if (line.includes('cwd')) {
        // The path is the last column
        const parts = line.trim().split(/\s+/)
        const path = parts[parts.length - 1]
        // Resolve /private/tmp to /tmp on macOS
        return path.replace(/^\/private/, '')
      }
    }
  } catch {
    // Process may have exited
  }
  
  return null
}

/**
 * Get sessions from an OpenCode instance's API
 */
async function getSessionsFromApi(
  port: number, 
  pid: number, 
  workDir: string,
  isTui: boolean
): Promise<DiscoveredSession[]> {
  try {
    const response = await fetch(`http://localhost:${port}/session`, {
      signal: AbortSignal.timeout(2000),
    })
    
    if (!response.ok) return []
    
    const data = await response.json() as Array<{
      id: string
      title?: string
      directory: string
      projectID?: string
      time?: {
        updated?: number
      }
    }>

    return data.map(s => ({
      id: s.id,
      title: s.title,
      directory: s.directory,
      projectId: s.projectID,
      updatedAt: s.time?.updated ? new Date(s.time.updated) : undefined,
      instance: {
        pid,
        port,
        workDir,
        isTui,
      },
    }))
  } catch {
    return []
  }
}

/**
 * Find a discovered session by name, ID, or directory
 */
export function findSession(
  sessions: DiscoveredSession[],
  query: string
): DiscoveredSession | undefined {
  const normalizedQuery = query.toLowerCase().trim()
  
  return sessions.find(s => 
    // Match by session ID (prefix match)
    s.id.toLowerCase().startsWith(normalizedQuery) ||
    // Match by title
    s.title?.toLowerCase().includes(normalizedQuery) ||
    // Match by directory name
    s.directory.toLowerCase().includes(normalizedQuery) ||
    // Match by directory basename
    s.directory.split('/').pop()?.toLowerCase() === normalizedQuery
  )
}
