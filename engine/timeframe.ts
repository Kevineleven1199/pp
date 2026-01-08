import type { Candle } from './types'

export function timeframeToMs(interval: string): number {
  const m = interval.match(/^(\d+)([smhdw])$/i)
  if (!m) throw new Error(`Unsupported interval: ${interval}`)

  const n = Number(m[1])
  const unit = m[2].toLowerCase()

  switch (unit) {
    case 's':
      return n * 1000
    case 'm':
      return n * 60 * 1000
    case 'h':
      return n * 60 * 60 * 1000
    case 'd':
      return n * 24 * 60 * 60 * 1000
    case 'w':
      return n * 7 * 24 * 60 * 60 * 1000
    default:
      throw new Error(`Unsupported interval: ${interval}`)
  }
}

export class TimeframeBuilder {
  private readonly ms: number
  private current: Candle | null = null

  constructor(private readonly interval: string) {
    this.ms = timeframeToMs(interval)
  }

  update(base: Candle): Candle | null {
    const bucketOpenTime = Math.floor(base.openTime / this.ms) * this.ms

    if (!this.current || this.current.openTime !== bucketOpenTime) {
      const closed = this.current

      this.current = {
        exchange: base.exchange,
        symbol: base.symbol,
        interval: this.interval,
        openTime: bucketOpenTime,
        closeTime: bucketOpenTime + this.ms - 1,
        open: base.open,
        high: base.high,
        low: base.low,
        close: base.close,
        volume: base.volume,
        quoteVolume: base.quoteVolume,
        trades: base.trades,
        takerBuyBase: base.takerBuyBase,
        takerBuyQuote: base.takerBuyQuote
      }

      return closed
    }

    this.current.high = Math.max(this.current.high, base.high)
    this.current.low = Math.min(this.current.low, base.low)
    this.current.close = base.close
    this.current.volume += base.volume
    this.current.quoteVolume += base.quoteVolume
    this.current.trades += base.trades
    this.current.takerBuyBase += base.takerBuyBase
    this.current.takerBuyQuote += base.takerBuyQuote

    return null
  }

  getCurrent(): Candle | null {
    return this.current
  }
}
