import * as fs from 'fs'
import * as path from 'path'
import { EventEmitter } from 'events'
import Decimal from 'decimal.js'
import * as crypto from 'crypto'
import { RobustWebSocket, ConnectionManager, RateLimiter, retryWithBackoff, SystemHealthMonitor } from './connectionManager'
import { PyramidStrategyEngine, ConfluenceSignal, PyramidPosition } from './pyramidStrategy'

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN })

// AsterDEX Configuration
const ASTER_API_BASE = 'https://fapi.asterdex.com'
const ASTER_WS_BASE = 'wss://fstream.asterdex.com'
const SYMBOL = 'ETHUSDT'
const MAX_LEVERAGE = 88
const RECV_WINDOW = 5000

// Data directories
const DATA_DIR = path.join(process.env.HOME || '', '.price-perfect')
const STATE_FILE = path.join(DATA_DIR, 'live-trader-state.json')
const TRADE_LOG_FILE = path.join(DATA_DIR, 'trades.jsonl')
const PERFORMANCE_FILE = path.join(DATA_DIR, 'performance.json')

export interface LiveTraderConfig {
  apiKey: string
  apiSecret: string
  testnet: boolean
  
  // Strategy Settings
  maxPyramidLevels: number
  minConfluenceToEnter: number
  minConfluenceToAdd: number
  enableHedgeMode: boolean
  
  // Risk Settings  
  initialMarginPercent: number    // 8% default
  maxMarginPercent: number        // 80% default
  maxConsecutiveLosses: number
  cooldownMinutes: number
  
  // 24/7 Settings
  enableAutoTrading: boolean
  avoidFundingWindow: boolean
  fundingWindowMinutes: number
}

interface AccountInfo {
  marginBalance: Decimal
  availableBalance: Decimal
  totalUnrealizedProfit: Decimal
  totalPositionInitialMargin: Decimal
}

interface PositionInfo {
  symbol: string
  positionSide: 'LONG' | 'SHORT' | 'BOTH'
  positionAmt: Decimal
  entryPrice: Decimal
  markPrice: Decimal
  unrealizedProfit: Decimal
  liquidationPrice: Decimal
  leverage: number
  marginType: 'isolated' | 'cross'
}

interface OrderResult {
  orderId: string
  clientOrderId: string
  status: string
  executedQty: Decimal
  avgPrice: Decimal
  side: string
  type: string
}

interface TradeRecord {
  id: string
  timestamp: number
  action: string
  side: 'long' | 'short'
  quantity: Decimal
  price: Decimal
  notionalValue: Decimal
  marginUsed: Decimal
  pyramidLevel: number
  confluenceScore: number
  factors: string[]
  orderId: string
  status: 'pending' | 'filled' | 'failed'
  pnl?: Decimal
  commission?: Decimal
  error?: string
}

interface PerformanceStats {
  startTime: number
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number
  totalPnl: Decimal
  totalCommissions: Decimal
  totalFundingPaid: Decimal
  largestWin: Decimal
  largestLoss: Decimal
  maxDrawdown: Decimal
  currentStreak: number
  longestWinStreak: number
  longestLoseStreak: number
  avgWin: Decimal
  avgLoss: Decimal
  profitFactor: number
  sharpeRatio: number
}

const DEFAULT_CONFIG: LiveTraderConfig = {
  apiKey: '',
  apiSecret: '',
  testnet: true,
  maxPyramidLevels: 5,
  minConfluenceToEnter: 4,
  minConfluenceToAdd: 5,
  enableHedgeMode: true,
  initialMarginPercent: 8,
  maxMarginPercent: 80,
  maxConsecutiveLosses: 3,
  cooldownMinutes: 5,
  enableAutoTrading: false,
  avoidFundingWindow: true,
  fundingWindowMinutes: 5
}

export class LiveTrader extends EventEmitter {
  private config: LiveTraderConfig
  private strategy: PyramidStrategyEngine
  private connections: ConnectionManager
  private healthMonitor: SystemHealthMonitor
  private rateLimiter: RateLimiter
  
  private serverTimeOffset: number = 0
  private listenKey: string = ''
  private listenKeyInterval: NodeJS.Timeout | null = null
  
  private accountInfo: AccountInfo | null = null
  private positions: Map<string, PositionInfo> = new Map()
  private currentPrice: Decimal = new Decimal(0)
  private recentCandles: Array<{ open: number; high: number; low: number; close: number; volume: number; time: number }> = []
  private latestFeatures: Record<string, number | null> = {}
  
  private isRunning: boolean = false
  private lastSignal: ConfluenceSignal | null = null
  private lastTradeTime: number = 0
  private consecutiveLosses: number = 0
  private circuitBreakerActive: boolean = false
  
  private performance: PerformanceStats
  private trades: TradeRecord[] = []

  constructor(config: Partial<LiveTraderConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
    
    this.strategy = new PyramidStrategyEngine({
      maxPyramidLevels: this.config.maxPyramidLevels,
      minConfluenceToEnter: this.config.minConfluenceToEnter,
      minConfluenceToAdd: this.config.minConfluenceToAdd,
      enableHedgeMode: this.config.enableHedgeMode,
      maxConsecutiveLosses: this.config.maxConsecutiveLosses,
      cooldownMinutes: this.config.cooldownMinutes
    })
    
    this.connections = new ConnectionManager()
    this.healthMonitor = new SystemHealthMonitor()
    this.rateLimiter = new RateLimiter(10, 5) // 10 requests, 5/sec refill
    
    this.performance = this.initPerformance()
    this.ensureDataDir()
    this.loadState()
    this.setupHealthMonitor()
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }
  }

  private initPerformance(): PerformanceStats {
    return {
      startTime: Date.now(),
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnl: new Decimal(0),
      totalCommissions: new Decimal(0),
      totalFundingPaid: new Decimal(0),
      largestWin: new Decimal(0),
      largestLoss: new Decimal(0),
      maxDrawdown: new Decimal(0),
      currentStreak: 0,
      longestWinStreak: 0,
      longestLoseStreak: 0,
      avgWin: new Decimal(0),
      avgLoss: new Decimal(0),
      profitFactor: 0,
      sharpeRatio: 0
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
        this.consecutiveLosses = data.consecutiveLosses || 0
        this.lastTradeTime = data.lastTradeTime || 0
        this.circuitBreakerActive = data.circuitBreakerActive || false
        console.log('[LiveTrader] State restored from disk')
      }
      
      if (fs.existsSync(PERFORMANCE_FILE)) {
        const perf = JSON.parse(fs.readFileSync(PERFORMANCE_FILE, 'utf-8'))
        this.performance = {
          ...perf,
          totalPnl: new Decimal(perf.totalPnl || 0),
          totalCommissions: new Decimal(perf.totalCommissions || 0),
          totalFundingPaid: new Decimal(perf.totalFundingPaid || 0),
          largestWin: new Decimal(perf.largestWin || 0),
          largestLoss: new Decimal(perf.largestLoss || 0),
          maxDrawdown: new Decimal(perf.maxDrawdown || 0),
          avgWin: new Decimal(perf.avgWin || 0),
          avgLoss: new Decimal(perf.avgLoss || 0)
        }
      }
    } catch (err) {
      console.error('[LiveTrader] Error loading state:', err)
    }
  }

  private saveState(): void {
    try {
      const state = {
        consecutiveLosses: this.consecutiveLosses,
        lastTradeTime: this.lastTradeTime,
        circuitBreakerActive: this.circuitBreakerActive,
        lastSaveTime: Date.now()
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
      
      const perfData = {
        ...this.performance,
        totalPnl: this.performance.totalPnl.toString(),
        totalCommissions: this.performance.totalCommissions.toString(),
        totalFundingPaid: this.performance.totalFundingPaid.toString(),
        largestWin: this.performance.largestWin.toString(),
        largestLoss: this.performance.largestLoss.toString(),
        maxDrawdown: this.performance.maxDrawdown.toString(),
        avgWin: this.performance.avgWin.toString(),
        avgLoss: this.performance.avgLoss.toString()
      }
      fs.writeFileSync(PERFORMANCE_FILE, JSON.stringify(perfData, null, 2))
    } catch (err) {
      console.error('[LiveTrader] Error saving state:', err)
    }
  }

  private setupHealthMonitor(): void {
    this.healthMonitor.registerComponent('api')
    this.healthMonitor.registerComponent('marketWs')
    this.healthMonitor.registerComponent('userWs')
    this.healthMonitor.registerComponent('strategy')
    
    this.healthMonitor.on('healthCheck', (status) => {
      this.emit('healthUpdate', status)
    })
  }

  // API Signing
  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.config.apiSecret)
      .update(queryString)
      .digest('hex')
  }

  private async getServerTime(): Promise<number> {
    const response = await fetch(`${ASTER_API_BASE}/fapi/v1/time`)
    const data = await response.json() as { serverTime: number }
    return data.serverTime
  }

  private async syncServerTime(): Promise<void> {
    const serverTime = await this.getServerTime()
    this.serverTimeOffset = serverTime - Date.now()
    console.log(`[LiveTrader] Server time offset: ${this.serverTimeOffset}ms`)
  }

  private getTimestamp(): number {
    return Date.now() + this.serverTimeOffset
  }

  // API Request with signing
  private async request(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    endpoint: string,
    params: Record<string, any> = {},
    signed: boolean = true
  ): Promise<any> {
    await this.rateLimiter.acquire()
    
    const url = new URL(`${ASTER_API_BASE}${endpoint}`)
    
    if (signed) {
      params.timestamp = this.getTimestamp()
      params.recvWindow = RECV_WINDOW
    }

    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')

    if (signed) {
      const signature = this.sign(queryString)
      params.signature = signature
    }

    const headers: Record<string, string> = {
      'X-MBX-APIKEY': this.config.apiKey
    }

    let response: Response
    const startTime = Date.now()

    try {
      if (method === 'GET') {
        const finalQuery = Object.entries(params)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
          .join('&')
        response = await fetch(`${url}?${finalQuery}`, { method, headers })
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        const body = Object.entries(params)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
          .join('&')
        response = await fetch(url.toString(), { method, headers, body })
      }

      const latency = Date.now() - startTime
      this.emit('apiLatency', latency)
      this.healthMonitor.updateHealth('api', true)

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`API Error ${response.status}: ${error}`)
      }

      return await response.json()
    } catch (err: any) {
      this.healthMonitor.updateHealth('api', false, err.message)
      throw err
    }
  }

  // Account & Position Management
  async fetchAccountInfo(): Promise<AccountInfo> {
    const data = await retryWithBackoff(() => this.request('GET', '/fapi/v2/account'), { maxRetries: 3 })
    
    this.accountInfo = {
      marginBalance: new Decimal(data.totalMarginBalance),
      availableBalance: new Decimal(data.availableBalance),
      totalUnrealizedProfit: new Decimal(data.totalUnrealizedProfit),
      totalPositionInitialMargin: new Decimal(data.totalPositionInitialMargin)
    }
    
    // Update positions
    for (const pos of data.positions) {
      if (pos.symbol === SYMBOL && parseFloat(pos.positionAmt) !== 0) {
        this.positions.set(pos.positionSide, {
          symbol: pos.symbol,
          positionSide: pos.positionSide,
          positionAmt: new Decimal(pos.positionAmt),
          entryPrice: new Decimal(pos.entryPrice),
          markPrice: new Decimal(pos.markPrice || 0),
          unrealizedProfit: new Decimal(pos.unrealizedProfit),
          liquidationPrice: new Decimal(pos.liquidationPrice || 0),
          leverage: parseInt(pos.leverage),
          marginType: pos.marginType
        })
      }
    }

    // Update strategy account state
    this.strategy.updateAccountState(
      this.accountInfo.marginBalance,
      this.accountInfo.availableBalance,
      new Decimal(0), // Funding rate updated separately
      0
    )

    this.emit('accountUpdate', this.accountInfo)
    return this.accountInfo
  }

  async fetchFundingRate(): Promise<{ rate: Decimal; nextTime: number }> {
    const data = await this.request('GET', '/fapi/v1/fundingRate', { symbol: SYMBOL, limit: 1 }, false)
    
    if (data && data[0]) {
      const rate = new Decimal(data[0].fundingRate)
      const nextTime = data[0].fundingTime
      
      this.strategy.updateAccountState(
        this.accountInfo?.marginBalance || new Decimal(0),
        this.accountInfo?.availableBalance || new Decimal(0),
        rate,
        nextTime
      )
      
      return { rate, nextTime }
    }
    
    return { rate: new Decimal(0), nextTime: 0 }
  }

  // Order Execution
  async placeOrder(
    side: 'BUY' | 'SELL',
    quantity: Decimal,
    type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' = 'MARKET',
    options: {
      price?: Decimal
      stopPrice?: Decimal
      positionSide?: 'LONG' | 'SHORT'
      reduceOnly?: boolean
      newClientOrderId?: string
    } = {}
  ): Promise<OrderResult> {
    const params: Record<string, any> = {
      symbol: SYMBOL,
      side,
      type,
      quantity: quantity.toFixed(3)
    }

    if (options.positionSide) params.positionSide = options.positionSide
    if (options.reduceOnly) params.reduceOnly = 'true'
    if (options.newClientOrderId) params.newClientOrderId = options.newClientOrderId
    if (options.price) params.price = options.price.toFixed(2)
    if (options.stopPrice) params.stopPrice = options.stopPrice.toFixed(2)
    if (type === 'LIMIT') params.timeInForce = 'GTC'

    console.log(`[LiveTrader] Placing ${type} ${side} order: ${quantity.toFixed(3)} ${SYMBOL}`)
    
    const result = await retryWithBackoff(
      () => this.request('POST', '/fapi/v1/order', params),
      { maxRetries: 2 }
    )

    return {
      orderId: result.orderId.toString(),
      clientOrderId: result.clientOrderId,
      status: result.status,
      executedQty: new Decimal(result.executedQty),
      avgPrice: new Decimal(result.avgPrice || 0),
      side: result.side,
      type: result.type
    }
  }

  async cancelAllOrders(): Promise<void> {
    await this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol: SYMBOL })
    console.log('[LiveTrader] All orders cancelled')
  }

  async closePosition(positionSide?: 'LONG' | 'SHORT'): Promise<void> {
    const positions = positionSide 
      ? [this.positions.get(positionSide)].filter(Boolean)
      : Array.from(this.positions.values())

    for (const pos of positions) {
      if (!pos || pos.positionAmt.isZero()) continue
      
      const side = pos.positionAmt.gt(0) ? 'SELL' : 'BUY'
      const qty = pos.positionAmt.abs()
      
      await this.placeOrder(side, qty, 'MARKET', {
        positionSide: pos.positionSide === 'BOTH' ? undefined : pos.positionSide,
        reduceOnly: true
      })
    }
  }

  async setLeverage(leverage: number = MAX_LEVERAGE): Promise<void> {
    await this.request('POST', '/fapi/v1/leverage', { symbol: SYMBOL, leverage })
    console.log(`[LiveTrader] Leverage set to ${leverage}x`)
  }

  // WebSocket Setup
  private async setupMarketStream(): Promise<void> {
    const marketWs = this.connections.addConnection('market', {
      wsUrl: `${ASTER_WS_BASE}/ws/${SYMBOL.toLowerCase()}@kline_1m`,
      autoReconnect: true
    })

    marketWs.on('message', (msg: any) => {
      if (msg.e === 'kline' && msg.k) {
        const k = msg.k
        this.currentPrice = new Decimal(k.c)
        
        if (k.x) { // Candle closed
          this.recentCandles.push({
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
            time: k.t
          })
          
          // Keep last 100 candles
          if (this.recentCandles.length > 100) {
            this.recentCandles = this.recentCandles.slice(-100)
          }
          
          // Evaluate market on each candle close
          this.onCandleClose()
        }
        
        this.emit('priceUpdate', this.currentPrice)
      }
    })

    marketWs.on('connected', () => {
      this.healthMonitor.updateHealth('marketWs', true)
    })

    marketWs.on('disconnected', () => {
      this.healthMonitor.updateHealth('marketWs', false, 'Disconnected')
    })

    marketWs.connect()
  }

  private async setupUserStream(): Promise<void> {
    // Get listen key
    const data = await this.request('POST', '/fapi/v1/listenKey', {})
    this.listenKey = data.listenKey

    const userWs = this.connections.addConnection('user', {
      wsUrl: `${ASTER_WS_BASE}/ws/${this.listenKey}`,
      autoReconnect: true
    })

    userWs.on('message', (msg: any) => {
      this.handleUserStreamEvent(msg)
    })

    userWs.on('connected', () => {
      this.healthMonitor.updateHealth('userWs', true)
    })

    userWs.on('disconnected', () => {
      this.healthMonitor.updateHealth('userWs', false, 'Disconnected')
    })

    userWs.connect()

    // Keep listen key alive
    this.listenKeyInterval = setInterval(async () => {
      try {
        await this.request('PUT', '/fapi/v1/listenKey', {})
      } catch (err) {
        console.error('[LiveTrader] Failed to refresh listen key:', err)
      }
    }, 30 * 60 * 1000) // Every 30 minutes
  }

  private handleUserStreamEvent(event: any): void {
    switch (event.e) {
      case 'ACCOUNT_UPDATE':
        this.handleAccountUpdate(event)
        break
      case 'ORDER_TRADE_UPDATE':
        this.handleOrderUpdate(event)
        break
      case 'MARGIN_CALL':
        this.handleMarginCall(event)
        break
    }
  }

  private handleAccountUpdate(event: any): void {
    if (event.a) {
      // Update balances
      for (const balance of event.a.B || []) {
        if (balance.a === 'USDT') {
          this.accountInfo = {
            marginBalance: new Decimal(balance.wb),
            availableBalance: new Decimal(balance.cw),
            totalUnrealizedProfit: this.accountInfo?.totalUnrealizedProfit || new Decimal(0),
            totalPositionInitialMargin: this.accountInfo?.totalPositionInitialMargin || new Decimal(0)
          }
        }
      }

      // Update positions
      for (const pos of event.a.P || []) {
        if (pos.s === SYMBOL) {
          this.positions.set(pos.ps, {
            symbol: pos.s,
            positionSide: pos.ps,
            positionAmt: new Decimal(pos.pa),
            entryPrice: new Decimal(pos.ep),
            markPrice: new Decimal(pos.mp || 0),
            unrealizedProfit: new Decimal(pos.up),
            liquidationPrice: new Decimal(0),
            leverage: MAX_LEVERAGE,
            marginType: 'cross'
          })
        }
      }
    }

    this.emit('accountUpdate', this.accountInfo)
  }

  private handleOrderUpdate(event: any): void {
    const o = event.o
    if (o.s !== SYMBOL) return

    const update = {
      orderId: o.i.toString(),
      clientOrderId: o.c,
      side: o.S,
      type: o.o,
      status: o.X,
      executedQty: new Decimal(o.z),
      avgPrice: new Decimal(o.ap || 0),
      commission: new Decimal(o.n || 0),
      realizedPnl: new Decimal(o.rp || 0)
    }

    // Update trade record
    const trade = this.trades.find(t => t.orderId === update.orderId)
    if (trade) {
      trade.status = update.status === 'FILLED' ? 'filled' : 
                     update.status === 'CANCELED' ? 'failed' : 'pending'
      if (update.status === 'FILLED') {
        trade.pnl = update.realizedPnl
        trade.commission = update.commission
        this.recordTradeResult(trade)
      }
    }

    this.emit('orderUpdate', update)
  }

  private handleMarginCall(event: any): void {
    console.error('[LiveTrader] ⚠️ MARGIN CALL RECEIVED')
    this.emit('marginCall', event)
    
    // Trigger circuit breaker
    this.triggerCircuitBreaker('Margin call received')
  }

  // Main Trading Logic
  private async onCandleClose(): Promise<void> {
    if (!this.isRunning || !this.config.enableAutoTrading) return
    if (this.circuitBreakerActive) return

    try {
      // Refresh account info
      await this.fetchAccountInfo()
      
      // Evaluate market with strategy
      const decision = this.strategy.evaluateMarket(
        this.currentPrice,
        this.latestFeatures,
        this.recentCandles
      )

      this.lastSignal = decision.signal
      this.emit('signal', decision)

      if (decision.action === 'none') return

      // Check cooldown
      const now = Date.now()
      if (now - this.lastTradeTime < this.config.cooldownMinutes * 60 * 1000) {
        console.log('[LiveTrader] Cooldown active, skipping signal')
        return
      }

      // Execute based on decision
      await this.executeDecision(decision)
      
      this.healthMonitor.updateHealth('strategy', true)
    } catch (err: any) {
      console.error('[LiveTrader] Error in candle processing:', err)
      this.healthMonitor.updateHealth('strategy', false, err.message)
    }
  }

  private async executeDecision(decision: ReturnType<PyramidStrategyEngine['evaluateMarket']>): Promise<void> {
    const { action, signal, positionSize, stopLoss, takeProfit, reason } = decision

    console.log(`[LiveTrader] Action: ${action} - ${reason}`)

    try {
      switch (action) {
        case 'open_long':
        case 'hedge_long':
          await this.openPosition('long', positionSize!, stopLoss, takeProfit, signal)
          break
          
        case 'open_short':
        case 'hedge_short':
          await this.openPosition('short', positionSize!, stopLoss, takeProfit, signal)
          break
          
        case 'add_long':
          await this.addToPosition('long', positionSize!, stopLoss, signal)
          break
          
        case 'add_short':
          await this.addToPosition('short', positionSize!, stopLoss, signal)
          break
          
        case 'close_long':
          await this.closePosition('LONG')
          break
          
        case 'close_short':
          await this.closePosition('SHORT')
          break
          
        case 'update_stops':
          await this.updateStopOrders(stopLoss!)
          break
          
        case 'take_profit':
          await this.closePosition()
          break
      }

      this.lastTradeTime = Date.now()
      this.saveState()
    } catch (err: any) {
      console.error(`[LiveTrader] Failed to execute ${action}:`, err)
      this.emit('error', { action, error: err.message })
    }
  }

  private async openPosition(
    side: 'long' | 'short',
    size: { marginToUse: Decimal; quantity: Decimal; notionalValue: Decimal },
    stopLoss?: Decimal,
    takeProfit?: Decimal,
    signal?: ConfluenceSignal
  ): Promise<void> {
    const orderSide = side === 'long' ? 'BUY' : 'SELL'
    const positionSide = side === 'long' ? 'LONG' : 'SHORT'

    // Record trade
    const trade: TradeRecord = {
      id: `trade-${Date.now()}`,
      timestamp: Date.now(),
      action: `OPEN_${side.toUpperCase()}`,
      side,
      quantity: size.quantity,
      price: this.currentPrice,
      notionalValue: size.notionalValue,
      marginUsed: size.marginToUse,
      pyramidLevel: 1,
      confluenceScore: signal?.score || 0,
      factors: signal?.factors.map(f => f.name) || [],
      orderId: '',
      status: 'pending'
    }

    // Place market order
    const result = await this.placeOrder(orderSide, size.quantity, 'MARKET', { positionSide })
    trade.orderId = result.orderId
    
    if (result.status === 'FILLED') {
      trade.status = 'filled'
      trade.price = result.avgPrice
      
      // Place stop loss
      if (stopLoss) {
        const stopSide = side === 'long' ? 'SELL' : 'BUY'
        await this.placeOrder(stopSide, size.quantity, 'STOP_MARKET', {
          positionSide,
          stopPrice: stopLoss,
          reduceOnly: true
        })
      }

      // Place take profit
      if (takeProfit) {
        const tpSide = side === 'long' ? 'SELL' : 'BUY'
        await this.placeOrder(tpSide, size.quantity, 'TAKE_PROFIT_MARKET', {
          positionSide,
          stopPrice: takeProfit,
          reduceOnly: true
        })
      }
    }

    this.trades.push(trade)
    this.logTrade(trade)
    this.emit('tradeOpened', trade)
  }

  private async addToPosition(
    side: 'long' | 'short',
    size: { marginToUse: Decimal; quantity: Decimal; notionalValue: Decimal },
    stopLoss?: Decimal,
    signal?: ConfluenceSignal
  ): Promise<void> {
    const positionSide = side === 'long' ? 'LONG' : 'SHORT'
    const existingPos = this.positions.get(positionSide)
    const pyramidLevel = existingPos ? 2 : 1 // Simplified - would track properly in production

    const trade: TradeRecord = {
      id: `trade-${Date.now()}`,
      timestamp: Date.now(),
      action: `ADD_${side.toUpperCase()}`,
      side,
      quantity: size.quantity,
      price: this.currentPrice,
      notionalValue: size.notionalValue,
      marginUsed: size.marginToUse,
      pyramidLevel,
      confluenceScore: signal?.score || 0,
      factors: signal?.factors.map(f => f.name) || [],
      orderId: '',
      status: 'pending'
    }

    const orderSide = side === 'long' ? 'BUY' : 'SELL'
    const result = await this.placeOrder(orderSide, size.quantity, 'MARKET', { positionSide })
    trade.orderId = result.orderId
    
    if (result.status === 'FILLED') {
      trade.status = 'filled'
      trade.price = result.avgPrice

      // Update stop loss if provided
      if (stopLoss) {
        await this.updateStopOrders(stopLoss)
      }
    }

    this.trades.push(trade)
    this.logTrade(trade)
    this.emit('pyramidAdded', trade)
  }

  private async updateStopOrders(newStopPrice: Decimal): Promise<void> {
    // Cancel existing stops and place new ones
    await this.cancelAllOrders()
    
    for (const pos of this.positions.values()) {
      if (pos.positionAmt.isZero()) continue
      
      const side = pos.positionAmt.gt(0) ? 'SELL' : 'BUY'
      const qty = pos.positionAmt.abs()
      
      await this.placeOrder(side, qty, 'STOP_MARKET', {
        positionSide: pos.positionSide === 'BOTH' ? undefined : pos.positionSide,
        stopPrice: newStopPrice,
        reduceOnly: true
      })
    }

    console.log(`[LiveTrader] Stop loss updated to ${newStopPrice.toFixed(2)}`)
  }

  private recordTradeResult(trade: TradeRecord): void {
    const pnl = trade.pnl || new Decimal(0)
    const isWin = pnl.gt(0)

    this.performance.totalTrades++
    this.performance.totalPnl = this.performance.totalPnl.plus(pnl)
    this.performance.totalCommissions = this.performance.totalCommissions.plus(trade.commission || new Decimal(0))

    if (isWin) {
      this.performance.winningTrades++
      this.consecutiveLosses = 0
      this.performance.currentStreak = Math.max(1, this.performance.currentStreak + 1)
      this.performance.longestWinStreak = Math.max(this.performance.longestWinStreak, this.performance.currentStreak)
      
      if (pnl.gt(this.performance.largestWin)) {
        this.performance.largestWin = pnl
      }
    } else {
      this.performance.losingTrades++
      this.consecutiveLosses++
      this.performance.currentStreak = Math.min(-1, this.performance.currentStreak - 1)
      this.performance.longestLoseStreak = Math.max(this.performance.longestLoseStreak, Math.abs(this.performance.currentStreak))
      
      if (pnl.lt(this.performance.largestLoss)) {
        this.performance.largestLoss = pnl
      }

      // Check circuit breaker
      if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
        this.triggerCircuitBreaker(`${this.consecutiveLosses} consecutive losses`)
      }
    }

    // Update win rate
    this.performance.winRate = this.performance.winningTrades / this.performance.totalTrades

    // Update averages
    if (this.performance.winningTrades > 0) {
      // This is simplified - would need to track all wins/losses properly
    }

    this.strategy.recordTradeResult(pnl, isWin)
    this.saveState()
    this.emit('tradeResult', { trade, performance: this.performance })
  }

  private logTrade(trade: TradeRecord): void {
    try {
      const logEntry = {
        ...trade,
        quantity: trade.quantity.toString(),
        price: trade.price.toString(),
        notionalValue: trade.notionalValue.toString(),
        marginUsed: trade.marginUsed.toString(),
        pnl: trade.pnl?.toString(),
        commission: trade.commission?.toString()
      }
      fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify(logEntry) + '\n')
    } catch (err) {
      console.error('[LiveTrader] Error logging trade:', err)
    }
  }

  private triggerCircuitBreaker(reason: string): void {
    console.error(`[LiveTrader] 🚨 CIRCUIT BREAKER: ${reason}`)
    this.circuitBreakerActive = true
    this.emit('circuitBreaker', reason)
    this.saveState()
  }

  resetCircuitBreaker(): void {
    this.circuitBreakerActive = false
    this.consecutiveLosses = 0
    this.saveState()
    console.log('[LiveTrader] Circuit breaker reset')
    this.emit('circuitBreakerReset')
  }

  // Update features from external source (e.g., engine.ts)
  updateFeatures(features: Record<string, number | null>): void {
    this.latestFeatures = features
  }

  // Lifecycle
  async start(): Promise<boolean> {
    if (this.isRunning) return true

    console.log('[LiveTrader] Starting live trader...')

    try {
      // Sync server time
      await this.syncServerTime()
      
      // Set leverage
      await this.setLeverage()
      
      // Fetch initial account info
      await this.fetchAccountInfo()
      await this.fetchFundingRate()
      
      // Setup WebSocket connections
      await this.setupMarketStream()
      await this.setupUserStream()
      
      // Start health monitoring
      this.healthMonitor.startMonitoring()
      
      this.isRunning = true
      console.log('[LiveTrader] ✅ Live trader started')
      this.emit('started')
      return true
    } catch (err: any) {
      console.error('[LiveTrader] Failed to start:', err)
      this.emit('error', { action: 'start', error: err.message })
      return false
    }
  }

  async stop(): Promise<void> {
    console.log('[LiveTrader] Stopping live trader...')
    
    this.isRunning = false
    
    // Clear intervals
    if (this.listenKeyInterval) {
      clearInterval(this.listenKeyInterval)
      this.listenKeyInterval = null
    }
    
    // Disconnect WebSockets
    this.connections.disconnectAll()
    
    // Stop health monitoring
    this.healthMonitor.stopMonitoring()
    
    // Save state
    this.saveState()
    
    console.log('[LiveTrader] Stopped')
    this.emit('stopped')
  }

  async emergencyStop(): Promise<void> {
    console.error('[LiveTrader] 🛑 EMERGENCY STOP')
    
    try {
      await this.cancelAllOrders()
      await this.closePosition()
    } catch (err) {
      console.error('[LiveTrader] Error during emergency stop:', err)
    }
    
    await this.stop()
    this.emit('emergencyStop')
  }

  // Getters
  getStatus() {
    return {
      isRunning: this.isRunning,
      circuitBreakerActive: this.circuitBreakerActive,
      consecutiveLosses: this.consecutiveLosses,
      currentPrice: this.currentPrice.toString(),
      accountInfo: this.accountInfo ? {
        marginBalance: this.accountInfo.marginBalance.toString(),
        availableBalance: this.accountInfo.availableBalance.toString(),
        unrealizedPnl: this.accountInfo.totalUnrealizedProfit.toString()
      } : null,
      positions: Array.from(this.positions.values()).map(p => ({
        side: p.positionSide,
        size: p.positionAmt.toString(),
        entryPrice: p.entryPrice.toString(),
        unrealizedPnl: p.unrealizedProfit.toString()
      })),
      lastSignal: this.lastSignal,
      performance: {
        totalTrades: this.performance.totalTrades,
        winRate: this.performance.winRate,
        totalPnl: this.performance.totalPnl.toString()
      }
    }
  }

  getPerformance(): PerformanceStats {
    return this.performance
  }

  getStrategyState() {
    return this.strategy.getState()
  }
}

export function createLiveTrader(config: Partial<LiveTraderConfig>): LiveTrader {
  const trader = new LiveTrader(config)
  
  // Register shutdown handlers
  process.on('SIGINT', async () => {
    console.log('[LiveTrader] Received SIGINT')
    await trader.emergencyStop()
    process.exit(0)
  })
  
  process.on('SIGTERM', async () => {
    console.log('[LiveTrader] Received SIGTERM')
    await trader.emergencyStop()
    process.exit(0)
  })
  
  return trader
}
