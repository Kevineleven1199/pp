import * as crypto from 'crypto'
import { EventEmitter } from 'events'
import Decimal from 'decimal.js'
import WebSocket from 'ws'
import { v4 as uuidv4 } from 'uuid'

// Configure Decimal.js for precise financial calculations
Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN })

// AsterDEX Legacy API Configuration
const ASTER_API_BASE = 'https://fapi.asterdex.com'
const ASTER_WS_BASE = 'wss://fstream.asterdex.com'
const SYMBOL = 'ETHUSDT'
const MAX_LEVERAGE = 88
const RECV_WINDOW = 5000

export interface AsterDEXConfig {
  apiKey: string
  apiSecret: string
  testnet: boolean
  maxPositionUsd: number
  maxLeverage?: number
  recvWindow?: number
}

export type OrderSide = 'BUY' | 'SELL'
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_MARKET' | 'TAKE_PROFIT' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET'
export type PositionSide = 'LONG' | 'SHORT' | 'BOTH'
export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'GTX'
export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED'

export interface AsterDEXOrder {
  orderId: string
  clientOrderId: string
  symbol: string
  side: OrderSide
  positionSide: PositionSide
  type: OrderType
  quantity: Decimal
  price?: Decimal
  stopPrice?: Decimal
  status: OrderStatus
  executedQty: Decimal
  avgPrice: Decimal
  timestamp: number
  updateTime: number
}

export interface AsterDEXPosition {
  symbol: string
  positionSide: PositionSide
  positionAmt: Decimal
  entryPrice: Decimal
  markPrice: Decimal
  liquidationPrice: Decimal
  unrealizedProfit: Decimal
  isolatedMargin: Decimal
  leverage: number
  marginType: 'isolated' | 'cross'
}

export interface AccountBalance {
  asset: string
  walletBalance: Decimal
  availableBalance: Decimal
  crossUnPnl: Decimal
  marginBalance: Decimal
}

export interface PyramidSignal {
  action: 'OPEN_LONG' | 'OPEN_SHORT' | 'ADD_LONG' | 'ADD_SHORT' | 'CLOSE' | 'UPDATE_STOP'
  symbol: string
  price: Decimal
  quantity: Decimal
  stopLoss?: Decimal
  takeProfit?: Decimal
  trailingCallback?: number
  confluenceScore: number
  factors: string[]
  timestamp: number
  pyramidLevel: number
}

export interface TradeExecution {
  id: string
  orderId: string
  clientOrderId: string
  timestamp: number
  action: string
  side: 'long' | 'short'
  price: Decimal
  quantity: Decimal
  executedQty: Decimal
  avgPrice: Decimal
  status: 'pending' | 'filled' | 'partial' | 'failed' | 'canceled'
  commission: Decimal
  commissionAsset: string
  realizedPnl: Decimal
  error?: string
  latencyMs: number
}

export interface RiskMetrics {
  totalMarginUsed: Decimal
  availableMargin: Decimal
  marginRatio: Decimal
  unrealizedPnl: Decimal
  liquidationRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  maxDrawdown: Decimal
  currentDrawdown: Decimal
  dailyPnl: Decimal
  winRate: number
  sharpeRatio: number
}

type TraderState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'TRADING' | 'CLOSING' | 'ERROR' | 'STOPPED'

export class AsterDEXTrader extends EventEmitter {
  private config: AsterDEXConfig
  private state: TraderState = 'IDLE'
  private position: AsterDEXPosition | null = null
  private orders: Map<string, AsterDEXOrder> = new Map()
  private executions: TradeExecution[] = []
  private balances: Map<string, AccountBalance> = new Map()
  private lastPrice: Decimal = new Decimal(0)
  private ws: WebSocket | null = null
  private userDataWs: WebSocket | null = null
  private listenKey: string = ''
  private listenKeyInterval: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private riskMetrics: RiskMetrics
  private orderRateLimiter: { count: number; resetTime: number } = { count: 0, resetTime: 0 }
  private readonly ORDER_RATE_LIMIT = 10 // orders per second
  private serverTimeOffset = 0

  constructor(config: AsterDEXConfig) {
    super()
    this.config = {
      ...config,
      maxLeverage: config.maxLeverage || MAX_LEVERAGE,
      recvWindow: config.recvWindow || RECV_WINDOW
    }
    this.riskMetrics = this.initRiskMetrics()
  }

  private initRiskMetrics(): RiskMetrics {
    return {
      totalMarginUsed: new Decimal(0),
      availableMargin: new Decimal(0),
      marginRatio: new Decimal(0),
      unrealizedPnl: new Decimal(0),
      liquidationRisk: 'LOW',
      maxDrawdown: new Decimal(0),
      currentDrawdown: new Decimal(0),
      dailyPnl: new Decimal(0),
      winRate: 0,
      sharpeRatio: 0
    }
  }

  // HMAC SHA256 signature generation
  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.config.apiSecret)
      .update(queryString)
      .digest('hex')
  }

  // Get synchronized server timestamp
  private async getServerTime(): Promise<number> {
    try {
      const response = await fetch(`${ASTER_API_BASE}/fapi/v1/time`)
      const data = await response.json() as { serverTime: number }
      const serverTime = data.serverTime
      this.serverTimeOffset = serverTime - Date.now()
      return serverTime
    } catch {
      return Date.now() + this.serverTimeOffset
    }
  }

  private getTimestamp(): number {
    return Date.now() + this.serverTimeOffset
  }

  // Rate-limited API request with retry logic
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    endpoint: string,
    params: Record<string, any> = {},
    signed = true,
    retries = 3
  ): Promise<T> {
    // Rate limiting check
    const now = Date.now()
    if (now > this.orderRateLimiter.resetTime) {
      this.orderRateLimiter = { count: 0, resetTime: now + 1000 }
    }
    if (this.orderRateLimiter.count >= this.ORDER_RATE_LIMIT) {
      await this.sleep(this.orderRateLimiter.resetTime - now)
    }
    this.orderRateLimiter.count++

    const timestamp = this.getTimestamp()
    const queryParams: Record<string, any> = { ...params }
    
    if (signed) {
      queryParams.timestamp = timestamp
      queryParams.recvWindow = this.config.recvWindow
    }

    let queryString = Object.entries(queryParams)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&')

    if (signed && queryString) {
      const signature = this.sign(queryString)
      queryString += `&signature=${signature}`
    }

    const url = method === 'GET' || method === 'DELETE'
      ? `${ASTER_API_BASE}${endpoint}?${queryString}`
      : `${ASTER_API_BASE}${endpoint}`

    const startTime = Date.now()

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const options: RequestInit = {
          method,
          headers: {
            'X-MBX-APIKEY': this.config.apiKey,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }

        if (method === 'POST' || method === 'PUT') {
          options.body = queryString
        }

        const response = await fetch(url, options)
        const latency = Date.now() - startTime

        if (!response.ok) {
          const error = await response.json() as { code?: number; msg?: string }
          const errorMsg = `[AsterDEX] API Error ${response.status}: ${error.msg || 'Unknown'} (code: ${error.code})`
          
          // Retry on specific errors
          if (error.code === -1021 || error.code === -1001) {
            // Timestamp/network issues - resync and retry
            await this.getServerTime()
            continue
          }
          
          throw new Error(errorMsg)
        }

        const data = await response.json() as T
        this.emit('apiCall', { endpoint, latency, success: true })
        return data
      } catch (err: any) {
        if (attempt === retries - 1) {
          this.emit('apiCall', { endpoint, latency: Date.now() - startTime, success: false, error: err.message })
          throw err
        }
        await this.sleep(Math.pow(2, attempt) * 100) // Exponential backoff
      }
    }

    throw new Error('Max retries exceeded')
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // Initialize connection and sync server time
  async initialize(): Promise<boolean> {
    try {
      this.setState('CONNECTING')
      
      // Sync server time
      await this.getServerTime()
      console.log(`[AsterDEX] Server time offset: ${this.serverTimeOffset}ms`)

      // Test connectivity
      await this.request<{ serverTime: number }>('GET', '/fapi/v1/time', {}, false)
      
      // Set leverage
      await this.setLeverage(this.config.maxLeverage || MAX_LEVERAGE)
      
      // Get initial position and balance
      await this.refreshPosition()
      await this.refreshBalance()

      // Start user data stream
      await this.startUserDataStream()

      this.setState('CONNECTED')
      console.log('[AsterDEX] Trader initialized successfully')
      return true
    } catch (err: any) {
      console.error('[AsterDEX] Initialization failed:', err.message)
      this.setState('ERROR')
      return false
    }
  }

  // User Data Stream for real-time updates
  private async startUserDataStream(): Promise<void> {
    try {
      const data = await this.request<{ listenKey: string }>('POST', '/fapi/v1/listenKey')
      this.listenKey = data.listenKey

      // Keep-alive every 30 minutes
      this.listenKeyInterval = setInterval(async () => {
        try {
          await this.request('PUT', '/fapi/v1/listenKey', { listenKey: this.listenKey })
        } catch (err) {
          console.error('[AsterDEX] Failed to extend listenKey:', err)
        }
      }, 30 * 60 * 1000)

      // Connect WebSocket
      this.connectUserDataWs()
    } catch (err) {
      console.error('[AsterDEX] Failed to start user data stream:', err)
    }
  }

  private connectUserDataWs(): void {
    const wsUrl = `${ASTER_WS_BASE}/ws/${this.listenKey}`
    this.userDataWs = new WebSocket(wsUrl)

    this.userDataWs.on('open', () => {
      console.log('[AsterDEX] User data WebSocket connected')
      this.reconnectAttempts = 0
    })

    this.userDataWs.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString())
        this.handleUserDataEvent(event)
      } catch (err) {
        console.error('[AsterDEX] Failed to parse user data event:', err)
      }
    })

    this.userDataWs.on('close', () => {
      console.log('[AsterDEX] User data WebSocket disconnected')
      this.attemptReconnect()
    })

    this.userDataWs.on('error', (err) => {
      console.error('[AsterDEX] User data WebSocket error:', err)
    })
  }

  private handleUserDataEvent(event: any): void {
    switch (event.e) {
      case 'ORDER_TRADE_UPDATE':
        this.handleOrderUpdate(event.o)
        break
      case 'ACCOUNT_UPDATE':
        this.handleAccountUpdate(event.a)
        break
      case 'MARGIN_CALL':
        this.handleMarginCall(event)
        break
      case 'listenKeyExpired':
        this.startUserDataStream()
        break
    }
  }

  private handleOrderUpdate(order: any): void {
    const execution: TradeExecution = {
      id: uuidv4(),
      orderId: order.i.toString(),
      clientOrderId: order.c,
      timestamp: order.T,
      action: order.o, // Order type
      side: order.S === 'BUY' ? 'long' : 'short',
      price: new Decimal(order.p || 0),
      quantity: new Decimal(order.q),
      executedQty: new Decimal(order.z),
      avgPrice: new Decimal(order.ap || 0),
      status: this.mapOrderStatus(order.X),
      commission: new Decimal(order.n || 0),
      commissionAsset: order.N || 'USDT',
      realizedPnl: new Decimal(order.rp || 0),
      latencyMs: Date.now() - order.T
    }

    this.executions.unshift(execution)
    if (this.executions.length > 500) {
      this.executions = this.executions.slice(0, 500)
    }

    this.emit('execution', execution)

    // Update position if order filled
    if (order.X === 'FILLED' || order.X === 'PARTIALLY_FILLED') {
      this.refreshPosition()
    }
  }

  private mapOrderStatus(status: string): TradeExecution['status'] {
    switch (status) {
      case 'NEW': return 'pending'
      case 'PARTIALLY_FILLED': return 'partial'
      case 'FILLED': return 'filled'
      case 'CANCELED': return 'canceled'
      case 'REJECTED':
      case 'EXPIRED': return 'failed'
      default: return 'pending'
    }
  }

  private handleAccountUpdate(account: any): void {
    // Update balances
    if (account.B) {
      for (const b of account.B) {
        this.balances.set(b.a, {
          asset: b.a,
          walletBalance: new Decimal(b.wb),
          availableBalance: new Decimal(b.cw),
          crossUnPnl: new Decimal(b.bc),
          marginBalance: new Decimal(b.wb)
        })
      }
    }

    // Update positions
    if (account.P) {
      for (const p of account.P) {
        if (p.s === SYMBOL) {
          const posAmt = new Decimal(p.pa)
          if (!posAmt.isZero()) {
            this.position = {
              symbol: p.s,
              positionSide: p.ps,
              positionAmt: posAmt,
              entryPrice: new Decimal(p.ep),
              markPrice: new Decimal(0),
              liquidationPrice: new Decimal(0),
              unrealizedProfit: new Decimal(p.up),
              isolatedMargin: new Decimal(p.iw),
              leverage: 0,
              marginType: p.mt === 'isolated' ? 'isolated' : 'cross'
            }
          } else {
            this.position = null
          }
        }
      }
    }

    this.updateRiskMetrics()
    this.emit('accountUpdate', { balances: this.balances, position: this.position })
  }

  private handleMarginCall(event: any): void {
    console.warn('[AsterDEX] MARGIN CALL:', event)
    this.riskMetrics.liquidationRisk = 'CRITICAL'
    this.emit('marginCall', event)
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts && this.state !== 'STOPPED') {
      this.reconnectAttempts++
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
      console.log(`[AsterDEX] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
      setTimeout(() => this.connectUserDataWs(), delay)
    }
  }

  // Position and Balance Management
  async refreshPosition(): Promise<AsterDEXPosition | null> {
    try {
      const positions = await this.request<any[]>('GET', '/fapi/v1/positionRisk')
      const ethPosition = positions.find(p => p.symbol === SYMBOL && parseFloat(p.positionAmt) !== 0)

      if (ethPosition) {
        this.position = {
          symbol: SYMBOL,
          positionSide: ethPosition.positionSide,
          positionAmt: new Decimal(ethPosition.positionAmt),
          entryPrice: new Decimal(ethPosition.entryPrice),
          markPrice: new Decimal(ethPosition.markPrice),
          liquidationPrice: new Decimal(ethPosition.liquidationPrice),
          unrealizedProfit: new Decimal(ethPosition.unRealizedProfit),
          isolatedMargin: new Decimal(ethPosition.isolatedMargin || 0),
          leverage: parseInt(ethPosition.leverage),
          marginType: ethPosition.marginType
        }
      } else {
        this.position = null
      }

      this.emit('positionUpdate', this.position)
      return this.position
    } catch (err) {
      console.error('[AsterDEX] Failed to refresh position:', err)
      return null
    }
  }

  async refreshBalance(): Promise<Map<string, AccountBalance>> {
    try {
      const account = await this.request<any>('GET', '/fapi/v1/balance')
      
      for (const b of account) {
        this.balances.set(b.asset, {
          asset: b.asset,
          walletBalance: new Decimal(b.balance),
          availableBalance: new Decimal(b.availableBalance),
          crossUnPnl: new Decimal(b.crossUnPnl),
          marginBalance: new Decimal(b.marginBalance || b.balance)
        })
      }

      this.updateRiskMetrics()
      return this.balances
    } catch (err) {
      console.error('[AsterDEX] Failed to refresh balance:', err)
      return this.balances
    }
  }

  // Leverage Management
  async setLeverage(leverage: number): Promise<boolean> {
    try {
      await this.request('POST', '/fapi/v1/leverage', {
        symbol: SYMBOL,
        leverage: Math.min(leverage, MAX_LEVERAGE)
      })
      console.log(`[AsterDEX] Leverage set to ${leverage}x`)
      return true
    } catch (err) {
      console.error('[AsterDEX] Failed to set leverage:', err)
      return false
    }
  }

  // Order Execution - Market Order
  async placeMarketOrder(
    side: OrderSide,
    quantity: Decimal,
    reduceOnly = false,
    positionSide: PositionSide = 'BOTH'
  ): Promise<AsterDEXOrder | null> {
    const clientOrderId = `PP_${Date.now()}_${uuidv4().slice(0, 8)}`
    
    try {
      const params: Record<string, any> = {
        symbol: SYMBOL,
        side,
        type: 'MARKET',
        quantity: quantity.toFixed(3),
        newClientOrderId: clientOrderId,
        newOrderRespType: 'RESULT'
      }

      if (positionSide !== 'BOTH') {
        params.positionSide = positionSide
      }
      if (reduceOnly) {
        params.reduceOnly = 'true'
      }

      const result = await this.request<any>('POST', '/fapi/v1/order', params)

      const order: AsterDEXOrder = {
        orderId: result.orderId.toString(),
        clientOrderId: result.clientOrderId,
        symbol: SYMBOL,
        side,
        positionSide,
        type: 'MARKET',
        quantity,
        status: result.status,
        executedQty: new Decimal(result.executedQty),
        avgPrice: new Decimal(result.avgPrice),
        timestamp: Date.now(),
        updateTime: result.updateTime
      }

      this.orders.set(order.orderId, order)
      this.emit('orderPlaced', order)
      return order
    } catch (err: any) {
      console.error('[AsterDEX] Market order failed:', err.message)
      this.emit('orderFailed', { clientOrderId, error: err.message })
      return null
    }
  }

  // Order Execution - Stop Loss
  async placeStopLoss(
    side: OrderSide,
    quantity: Decimal,
    stopPrice: Decimal,
    positionSide: PositionSide = 'BOTH'
  ): Promise<AsterDEXOrder | null> {
    const clientOrderId = `PP_SL_${Date.now()}_${uuidv4().slice(0, 8)}`

    try {
      const params: Record<string, any> = {
        symbol: SYMBOL,
        side,
        type: 'STOP_MARKET',
        quantity: quantity.toFixed(3),
        stopPrice: stopPrice.toFixed(2),
        reduceOnly: 'true',
        newClientOrderId: clientOrderId,
        workingType: 'MARK_PRICE',
        priceProtect: 'TRUE'
      }

      if (positionSide !== 'BOTH') {
        params.positionSide = positionSide
      }

      const result = await this.request<any>('POST', '/fapi/v1/order', params)

      const order: AsterDEXOrder = {
        orderId: result.orderId.toString(),
        clientOrderId: result.clientOrderId,
        symbol: SYMBOL,
        side,
        positionSide,
        type: 'STOP_MARKET',
        quantity,
        stopPrice,
        status: result.status,
        executedQty: new Decimal(0),
        avgPrice: new Decimal(0),
        timestamp: Date.now(),
        updateTime: result.updateTime
      }

      this.orders.set(order.orderId, order)
      return order
    } catch (err: any) {
      console.error('[AsterDEX] Stop loss failed:', err.message)
      return null
    }
  }

  // Order Execution - Take Profit
  async placeTakeProfit(
    side: OrderSide,
    quantity: Decimal,
    stopPrice: Decimal,
    positionSide: PositionSide = 'BOTH'
  ): Promise<AsterDEXOrder | null> {
    const clientOrderId = `PP_TP_${Date.now()}_${uuidv4().slice(0, 8)}`

    try {
      const params: Record<string, any> = {
        symbol: SYMBOL,
        side,
        type: 'TAKE_PROFIT_MARKET',
        quantity: quantity.toFixed(3),
        stopPrice: stopPrice.toFixed(2),
        reduceOnly: 'true',
        newClientOrderId: clientOrderId,
        workingType: 'MARK_PRICE'
      }

      if (positionSide !== 'BOTH') {
        params.positionSide = positionSide
      }

      const result = await this.request<any>('POST', '/fapi/v1/order', params)

      const order: AsterDEXOrder = {
        orderId: result.orderId.toString(),
        clientOrderId: result.clientOrderId,
        symbol: SYMBOL,
        side,
        positionSide,
        type: 'TAKE_PROFIT_MARKET',
        quantity,
        stopPrice,
        status: result.status,
        executedQty: new Decimal(0),
        avgPrice: new Decimal(0),
        timestamp: Date.now(),
        updateTime: result.updateTime
      }

      this.orders.set(order.orderId, order)
      return order
    } catch (err: any) {
      console.error('[AsterDEX] Take profit failed:', err.message)
      return null
    }
  }

  // Cancel All Open Orders
  async cancelAllOrders(): Promise<boolean> {
    try {
      await this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol: SYMBOL })
      this.orders.clear()
      return true
    } catch (err) {
      console.error('[AsterDEX] Cancel all orders failed:', err)
      return false
    }
  }

  // Close Entire Position
  async closePosition(): Promise<boolean> {
    await this.refreshPosition()
    if (!this.position) return true

    const closeSide: OrderSide = this.position.positionAmt.gt(0) ? 'SELL' : 'BUY'
    const quantity = this.position.positionAmt.abs()

    await this.cancelAllOrders()
    const order = await this.placeMarketOrder(closeSide, quantity, true)
    
    if (order && (order.status === 'FILLED' || order.status === 'PARTIALLY_FILLED')) {
      this.position = null
      return true
    }
    return false
  }

  // Execute Pyramid Trading Signal
  async executeSignal(signal: PyramidSignal): Promise<boolean> {
    if (!this.config.apiKey || !this.config.apiSecret) {
      console.error('[AsterDEX] No API credentials configured')
      return false
    }

    if (this.state !== 'CONNECTED' && this.state !== 'TRADING') {
      console.error('[AsterDEX] Trader not connected')
      return false
    }

    this.setState('TRADING')
    console.log(`[AsterDEX] Executing signal: ${signal.action} @ ${signal.price.toFixed(2)} (Level ${signal.pyramidLevel})`)

    try {
      switch (signal.action) {
        case 'OPEN_LONG': {
          await this.setLeverage(this.config.maxLeverage || MAX_LEVERAGE)
          const order = await this.placeMarketOrder('BUY', signal.quantity)
          if (order && signal.stopLoss) {
            await this.placeStopLoss('SELL', signal.quantity, signal.stopLoss)
          }
          if (order && signal.takeProfit) {
            await this.placeTakeProfit('SELL', signal.quantity, signal.takeProfit)
          }
          return order !== null
        }

        case 'OPEN_SHORT': {
          await this.setLeverage(this.config.maxLeverage || MAX_LEVERAGE)
          const order = await this.placeMarketOrder('SELL', signal.quantity)
          if (order && signal.stopLoss) {
            await this.placeStopLoss('BUY', signal.quantity, signal.stopLoss)
          }
          if (order && signal.takeProfit) {
            await this.placeTakeProfit('BUY', signal.quantity, signal.takeProfit)
          }
          return order !== null
        }

        case 'ADD_LONG': {
          const order = await this.placeMarketOrder('BUY', signal.quantity)
          if (order && signal.stopLoss) {
            await this.cancelAllOrders()
            await this.refreshPosition()
            if (this.position) {
              await this.placeStopLoss('SELL', this.position.positionAmt.abs(), signal.stopLoss)
            }
          }
          return order !== null
        }

        case 'ADD_SHORT': {
          const order = await this.placeMarketOrder('SELL', signal.quantity)
          if (order && signal.stopLoss) {
            await this.cancelAllOrders()
            await this.refreshPosition()
            if (this.position) {
              await this.placeStopLoss('BUY', this.position.positionAmt.abs(), signal.stopLoss)
            }
          }
          return order !== null
        }

        case 'UPDATE_STOP': {
          if (!this.position) return false
          await this.cancelAllOrders()
          const stopSide: OrderSide = this.position.positionAmt.gt(0) ? 'SELL' : 'BUY'
          if (signal.stopLoss) {
            await this.placeStopLoss(stopSide, this.position.positionAmt.abs(), signal.stopLoss)
          }
          return true
        }

        case 'CLOSE': {
          return this.closePosition()
        }

        default:
          return false
      }
    } catch (err: any) {
      console.error('[AsterDEX] Signal execution failed:', err.message)
      return false
    } finally {
      if (this.state === 'TRADING') {
        this.setState('CONNECTED')
      }
    }
  }

  // Risk Management
  private updateRiskMetrics(): void {
    const usdtBalance = this.balances.get('USDT')
    if (usdtBalance) {
      this.riskMetrics.availableMargin = usdtBalance.availableBalance
      this.riskMetrics.totalMarginUsed = usdtBalance.walletBalance.minus(usdtBalance.availableBalance)
      
      if (!usdtBalance.walletBalance.isZero()) {
        this.riskMetrics.marginRatio = this.riskMetrics.totalMarginUsed.div(usdtBalance.walletBalance)
      }
    }

    if (this.position) {
      this.riskMetrics.unrealizedPnl = this.position.unrealizedProfit
      
      // Calculate liquidation risk
      if (this.position.liquidationPrice.gt(0) && !this.lastPrice.isZero()) {
        const distToLiq = this.position.positionAmt.gt(0)
          ? this.lastPrice.minus(this.position.liquidationPrice).div(this.lastPrice)
          : this.position.liquidationPrice.minus(this.lastPrice).div(this.lastPrice)

        if (distToLiq.lt(0.02)) {
          this.riskMetrics.liquidationRisk = 'CRITICAL'
        } else if (distToLiq.lt(0.05)) {
          this.riskMetrics.liquidationRisk = 'HIGH'
        } else if (distToLiq.lt(0.1)) {
          this.riskMetrics.liquidationRisk = 'MEDIUM'
        } else {
          this.riskMetrics.liquidationRisk = 'LOW'
        }
      }
    }

    this.emit('riskUpdate', this.riskMetrics)
  }

  // Price Updates
  updatePrice(price: number | Decimal): void {
    this.lastPrice = price instanceof Decimal ? price : new Decimal(price)
    this.updateRiskMetrics()
  }

  // State Management
  private setState(newState: TraderState): void {
    const oldState = this.state
    this.state = newState
    this.emit('stateChange', { oldState, newState })
  }

  // Getters
  getState(): TraderState { return this.state }
  getPosition(): AsterDEXPosition | null { return this.position }
  getExecutions(): TradeExecution[] { return this.executions }
  getRiskMetrics(): RiskMetrics { return this.riskMetrics }
  getLastPrice(): Decimal { return this.lastPrice }

  getStatus() {
    return {
      state: this.state,
      position: this.position,
      lastPrice: this.lastPrice.toFixed(2),
      riskMetrics: this.riskMetrics,
      totalExecutions: this.executions.length,
      openOrders: this.orders.size
    }
  }

  // Lifecycle
  async start(): Promise<boolean> {
    if (this.state === 'TRADING' || this.state === 'CONNECTED') {
      return true
    }
    return this.initialize()
  }

  async stop(): Promise<void> {
    this.setState('STOPPING' as TraderState)
    
    if (this.listenKeyInterval) {
      clearInterval(this.listenKeyInterval)
      this.listenKeyInterval = null
    }

    if (this.userDataWs) {
      this.userDataWs.close()
      this.userDataWs = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    // Close listen key
    if (this.listenKey) {
      try {
        await this.request('DELETE', '/fapi/v1/listenKey', { listenKey: this.listenKey })
      } catch {}
    }

    this.setState('STOPPED')
    console.log('[AsterDEX] Trader stopped')
  }
}

export function createAsterDEXTrader(config: AsterDEXConfig): AsterDEXTrader {
  return new AsterDEXTrader(config)
}
