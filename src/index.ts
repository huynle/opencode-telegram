#!/usr/bin/env bun
/**
 * Telegram OpenCode Orchestrator
 * 
 * Main entry point for the Telegram bot that manages OpenCode instances
 * via forum topics in a Telegram supergroup.
 * 
 * Usage:
 *   bun run src/index.ts
 * 
 * Environment:
 *   See .env.example for required configuration
 */

import { loadConfig, validateConfig, printConfig } from "./config"
import { createIntegratedApp } from "./integration"

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("=".repeat(60))
  console.log("  Telegram OpenCode Orchestrator")
  console.log("=".repeat(60))

  // Load configuration
  let config
  try {
    config = loadConfig()
  } catch (error) {
    console.error("\n[Error] Failed to load configuration:")
    console.error(error instanceof Error ? error.message : String(error))
    console.error("\nMake sure you have set the required environment variables.")
    console.error("See .env.example for reference.")
    process.exit(1)
  }

  // Validate configuration
  const validation = validateConfig(config)
  if (!validation.valid) {
    console.error("\n[Error] Invalid configuration:")
    for (const error of validation.errors) {
      console.error(`  - ${error}`)
    }
    process.exit(1)
  }

  // Print configuration (with sensitive values masked)
  printConfig(config)

  // Ensure data directory exists
  try {
    await Bun.$`mkdir -p ./data`.quiet()
  } catch {
    // Ignore errors
  }

  // Create the integrated application
  let app: Awaited<ReturnType<typeof createIntegratedApp>> | undefined
  try {
    app = await createIntegratedApp(config)
  } catch (error) {
    console.error("\n[Error] Failed to initialize application:")
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  // Set up graceful shutdown
  let shuttingDown = false

  async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true

    console.log(`\n[${signal}] Shutting down gracefully...`)
    
    try {
      await app?.stop()
      console.log("[Shutdown] Complete")
      process.exit(0)
    } catch (error) {
      console.error("[Shutdown] Error:", error)
      process.exit(1)
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    console.error("[Fatal] Uncaught exception:", error)
    shutdown("uncaughtException")
  })

  process.on("unhandledRejection", (reason) => {
    console.error("[Fatal] Unhandled rejection:", reason)
    shutdown("unhandledRejection")
  })

  // Start the application
  try {
    console.log("\n[Starting] Initializing bot and orchestrator...")
    await app.start()
  } catch (error) {
    console.error("\n[Error] Failed to start application:")
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

// Run
main().catch((error) => {
  console.error("[Fatal]", error)
  process.exit(1)
})
