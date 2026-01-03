/**
 * OpenCode Multi-Instance Orchestrator
 * 
 * Main entry point for the orchestrator module.
 * Exports all components needed to manage multiple OpenCode instances.
 * 
 * ## Architecture
 * 
 * ```
 * Telegram Forum Topics     Orchestrator Manager      OpenCode Instances
 * ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
 * │ Topic 1 (Port)   │────▶│                  │────▶│ Instance 1:4100  │
 * │ Topic 2 (Auth)   │────▶│  InstanceManager │────▶│ Instance 2:4101  │
 * │ Topic 3 (Perf)   │────▶│                  │────▶│ Instance 3:4102  │
 * └──────────────────┘     └──────────────────┘     └──────────────────┘
 *                                  │
 *                                  ▼
 *                          ┌──────────────────┐
 *                          │   SQLite State   │
 *                          │   (persistence)  │
 *                          └──────────────────┘
 * ```
 * 
 * ## Quick Start
 * 
 * ```typescript
 * import { InstanceManager } from "./orchestrator"
 * 
 * // Create manager with custom config
 * const manager = new InstanceManager({
 *   maxInstances: 5,
 *   defaultIdleTimeoutMs: 15 * 60 * 1000, // 15 min
 * })
 * 
 * // Listen to events
 * manager.on((event) => {
 *   console.log("Event:", event)
 * })
 * 
 * // Get or create instance for a topic
 * const instance = await manager.getOrCreateInstance(
 *   12345,              // topicId
 *   "/path/to/project", // workDir
 *   { name: "My Topic" }
 * )
 * 
 * if (instance) {
 *   console.log(`Instance ready on port ${instance.port}`)
 *   // Use instance.port to connect OpenCodeClient
 * }
 * 
 * // Graceful shutdown
 * await manager.shutdown()
 * ```
 */

export { InstanceManager, DEFAULT_MANAGER_CONFIG } from "./manager"
export { OpenCodeInstance } from "./instance"
export { PortPool } from "./port-pool"
export { StateStore } from "./state-store"

// Re-export types
export type {
  InstanceConfig,
  InstanceInfo,
  InstanceState,
  ManagedInstance,
  ManagerConfig,
  OrchestratorEvent,
  EventCallback,
  PortPoolConfig,
  PortAllocation,
  HealthCheckResult,
  PersistedInstanceState,
  PersistedPortAllocation,
} from "../types/orchestrator"

// =============================================================================
// Integration Example: Using with Forum Topics and Telegram
// =============================================================================

/**
 * Example integration showing how to use the orchestrator with
 * Telegram forum topics and OpenCode clients.
 * 
 * This demonstrates:
 * 1. Creating a manager
 * 2. Routing forum messages to instances
 * 3. Handling SSE events and sending responses back
 * 4. Graceful shutdown
 * 
 * @example
 * ```typescript
 * // In your Telegram bot handler:
 * 
 * import { InstanceManager, type OrchestratorEvent } from "./orchestrator"
 * import { TelegramClient } from "./telegram-api"
 * 
 * // Configuration from environment
 * const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || "/home/user/projects"
 * 
 * // Initialize components
 * const telegram = new TelegramClient({
 *   botToken: process.env.TELEGRAM_BOT_TOKEN!,
 *   chatId: process.env.TELEGRAM_CHAT_ID!,
 * })
 * 
 * const manager = new InstanceManager({
 *   maxInstances: 10,
 *   defaultIdleTimeoutMs: 30 * 60 * 1000,
 *   statePath: "./data/orchestrator.db",
 * })
 * 
 * // Handle orchestrator events
 * manager.on((event: OrchestratorEvent) => {
 *   switch (event.type) {
 *     case "instance:ready":
 *       console.log(`Instance ${event.instanceId} ready on port ${event.port}`)
 *       // Start SSE subscription here
 *       subscribeToInstance(event.instanceId, event.port)
 *       break
 *       
 *     case "instance:crashed":
 *       console.log(`Instance ${event.instanceId} crashed: ${event.error}`)
 *       if (event.willRestart) {
 *         telegram.sendMessage({
 *           text: `Instance crashed, restarting...`,
 *           chatId: getTopicChatId(event.instanceId),
 *         })
 *       }
 *       break
 *       
 *     case "instance:idle-timeout":
 *       console.log(`Instance ${event.instanceId} stopped due to inactivity`)
 *       break
 *   }
 * })
 * 
 * // Handle incoming Telegram forum messages
 * async function handleForumMessage(
 *   chatId: number,
 *   topicId: number,
 *   topicName: string,
 *   messageText: string
 * ) {
 *   // Determine project path from topic (could use topic name, metadata, etc.)
 *   const projectPath = `${PROJECT_BASE_PATH}/${topicName}`
 *   
 *   // Get or create instance for this topic
 *   const instance = await manager.getOrCreateInstance(topicId, projectPath, {
 *     name: topicName,
 *   })
 *   
 *   if (!instance) {
 *     await telegram.sendMessage({
 *       text: "Failed to start OpenCode instance. Please try again.",
 *       chatId: String(chatId),
 *       messageThreadId: topicId,
 *     })
 *     return
 *   }
 *   
 *   // Record activity to reset idle timer
 *   manager.recordActivity(instance.config.instanceId)
 *   
 *   // Send message to OpenCode via REST API
 *   const response = await fetch(`http://localhost:${instance.port}/session/${instance.sessionId}/message`, {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify({ content: messageText }),
 *   })
 *   
 *   if (!response.ok) {
 *     await telegram.sendMessage({
 *       text: `Error sending message: ${response.statusText}`,
 *       chatId: String(chatId),
 *       messageThreadId: topicId,
 *     })
 *   }
 * }
 * 
 * // Subscribe to SSE events from an instance
 * async function subscribeToInstance(instanceId: string, port: number) {
 *   const instance = manager.getInstance(instanceId)
 *   if (!instance?.sessionId) return
 *   
 *   const url = `http://localhost:${port}/session/${instance.sessionId}/events`
 *   
 *   const response = await fetch(url)
 *   if (!response.ok || !response.body) return
 *   
 *   const reader = response.body.getReader()
 *   const decoder = new TextDecoder()
 *   
 *   while (true) {
 *     const { done, value } = await reader.read()
 *     if (done) break
 *     
 *     const text = decoder.decode(value)
 *     // Parse SSE events and forward to Telegram
 *     for (const line of text.split("\n")) {
 *       if (line.startsWith("data: ")) {
 *         const data = JSON.parse(line.slice(6))
 *         await handleSSEEvent(instanceId, data)
 *       }
 *     }
 *   }
 * }
 * 
 * // Handle SSE events and forward to Telegram
 * async function handleSSEEvent(instanceId: string, event: any) {
 *   const instance = manager.getInstance(instanceId)
 *   if (!instance) return
 *   
 *   // Record activity
 *   manager.recordActivity(instanceId)
 *   
 *   // Get topic info from instance
 *   const topicId = instance.config.topicId
 *   const chatId = process.env.TELEGRAM_CHAT_ID!
 *   
 *   switch (event.type) {
 *     case "message":
 *       // Forward assistant message to Telegram topic
 *       if (event.role === "assistant") {
 *         await telegram.sendMessage({
 *           text: event.content,
 *           chatId,
 *           messageThreadId: topicId,
 *         })
 *       }
 *       break
 *       
 *     case "tool":
 *       // Optionally notify about tool usage
 *       await telegram.sendMessage({
 *         text: `Using tool: ${event.toolName}`,
 *         chatId,
 *         messageThreadId: topicId,
 *         disableNotification: true,
 *       })
 *       break
 *   }
 * }
 * 
 * // Graceful shutdown
 * process.on("SIGINT", async () => {
 *   console.log("Shutting down...")
 *   await manager.shutdown()
 *   process.exit(0)
 * })
 * ```
 */
export function _integrationExampleDocs() {
  // This function exists only for documentation purposes
  // The actual integration code is in the JSDoc above
}
