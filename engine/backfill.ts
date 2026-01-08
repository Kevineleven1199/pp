import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import * as readline from 'readline'
const unzipper: any = require('unzipper')
import type { Candle, ExchangeId } from './types'

export type BackfillProgress = {
  state: 'idle' | 'running' | 'done' | 'error' | 'stopped'
  startedAt?: number
  finishedAt?: number
  message?: string
  currentMonth?: string
  currentUrl?: string
  monthsProcessed?: number
  daysWritten?: number
  candlesIngested?: number
  lastError?: string
}

export type BackfillOptions = {
  exchange: ExchangeId
  symbol: string
  interval: string
  dataDir: string
  maxMonths?: number
  stopSignal?: () => boolean
  onProgress?: (p: BackfillProgress) => void
}

type HttpError = Error & { statusCode?: number }

function emit(onProgress: BackfillOptions['onProgress'], p: BackfillProgress) {
  onProgress?.(p)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function monthKey(year: number, month1: number): string {
  return `${year}-${pad2(month1)}`
}

function addMonths(year: number, month1: number, delta: number): { year: number; month1: number } {
  const idx = year * 12 + (month1 - 1) + delta
  const y = Math.floor(idx / 12)
  const m0 = idx % 12
  return { year: y, month1: m0 + 1 }
}

function getCandleDir(opts: BackfillOptions): string {
  const symbolLower = opts.symbol.toLowerCase()
  return path.join(opts.dataDir, 'candles', opts.exchange, symbolLower, opts.interval)
}

function getCandlePath(opts: BackfillOptions, dateKey: string): string {
  const symbolLower = opts.symbol.toLowerCase()
  return path.join(opts.dataDir, 'candles', opts.exchange, symbolLower, opts.interval, `${dateKey}.jsonl`)
}

function getEarliestLocalOpenTime(opts: BackfillOptions): number | null {
  const dir = getCandleDir(opts)
  if (!fs.existsSync(dir)) return null

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()

  if (files.length === 0) return null

  const earliestPath = path.join(dir, files[0])
  const raw = fs.readFileSync(earliestPath, 'utf8')
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0)
  if (!firstLine) return null

  try {
    const obj = JSON.parse(firstLine) as { openTime?: unknown }
    return typeof obj.openTime === 'number' ? obj.openTime : null
  } catch {
    return null
  }
}

function buildMonthlyZipUrl(exchange: ExchangeId, symbolUpper: string, interval: string, ym: string): string {
  const base =
    exchange === 'binance_us'
      ? 'https://data.binance.us/public_data/spot'
      : 'https://data.binance.vision/data/spot'

  return `${base}/monthly/klines/${symbolUpper}/${interval}/${symbolUpper}-${interval}-${ym}.zip`
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PricePerfect/1.0)',
        'Accept': '*/*'
      }
    }

    const req = https.request(options, (res) => {
      const status = res.statusCode ?? 0

      if (
        (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) &&
        res.headers.location
      ) {
        res.resume()
        const redirected = new URL(res.headers.location, u).toString()
        downloadFile(redirected, destPath).then(resolve).catch(reject)
        return
      }

      if (status !== 200) {
        res.resume()
        const err: HttpError = new Error(`HTTP ${status} ${res.statusMessage ?? ''}`.trim())
        err.statusCode = status
        reject(err)
        return
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      const out = fs.createWriteStream(destPath)

      out.on('finish', () => {
        console.log('[Backfill] Saved ZIP to', destPath)
        resolve()
      })
      out.on('error', (err) => {
        console.log('[Backfill] Write error:', err.message)
        reject(err)
      })
      res.on('error', reject)

      res.pipe(out)
    })

    req.on('error', (err) => {
      console.log('[Backfill] Request error:', err.message)
      reject(err)
    })
    req.end()
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
      } catch {
      }
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

async function ingestZip(opts: BackfillOptions, zipPath: string, onProgress: BackfillOptions['onProgress'], p: BackfillProgress) {
  const symbolUpper = opts.symbol.toUpperCase()

  const directory = await unzipper.Open.file(zipPath)
  const csvFiles = directory.files.filter((f: any) => String(f?.path ?? '').toLowerCase().endsWith('.csv'))

  if (csvFiles.length === 0) {
    throw new Error('ZIP contained no CSV files')
  }

  let candlesIngested = p.candlesIngested ?? 0
  let daysWritten = p.daysWritten ?? 0

  for (const csv of csvFiles) {
    const stream = await csv.stream()
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    let currentDateKey: string | null = null
    let dayCandles: Candle[] = []

    const flush = () => {
      if (!currentDateKey || dayCandles.length === 0) return
      upsertCandlesForDay(getCandlePath(opts, currentDateKey), dayCandles)
      daysWritten += 1
      dayCandles = []
      emit(onProgress, { ...p, state: 'running', daysWritten, candlesIngested })
    }

    for await (const line of rl) {
      if (opts.stopSignal?.()) {
        rl.close()
        return { candlesIngested, daysWritten, stopped: true }
      }

      const t = line.trim()
      if (!t) continue
      const cols = t.split(',')
      if (cols.length < 11) continue

      let openTime = Number(cols[0])
      const open = Number(cols[1])
      const high = Number(cols[2])
      const low = Number(cols[3])
      const close = Number(cols[4])
      const volume = Number(cols[5])
      let closeTime = Number(cols[6])
      const quoteVolume = Number(cols[7])
      const trades = Number(cols[8])
      const takerBuyBase = Number(cols[9])
      const takerBuyQuote = Number(cols[10])

      if (!Number.isFinite(openTime)) continue

      if (openTime < 1e12) {
        openTime = openTime * 1000
        closeTime = closeTime * 1000
      }

      const candle: Candle = {
        exchange: opts.exchange,
        symbol: symbolUpper,
        interval: opts.interval,
        openTime,
        closeTime,
        open,
        high,
        low,
        close,
        volume,
        quoteVolume,
        trades,
        takerBuyBase,
        takerBuyQuote
      }

      const dateKey = new Date(openTime).toISOString().slice(0, 10)
      if (currentDateKey === null) {
        currentDateKey = dateKey
      }

      if (dateKey !== currentDateKey) {
        flush()
        currentDateKey = dateKey
      }

      dayCandles.push(candle)
      candlesIngested += 1
    }

    flush()
  }

  try {
    fs.unlinkSync(zipPath)
  } catch {
  }

  return { candlesIngested, daysWritten, stopped: false }
}

export async function runBackfill(opts: BackfillOptions): Promise<void> {
  const onProgress = opts.onProgress

  let progress: BackfillProgress = {
    state: 'running',
    startedAt: Date.now(),
    monthsProcessed: 0,
    daysWritten: 0,
    candlesIngested: 0
  }

  emit(onProgress, progress)

  try {
    emit(onProgress, { ...progress, message: 'Scanning local candle store…' })
    console.log('[Backfill] Starting backfill for', opts.exchange, opts.symbol, opts.interval)

    const earliestOpenTime = getEarliestLocalOpenTime(opts)
    const now = new Date()

    let year: number
    let month1: number

    if (earliestOpenTime !== null) {
      const d = new Date(earliestOpenTime)
      year = d.getUTCFullYear()
      month1 = d.getUTCMonth() + 1
      year = Math.max(2017, Math.min(2030, year))
      ;({ year, month1 } = addMonths(year, month1, -1))
      console.log('[Backfill] Found existing data, starting from', year, month1)
    } else {
      year = 2024
      month1 = 12
      console.log('[Backfill] No existing data, starting from', year, month1)
    }

    const symbolUpper = opts.symbol.toUpperCase()

    const tmpDir = path.join(opts.dataDir, 'tmp', 'backfill')
    fs.mkdirSync(tmpDir, { recursive: true })

    const maxMonths = Math.max(1, opts.maxMonths ?? 600)
    let consecutiveNotFound = 0
    let foundAny = false

    for (let i = 0; i < maxMonths; i++) {
      if (opts.stopSignal?.()) {
        progress = { ...progress, state: 'stopped', finishedAt: Date.now(), message: 'Stopped' }
        emit(onProgress, progress)
        return
      }

      const ym = monthKey(year, month1)
      const url = buildMonthlyZipUrl(opts.exchange, symbolUpper, opts.interval, ym)
      const zipPath = path.join(tmpDir, `${symbolUpper}-${opts.interval}-${ym}.zip`)

      progress = {
        ...progress,
        state: 'running',
        currentMonth: ym,
        currentUrl: url,
        message: `Downloading ${ym}…`
      }
      emit(onProgress, progress)

      try {
        console.log('[Backfill] Downloading', url)
        await downloadFile(url, zipPath)
        console.log('[Backfill] Downloaded', ym)
      } catch (err) {
        const e = err as HttpError
        console.log('[Backfill] Download error for', ym, ':', e?.statusCode || e?.message)
        if (e?.statusCode === 404) {
          consecutiveNotFound += 1
          progress = {
            ...progress,
            message: `No data for ${ym} (404)`
          }
          emit(onProgress, progress)

          // Stop after 3 consecutive 404s if we've found data, or 12 if we haven't (to skip years without data faster)
          const maxConsecutive = foundAny ? 3 : 12
          if (consecutiveNotFound >= maxConsecutive) {
            progress = {
              ...progress,
              state: 'done',
              finishedAt: Date.now(),
              message: foundAny ? 'Backfill complete' : 'No historical data found for this symbol/timeframe'
            }
            emit(onProgress, progress)
            return
          }

          ;({ year, month1 } = addMonths(year, month1, -1))
          continue
        }

        throw err
      }

      foundAny = true
      consecutiveNotFound = 0

      progress = {
        ...progress,
        message: `Ingesting ${ym}…`
      }
      emit(onProgress, progress)

      const ingestRes = await ingestZip(opts, zipPath, onProgress, progress)
      progress = {
        ...progress,
        candlesIngested: ingestRes.candlesIngested,
        daysWritten: ingestRes.daysWritten
      }

      if (ingestRes.stopped) {
        progress = { ...progress, state: 'stopped', finishedAt: Date.now(), message: 'Stopped' }
        emit(onProgress, progress)
        return
      }

      progress = {
        ...progress,
        monthsProcessed: (progress.monthsProcessed ?? 0) + 1,
        message: `Finished ${ym}`
      }
      emit(onProgress, progress)

      ;({ year, month1 } = addMonths(year, month1, -1))
    }

    progress = {
      ...progress,
      state: 'done',
      finishedAt: Date.now(),
      message: 'Backfill complete (max months reached)'
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
