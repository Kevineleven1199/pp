export type ExchangeId = 'binance' | 'binance_us' | 'yahoo'

export type Candle = {
  exchange: ExchangeId
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
}

export type SwingType = 'high' | 'low'

export type SwingEvent = {
  id: string
  exchange: ExchangeId
  symbol: string
  baseInterval: string
  pivotLen: number
  swingType: SwingType
  openTime: number
  closeTime: number
  price: number
  features: Record<string, number | string | boolean | null>
}
