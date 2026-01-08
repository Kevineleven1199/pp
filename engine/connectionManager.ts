import { EventEmitter } from 'events'
import WebSocket from 'ws'
import Decimal from 'decimal.js'

// Connection states
export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'ERROR'

// Exponential backoff configuration
const INITIAL_RECONNECT_DELAY = 1000      // 1 second
const MAX_RECONNECT_DELAY = 60000         // 1 minute max
const RECONNECT_MULTIPLIER = 1.5
const MAX_RECONNECT_ATTEMPTS = 50         // Before giving up
const PING_INTERVAL = 30000               // 30 seconds
const PONG_TIMEOUT = 10000                // 10 seconds to receive pong

export interface ConnectionConfig {
  wsUrl: string
  name: string
  autoReconnect: boolean
  pingInterval?: number
  pongTimeout?: number
  maxReconnectAttempts?: number
}

export interface ConnectionStats {
  state: ConnectionState
  connectTime: number
  disconnectCount: number
  reconnectAttempts: number
  lastPingTime: number
  lastPongTime: number
  latencyMs: number
  messagesReceived: number
  messagesSent: number
  bytesReceived: number
  bytesSent: number
  errors: string[]
}

export class RobustWebSocket extends EventEmitter {
  private config: ConnectionConfig
  private ws: WebSocket | null = null
  private state: ConnectionState = 'DISCONNECTED'
  private reconnectAttempts = 0
  private reconnectDelay = INITIAL_RECONNECT_DELAY
  private reconnectTimeout: NodeJS.Timeout | null = null
  private pingInterval: NodeJS.Timeout | null = null
  private pongTimeout: NodeJS.Timeout | null = null
  private connectTime = 0
  private stats: ConnectionStats

  constructor(config: ConnectionConfig) {
    super()
    this.config = {
      pingInterval: PING_INTERVAL,
      pongTimeout: PONG_TIMEOUT,
      maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
      ...config
    }
    this.stats = this.initStats()
  }

  private initStats(): ConnectionStats {
    return {
      state: 'DISCONNECTED',
      connectTime: 0,
      disconnectCount: 0,
      reconnectAttempts: 0,
      lastPingTime: 0,
      lastPongTime: 0,
      latencyMs: 0,
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      errors: []
    }
  }

  connect(): void {
    if (this.state === 'CONNECTING' || this.state === 'CONNECTED') {
      return
    }

    this.setState('CONNECTING')
    console.log(`[${this.config.name}] Connecting to ${this.config.wsUrl}`)

    try {
      this.ws = new WebSocket(this.config.wsUrl)
      
      this.ws.on('open', () => this.handleOpen())
      this.ws.on('message', (data) => this.handleMessage(data))
      this.ws.on('close', (code, reason) => this.handleClose(code, reason.toString()))
      this.ws.on('error', (err) => this.handleError(err))
      this.ws.on('pong', () => this.handlePong())

    } catch (err: any) {
      this.handleError(err)
    }
  }

  private handleOpen(): void {
    console.log(`[${this.config.name}] Connected`)
    this.setState('CONNECTED')
    this.connectTime = Date.now()
    this.stats.connectTime = this.connectTime
    this.reconnectAttempts = 0
    this.reconnectDelay = INITIAL_RECONNECT_DELAY
    
    // Start ping/pong heartbeat
    this.startHeartbeat()
    
    this.emit('connected')
  }

  private handleMessage(data: WebSocket.RawData): void {
    this.stats.messagesReceived++
    this.stats.bytesReceived += data.toString().length

    try {
      const parsed = JSON.parse(data.toString())
      this.emit('message', parsed)
    } catch {
      this.emit('message', data.toString())
    }
  }

  private handleClose(code: number, reason: string): void {
    console.log(`[${this.config.name}] Disconnected: ${code} - ${reason}`)
    this.stats.disconnectCount++
    this.stopHeartbeat()
    
    if (this.config.autoReconnect && this.state !== 'DISCONNECTED') {
      this.scheduleReconnect()
    } else {
      this.setState('DISCONNECTED')
    }
    
    this.emit('disconnected', { code, reason })
  }

  private handleError(err: Error): void {
    console.error(`[${this.config.name}] Error:`, err.message)
    this.stats.errors.push(`${new Date().toISOString()}: ${err.message}`)
    
    // Keep only last 10 errors
    if (this.stats.errors.length > 10) {
      this.stats.errors = this.stats.errors.slice(-10)
    }
    
    this.emit('error', err)
  }

  private handlePong(): void {
    const now = Date.now()
    this.stats.lastPongTime = now
    this.stats.latencyMs = now - this.stats.lastPingTime
    
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout)
      this.pongTimeout = null
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.stats.lastPingTime = Date.now()
        this.ws.ping()
        
        // Set timeout for pong response
        this.pongTimeout = setTimeout(() => {
          console.warn(`[${this.config.name}] Pong timeout, reconnecting...`)
          this.ws?.terminate()
        }, this.config.pongTimeout)
      }
    }, this.config.pingInterval)
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout)
      this.pongTimeout = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts!) {
      console.error(`[${this.config.name}] Max reconnect attempts reached`)
      this.setState('ERROR')
      this.emit('maxReconnectReached')
      return
    }

    this.setState('RECONNECTING')
    this.reconnectAttempts++
    this.stats.reconnectAttempts = this.reconnectAttempts

    console.log(`[${this.config.name}] Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`)
    
    this.reconnectTimeout = setTimeout(() => {
      this.connect()
    }, this.reconnectDelay)

    // Exponential backoff
    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_MULTIPLIER,
      MAX_RECONNECT_DELAY
    )
  }

  private setState(state: ConnectionState): void {
    const oldState = this.state
    this.state = state
    this.stats.state = state
    
    if (oldState !== state) {
      this.emit('stateChange', { oldState, newState: state })
    }
  }

  send(data: any): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[${this.config.name}] Cannot send - not connected`)
      return false
    }

    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data)
      this.ws.send(payload)
      this.stats.messagesSent++
      this.stats.bytesSent += payload.length
      return true
    } catch (err: any) {
      console.error(`[${this.config.name}] Send error:`, err.message)
      return false
    }
  }

  disconnect(): void {
    this.config.autoReconnect = false
    this.stopHeartbeat()
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }

    this.setState('DISCONNECTED')
  }

  getStats(): ConnectionStats {
    return { ...this.stats }
  }

  isConnected(): boolean {
    return this.state === 'CONNECTED'
  }

  getState(): ConnectionState {
    return this.state
  }

  // Force reconnect (useful after network changes)
  forceReconnect(): void {
    console.log(`[${this.config.name}] Force reconnecting...`)
    this.reconnectAttempts = 0
    this.reconnectDelay = INITIAL_RECONNECT_DELAY
    
    if (this.ws) {
      this.ws.terminate()
    }
  }

  // Reset error state and try again
  resetAndReconnect(): void {
    this.reconnectAttempts = 0
    this.reconnectDelay = INITIAL_RECONNECT_DELAY
    this.stats.errors = []
    this.connect()
  }
}

// Multi-connection manager for handling multiple WebSocket connections
export class ConnectionManager extends EventEmitter {
  private connections: Map<string, RobustWebSocket> = new Map()
  private healthCheckInterval: NodeJS.Timeout | null = null

  constructor() {
    super()
  }

  addConnection(name: string, config: Omit<ConnectionConfig, 'name'>): RobustWebSocket {
    if (this.connections.has(name)) {
      throw new Error(`Connection ${name} already exists`)
    }

    const ws = new RobustWebSocket({ ...config, name })
    
    // Forward events
    ws.on('connected', () => this.emit('connected', name))
    ws.on('disconnected', (data) => this.emit('disconnected', name, data))
    ws.on('message', (msg) => this.emit('message', name, msg))
    ws.on('error', (err) => this.emit('error', name, err))
    ws.on('stateChange', (data) => this.emit('stateChange', name, data))
    ws.on('maxReconnectReached', () => this.emit('maxReconnectReached', name))

    this.connections.set(name, ws)
    return ws
  }

  getConnection(name: string): RobustWebSocket | undefined {
    return this.connections.get(name)
  }

  connectAll(): void {
    for (const ws of this.connections.values()) {
      ws.connect()
    }
  }

  disconnectAll(): void {
    for (const ws of this.connections.values()) {
      ws.disconnect()
    }
  }

  getAllStats(): Map<string, ConnectionStats> {
    const stats = new Map<string, ConnectionStats>()
    for (const [name, ws] of this.connections) {
      stats.set(name, ws.getStats())
    }
    return stats
  }

  isAllConnected(): boolean {
    for (const ws of this.connections.values()) {
      if (!ws.isConnected()) return false
    }
    return true
  }

  startHealthCheck(intervalMs: number = 60000): void {
    this.stopHealthCheck()
    
    this.healthCheckInterval = setInterval(() => {
      const unhealthy: string[] = []
      
      for (const [name, ws] of this.connections) {
        if (!ws.isConnected()) {
          unhealthy.push(name)
        }
      }

      this.emit('healthCheck', {
        healthy: unhealthy.length === 0,
        unhealthyConnections: unhealthy,
        stats: this.getAllStats()
      })
    }, intervalMs)
  }

  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
  }

  // Reconnect all unhealthy connections
  reconnectUnhealthy(): void {
    for (const ws of this.connections.values()) {
      if (!ws.isConnected()) {
        ws.resetAndReconnect()
      }
    }
  }
}

// Rate limiter for API calls
export class RateLimiter {
  private tokens: number
  private maxTokens: number
  private refillRate: number  // tokens per second
  private lastRefill: number
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
  private processing = false

  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens
    this.tokens = maxTokens
    this.refillRate = refillRate
    this.lastRefill = Date.now()
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    const newTokens = elapsed * this.refillRate
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens)
    this.lastRefill = now
  }

  async acquire(): Promise<void> {
    this.refill()
    
    if (this.tokens >= 1) {
      this.tokens -= 1
      return
    }

    // Wait for token
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject })
      this.processQueue()
    })
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return
    
    this.processing = true
    
    while (this.queue.length > 0) {
      this.refill()
      
      if (this.tokens >= 1) {
        this.tokens -= 1
        const { resolve } = this.queue.shift()!
        resolve()
      } else {
        // Wait for refill
        const waitTime = (1 - this.tokens) / this.refillRate * 1000
        await new Promise(r => setTimeout(r, Math.max(waitTime, 100)))
      }
    }
    
    this.processing = false
  }

  getAvailableTokens(): number {
    this.refill()
    return this.tokens
  }
}

// Retry helper with exponential backoff
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number
    initialDelay?: number
    maxDelay?: number
    multiplier?: number
    shouldRetry?: (error: any) => boolean
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    multiplier = 2,
    shouldRetry = () => true
  } = options

  let lastError: any
  let delay = initialDelay

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      
      if (attempt === maxRetries || !shouldRetry(err)) {
        throw err
      }

      console.log(`Retry attempt ${attempt + 1}/${maxRetries} in ${delay}ms`)
      await new Promise(r => setTimeout(r, delay))
      delay = Math.min(delay * multiplier, maxDelay)
    }
  }

  throw lastError
}

// Health monitor for the entire trading system
export class SystemHealthMonitor extends EventEmitter {
  private components: Map<string, { healthy: boolean; lastCheck: number; error?: string }> = new Map()
  private checkInterval: NodeJS.Timeout | null = null

  registerComponent(name: string): void {
    this.components.set(name, { healthy: false, lastCheck: 0 })
  }

  updateHealth(name: string, healthy: boolean, error?: string): void {
    this.components.set(name, { healthy, lastCheck: Date.now(), error })
    this.emit('componentUpdate', { name, healthy, error })
  }

  isSystemHealthy(): boolean {
    for (const component of this.components.values()) {
      if (!component.healthy) return false
    }
    return true
  }

  getStatus(): Map<string, { healthy: boolean; lastCheck: number; error?: string }> {
    return new Map(this.components)
  }

  startMonitoring(intervalMs: number = 30000): void {
    this.stopMonitoring()
    
    this.checkInterval = setInterval(() => {
      const status = this.getStatus()
      const healthy = this.isSystemHealthy()
      
      this.emit('healthCheck', { healthy, components: status })
      
      // Check for stale components (not updated in 2 minutes)
      const now = Date.now()
      for (const [name, comp] of status) {
        if (now - comp.lastCheck > 120000) {
          this.updateHealth(name, false, 'Component not responding')
        }
      }
    }, intervalMs)
  }

  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
  }
}
