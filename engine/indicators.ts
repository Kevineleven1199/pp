export class EMA {
  private readonly multiplier: number
  private value: number | null = null
  private count = 0

  constructor(private readonly period: number) {
    this.multiplier = 2 / (period + 1)
  }

  update(close: number): number | null {
    this.count += 1

    if (this.value === null) {
      this.value = close
    } else {
      this.value = (close - this.value) * this.multiplier + this.value
    }

    if (this.count < this.period) return null
    return this.value
  }
}

export class SMA {
  private window: number[] = []
  private sum = 0

  constructor(private readonly period: number) {}

  update(close: number): number | null {
    this.window.push(close)
    this.sum += close

    if (this.window.length > this.period) {
      const removed = this.window.shift()
      if (removed !== undefined) this.sum -= removed
    }

    if (this.window.length < this.period) return null
    return this.sum / this.period
  }
}

export class RSI {
  private prev: number | null = null
  private gains: number[] = []
  private losses: number[] = []
  private avgGain: number | null = null
  private avgLoss: number | null = null
  private count = 0

  constructor(private readonly period: number) {}

  update(close: number): number | null {
    if (this.prev === null) {
      this.prev = close
      return null
    }

    const change = close - this.prev
    this.prev = close

    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)

    this.count += 1

    if (this.avgGain === null || this.avgLoss === null) {
      this.gains.push(gain)
      this.losses.push(loss)

      if (this.count < this.period) return null

      const sumGain = this.gains.reduce((a, b) => a + b, 0)
      const sumLoss = this.losses.reduce((a, b) => a + b, 0)

      this.avgGain = sumGain / this.period
      this.avgLoss = sumLoss / this.period

      const rs = this.avgLoss === 0 ? Infinity : this.avgGain / this.avgLoss
      return 100 - 100 / (1 + rs)
    }

    this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period
    this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period

    const rs = this.avgLoss === 0 ? Infinity : this.avgGain / this.avgLoss
    return 100 - 100 / (1 + rs)
  }
}

// ATR - Average True Range (volatility)
export class ATR {
  private prevClose: number | null = null
  private trValues: number[] = []

  constructor(private readonly period: number) {}

  update(high: number, low: number, close: number): number | null {
    let tr: number
    if (this.prevClose === null) {
      tr = high - low
    } else {
      tr = Math.max(high - low, Math.abs(high - this.prevClose), Math.abs(low - this.prevClose))
    }
    this.prevClose = close
    this.trValues.push(tr)

    if (this.trValues.length > this.period) {
      this.trValues.shift()
    }

    if (this.trValues.length < this.period) return null
    return this.trValues.reduce((a, b) => a + b, 0) / this.period
  }
}

// Bollinger Bands
export class BollingerBands {
  private window: number[] = []

  constructor(private readonly period: number, private readonly stdDev: number = 2) {}

  update(close: number): { upper: number; middle: number; lower: number; pctB: number } | null {
    this.window.push(close)
    if (this.window.length > this.period) this.window.shift()
    if (this.window.length < this.period) return null

    const sum = this.window.reduce((a, b) => a + b, 0)
    const mean = sum / this.period
    const variance = this.window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / this.period
    const std = Math.sqrt(variance)

    const upper = mean + this.stdDev * std
    const lower = mean - this.stdDev * std
    const pctB = std === 0 ? 0.5 : (close - lower) / (upper - lower)

    return { upper, middle: mean, lower, pctB }
  }
}

// MACD
export class MACD {
  private ema12 = new EMA(12)
  private ema26 = new EMA(26)
  private signalEma = new EMA(9)

  update(close: number): { macd: number; signal: number; histogram: number } | null {
    const fast = this.ema12.update(close)
    const slow = this.ema26.update(close)
    if (fast === null || slow === null) return null

    const macdLine = fast - slow
    const signal = this.signalEma.update(macdLine)
    if (signal === null) return null

    return { macd: macdLine, signal, histogram: macdLine - signal }
  }
}

// Stochastic Oscillator
export class Stochastic {
  private highs: number[] = []
  private lows: number[] = []
  private kValues: number[] = []

  constructor(private readonly kPeriod: number = 14, private readonly dPeriod: number = 3) {}

  update(high: number, low: number, close: number): { k: number; d: number } | null {
    this.highs.push(high)
    this.lows.push(low)
    if (this.highs.length > this.kPeriod) {
      this.highs.shift()
      this.lows.shift()
    }
    if (this.highs.length < this.kPeriod) return null

    const highestHigh = Math.max(...this.highs)
    const lowestLow = Math.min(...this.lows)
    const k = highestHigh === lowestLow ? 50 : ((close - lowestLow) / (highestHigh - lowestLow)) * 100

    this.kValues.push(k)
    if (this.kValues.length > this.dPeriod) this.kValues.shift()

    const d = this.kValues.reduce((a, b) => a + b, 0) / this.kValues.length
    return { k, d }
  }
}

// ROC - Rate of Change (Momentum)
export class ROC {
  private window: number[] = []

  constructor(private readonly period: number = 10) {}

  update(close: number): number | null {
    this.window.push(close)
    if (this.window.length > this.period + 1) this.window.shift()
    if (this.window.length <= this.period) return null

    const prev = this.window[0]
    return prev === 0 ? 0 : ((close - prev) / prev) * 100
  }
}

// ADX - Average Directional Index (Trend Strength)
export class ADX {
  private prevHigh: number | null = null
  private prevLow: number | null = null
  private prevClose: number | null = null
  private dmPlusValues: number[] = []
  private dmMinusValues: number[] = []
  private trValues: number[] = []
  private dxValues: number[] = []

  constructor(private readonly period: number = 14) {}

  update(high: number, low: number, close: number): number | null {
    if (this.prevHigh === null || this.prevLow === null || this.prevClose === null) {
      this.prevHigh = high
      this.prevLow = low
      this.prevClose = close
      return null
    }

    const dmPlus = Math.max(high - this.prevHigh, 0)
    const dmMinus = Math.max(this.prevLow - low, 0)
    const tr = Math.max(high - low, Math.abs(high - this.prevClose), Math.abs(low - this.prevClose))

    this.dmPlusValues.push(dmPlus > dmMinus ? dmPlus : 0)
    this.dmMinusValues.push(dmMinus > dmPlus ? dmMinus : 0)
    this.trValues.push(tr)

    if (this.dmPlusValues.length > this.period) {
      this.dmPlusValues.shift()
      this.dmMinusValues.shift()
      this.trValues.shift()
    }

    this.prevHigh = high
    this.prevLow = low
    this.prevClose = close

    if (this.dmPlusValues.length < this.period) return null

    const sumTR = this.trValues.reduce((a, b) => a + b, 0)
    const sumDMPlus = this.dmPlusValues.reduce((a, b) => a + b, 0)
    const sumDMMinus = this.dmMinusValues.reduce((a, b) => a + b, 0)

    const diPlus = sumTR === 0 ? 0 : (sumDMPlus / sumTR) * 100
    const diMinus = sumTR === 0 ? 0 : (sumDMMinus / sumTR) * 100
    const diSum = diPlus + diMinus
    const dx = diSum === 0 ? 0 : (Math.abs(diPlus - diMinus) / diSum) * 100

    this.dxValues.push(dx)
    if (this.dxValues.length > this.period) this.dxValues.shift()

    return this.dxValues.reduce((a, b) => a + b, 0) / this.dxValues.length
  }
}
