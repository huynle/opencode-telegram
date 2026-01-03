/**
 * Port Pool Manager
 * 
 * Manages allocation and deallocation of ports for OpenCode instances.
 * Ensures no port conflicts and provides efficient port reuse.
 * 
 * Design decisions:
 * - Uses a Set for O(1) allocation checks
 * - Allocates from lowest available port for predictability
 * - Thread-safe through single-threaded JS execution
 * - No external dependencies for simplicity
 */

import type { PortPoolConfig, PortAllocation } from "../types/orchestrator"

export class PortPool {
  private startPort: number
  private poolSize: number
  private allocations: Map<number, PortAllocation> = new Map()
  
  constructor(config: PortPoolConfig) {
    this.startPort = config.startPort
    this.poolSize = config.poolSize
    
    console.log(`[PortPool] Initialized with ports ${this.startPort}-${this.startPort + this.poolSize - 1}`)
  }
  
  /**
   * Allocate the next available port for an instance
   * 
   * @param instanceId - ID of the instance requesting the port
   * @returns The allocated port, or null if no ports available
   */
  allocate(instanceId: string): number | null {
    // Find first available port (linear scan, but pool is small)
    for (let offset = 0; offset < this.poolSize; offset++) {
      const port = this.startPort + offset
      
      if (!this.allocations.has(port)) {
        const allocation: PortAllocation = {
          port,
          instanceId,
          allocatedAt: new Date(),
        }
        this.allocations.set(port, allocation)
        console.log(`[PortPool] Allocated port ${port} to instance ${instanceId}`)
        return port
      }
    }
    
    console.log(`[PortPool] No ports available (${this.allocations.size}/${this.poolSize} in use)`)
    return null
  }
  
  /**
   * Release a previously allocated port
   * 
   * @param port - Port number to release
   * @returns true if port was released, false if it wasn't allocated
   */
  release(port: number): boolean {
    const allocation = this.allocations.get(port)
    
    if (allocation) {
      this.allocations.delete(port)
      console.log(`[PortPool] Released port ${port} (was allocated to ${allocation.instanceId})`)
      return true
    }
    
    console.log(`[PortPool] Port ${port} was not allocated`)
    return false
  }
  
  /**
   * Release all ports allocated to a specific instance
   * Useful when an instance crashes and we need to clean up
   * 
   * @param instanceId - Instance ID to release ports for
   * @returns Number of ports released
   */
  releaseByInstance(instanceId: string): number {
    let released = 0
    
    for (const [port, allocation] of this.allocations) {
      if (allocation.instanceId === instanceId) {
        this.allocations.delete(port)
        released++
        console.log(`[PortPool] Released port ${port} for instance ${instanceId}`)
      }
    }
    
    return released
  }
  
  /**
   * Check if a specific port is available
   */
  isAvailable(port: number): boolean {
    if (port < this.startPort || port >= this.startPort + this.poolSize) {
      return false // Out of range
    }
    return !this.allocations.has(port)
  }
  
  /**
   * Get the instance ID for an allocated port
   */
  getInstanceForPort(port: number): string | null {
    return this.allocations.get(port)?.instanceId ?? null
  }
  
  /**
   * Get the port allocated to a specific instance
   */
  getPortForInstance(instanceId: string): number | null {
    for (const [port, allocation] of this.allocations) {
      if (allocation.instanceId === instanceId) {
        return port
      }
    }
    return null
  }
  
  /**
   * Reserve a specific port (used during state recovery)
   * 
   * @param port - Port to reserve
   * @param instanceId - Instance to reserve it for
   * @returns true if reserved, false if port not available
   */
  reserve(port: number, instanceId: string): boolean {
    if (port < this.startPort || port >= this.startPort + this.poolSize) {
      console.log(`[PortPool] Cannot reserve port ${port} - out of range`)
      return false
    }
    
    if (this.allocations.has(port)) {
      console.log(`[PortPool] Cannot reserve port ${port} - already allocated`)
      return false
    }
    
    this.allocations.set(port, {
      port,
      instanceId,
      allocatedAt: new Date(),
    })
    console.log(`[PortPool] Reserved port ${port} for instance ${instanceId}`)
    return true
  }
  
  /**
   * Get current allocation status
   */
  getStatus(): { allocated: number; available: number; total: number } {
    return {
      allocated: this.allocations.size,
      available: this.poolSize - this.allocations.size,
      total: this.poolSize,
    }
  }
  
  /**
   * Get all current allocations (for debugging/persistence)
   */
  getAllocations(): PortAllocation[] {
    return Array.from(this.allocations.values())
  }
  
  /**
   * Clear all allocations (used during shutdown or reset)
   */
  clear(): void {
    const count = this.allocations.size
    this.allocations.clear()
    console.log(`[PortPool] Cleared ${count} allocations`)
  }
}
