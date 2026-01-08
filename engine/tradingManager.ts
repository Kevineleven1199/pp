import * as fs from 'fs'
import * as path from 'path'
import { EventEmitter } from 'events'
import Decimal from 'decimal.js'
import { AsterDEXTrader, AsterDEXConfig, AsterDEXPosition, PyramidSignal, TradeExecution, RiskMetrics } from './asterDexTrader'

const DATA_DIR = path.join(process.env.HOME || '', '.price-perfect')
const STATE_FILE = path.join(DATA_DIR, 'trader-state.json')
const TRADE_LOG_FILE = path.join(DATA_DIR, 'trade-log.jsonl')
const DAILY_STATS_FILE = path.join(DATA_DIR, 'daily-stats.json')

// Funding rate fetched every 8 hours on AsterDEX
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000

export interface TradingConfig extends AsterDEXConfig {
  // Circuit Breaker Settings
  maxDailyLoss: number          // Max daily loss in USD before stopping
  maxDrawdownPercent: number    // Max drawdown % before emergency stop
  maxConsecutiveLosses: number  // Stop after N consecutive losses
  maxPositionSize: number       // Max position size in USD
  
  // Health Settings
  heartbeatIntervalMs: number   // Health check interval
  maxLatencyMs: number          // Max acceptable API latency
  reconnectDelayMs: number      // Delay before reconnect attempts
  
  // Trading Hours (optional)
  tradingHoursEnabled: boolean
  tradingStartHour: number      // UTC hour to start (0-23)
  tradingEndHour: number        // UTC hour to stop (0-23)
  
  // Funding Awareness
  avoidFundingWindow: boolean   // Avoid trading near funding
  fundingWindowMinutes: number  // Minutes before/after funding to avoid
}

export interface DailyStats {
  date: string
  startingBalance: Decimal
  endingBalance: Decimal
  realizedPnl: Decimal
  unrealizedPnl: Decimal
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number
  largestWin: Decimal
  largestLoss: Decimal
  maxDrawdown: Decimal
  fundingPaid: Decimal
  commissionPaid: Decimal
  sharpeRatio: number
}

export interface TraderState {
  lastSaveTime: number
  isRunning: boolean
  currentPosition: AsterDEXPosition | null
  pendingSignal: PyramidSignal | null
  dailyStats: DailyStats
  consecutiveLosses: number
  highWaterMark: Decimal
  circuitBreakerTriggered: boolean
  circuitBreakerReason: string | null
  lastFundingRate: number
  nextFundingTime: number
  totalSessionPnl: Decimal
  sessionStartTime: number
}

export interface HealthStatus {
  isHealthy: boolean
  lastHeartbeat: number
  apiLatencyMs: number
  wsConnected: boolean
  userStreamConnected: boolean
  positionSynced: boolean
  errorCount: number
  lastError: string | null
  uptime: number
}

const DEFAULT_CONFIG: Partial<TradingConfig> = {
  maxDailyLoss: 500,
  maxDrawdownPercent: 10,
  maxConsecutiveLosses: 5,
  maxPositionSize: 10000,
  heartbeatIntervalMs: 30000,
  maxLatencyMs: 1000,
  reconnectDelayMs: 5000,
  tradingHoursEnabled: false,
  tradingStartHour: 0,
  tradingEndHour: 24,
  avoidFundingWindow: true,
  fundingWindowMinutes: 5
}

export class TradingManager extends EventEmitter {
  private config: TradingConfig
  private trader: AsterDEXTrader
  private state: TraderState
  private health: HealthStatus
  private heartbeatInterval: NodeJS.Timeout | null = null
  private fundingInterval: NodeJS.Timeout | null = null
  private autoSaveInterval: NodeJS.Timeout | null = null
  private watchdogInterval: NodeJS.Timeout | null = null
  private isShuttingDown = false
  private startTime: number = 0

  constructor(config: Partial<TradingConfig>) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config } as TradingConfig
    this.trader = new AsterDEXTrader(this.config)
    this.state = this.loadState()
    this.health = this.initHealth()
    this.setupEventHandlers()
    this.ensureDataDir()
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }
  }

  private initHealth(): HealthStatus {
    return {
      isHealthy: false,
      lastHeartbeat: 0,
      apiLatencyMs: 0,
      wsConnected: false,
      userStreamConnected: false,
      positionSynced: false,
      errorCount: 0,
      lastError: null,
      uptime: 0
    }
  }

  private initDailyStats(): DailyStats {
    return {
      date: new Date().toISOString().split('T')[0],
      startingBalance: new Decimal(0),
      endingBalance: new Decimal(0),
      realizedPnl: new Decimal(0),
      unrealizedPnl: new Decimal(0),
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      largestWin: new Decimal(0),
      largestLoss: new Decimal(0),
      maxDrawdown: new Decimal(0),
      fundingPaid: new Decimal(0),
      commissionPaid: new Decimal(0),
      sharpeRatio: 0
    }
  }

  private loadState(): TraderState {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
        console.log('[TradingManager] Restored state from disk')
        
        // Convert Decimal strings back to Decimal objects
        return {
          ...data,
          highWaterMark: new Decimal(data.highWaterMark || 0),
          totalSessionPnl: new Decimal(data.totalSessionPnl || 0),
          dailyStats: {
            ...data.dailyStats,
            startingBalance: new Decimal(data.dailyStats?.startingBalance || 0),
            endingBalance: new Decimal(data.dailyStats?.endingBalance || 0),
            realizedPnl: new Decimal(data.dailyStats?.realizedPnl || 0),
            unrealizedPnl: new Decimal(data.dailyStats?.unrealizedPnl || 0),
            largestWin: new Decimal(data.dailyStats?.largestWin || 0),
            largestLoss: new Decimal(data.dailyStats?.largestLoss || 0),
            maxDrawdown: new Decimal(data.dailyStats?.maxDrawdown || 0),
            fundingPaid: new Decimal(data.dailyStats?.fundingPaid || 0),
            commissionPaid: new Decimal(data.dailyStats?.commissionPaid || 0)
          }
        }
      }
    } catch (err) {
      console.error('[TradingManager] Failed to load state:', err)
    }

    // Return fresh state
    return {
      lastSaveTime: Date.now(),
      isRunning: false,
      currentPosition: null,
      pendingSignal: null,
      dailyStats: this.initDailyStats(),
      consecutiveLosses: 0,
      highWaterMark: new Decimal(0),
      circuitBreakerTriggered: false,
      circuitBreakerReason: null,
      lastFundingRate: 0,
      nextFundingTime: 0,
      totalSessionPnl: new Decimal(0),
      sessionStartTime: Date.now()
    }
  }

  private saveState(): void {
    try {
      this.state.lastSaveTime = Date.now()
      
      // Convert Decimals to strings for JSON serialization
      const serializable = {
        ...this.state,
        highWaterMark: this.state.highWaterMark.toString(),
        totalSessionPnl: this.state.totalSessionPnl.toString(),
        dailyStats: {
          ...this.state.dailyStats,
          startingBalance: this.state.dailyStats.startingBalance.toString(),
          endingBalance: this.state.dailyStats.endingBalance.toString(),
          realizedPnl: this.state.dailyStats.realizedPnl.toString(),
          unrealizedPnl: this.state.dailyStats.unrealizedPnl.toString(),
          largestWin: this.state.dailyStats.largestWin.toString(),
          largestLoss: this.state.dailyStats.largestLoss.toString(),
          maxDrawdown: this.state.dailyStats.maxDrawdown.toString(),
          fundingPaid: this.state.dailyStats.fundingPaid.toString(),
          commissionPaid: this.state.dailyStats.commissionPaid.toString()
        }
      }
      
      fs.writeFileSync(STATE_FILE, JSON.stringify(serializable, null, 2))
    } catch (err) {
      console.error('[TradingManager] Failed to save state:', err)
    }
  }

  private setupEventHandlers(): void {
    // Handle trade executions
    this.trader.on('execution', (exec: TradeExecution) => {
      this.handleExecution(exec)
    })

    // Handle position updates
    this.trader.on('positionUpdate', (pos: AsterDEXPosition | null) => {
      this.state.currentPosition = pos
      this.health.positionSynced = true
      this.emit('positionUpdate', pos)
    })

    // Handle risk updates
    this.trader.on('riskUpdate', (risk: RiskMetrics) => {
      this.checkCircuitBreakers(risk)
      this.emit('riskUpdate', risk)
    })

    // Handle margin calls
    this.trader.on('marginCall', (event: any) => {
      this.triggerCircuitBreaker('MARGIN_CALL', 'Margin call received from exchange')
    })

    // Handle API calls for latency tracking
    this.trader.on('apiCall', (data: { latency: number; success: boolean; error?: string }) => {
      this.health.apiLatencyMs = data.latency
      if (!data.success) {
        this.health.errorCount++
        this.health.lastError = data.error || 'Unknown error'
      }
      if (data.latency > this.config.maxLatencyMs) {
        console.warn(`[TradingManager] High latency detected: ${data.latency}ms`)
      }
    })

    // Handle state changes
    this.trader.on('stateChange', ({ oldState, newState }) => {
      console.log(`[TradingManager] Trader state: ${oldState} → ${newState}`)
      this.health.wsConnected = newState === 'CONNECTED' || newState === 'TRADING'
      this.emit('traderStateChange', { oldState, newState })
    })
  }

  private handleExecution(exec: TradeExecution): void {
    // Log trade to file
    this.logTrade(exec)

    // Update daily stats
    if (exec.status === 'filled') {
      this.state.dailyStats.totalTrades++
      this.state.dailyStats.commissionPaid = this.state.dailyStats.commissionPaid.plus(exec.commission)

      if (!exec.realizedPnl.isZero()) {
        this.state.dailyStats.realizedPnl = this.state.dailyStats.realizedPnl.plus(exec.realizedPnl)
        this.state.totalSessionPnl = this.state.totalSessionPnl.plus(exec.realizedPnl)

        if (exec.realizedPnl.gt(0)) {
          this.state.dailyStats.winningTrades++
          this.state.consecutiveLosses = 0
          if (exec.realizedPnl.gt(this.state.dailyStats.largestWin)) {
            this.state.dailyStats.largestWin = exec.realizedPnl
          }
        } else {
          this.state.dailyStats.losingTrades++
          this.state.consecutiveLosses++
          if (exec.realizedPnl.lt(this.state.dailyStats.largestLoss)) {
            this.state.dailyStats.largestLoss = exec.realizedPnl
          }
        }

        // Update win rate
        if (this.state.dailyStats.totalTrades > 0) {
          this.state.dailyStats.winRate = 
            this.state.dailyStats.winningTrades / this.state.dailyStats.totalTrades
        }

        // Check consecutive losses circuit breaker
        if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
          this.triggerCircuitBreaker(
            'CONSECUTIVE_LOSSES',
            `${this.state.consecutiveLosses} consecutive losses`
          )
        }
      }
    }

    this.emit('execution', exec)
    this.saveState()
  }

  private logTrade(exec: TradeExecution): void {
    try {
      const logEntry = {
        ...exec,
        price: exec.price.toString(),
        quantity: exec.quantity.toString(),
        executedQty: exec.executedQty.toString(),
        avgPrice: exec.avgPrice.toString(),
        commission: exec.commission.toString(),
        realizedPnl: exec.realizedPnl.toString()
      }
      fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify(logEntry) + '\n')
    } catch (err) {
      console.error('[TradingManager] Failed to log trade:', err)
    }
  }

  private checkCircuitBreakers(risk: RiskMetrics): void {
    if (this.state.circuitBreakerTriggered) return

    // Check daily loss limit
    const dailyLoss = this.state.dailyStats.realizedPnl.neg()
    if (dailyLoss.gt(this.config.maxDailyLoss)) {
      this.triggerCircuitBreaker('DAILY_LOSS', `Daily loss $${dailyLoss.toFixed(2)} exceeds limit $${this.config.maxDailyLoss}`)
      return
    }

    // Check drawdown
    if (risk.currentDrawdown.gt(this.config.maxDrawdownPercent)) {
      this.triggerCircuitBreaker('DRAWDOWN', `Drawdown ${risk.currentDrawdown.toFixed(2)}% exceeds limit ${this.config.maxDrawdownPercent}%`)
      return
    }

    // Check liquidation risk
    if (risk.liquidationRisk === 'CRITICAL') {
      this.triggerCircuitBreaker('LIQUIDATION_RISK', 'Critical liquidation risk detected')
      return
    }
  }

  private async triggerCircuitBreaker(reason: string, message: string): Promise<void> {
    console.error(`[TradingManager] 🚨 CIRCUIT BREAKER: ${reason} - ${message}`)
    
    this.state.circuitBreakerTriggered = true
    this.state.circuitBreakerReason = message
    this.state.isRunning = false

    // Emergency close all positions
    try {
      await this.trader.cancelAllOrders()
      await this.trader.closePosition()
    } catch (err) {
      console.error('[TradingManager] Failed to close position on circuit breaker:', err)
    }

    this.emit('circuitBreaker', { reason, message })
    this.saveState()
  }

  // Funding Rate Tracking
  private async fetchFundingRate(): Promise<void> {
    try {
      const response = await fetch('https://fapi.asterdex.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=1')
      const data = await response.json() as any[]
      
      if (data && data[0]) {
        this.state.lastFundingRate = parseFloat(data[0].fundingRate)
        this.state.nextFundingTime = data[0].fundingTime
        
        console.log(`[TradingManager] Funding rate: ${(this.state.lastFundingRate * 100).toFixed(4)}%`)
        this.emit('fundingUpdate', {
          rate: this.state.lastFundingRate,
          nextTime: this.state.nextFundingTime
        })
      }
    } catch (err) {
      console.error('[TradingManager] Failed to fetch funding rate:', err)
    }
  }

  private isInFundingWindow(): boolean {
    if (!this.config.avoidFundingWindow) return false
    
    const now = Date.now()
    const windowMs = this.config.fundingWindowMinutes * 60 * 1000
    const distToFunding = this.state.nextFundingTime - now
    
    return distToFunding > 0 && distToFunding < windowMs
  }

  // Trading Hours Check
  private isWithinTradingHours(): boolean {
    if (!this.config.tradingHoursEnabled) return true
    
    const hour = new Date().getUTCHours()
    if (this.config.tradingStartHour < this.config.tradingEndHour) {
      return hour >= this.config.tradingStartHour && hour < this.config.tradingEndHour
    } else {
      // Wraps around midnight
      return hour >= this.config.tradingStartHour || hour < this.config.tradingEndHour
    }
  }

  // Health Check / Heartbeat
  private async performHealthCheck(): Promise<void> {
    const now = Date.now()
    this.health.lastHeartbeat = now
    this.health.uptime = now - this.startTime

    // Check trader connection
    const traderStatus = this.trader.getStatus()
    this.health.wsConnected = traderStatus.state === 'CONNECTED' || traderStatus.state === 'TRADING'

    // Determine overall health
    this.health.isHealthy = 
      this.health.wsConnected &&
      this.health.apiLatencyMs < this.config.maxLatencyMs &&
      this.health.errorCount < 10 &&
      !this.state.circuitBreakerTriggered

    this.emit('healthCheck', this.health)
  }

  // Watchdog - detect if system is stuck
  private watchdogCheck(): void {
    const now = Date.now()
    const timeSinceHeartbeat = now - this.health.lastHeartbeat

    if (timeSinceHeartbeat > this.config.heartbeatIntervalMs * 3) {
      console.error('[TradingManager] ⚠️ WATCHDOG: System appears stuck!')
      this.emit('watchdogAlert', { timeSinceHeartbeat })
    }
  }

  // Signal Processing with Safety Checks
  async processSignal(signal: PyramidSignal): Promise<boolean> {
    // Safety checks
    if (!this.state.isRunning) {
      console.log('[TradingManager] Signal ignored - trading stopped')
      return false
    }

    if (this.state.circuitBreakerTriggered) {
      console.log('[TradingManager] Signal ignored - circuit breaker active')
      return false
    }

    if (!this.isWithinTradingHours()) {
      console.log('[TradingManager] Signal ignored - outside trading hours')
      return false
    }

    if (this.isInFundingWindow()) {
      console.log('[TradingManager] Signal ignored - within funding window')
      return false
    }

    // Check position size limit
    const positionValue = signal.quantity.mul(signal.price)
    if (positionValue.gt(this.config.maxPositionSize)) {
      console.warn(`[TradingManager] Signal rejected - position size $${positionValue.toFixed(2)} exceeds limit`)
      return false
    }

    // Store pending signal
    this.state.pendingSignal = signal
    this.saveState()

    // Execute signal
    const success = await this.trader.executeSignal(signal)
    
    this.state.pendingSignal = null
    this.saveState()

    return success
  }

  // Reset Circuit Breaker (manual)
  resetCircuitBreaker(): void {
    this.state.circuitBreakerTriggered = false
    this.state.circuitBreakerReason = null
    this.state.consecutiveLosses = 0
    this.saveState()
    console.log('[TradingManager] Circuit breaker reset')
    this.emit('circuitBreakerReset')
  }

  // Reset Daily Stats (call at midnight UTC)
  resetDailyStats(): void {
    // Save previous day stats
    this.saveDailyStats()
    
    // Reset for new day
    this.state.dailyStats = this.initDailyStats()
    this.saveState()
    console.log('[TradingManager] Daily stats reset')
  }

  private saveDailyStats(): void {
    try {
      let allStats: DailyStats[] = []
      if (fs.existsSync(DAILY_STATS_FILE)) {
        allStats = JSON.parse(fs.readFileSync(DAILY_STATS_FILE, 'utf-8'))
      }
      
      const serializable = {
        ...this.state.dailyStats,
        startingBalance: this.state.dailyStats.startingBalance.toString(),
        endingBalance: this.state.dailyStats.endingBalance.toString(),
        realizedPnl: this.state.dailyStats.realizedPnl.toString(),
        unrealizedPnl: this.state.dailyStats.unrealizedPnl.toString(),
        largestWin: this.state.dailyStats.largestWin.toString(),
        largestLoss: this.state.dailyStats.largestLoss.toString(),
        maxDrawdown: this.state.dailyStats.maxDrawdown.toString(),
        fundingPaid: this.state.dailyStats.fundingPaid.toString(),
        commissionPaid: this.state.dailyStats.commissionPaid.toString()
      }
      
      allStats.push(serializable as any)
      fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(allStats, null, 2))
    } catch (err) {
      console.error('[TradingManager] Failed to save daily stats:', err)
    }
  }

  // Emergency Stop - Close everything immediately
  async emergencyStop(): Promise<void> {
    console.warn('[TradingManager] 🛑 EMERGENCY STOP TRIGGERED')
    
    this.isShuttingDown = true
    this.state.isRunning = false

    try {
      await this.trader.cancelAllOrders()
      await this.trader.closePosition()
    } catch (err) {
      console.error('[TradingManager] Emergency stop error:', err)
    }

    this.emit('emergencyStop')
    this.saveState()
  }

  // Getters
  getState(): TraderState { return this.state }
  getHealth(): HealthStatus { return this.health }
  getDailyStats(): DailyStats { return this.state.dailyStats }
  isRunning(): boolean { return this.state.isRunning }
  isCircuitBreakerActive(): boolean { return this.state.circuitBreakerTriggered }

  getFullStatus() {
    return {
      state: this.state,
      health: this.health,
      traderStatus: this.trader.getStatus(),
      config: {
        maxDailyLoss: this.config.maxDailyLoss,
        maxDrawdownPercent: this.config.maxDrawdownPercent,
        maxConsecutiveLosses: this.config.maxConsecutiveLosses,
        tradingHoursEnabled: this.config.tradingHoursEnabled,
        avoidFundingWindow: this.config.avoidFundingWindow
      }
    }
  }

  // Lifecycle
  async start(): Promise<boolean> {
    if (this.state.circuitBreakerTriggered) {
      console.error('[TradingManager] Cannot start - circuit breaker active. Call resetCircuitBreaker() first.')
      return false
    }

    console.log('[TradingManager] Starting 24/7 trading manager...')
    this.startTime = Date.now()
    this.state.sessionStartTime = this.startTime

    // Initialize trader
    const success = await this.trader.start()
    if (!success) {
      console.error('[TradingManager] Failed to start trader')
      return false
    }

    this.state.isRunning = true

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.performHealthCheck()
    }, this.config.heartbeatIntervalMs)

    // Start funding rate tracker
    await this.fetchFundingRate()
    this.fundingInterval = setInterval(() => {
      this.fetchFundingRate()
    }, 60 * 60 * 1000) // Check every hour

    // Start auto-save
    this.autoSaveInterval = setInterval(() => {
      this.saveState()
    }, 60 * 1000) // Save every minute

    // Start watchdog
    this.watchdogInterval = setInterval(() => {
      this.watchdogCheck()
    }, this.config.heartbeatIntervalMs * 2)

    // Check for day rollover
    this.scheduleDayRollover()

    this.saveState()
    console.log('[TradingManager] ✅ Trading manager started')
    this.emit('started')
    return true
  }

  private scheduleDayRollover(): void {
    const now = new Date()
    const tomorrow = new Date(now)
    tomorrow.setUTCHours(0, 0, 0, 0)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    
    const msUntilMidnight = tomorrow.getTime() - now.getTime()
    
    setTimeout(() => {
      this.resetDailyStats()
      this.scheduleDayRollover() // Schedule next rollover
    }, msUntilMidnight)
  }

  async stop(): Promise<void> {
    console.log('[TradingManager] Stopping trading manager...')
    this.isShuttingDown = true
    this.state.isRunning = false

    // Clear intervals
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
    if (this.fundingInterval) clearInterval(this.fundingInterval)
    if (this.autoSaveInterval) clearInterval(this.autoSaveInterval)
    if (this.watchdogInterval) clearInterval(this.watchdogInterval)

    // Stop trader
    await this.trader.stop()

    // Save final state
    this.saveState()
    this.saveDailyStats()

    console.log('[TradingManager] Trading manager stopped')
    this.emit('stopped')
  }

  // Graceful shutdown handler
  async gracefulShutdown(signal: string): Promise<void> {
    console.log(`[TradingManager] Received ${signal}, initiating graceful shutdown...`)
    
    // If we have a position, close it
    if (this.state.currentPosition) {
      console.log('[TradingManager] Closing open position before shutdown...')
      await this.trader.closePosition()
    }

    await this.stop()
    process.exit(0)
  }
}

export function createTradingManager(config: Partial<TradingConfig>): TradingManager {
  const manager = new TradingManager(config)
  
  // Register shutdown handlers
  process.on('SIGINT', () => manager.gracefulShutdown('SIGINT'))
  process.on('SIGTERM', () => manager.gracefulShutdown('SIGTERM'))
  
  return manager
}
