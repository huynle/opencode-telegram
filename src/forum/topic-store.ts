/**
 * Topic Store - SQLite Persistence Layer
 * 
 * Provides durable storage for topic→session mappings using SQLite.
 * Handles:
 * - CRUD operations for topic mappings
 * - Event logging for lifecycle tracking
 * - Recovery after bot restarts
 * - Query and filtering capabilities
 */

import { Database } from "bun:sqlite"
import type {
  TopicMapping,
  TopicMappingResult,
  TopicQueryOptions,
  TopicStatus,
  TopicEvent,
  TopicEventType,
} from "../types/forum"

/**
 * SQLite-based persistence for topic mappings
 */
export class TopicStore {
  private db: Database
  private initialized = false

  constructor(private databasePath: string) {
    this.db = new Database(databasePath)
    this.initialize()
  }

  /**
   * Initialize database schema
   */
  private initialize(): void {
    if (this.initialized) return

    // Enable WAL mode for better concurrent access
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")

    // Main topic mappings table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_mappings (
        chat_id INTEGER NOT NULL,
        topic_id INTEGER NOT NULL,
        topic_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        work_dir TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        creator_user_id INTEGER,
        icon_color INTEGER,
        icon_emoji_id TEXT,
        PRIMARY KEY (chat_id, topic_id)
      )
    `)

    // Migration: Add work_dir column if it doesn't exist
    try {
      this.db.exec(`ALTER TABLE topic_mappings ADD COLUMN work_dir TEXT`)
      console.log("[TopicStore] Added work_dir column")
    } catch {
      // Column already exists, ignore
    }

    // Migration: Add streaming_enabled column if it doesn't exist
    try {
      this.db.exec(`ALTER TABLE topic_mappings ADD COLUMN streaming_enabled INTEGER DEFAULT 0`)
      console.log("[TopicStore] Added streaming_enabled column")
    } catch {
      // Column already exists, ignore
    }

    // Index for fast session lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_id 
      ON topic_mappings(session_id)
    `)

    // Index for status queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_status 
      ON topic_mappings(status)
    `)

    // Event log table for lifecycle tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_events (
        id TEXT PRIMARY KEY,
        topic_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        user_id INTEGER,
        metadata TEXT
      )
    `)

    // Index for querying events by topic
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_topic_events 
      ON topic_events(chat_id, topic_id, timestamp DESC)
    `)

    // Session stats table (updated incrementally)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_stats (
        chat_id INTEGER NOT NULL,
        topic_id INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (chat_id, topic_id),
        FOREIGN KEY (chat_id, topic_id) REFERENCES topic_mappings(chat_id, topic_id)
      )
    `)

    this.initialized = true
    console.log(`[TopicStore] Initialized database at ${this.databasePath}`)
  }

  /**
   * Create a new topic mapping
   */
  createMapping(
    chatId: number,
    topicId: number,
    topicName: string,
    sessionId: string,
    options?: {
      creatorUserId?: number
      iconColor?: number
      iconEmojiId?: string
    }
  ): TopicMappingResult {
    const now = Date.now()

    try {
      // Check if mapping already exists
      const existing = this.getMapping(chatId, topicId)
      if (existing) {
        console.log(`[TopicStore] Mapping already exists for topic ${topicId} in chat ${chatId}`)
        return {
          success: true,
          mapping: existing,
          isExisting: true,
        }
      }

      // Insert new mapping
      const stmt = this.db.prepare(`
        INSERT INTO topic_mappings (
          chat_id, topic_id, topic_name, session_id, status,
          created_at, updated_at, creator_user_id, icon_color, icon_emoji_id
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `)

      stmt.run(
        chatId,
        topicId,
        topicName,
        sessionId,
        now,
        now,
        options?.creatorUserId ?? null,
        options?.iconColor ?? null,
        options?.iconEmojiId ?? null
      )

      // Initialize stats
      this.db.prepare(`
        INSERT INTO topic_stats (chat_id, topic_id)
        VALUES (?, ?)
      `).run(chatId, topicId)

      // Log creation event
      this.logEvent(chatId, topicId, "created", options?.creatorUserId)

      const mapping = this.getMapping(chatId, topicId)
      console.log(`[TopicStore] Created mapping: topic ${topicId} -> session ${sessionId}`)

      return {
        success: true,
        mapping: mapping!,
        isExisting: false,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[TopicStore] Failed to create mapping: ${message}`)
      return {
        success: false,
        error: message,
      }
    }
  }

  /**
   * Get a topic mapping by chat and topic ID
   */
  getMapping(chatId: number, topicId: number): TopicMapping | null {
    const stmt = this.db.prepare(`
      SELECT * FROM topic_mappings
      WHERE chat_id = ? AND topic_id = ?
    `)

    const row = stmt.get(chatId, topicId) as Record<string, unknown> | null
    return row ? this.rowToMapping(row) : null
  }

  /**
   * Get a topic mapping by session ID
   */
  getMappingBySession(sessionId: string): TopicMapping | null {
    const stmt = this.db.prepare(`
      SELECT * FROM topic_mappings
      WHERE session_id = ?
    `)

    const row = stmt.get(sessionId) as Record<string, unknown> | null
    return row ? this.rowToMapping(row) : null
  }

  /**
   * Get all active mappings for a chat
   */
  getActiveMappings(chatId: number): TopicMapping[] {
    const stmt = this.db.prepare(`
      SELECT * FROM topic_mappings
      WHERE chat_id = ? AND status = 'active'
      ORDER BY updated_at DESC
    `)

    const rows = stmt.all(chatId) as Record<string, unknown>[]
    return rows.map(row => this.rowToMapping(row))
  }

  /**
   * Query mappings with filters
   */
  queryMappings(options: TopicQueryOptions = {}): TopicMapping[] {
    let sql = "SELECT * FROM topic_mappings WHERE 1=1"
    const params: (string | number | null)[] = []

    if (options.chatId !== undefined) {
      sql += " AND chat_id = ?"
      params.push(options.chatId)
    }

    if (options.status !== undefined) {
      sql += " AND status = ?"
      params.push(options.status)
    }

    sql += " ORDER BY updated_at DESC"

    if (options.limit !== undefined) {
      sql += " LIMIT ?"
      params.push(options.limit)
    }

    if (options.offset !== undefined) {
      sql += " OFFSET ?"
      params.push(options.offset)
    }

    const stmt = this.db.prepare(sql)
    const rows = stmt.all(...params) as Record<string, unknown>[]
    return rows.map(row => this.rowToMapping(row))
  }

  /**
   * Update topic status
   */
  updateStatus(chatId: number, topicId: number, status: TopicStatus, userId?: number): boolean {
    const now = Date.now()

    try {
      const stmt = this.db.prepare(`
        UPDATE topic_mappings
        SET status = ?, updated_at = ?, closed_at = ?
        WHERE chat_id = ? AND topic_id = ?
      `)

      const closedAt = status === "closed" ? now : null
      const result = stmt.run(status, now, closedAt, chatId, topicId)

      if (result.changes > 0) {
        // Log event based on status change
        const eventType: TopicEventType = status === "closed" ? "closed" : 
                                          status === "active" ? "reopened" : "deleted"
        this.logEvent(chatId, topicId, eventType, userId)
        console.log(`[TopicStore] Updated topic ${topicId} status to ${status}`)
        return true
      }

      return false
    } catch (error) {
      console.error(`[TopicStore] Failed to update status: ${error}`)
      return false
    }
  }

  /**
   * Toggle streaming for a topic
   */
  toggleStreaming(chatId: number, topicId: number, enabled: boolean, userId?: number): boolean {
    const now = Date.now()

    try {
      const stmt = this.db.prepare(`
        UPDATE topic_mappings
        SET streaming_enabled = ?, updated_at = ?
        WHERE chat_id = ? AND topic_id = ?
      `)

      const result = stmt.run(enabled ? 1 : 0, now, chatId, topicId)

      if (result.changes > 0) {
        console.log(`[TopicStore] Updated topic ${topicId} streaming to ${enabled}`)
        return true
      }

      return false
    } catch (error) {
      console.error(`[TopicStore] Failed to toggle streaming: ${error}`)
      return false
    }
  }

  /**
   * Update topic working directory (for linking to existing projects)
   */
  updateWorkDir(chatId: number, topicId: number, workDir: string, userId?: number): boolean {
    const now = Date.now()

    try {
      const stmt = this.db.prepare(`
        UPDATE topic_mappings
        SET work_dir = ?, updated_at = ?
        WHERE chat_id = ? AND topic_id = ?
      `)

      const result = stmt.run(workDir, now, chatId, topicId)

      if (result.changes > 0) {
        this.logEvent(chatId, topicId, "linked", userId, { workDir })
        console.log(`[TopicStore] Updated topic ${topicId} workDir to "${workDir}"`)
        return true
      }

      return false
    } catch (error) {
      console.error(`[TopicStore] Failed to update workDir: ${error}`)
      return false
    }
  }

  /**
   * Update topic name
   */
  updateName(chatId: number, topicId: number, newName: string, userId?: number): boolean {
    const now = Date.now()

    try {
      const stmt = this.db.prepare(`
        UPDATE topic_mappings
        SET topic_name = ?, updated_at = ?
        WHERE chat_id = ? AND topic_id = ?
      `)

      const result = stmt.run(newName, now, chatId, topicId)

      if (result.changes > 0) {
        this.logEvent(chatId, topicId, "renamed", userId, { newName })
        console.log(`[TopicStore] Updated topic ${topicId} name to "${newName}"`)
        return true
      }

      return false
    } catch (error) {
      console.error(`[TopicStore] Failed to update name: ${error}`)
      return false
    }
  }

  /**
   * Delete a topic mapping
   */
  deleteMapping(chatId: number, topicId: number): boolean {
    try {
      // Delete stats first (foreign key)
      this.db.prepare(`
        DELETE FROM topic_stats
        WHERE chat_id = ? AND topic_id = ?
      `).run(chatId, topicId)

      // Delete mapping
      const stmt = this.db.prepare(`
        DELETE FROM topic_mappings
        WHERE chat_id = ? AND topic_id = ?
      `)

      const result = stmt.run(chatId, topicId)
      
      if (result.changes > 0) {
        console.log(`[TopicStore] Deleted mapping for topic ${topicId}`)
        return true
      }

      return false
    } catch (error) {
      console.error(`[TopicStore] Failed to delete mapping: ${error}`)
      return false
    }
  }

  /**
   * Increment message count and update last message time
   */
  recordMessage(chatId: number, topicId: number): void {
    const now = Date.now()

    try {
      this.db.prepare(`
        UPDATE topic_stats
        SET message_count = message_count + 1, last_message_at = ?
        WHERE chat_id = ? AND topic_id = ?
      `).run(now, chatId, topicId)

      // Also update the mapping's updated_at
      this.db.prepare(`
        UPDATE topic_mappings
        SET updated_at = ?
        WHERE chat_id = ? AND topic_id = ?
      `).run(now, chatId, topicId)
    } catch (error) {
      console.error(`[TopicStore] Failed to record message: ${error}`)
    }
  }

  /**
   * Increment tool call count
   */
  recordToolCall(chatId: number, topicId: number): void {
    try {
      this.db.prepare(`
        UPDATE topic_stats
        SET tool_calls = tool_calls + 1
        WHERE chat_id = ? AND topic_id = ?
      `).run(chatId, topicId)
    } catch (error) {
      console.error(`[TopicStore] Failed to record tool call: ${error}`)
    }
  }

  /**
   * Increment error count
   */
  recordError(chatId: number, topicId: number): void {
    try {
      this.db.prepare(`
        UPDATE topic_stats
        SET error_count = error_count + 1
        WHERE chat_id = ? AND topic_id = ?
      `).run(chatId, topicId)
    } catch (error) {
      console.error(`[TopicStore] Failed to record error: ${error}`)
    }
  }

  /**
   * Get stats for a topic
   */
  getStats(chatId: number, topicId: number): {
    messageCount: number
    lastMessageAt?: number
    toolCalls: number
    errorCount: number
  } | null {
    const stmt = this.db.prepare(`
      SELECT * FROM topic_stats
      WHERE chat_id = ? AND topic_id = ?
    `)

    const row = stmt.get(chatId, topicId) as Record<string, unknown> | null
    if (!row) return null

    return {
      messageCount: row.message_count as number,
      lastMessageAt: row.last_message_at as number | undefined,
      toolCalls: row.tool_calls as number,
      errorCount: row.error_count as number,
    }
  }

  /**
   * Log a topic lifecycle event
   */
  logEvent(
    chatId: number,
    topicId: number,
    eventType: TopicEventType,
    userId?: number,
    metadata?: Record<string, unknown>
  ): void {
    const id = `${chatId}_${topicId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    try {
      this.db.prepare(`
        INSERT INTO topic_events (id, chat_id, topic_id, event_type, timestamp, user_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        chatId,
        topicId,
        eventType,
        Date.now(),
        userId ?? null,
        metadata ? JSON.stringify(metadata) : null
      )
    } catch (error) {
      console.error(`[TopicStore] Failed to log event: ${error}`)
    }
  }

  /**
   * Get recent events for a topic
   */
  getEvents(chatId: number, topicId: number, limit = 50): TopicEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM topic_events
      WHERE chat_id = ? AND topic_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `)

    const rows = stmt.all(chatId, topicId, limit) as Record<string, unknown>[]
    return rows.map(row => ({
      id: row.id as string,
      chatId: row.chat_id as number,
      topicId: row.topic_id as number,
      eventType: row.event_type as TopicEventType,
      timestamp: row.timestamp as number,
      userId: row.user_id as number | undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    }))
  }

  /**
   * Get all session IDs for recovery after restart
   */
  getAllSessionIds(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT session_id FROM topic_mappings
      WHERE status = 'active'
    `)

    const rows = stmt.all() as { session_id: string }[]
    return rows.map(row => row.session_id)
  }

  /**
   * Find stale sessions (no activity within timeout)
   */
  findStaleSessions(timeoutMs: number): TopicMapping[] {
    const cutoff = Date.now() - timeoutMs

    const stmt = this.db.prepare(`
      SELECT tm.* FROM topic_mappings tm
      LEFT JOIN topic_stats ts ON tm.chat_id = ts.chat_id AND tm.topic_id = ts.topic_id
      WHERE tm.status = 'active'
        AND (ts.last_message_at IS NULL OR ts.last_message_at < ?)
        AND tm.updated_at < ?
    `)

    const rows = stmt.all(cutoff, cutoff) as Record<string, unknown>[]
    return rows.map(row => this.rowToMapping(row))
  }

  /**
   * Convert database row to TopicMapping
   */
  private rowToMapping(row: Record<string, unknown>): TopicMapping {
    return {
      chatId: row.chat_id as number,
      topicId: row.topic_id as number,
      topicName: row.topic_name as string,
      sessionId: row.session_id as string,
      workDir: row.work_dir as string | undefined,
      streamingEnabled: (row.streaming_enabled as number) === 1,
      status: row.status as TopicStatus,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      closedAt: row.closed_at as number | undefined,
      creatorUserId: row.creator_user_id as number | undefined,
      iconColor: row.icon_color as number | undefined,
      iconEmojiId: row.icon_emoji_id as string | undefined,
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close()
    console.log("[TopicStore] Database connection closed")
  }
}

/**
 * Create a topic store instance
 */
export function createTopicStore(databasePath: string): TopicStore {
  return new TopicStore(databasePath)
}
