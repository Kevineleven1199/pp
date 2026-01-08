import * as fs from 'fs'
import * as https from 'https'
import * as path from 'path'
import type { Candle } from './types'

export type YahooBackfillProgress = {
  state: 'idle' | 'running' | 'done' | 'error' | 'stopped'
  startedAt?: number
  finishedAt?: number
  message?: string
  symbol?: string
  daysWritten?: number
  candlesIngested?: number
  lastError?: string
}

export type YahooBackfillOptions = {
  symbol: string // 'SPY', 'NQ=F' (NQ futures), 'ES=F' (S&P futures)
  dataDir: string
  maxDays?: number
  stopSignal?: () => boolean
  onProgress?: (p: YahooBackfillProgress) => void
}

function emit(onProgress: YahooBackfillOptions['onProgress'], p: YahooBackfillProgress) {
  if (onProgress) onProgress(p)
}

function fetchYahooData(symbol: string, period1: number, period2: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1m&includePrePost=true`
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    }

    https.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }

      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

function upsertCandlesForDay(filePath: string, newCandles: Candle[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const map = new Map<number, Candle>()

  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        const c = JSON.parse(t) as Candle
        if (typeof c.openTime === 'number') {
          map.set(c.openTime, c)
        }
      } catch {}
    }
  }

  for (const c of newCandles) {
    map.set(c.openTime, c)
  }

  const openTimes = Array.from(map.keys()).sort((a, b) => a - b)
  const tmpPath = `${filePath}.tmp-${Date.now()}`

  const lines = openTimes.map((t) => JSON.stringify(map.get(t)!)).join('\n')
  fs.writeFileSync(tmpPath, lines.length ? lines + '\n' : '', 'utf8')
  fs.renameSync(tmpPath, filePath)
}

export async function runYahooBackfill(opts: YahooBackfillOptions): Promise<void> {
  const onProgress = opts.onProgress
  const symbolLower = opts.symbol.toLowerCase().replace('=f', '')
  const yahooSymbol = opts.symbol.toUpperCase()

  let progress: YahooBackfillProgress = {
    state: 'running',
    startedAt: Date.now(),
    symbol: yahooSymbol,
    daysWritten: 0,
    candlesIngested: 0
  }

  emit(onProgress, progress)

  try {
    // Yahoo Finance only provides 7 days of 1-minute data
    // We'll fetch in chunks going back
    const now = Math.floor(Date.now() / 1000)
    const maxDays = opts.maxDays ?? 7 // Yahoo limits 1m data to ~7 days
    const chunkDays = 7

    for (let dayOffset = 0; dayOffset < maxDays; dayOffset += chunkDays) {
      if (opts.stopSignal?.()) {
        progress = { ...progress, state: 'stopped', finishedAt: Date.now(), message: 'Stopped' }
        emit(onProgress, progress)
        return
      }

      const period2 = now - (dayOffset * 86400)
      const period1 = period2 - (chunkDays * 86400)

      progress = { ...progress, message: `Fetching ${yahooSymbol} data...` }
      emit(onProgress, progress)

      try {
        console.log(`[YahooBackfill] Fetching ${yahooSymbol} from ${new Date(period1 * 1000).toISOString()} to ${new Date(period2 * 1000).toISOString()}`)
        const data = await fetchYahooData(yahooSymbol, period1, period2)

        const result = data?.chart?.result?.[0]
        if (!result || !result.timestamp) {
          console.log(`[YahooBackfill] No data for ${yahooSymbol}`)
          continue
        }

        const timestamps = result.timestamp as number[]
        const quote = result.indicators?.quote?.[0]
        if (!quote) continue

        const opens = quote.open as (number | null)[]
        const highs = quote.high as (number | null)[]
        const lows = quote.low as (number | null)[]
        const closes = quote.close as (number | null)[]
        const volumes = quote.volume as (number | null)[]

        // Group by day
        const candlesByDay = new Map<string, Candle[]>()

        for (let i = 0; i < timestamps.length; i++) {
          const openTime = timestamps[i] * 1000
          const open = opens[i]
          const high = highs[i]
          const low = lows[i]
          const close = closes[i]
          const volume = volumes[i]

          if (open === null || high === null || low === null || close === null) continue

          const dateKey = new Date(openTime).toISOString().slice(0, 10)
          const candle: Candle = {
            exchange: 'yahoo',
            symbol: symbolLower,
            interval: '1m',
            openTime,
            closeTime: openTime + 60000,
            open,
            high,
            low,
            close,
            volume: volume ?? 0,
            quoteVolume: (volume ?? 0) * close,
            trades: 0,
            takerBuyBase: 0,
            takerBuyQuote: 0
          }

          const existing = candlesByDay.get(dateKey) || []
          existing.push(candle)
          candlesByDay.set(dateKey, existing)
        }

        // Write each day's candles
        for (const [dateKey, candles] of candlesByDay.entries()) {
          const filePath = path.join(opts.dataDir, 'candles', 'yahoo', symbolLower, '1m', `${dateKey}.jsonl`)
          upsertCandlesForDay(filePath, candles)
          progress.daysWritten = (progress.daysWritten ?? 0) + 1
          progress.candlesIngested = (progress.candlesIngested ?? 0) + candles.length
        }

        emit(onProgress, progress)
        console.log(`[YahooBackfill] Saved ${progress.candlesIngested} candles for ${yahooSymbol}`)

      } catch (err) {
        console.log(`[YahooBackfill] Error fetching ${yahooSymbol}:`, err)
        // Continue with next chunk
      }
    }

    progress = {
      ...progress,
      state: 'done',
      finishedAt: Date.now(),
      message: `${yahooSymbol} backfill complete`
    }
    emit(onProgress, progress)

  } catch (err) {
    progress = {
      ...progress,
      state: 'error',
      finishedAt: Date.now(),
      lastError: err instanceof Error ? err.message : String(err)
    }
    emit(onProgress, progress)
  }
}
