import { EMA, RSI, SMA, ATR, BollingerBands, MACD, Stochastic, ROC, ADX } from './indicators'
import type { Candle } from './types'

export type CandleIndicators = {
  ema6: number | null
  ema50: number | null
  sma200: number | null
  rsi14: number | null
  atr14: number | null
  bbPctB: number | null
  bbUpper: number | null
  bbLower: number | null
  macdHist: number | null
  macdSignal: number | null
  stochK: number | null
  stochD: number | null
  roc10: number | null
  adx14: number | null
}

export type SeriesPoint = CandleIndicators & { candle: Candle }

export class CandleSeries {
  private readonly ema6 = new EMA(6)
  private readonly ema50 = new EMA(50)
  private readonly sma200 = new SMA(200)
  private readonly rsi14 = new RSI(14)
  private readonly atr14 = new ATR(14)
  private readonly bb20 = new BollingerBands(20, 2)
  private readonly macd = new MACD()
  private readonly stoch = new Stochastic(14, 3)
  private readonly roc10 = new ROC(10)
  private readonly adx14 = new ADX(14)
  private readonly points: SeriesPoint[] = []

  // MEMORY LIMIT: Keep max 5000 points to prevent 88GB memory usage
  private static readonly MAX_POINTS = 5000

  push(candle: Candle): SeriesPoint {
    const atr = this.atr14.update(candle.high, candle.low, candle.close)
    const bb = this.bb20.update(candle.close)
    const macdRes = this.macd.update(candle.close)
    const stochRes = this.stoch.update(candle.high, candle.low, candle.close)
    const roc = this.roc10.update(candle.close)
    const adx = this.adx14.update(candle.high, candle.low, candle.close)

    const pt: SeriesPoint = {
      candle,
      ema6: this.ema6.update(candle.close),
      ema50: this.ema50.update(candle.close),
      sma200: this.sma200.update(candle.close),
      rsi14: this.rsi14.update(candle.close),
      atr14: atr,
      bbPctB: bb?.pctB ?? null,
      bbUpper: bb?.upper ?? null,
      bbLower: bb?.lower ?? null,
      macdHist: macdRes?.histogram ?? null,
      macdSignal: macdRes?.signal ?? null,
      stochK: stochRes?.k ?? null,
      stochD: stochRes?.d ?? null,
      roc10: roc,
      adx14: adx
    }

    this.points.push(pt)
    
    // Auto-trim to prevent memory bloat
    if (this.points.length > CandleSeries.MAX_POINTS) {
      this.points.splice(0, this.points.length - CandleSeries.MAX_POINTS)
    }
    
    return pt
  }

  get length() {
    return this.points.length
  }

  at(index: number): SeriesPoint {
    return this.points[index]
  }

  lastIndexBefore(closeTime: number): number {
    let lo = 0
    let hi = this.points.length - 1
    let ans = -1

    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.points[mid].candle.closeTime <= closeTime) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    return ans
  }

  trimToLast(maxPoints: number) {
    if (!Number.isFinite(maxPoints) || maxPoints <= 0) {
      this.points.length = 0
      return
    }

    if (this.points.length <= maxPoints) return
    this.points.splice(0, this.points.length - maxPoints)
  }

  toArray(): readonly SeriesPoint[] {
    return this.points
  }
}
