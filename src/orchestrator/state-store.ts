/**
 * State Store for Instance Persistence
 * 
 * Uses SQLite (via Bun's built-in bun:sqlite) to persist instance state.
 * This enables recovery of instance mappings after orchestrator restarts.
 * 
 * Design decisions:
 * - SQLite for simplicity and zero external dependencies
 * - Single file database for easy backup/migration
 * - Stores only metadata, not process handles (those are runtime-only)
 * - Automatic schema creation on first use
 */

import { Database } from "bun:sqlite"
import type {
  PersistedInstanceState,
  PersistedPortAllocation,
  InstanceState,
} from "../types/orchestrator"

export class StateStore {
  private db: Database
  
  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.initSchema()
    console.log(`[StateStore] Initialized database at ${dbPath}`)
  }
  
  /**
   * Initialize database schema
   * Creates tables if they don't exist
   */
  private initSchema(): void {
    // Instance state table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS instances (
        instance_id TEXT PRIMARY KEY,
        topic_id INTEGER NOT NULL,
        port INTEGER NOT NULL,
        work_dir TEXT NOT NULL,
        name TEXT,
        session_id TEXT,
        state TEXT NOT NULL,
        pid INTEGER,
        started_at TEXT,
        last_activity_at TEXT,
        restart_count INTEGER DEFAULT 0,
        env TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)
    
    // Port allocations table (for recovery)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS port_allocations (
        port INTEGER PRIMARY KEY,
        instance_id TEXT NOT NULL,
        allocated_at TEXT NOT NULL,
        FOREIGN KEY (instance_id) REFERENCES instances(instance_id)
      )
    `)
    
    // Index for efficient topic lookups
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_instances_topic_id ON instances(topic_id)
    `)
    
    // Index for state queries
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_instances_state ON instances(state)
    `)
    
    console.log("[StateStore] Schema initialized")
  }
  
  // ===========================================================================
  // Instance Operations
  // ===========================================================================
  
  /**
   * Save instance state (insert or update)
   */
  saveInstance(state: PersistedInstanceState): void {
    const stmt = this.db.prepare(`
      INSERT INTO instances (
        instance_id, topic_id, port, work_dir, name, session_id,
        state, pid, started_at, last_activity_at, restart_count, env, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(instance_id) DO UPDATE SET
        topic_id = excluded.topic_id,
        port = excluded.port,
        work_dir = excluded.work_dir,
        name = excluded.name,
        session_id = excluded.session_id,
        state = excluded.state,
        pid = excluded.pid,
        started_at = excluded.started_at,
        last_activity_at = excluded.last_activity_at,
        restart_count = excluded.restart_count,
        env = excluded.env,
        updated_at = CURRENT_TIMESTAMP
    `)
    
    stmt.run(
      state.instanceId,
      state.topicId,
      state.port,
      state.workDir,
      state.name ?? null,
      state.sessionId ?? null,
      state.state,
      state.pid ?? null,
      state.startedAt ?? null,
      state.lastActivityAt ?? null,
      state.restartCount,
      state.env ?? null
    )
    
    console.log(`[StateStore] Saved instance ${state.instanceId} (state: ${state.state})`)
  }
  
  /**
   * Get instance by ID
   */
  getInstance(instanceId: string): PersistedInstanceState | null {
    const stmt = this.db.prepare(`
      SELECT instance_id, topic_id, port, work_dir, name, session_id,
             state, pid, started_at, last_activity_at, restart_count, env
      FROM instances
      WHERE instance_id = ?
    `)
    
    const row = stmt.get(instanceId) as any
    return row ? this.rowToInstanceState(row) : null
  }
  
  /**
   * Get instance by topic ID
   */
  getInstanceByTopic(topicId: number): PersistedInstanceState | null {
    const stmt = this.db.prepare(`
      SELECT instance_id, topic_id, port, work_dir, name, session_id,
             state, pid, started_at, last_activity_at, restart_count, env
      FROM instances
      WHERE topic_id = ?
    `)
    
    const row = stmt.get(topicId) as any
    return row ? this.rowToInstanceState(row) : null
  }
  
  /**
   * Get all instances with specified states
   */
  getInstancesByState(states: InstanceState[]): PersistedInstanceState[] {
    const placeholders = states.map(() => "?").join(", ")
    const stmt = this.db.prepare(`
      SELECT instance_id, topic_id, port, work_dir, name, session_id,
             state, pid, started_at, last_activity_at, restart_count, env
      FROM instances
      WHERE state IN (${placeholders})
    `)
    
    const rows = stmt.all(...states) as any[]
    return rows.map(row => this.rowToInstanceState(row))
  }
  
  /**
   * Get all instances
   */
  getAllInstances(): PersistedInstanceState[] {
    const stmt = this.db.prepare(`
      SELECT instance_id, topic_id, port, work_dir, name, session_id,
             state, pid, started_at, last_activity_at, restart_count, env
      FROM instances
    `)
    
    const rows = stmt.all() as any[]
    return rows.map(row => this.rowToInstanceState(row))
  }
  
  /**
   * Update instance state
   */
  updateInstanceState(instanceId: string, state: InstanceState, error?: string): void {
    const stmt = this.db.prepare(`
      UPDATE instances
      SET state = ?, updated_at = CURRENT_TIMESTAMP
      WHERE instance_id = ?
    `)
    
    stmt.run(state, instanceId)
    console.log(`[StateStore] Updated instance ${instanceId} state to ${state}`)
  }
  
  /**
   * Update last activity timestamp
   */
  updateLastActivity(instanceId: string): void {
    const stmt = this.db.prepare(`
      UPDATE instances
      SET last_activity_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE instance_id = ?
    `)
    
    stmt.run(new Date().toISOString(), instanceId)
  }
  
  /**
   * Update session ID after health check
   */
  updateSessionId(instanceId: string, sessionId: string): void {
    const stmt = this.db.prepare(`
      UPDATE instances
      SET session_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE instance_id = ?
    `)
    
    stmt.run(sessionId, instanceId)
    console.log(`[StateStore] Updated instance ${instanceId} sessionId to ${sessionId}`)
  }
  
  /**
   * Increment restart count
   */
  incrementRestartCount(instanceId: string): number {
    const stmt = this.db.prepare(`
      UPDATE instances
      SET restart_count = restart_count + 1, updated_at = CURRENT_TIMESTAMP
      WHERE instance_id = ?
      RETURNING restart_count
    `)
    
    const result = stmt.get(instanceId) as { restart_count: number } | null
    return result?.restart_count ?? 0
  }
  
  /**
   * Delete instance record
   */
  deleteInstance(instanceId: string): void {
    // Also delete associated port allocation
    this.db.prepare("DELETE FROM port_allocations WHERE instance_id = ?").run(instanceId)
    this.db.prepare("DELETE FROM instances WHERE instance_id = ?").run(instanceId)
    console.log(`[StateStore] Deleted instance ${instanceId}`)
  }
  
  /**
   * Convert database row to PersistedInstanceState
   */
  private rowToInstanceState(row: any): PersistedInstanceState {
    return {
      instanceId: row.instance_id,
      topicId: row.topic_id,
      port: row.port,
      workDir: row.work_dir,
      name: row.name ?? undefined,
      sessionId: row.session_id ?? undefined,
      state: row.state as InstanceState,
      pid: row.pid ?? undefined,
      startedAt: row.started_at ?? undefined,
      lastActivityAt: row.last_activity_at ?? undefined,
      restartCount: row.restart_count,
      env: row.env ?? undefined,
    }
  }
  
  // ===========================================================================
  // Port Allocation Operations
  // ===========================================================================
  
  /**
   * Save port allocation
   */
  savePortAllocation(allocation: PersistedPortAllocation): void {
    const stmt = this.db.prepare(`
      INSERT INTO port_allocations (port, instance_id, allocated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(port) DO UPDATE SET
        instance_id = excluded.instance_id,
        allocated_at = excluded.allocated_at
    `)
    
    stmt.run(allocation.port, allocation.instanceId, allocation.allocatedAt)
  }
  
  /**
   * Get all port allocations
   */
  getPortAllocations(): PersistedPortAllocation[] {
    const stmt = this.db.prepare(`
      SELECT port, instance_id, allocated_at
      FROM port_allocations
    `)
    
    const rows = stmt.all() as any[]
    return rows.map(row => ({
      port: row.port,
      instanceId: row.instance_id,
      allocatedAt: row.allocated_at,
    }))
  }
  
  /**
   * Delete port allocation
   */
  deletePortAllocation(port: number): void {
    this.db.prepare("DELETE FROM port_allocations WHERE port = ?").run(port)
  }
  
  /**
   * Clear all port allocations
   */
  clearPortAllocations(): void {
    this.db.prepare("DELETE FROM port_allocations").run()
    console.log("[StateStore] Cleared all port allocations")
  }
  
  // ===========================================================================
  // Maintenance Operations
  // ===========================================================================
  
  /**
   * Mark all "running" or "starting" instances as "crashed"
   * Used on startup to handle instances that were running when orchestrator crashed
   */
  markStaleInstancesAsCrashed(): number {
    const stmt = this.db.prepare(`
      UPDATE instances
      SET state = 'crashed', updated_at = CURRENT_TIMESTAMP
      WHERE state IN ('running', 'starting', 'stopping')
    `)
    
    const result = stmt.run()
    const count = result.changes
    
    if (count > 0) {
      console.log(`[StateStore] Marked ${count} stale instances as crashed`)
    }
    
    return count
  }
  
  /**
   * Clean up old stopped/failed instances
   * @param olderThanDays - Delete instances stopped more than N days ago
   */
  cleanupOldInstances(olderThanDays: number = 7): number {
    const stmt = this.db.prepare(`
      DELETE FROM instances
      WHERE state IN ('stopped', 'failed')
        AND updated_at < datetime('now', '-' || ? || ' days')
    `)
    
    const result = stmt.run(olderThanDays)
    const count = result.changes
    
    if (count > 0) {
      console.log(`[StateStore] Cleaned up ${count} old instances`)
    }
    
    return count
  }
  
  /**
   * Get database statistics
   */
  getStats(): {
    totalInstances: number
    byState: Record<InstanceState, number>
    allocatedPorts: number
  } {
    const total = this.db.prepare("SELECT COUNT(*) as count FROM instances").get() as { count: number }
    
    const byStateRows = this.db.prepare(`
      SELECT state, COUNT(*) as count FROM instances GROUP BY state
    `).all() as { state: InstanceState; count: number }[]
    
    const byState = {} as Record<InstanceState, number>
    for (const row of byStateRows) {
      byState[row.state] = row.count
    }
    
    const ports = this.db.prepare("SELECT COUNT(*) as count FROM port_allocations").get() as { count: number }
    
    return {
      totalInstances: total.count,
      byState,
      allocatedPorts: ports.count,
    }
  }
  
  /**
   * Close database connection
   */
  close(): void {
    this.db.close()
    console.log("[StateStore] Database closed")
  }
}
