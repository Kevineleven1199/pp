import WebSocket from 'ws'

export type BinanceExchangeId = 'binance' | 'binance_us'

type BinanceWsState = {
  connected: boolean
  lastPrice?: number
  lastKlineOpenTime?: number
}

type KlineMessage = {
  exchange: BinanceExchangeId
  symbol: string
  interval: string
  openTime: number
  closeTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
  trades: number
  takerBuyBase: number
  takerBuyQuote: number
  isFinal: boolean
}

type Handlers = {
  onStatus: (status: BinanceWsState) => void
  onKline: (kline: KlineMessage) => void
}

export class BinanceKlineWs {
  private ws: WebSocket | null = null
  private state: BinanceWsState = { connected: false }
  private reconnectTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly exchange: BinanceExchangeId,
    private readonly baseWsUrl: string,
    private readonly symbolLower: string,
    private readonly interval: string,
    private readonly handlers: Handlers
  ) {}

  connect() {
    if (this.ws) return

    const url = `${this.baseWsUrl}/${this.symbolLower}@kline_${this.interval}`
    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('open', () => {
      this.state.connected = true
      this.handlers.onStatus({ ...this.state })
    })

    ws.on('close', () => {
      this.state.connected = false
      this.handlers.onStatus({ ...this.state })
      this.cleanup()
      this.scheduleReconnect()
    })

    ws.on('error', () => {
      this.state.connected = false
      this.handlers.onStatus({ ...this.state })
      this.cleanup()
      this.scheduleReconnect()
    })

    ws.on('message', (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(raw.toString()) as any
      if (!parsed?.k) return

      const k = parsed.k
      const openTime = Number(k.t)
      const closeTime = Number(k.T)
      const close = Number(k.c)

      this.state.lastPrice = close
      this.state.lastKlineOpenTime = openTime
      this.handlers.onStatus({ ...this.state })

      const msg: KlineMessage = {
        exchange: this.exchange,
        symbol: k.s,
        interval: k.i,
        openTime,
        closeTime,
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close,
        volume: Number(k.v),
        quoteVolume: Number(k.q),
        trades: Number(k.n),
        takerBuyBase: Number(k.V),
        takerBuyQuote: Number(k.Q),
        isFinal: Boolean(k.x)
      }
      this.handlers.onKline(msg)
    })
  }

  disconnect() {
    this.reconnectTimer && clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null

    if (!this.ws) return
    this.ws.close()
    this.cleanup()
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 2000)
  }

  private cleanup() {
    if (!this.ws) return
    this.ws.removeAllListeners()
    this.ws = null
  }
}
