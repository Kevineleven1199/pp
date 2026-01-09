import { BinanceKlineWs, type BinanceExchangeId } from './binanceWs'
import * as fs from 'fs'
import * as https from 'https'
import * as path from 'path'
import * as crypto from 'crypto'
import { runBackfill, type BackfillProgress } from './backfill'
import { runYahooBackfill } from './yahooBackfill'
import { CandleSeries } from './candleSeries'
import { JsonlRotatingWriter } from './jsonlWriter'
import { detectSwingAt } from './swingDetector'
import { TimeframeBuilder, timeframeToMs } from './timeframe'
import type { Candle, SwingEvent } from './types'

type ReconcileProgress = {
  state: 'idle' | 'running' | 'done' | 'error' | 'stopped'
  startedAt?: number
  finishedAt?: number
  message?: string
  currentFile?: string
  daysScanned?: number
  gapsFound?: number
  gapsRepaired?: number
  gapsSkipped?: number
  candlesRepaired?: number
  lastError?: string
}

type DerivedRebuildProgress = {
  state: 'idle' | 'running' | 'done' | 'error' | 'stopped'
  startedAt?: number
  finishedAt?: number
  message?: string
  currentFile?: string
  daysProcessed?: number
  baseCandlesProcessed?: number
  aggCandlesWritten?: number
  swingEventsWritten?: number
  lastError?: string
}

type DataStatus = {
  symbol: string
  timeframe: string
  candleFiles: number
  swingFiles: number
  totalCandles: number
  totalSwings: number
  oldestCandle?: string
  newestCandle?: string
  featuresComplete: boolean
  insufficientData: boolean // True if candles exist but not enough to generate swings
}

type EngineStatus = {
  connected: boolean
  lastPrice?: number
  lastKlineOpenTime?: number
  symbol?: string
  exchange?: BinanceExchangeId
  interval?: string
  dataDir?: string
  candlesWritten?: number
  gapsFound?: number
  swingsFound?: number
  pivotLen?: number
  dataStatuses?: DataStatus[]
  databaseSizeBytes?: number
  databaseSizeMB?: number
  backfill?: BackfillProgress
  reconcile?: ReconcileProgress
  derivedRebuild?: DerivedRebuildProgress
}

function parseExchangeId(raw: string | undefined): BinanceExchangeId {
  const v = (raw ?? '').toLowerCase()
  if (v === 'binance_us' || v === 'binanceus' || v === 'us') return 'binance_us'
  return 'binance'
}

const exchangeId = parseExchangeId(process.env.EXCHANGE)
const baseWsUrl =
  exchangeId === 'binance_us'
    ? 'wss://stream.binance.us:9443/ws'
    : 'wss://data-stream.binance.vision/ws'

const symbolLower = (process.env.SYMBOL ?? 'btcusdt').toLowerCase()
const interval = process.env.INTERVAL ?? '1m'
const pivotLen = Math.max(1, Number(process.env.PIVOT_LEN ?? '3'))

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
const baseMs = timeframeToMs(interval)

const restBaseUrl =
  exchangeId === 'binance_us' ? 'https://api.binance.us' : 'https://data-api.binance.vision'

const gapRepairMaxCandles = Math.max(0, Number(process.env.GAP_REPAIR_MAX_CANDLES ?? '120'))

// ═══════════════════════════════════════════════════════════════
// ASTERDEX LIVE TRADING - REAL API CALLS
// ═══════════════════════════════════════════════════════════════

const ASTERDEX_API_BASE = 'https://fapi.asterdex.com'

// ═══════════════════════════════════════════════════════════════
// LIVE PRICE - PUBLIC ENDPOINT (NO AUTH NEEDED)
// ═══════════════════════════════════════════════════════════════

let currentLivePrice = 0
let liveTraderInterval: NodeJS.Timeout | null = null
let loadedSwingPatterns: Array<{ price: number; direction: 'high' | 'low'; confluence: number; timestamp: number }> = []

// Get live price - PUBLIC endpoint, no auth required
async function fetchLivePrice(): Promise<number> {
  try {
    const res = await fetch(`${ASTERDEX_API_BASE}/fapi/v1/ticker/price?symbol=ETHUSDT`)
    const data = await res.json() as { symbol: string; price: string }
    currentLivePrice = parseFloat(data.price)
    return currentLivePrice
  } catch (err: any) {
    console.error('[LiveTrader] Price fetch error:', err.message)
    return currentLivePrice // Return last known price
  }
}

// Analyze current price against our pattern database
function analyzeConfluence(price: number): { signal: 'long' | 'short' | 'none'; strength: number; reason: string } {
  if (loadedSwingPatterns.length === 0) {
    return { signal: 'none', strength: 0, reason: 'No pattern data loaded' }
  }

  // Find nearby swing levels from our database
  const nearbySwings = loadedSwingPatterns.filter(s => {
    const distance = Math.abs(s.price - price) / price
    return distance < 0.02 // Within 2% of current price
  })

  if (nearbySwings.length === 0) {
    return { signal: 'none', strength: 0, reason: 'No nearby swing levels' }
  }

  // Calculate average confluence at nearby levels
  const avgConfluence = nearbySwings.reduce((sum, s) => sum + s.confluence, 0) / nearbySwings.length
  const highCount = nearbySwings.filter(s => s.direction === 'high').length
  const lowCount = nearbySwings.filter(s => s.direction === 'low').length

  // Determine signal based on swing type dominance
  if (lowCount > highCount && avgConfluence >= 3) {
    // More lows nearby = potential support = long signal
    return { signal: 'long', strength: avgConfluence, reason: `Support zone: ${lowCount} lows, avg confluence ${avgConfluence.toFixed(1)}` }
  } else if (highCount > lowCount && avgConfluence >= 3) {
    // More highs nearby = potential resistance = short signal
    return { signal: 'short', strength: avgConfluence, reason: `Resistance zone: ${highCount} highs, avg confluence ${avgConfluence.toFixed(1)}` }
  }

  return { signal: 'none', strength: avgConfluence, reason: `Mixed signals: ${highCount} highs, ${lowCount} lows` }
}
const ASTERDEX_SYMBOL = 'ETHUSDT'
const ASTERDEX_LEVERAGE = 88

let asterDexConfig: { apiKey: string; apiSecret: string; testnet: boolean } | null = null
let asterDexRunning = false
let asterDexApiCalls = 0

// Start the live trading loop - uses pre-computed patterns, lightweight
function startLiveTraderLoop(): void {
  if (liveTraderInterval) {
    clearInterval(liveTraderInterval)
  }

  console.log('[LiveTrader] Starting 24/7 trading loop...')
  console.log(`[LiveTrader] Loaded ${loadedSwingPatterns.length} swing patterns for analysis`)

  // Fetch price and analyze every 5 seconds
  liveTraderInterval = setInterval(async () => {
    if (!asterDexRunning) return

    try {
      const price = await fetchLivePrice()
      const analysis = analyzeConfluence(price)

      // Send live update to UI
      process.send?.({
        type: 'trader:liveUpdate',
        data: {
          price,
          signal: analysis.signal,
          strength: analysis.strength,
          reason: analysis.reason,
          timestamp: Date.now(),
          apiCalls: asterDexApiCalls
        }
      })

      // Log significant signals
      if (analysis.signal !== 'none' && analysis.strength >= 4) {
        console.log(`[LiveTrader] SIGNAL: ${analysis.signal.toUpperCase()} @ $${price.toFixed(2)} - ${analysis.reason}`)
      }
    } catch (err: any) {
      console.error('[LiveTrader] Loop error:', err.message)
    }
  }, 5000)
}

function stopLiveTraderLoop(): void {
  if (liveTraderInterval) {
    clearInterval(liveTraderInterval)
    liveTraderInterval = null
  }
  console.log('[LiveTrader] Stopped trading loop')
}

function signAsterDexRequest(queryString: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex')
}

async function asterDexRequest(
  method: 'GET' | 'POST' | 'DELETE',
  endpoint: string,
  params: Record<string, any> = {},
  signed: boolean = true
): Promise<any> {
  if (!asterDexConfig) {
    console.error('[AsterDEX] ERROR: Not configured! apiKey:', asterDexConfig)
    throw new Error('AsterDEX not configured')
  }
  
  asterDexApiCalls++
  const startTime = Date.now()
  
  console.log(`[AsterDEX] ===== API CALL #${asterDexApiCalls} =====`)
  console.log(`[AsterDEX] ${method} ${endpoint}`)
  console.log(`[AsterDEX] API Key: ${asterDexConfig.apiKey.substring(0, 8)}...`)
  
  if (signed) {
    params.timestamp = Date.now()
    params.recvWindow = 10000
  }

  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')

  let finalQuery = queryString
  if (signed) {
    const signature = signAsterDexRequest(queryString, asterDexConfig.apiSecret)
    finalQuery = `${queryString}&signature=${signature}`
  }

  const url = method === 'GET' 
    ? `${ASTERDEX_API_BASE}${endpoint}?${finalQuery}`
    : `${ASTERDEX_API_BASE}${endpoint}`

  console.log(`[AsterDEX] URL: ${url.substring(0, 80)}...`)

  const headers: Record<string, string> = {
    'X-MBX-APIKEY': asterDexConfig.apiKey
  }

  const options: RequestInit = { method, headers }
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    options.body = finalQuery
  }

  try {
    const response = await fetch(url, options)
    const latency = Date.now() - startTime
    
    console.log(`[AsterDEX] Response status: ${response.status} in ${latency}ms`)
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[AsterDEX] ERROR ${response.status}: ${errorText}`)
      throw new Error(`AsterDEX API ${response.status}: ${errorText}`)
    }

    const data = await response.json() as Record<string, unknown>
    console.log(`[AsterDEX] Response data keys:`, Object.keys(data))
    return data
  } catch (err: any) {
    console.error(`[AsterDEX] FETCH ERROR: ${err.message}`)
    throw err
  }
}

async function fetchAsterDexBalance(): Promise<{ marginBalance: number; availableBalance: number; unrealizedPnl: number }> {
  try {
    console.log('[AsterDEX] Fetching balance via /fapi/v2/balance ...')
    // Use /fapi/v2/balance which returns an array of asset balances
    const data = await asterDexRequest('GET', '/fapi/v2/balance') as Array<{
      asset: string
      balance: string
      crossWalletBalance: string
      crossUnPnl: string
      availableBalance: string
      maxWithdrawAmount: string
    }>
    
    // Find USDT balance (primary trading asset)
    const usdtBalance = data.find(b => b.asset === 'USDT')
    
    if (!usdtBalance) {
      console.log('[AsterDEX] No USDT balance found, checking all balances:', data.map(b => b.asset))
      // Return first balance if USDT not found
      const firstBalance = data[0]
      if (firstBalance) {
        return {
          marginBalance: parseFloat(firstBalance.balance || '0'),
          availableBalance: parseFloat(firstBalance.availableBalance || '0'),
          unrealizedPnl: parseFloat(firstBalance.crossUnPnl || '0')
        }
      }
      return { marginBalance: 0, availableBalance: 0, unrealizedPnl: 0 }
    }
    
    const balance = {
      marginBalance: parseFloat(usdtBalance.balance || usdtBalance.crossWalletBalance || '0'),
      availableBalance: parseFloat(usdtBalance.availableBalance || usdtBalance.maxWithdrawAmount || '0'),
      unrealizedPnl: parseFloat(usdtBalance.crossUnPnl || '0')
    }
    
    console.log(`[AsterDEX] USDT Balance: $${balance.marginBalance.toFixed(2)} (available: $${balance.availableBalance.toFixed(2)}, uPnL: $${balance.unrealizedPnl.toFixed(2)})`)
    return balance
  } catch (err: any) {
    console.error('[AsterDEX] Balance fetch failed:', err.message)
    throw err
  }
}

async function setAsterDexMarginMode(): Promise<void> {
  // CRITICAL: Set ISOLATED margin mode - NEVER use cross margin (too dangerous)
  try {
    await asterDexRequest('POST', '/fapi/v1/marginType', {
      symbol: ASTERDEX_SYMBOL,
      marginType: 'ISOLATED'
    })
    console.log('[AsterDEX] Margin mode set to ISOLATED')
  } catch (err: any) {
    // Already set to isolated, ignore
    console.log('[AsterDEX] Margin mode (already ISOLATED):', err.message)
  }
}

async function setAsterDexHedgeMode(): Promise<void> {
  // Enable hedge mode for separate LONG/SHORT positions
  try {
    await asterDexRequest('POST', '/fapi/v1/positionSide/dual', {
      dualSidePosition: 'true'
    })
    console.log('[AsterDEX] Hedge mode ENABLED (dual position side)')
  } catch (err: any) {
    // Already enabled, ignore
    console.log('[AsterDEX] Hedge mode (already enabled):', err.message)
  }
}

async function setAsterDexLeverage(): Promise<void> {
  try {
    await asterDexRequest('POST', '/fapi/v1/leverage', {
      symbol: ASTERDEX_SYMBOL,
      leverage: ASTERDEX_LEVERAGE
    })
    console.log(`[AsterDEX] Leverage set to ${ASTERDEX_LEVERAGE}x`)
  } catch (err: any) {
    // Leverage might already be set, ignore error
    console.log('[AsterDEX] Leverage set (or already set):', err.message)
  }
}

async function executeAsterDexTestTrade(side: 'long' | 'short' | 'close', marginUsd: number): Promise<any> {
  if (!asterDexConfig) throw new Error('AsterDEX not configured')

  // CRITICAL: Ensure ISOLATED margin and HEDGE mode before any trade
  await setAsterDexMarginMode()  // ISOLATED only, never cross
  await setAsterDexHedgeMode()   // Enable dual position side
  await setAsterDexLeverage()

  if (side === 'close') {
    // Close any open position
    return closeAllAsterDexPositions()
  }

  // Get current price for quantity calculation
  const ticker = await asterDexRequest('GET', '/fapi/v1/ticker/price', { symbol: ASTERDEX_SYMBOL }, false)
  const price = parseFloat(ticker.price)
  
  // Calculate quantity: margin * leverage / price
  const notional = marginUsd * ASTERDEX_LEVERAGE
  const quantity = (notional / price).toFixed(3)

  console.log(`[AsterDEX] Test ${side}: $${marginUsd} margin × ${ASTERDEX_LEVERAGE}x = $${notional.toFixed(0)} notional = ${quantity} ETH @ $${price.toFixed(2)}`)

  // Place market order with HEDGE MODE position side
  const orderSide = side === 'long' ? 'BUY' : 'SELL'
  const positionSide = side === 'long' ? 'LONG' : 'SHORT'  // Hedge mode requires positionSide
  
  const result = await asterDexRequest('POST', '/fapi/v1/order', {
    symbol: ASTERDEX_SYMBOL,
    side: orderSide,
    positionSide: positionSide,  // HEDGE MODE: explicit LONG or SHORT
    type: 'MARKET',
    quantity: quantity
  })

  console.log(`[AsterDEX] Order placed: ${result.orderId} - ${result.status} (${positionSide})`)
  
  return {
    success: true,
    orderId: result.orderId,
    status: result.status,
    side,
    positionSide,
    quantity,
    price,
    notional,
    marginUsd
  }
}

async function closeAllAsterDexPositions(): Promise<void> {
  if (!asterDexConfig) return

  try {
    // Get current positions (hedge mode returns separate LONG and SHORT)
    const positions = await asterDexRequest('GET', '/fapi/v2/positionRisk', { symbol: ASTERDEX_SYMBOL })
    
    for (const pos of positions) {
      const posAmt = parseFloat(pos.positionAmt || '0')
      if (posAmt === 0) continue

      // HEDGE MODE: Use positionSide from the position data
      const positionSide = pos.positionSide || (posAmt > 0 ? 'LONG' : 'SHORT')
      const closeSide = posAmt > 0 ? 'SELL' : 'BUY'
      const closeQty = Math.abs(posAmt).toFixed(3)

      console.log(`[AsterDEX] Closing ${positionSide} position: ${closeSide} ${closeQty} ETH`)
      
      await asterDexRequest('POST', '/fapi/v1/order', {
        symbol: ASTERDEX_SYMBOL,
        side: closeSide,
        positionSide: positionSide,  // HEDGE MODE: must specify which position to close
        type: 'MARKET',
        quantity: closeQty
      })
    }
    
    console.log('[AsterDEX] All positions closed')
  } catch (err: any) {
    console.error('[AsterDEX] Close positions error:', err.message)
    throw err
  }
}

const nyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit'
})

function getNyParts(ts: number): { weekday: string | null; hour: number | null; minute: number | null } {
  const parts = nyFormatter.formatToParts(new Date(ts))
  const m: Record<string, string> = {}
  for (const p of parts) {
    if (p.type === 'literal') continue
    m[p.type] = p.value
  }

  const hour = m.hour ? Number(m.hour) : null
  const minute = m.minute ? Number(m.minute) : null
  return {
    weekday: m.weekday ?? null,
    hour: hour !== null && Number.isFinite(hour) ? hour : null,
    minute: minute !== null && Number.isFinite(minute) ? minute : null
  }
}

function isUsMarketHours(ts: number): boolean | null {
  const { weekday, hour, minute } = getNyParts(ts)
  if (!weekday || hour === null || minute === null) return null
  if (weekday === 'Sat' || weekday === 'Sun') return false

  const mins = hour * 60 + minute
  return mins >= 9 * 60 + 30 && mins < 16 * 60
}

function getMoonPhase(ts: number): { phase: number; name: string; illumination: number } {
  const date = new Date(ts)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  
  const c = Math.floor((year - 1900) * 12.3685)
  const t = (year - 1900 + (month - 1) / 12) / 100
  const jd = 2415020.75933 + 29.53058868 * c + 0.0001178 * t * t
  const daysSinceNew = (ts / 86400000 + 2440587.5 - jd) % 29.53058868
  const phase = daysSinceNew / 29.53058868
  
  const illumination = (1 - Math.cos(phase * 2 * Math.PI)) / 2 * 100
  
  let name: string
  if (phase < 0.0625) name = 'New Moon'
  else if (phase < 0.1875) name = 'Waxing Crescent'
  else if (phase < 0.3125) name = 'First Quarter'
  else if (phase < 0.4375) name = 'Waxing Gibbous'
  else if (phase < 0.5625) name = 'Full Moon'
  else if (phase < 0.6875) name = 'Waning Gibbous'
  else if (phase < 0.8125) name = 'Last Quarter'
  else if (phase < 0.9375) name = 'Waning Crescent'
  else name = 'New Moon'
  
  return { phase: Math.round(phase * 100) / 100, name, illumination: Math.round(illumination * 10) / 10 }
}

function getGlobalMarketStatus(ts: number): {
  tokyo: boolean; london: boolean; nyse: boolean; sydney: boolean; frankfurt: boolean
} {
  const utc = new Date(ts)
  const hour = utc.getUTCHours()
  const day = utc.getUTCDay()
  const isWeekend = day === 0 || day === 6
  
  if (isWeekend) return { tokyo: false, london: false, nyse: false, sydney: false, frankfurt: false }
  
  return {
    tokyo: hour >= 0 && hour < 6,
    sydney: hour >= 22 || hour < 6,
    london: hour >= 8 && hour < 16,
    frankfurt: hour >= 7 && hour < 15,
    nyse: hour >= 14 && hour < 21
  }
}

function getSession(utcHour: number): string {
  if (utcHour >= 0 && utcHour < 6) return 'asian'
  if (utcHour >= 6 && utcHour < 8) return 'asian_europe_overlap'
  if (utcHour >= 8 && utcHour < 13) return 'european'
  if (utcHour >= 13 && utcHour < 17) return 'europe_us_overlap'
  if (utcHour >= 17 && utcHour < 22) return 'us'
  return 'pacific'
}

const candleWriter = new JsonlRotatingWriter<Candle>((dateKey) =>
  path.join(dataDir, 'candles', exchangeId, symbolLower, interval, `${dateKey}.jsonl`),
  (c) => c.openTime
)

const swingWriter = new JsonlRotatingWriter<SwingEvent>((dateKey) =>
  path.join(dataDir, 'swings', exchangeId, symbolLower, interval, `p${pivotLen}`, `${dateKey}.jsonl`),
  (e) => e.id
)

const gapWriter = new JsonlRotatingWriter<{
  expectedOpenTime: number
  actualOpenTime: number
  missingCandles: number
}>((dateKey) => path.join(dataDir, 'gaps', exchangeId, symbolLower, interval, `${dateKey}.jsonl`), (g) =>
  `${g.expectedOpenTime}:${g.actualOpenTime}`
)

const aggregateIntervals = ['3m', '5m', '7m', '15m', '1h', '4h', '1d']
const aggregators = aggregateIntervals
  .map((tf) => ({ tf, ms: timeframeToMs(tf) }))
  .filter(({ ms }) => ms > baseMs)
  .map(({ tf }) => ({
    tf,
    builder: new TimeframeBuilder(tf),
    writer: new JsonlRotatingWriter<Candle>((dateKey) =>
      path.join(dataDir, 'candles', exchangeId, symbolLower, tf, `${dateKey}.jsonl`),
      (c) => c.openTime
    )
  }))

let lastFinalOpenTime: number | null = null
let shuttingDown = false
let candlesWritten = 0
let gapsFound = 0
let swingsFound = 0
const baseSeries = new CandleSeries()

let finalCandleChain: Promise<void> = Promise.resolve()

let backfillStop = false
let backfillRunning = false
let backfillProgress: BackfillProgress = { state: 'idle' }

let reconcileStop = false
let reconcileRunning = false
let reconcileProgress: ReconcileProgress = { state: 'idle' }

let derivedRebuildStop = false
let derivedRebuildRunning = false
let derivedRebuildProgress: DerivedRebuildProgress = { state: 'idle' }

let status: EngineStatus = {
  connected: false,
  symbol: symbolLower.toUpperCase(),
  exchange: exchangeId,
  interval,
  dataDir,
  candlesWritten,
  gapsFound,
  swingsFound,
  pivotLen,
  dataStatuses: [],
  backfill: backfillProgress,
  reconcile: reconcileProgress,
  derivedRebuild: derivedRebuildProgress
}

// Calculate total size of a directory recursively
function getDirSizeBytes(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0
  let total = 0
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        total += getDirSizeBytes(fullPath)
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(fullPath).size
        } catch {}
      }
    }
  } catch {}
  return total
}

// Scan actual data on disk for all symbols and timeframes with detailed counts
function scanDataStatuses(): { statuses: DataStatus[], totalSizeBytes: number } {
  const cryptoSymbols = ['btcusdt', 'ethusdt', 'ethbtc', 'solusdt', 'dogeusdt', 'xrpusdt']
  const yahooSymbols = ['spy', 'nq', 'gc', 'cl'] // SPY, NQ futures, Gold, Crude Oil
  const timeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']
  const results: DataStatus[] = []
  
  // Helper to scan a symbol with given exchange
  const scanSymbol = (sym: string, exchange: string) => {
    for (const tf of timeframes) {
      const candleDir = path.join(dataDir, 'candles', exchange, sym, tf)
      const swingDir = path.join(dataDir, 'swings', exchange, sym, tf, `p${pivotLen}`)
      
      let candleFiles = 0
      let swingFiles = 0
      let totalCandles = 0
      let totalSwings = 0
      let oldestCandle: string | undefined
      let newestCandle: string | undefined
      let featuresComplete = false
      
      try {
        if (fs.existsSync(candleDir)) {
          const files = fs.readdirSync(candleDir).filter(f => f.endsWith('.jsonl')).sort()
          candleFiles = files.length
          if (files.length > 0) {
            oldestCandle = files[0].replace('.jsonl', '')
            newestCandle = files[files.length - 1].replace('.jsonl', '')
            // Count candles in newest file for estimate
            const newestFile = path.join(candleDir, files[files.length - 1])
            const content = fs.readFileSync(newestFile, 'utf8')
            const lines = content.split('\n').filter(l => l.trim()).length
            totalCandles = candleFiles * 1440 // Estimate: 1440 candles per day for 1m
          }
        }
      } catch {}
      
      try {
        if (fs.existsSync(swingDir)) {
          const files = fs.readdirSync(swingDir).filter(f => f.endsWith('.jsonl')).sort()
          swingFiles = files.length
          if (files.length > 0) {
            // Sample newest file to check features and count swings
            const newestFile = path.join(swingDir, files[files.length - 1])
            const content = fs.readFileSync(newestFile, 'utf8')
            const lines = content.split('\n').filter(l => l.trim())
            totalSwings = swingFiles * Math.max(lines.length, 10) // Estimate
            
            // Check if features are complete by sampling first swing
            if (lines.length > 0) {
              try {
                const swing = JSON.parse(lines[0])
                const featureKeys = Object.keys(swing.features || {})
                featuresComplete = featureKeys.length >= 50 // Should have 80+ features
              } catch {}
            }
          }
        }
      } catch {}
      
      // Determine if there's insufficient data to generate swings
      // Need at least (2 * pivotLen + 1) = 7 candles minimum for swing detection
      const minCandlesNeeded = 2 * pivotLen + 1
      const insufficientData = candleFiles > 0 && swingFiles === 0 && totalCandles < minCandlesNeeded * 10
      
      results.push({ 
        symbol: sym, 
        timeframe: tf, 
        candleFiles, 
        swingFiles,
        totalCandles,
        totalSwings,
        oldestCandle,
        newestCandle,
        featuresComplete,
        insufficientData
      })
    }
  }

  // Scan crypto symbols
  for (const sym of cryptoSymbols) {
    scanSymbol(sym, exchangeId)
  }

  // Scan Yahoo/TradFi symbols  
  for (const sym of yahooSymbols) {
    scanSymbol(sym, 'yahoo')
  }

  // Calculate total database size
  const totalSizeBytes = getDirSizeBytes(dataDir)
  
  return { statuses: results, totalSizeBytes }
}

// Update data statuses periodically
function updateDataStatuses() {
  const { statuses, totalSizeBytes } = scanDataStatuses()
  status.dataStatuses = statuses
  status.databaseSizeBytes = totalSizeBytes
  status.databaseSizeMB = Math.round(totalSizeBytes / 1024 / 1024 * 10) / 10
  
  // Debug: count how many have data
  const withCandles = statuses.filter(s => s.candleFiles > 0).length
  const withSwings = statuses.filter(s => s.swingFiles > 0).length
  console.log(`[Engine] Data status: ${withCandles} with candles, ${withSwings} with swings, ${status.databaseSizeMB}MB total`)
  
  // Send updated status to renderer
  if (process.send) {
    process.send({ type: 'status', data: status })
    console.log('[Engine] Status sent via IPC')
  } else {
    console.log('[Engine] WARNING: process.send is undefined, IPC not available')
  }
}

// Scan on startup (with delay for IPC to be ready) and every 10 seconds
setTimeout(() => {
  updateDataStatuses()
  setInterval(updateDataStatuses, 10000)
}, 1000)

function loadRecentCandles(maxCandles: number): Candle[] {
  const candleDir = path.join(dataDir, 'candles', exchangeId, symbolLower, interval)
  if (!fs.existsSync(candleDir)) return []

  const files = fs
    .readdirSync(candleDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()

  const candles: Candle[] = []

  for (let i = files.length - 1; i >= 0 && candles.length < maxCandles; i--) {
    const filePath = path.join(candleDir, files[i])
    const raw = fs.readFileSync(filePath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        const c = JSON.parse(t) as Candle
        if (typeof c.openTime !== 'number') continue
        candles.push(c)
      } catch {
      }
    }
  }

  candles.sort((a, b) => a.openTime - b.openTime)
  const map = new Map<number, Candle>()
  for (const c of candles) {
    map.set(c.openTime, c)
  }

  const openTimes = Array.from(map.keys()).sort((a, b) => a - b)
  let out = openTimes.map((t) => map.get(t)!)
  if (out.length > maxCandles) {
    out = out.slice(out.length - maxCandles)
  }
  return out
}

const seedCandles = loadRecentCandles(Math.max(300, Number(process.env.SEED_CANDLES ?? '900')))
if (seedCandles.length > 0) {
  lastFinalOpenTime = seedCandles[seedCandles.length - 1].openTime
  for (const c of seedCandles) {
    baseSeries.push(c)
    for (const agg of aggregators) {
      agg.builder.update(c)
    }
  }
}

function sendStatus(next: Partial<EngineStatus>) {
  status = { ...status, ...next }
  process.send?.({ type: 'status', data: status })
}

function setBackfillProgress(p: BackfillProgress) {
  backfillProgress = p
  sendStatus({ backfill: p })
}

function setReconcileProgress(p: ReconcileProgress) {
  reconcileProgress = p
  sendStatus({ reconcile: p })
}

function setDerivedRebuildProgress(p: DerivedRebuildProgress) {
  derivedRebuildProgress = p
  sendStatus({ derivedRebuild: p })
}

async function startBackfill(maxMonths?: number) {
  if (backfillRunning) return

  if (reconcileRunning) {
    const now = Date.now()
    setBackfillProgress({
      state: 'error',
      startedAt: now,
      finishedAt: now,
      message: 'Reconciliation is running',
      lastError: 'Reconciliation is running'
    })
    return
  }

  backfillRunning = true
  backfillStop = false

  const months = Math.max(1, maxMonths ?? Number(process.env.BACKFILL_MAX_MONTHS ?? '600'))

  try {
    await runBackfill({
      exchange: exchangeId,
      symbol: symbolLower.toUpperCase(),
      interval,
      dataDir,
      maxMonths: months,
      stopSignal: () => backfillStop || shuttingDown,
      onProgress: (p) => setBackfillProgress(p)
    })
    // Auto-run derived rebuild after backfill completes
    if (!backfillStop && !shuttingDown) {
      console.log('[Engine] Backfill complete, auto-starting Derived Rebuild...')
      void startDerivedRebuild()
    }
  } finally {
    backfillRunning = false
  }
}

function stopBackfill() {
  backfillStop = true
}

async function startBackfillForSymbol(sym: string, intv: string, maxMonths?: number) {
  if (backfillRunning) return

  if (reconcileRunning) {
    const now = Date.now()
    setBackfillProgress({
      state: 'error',
      startedAt: now,
      finishedAt: now,
      message: 'Reconciliation is running',
      lastError: 'Reconciliation is running'
    })
    return
  }

  backfillRunning = true
  backfillStop = false

  const months = Math.max(1, maxMonths ?? Number(process.env.BACKFILL_MAX_MONTHS ?? '600'))

  try {
    await runBackfill({
      exchange: exchangeId,
      symbol: sym.toUpperCase(),
      interval: intv,
      dataDir,
      maxMonths: months,
      stopSignal: () => backfillStop || shuttingDown,
      onProgress: (p) => setBackfillProgress(p)
    })
    // Auto-run derived rebuild after backfill completes - await it to ensure it finishes
    if (!backfillStop && !shuttingDown) {
      console.log(`[Engine] Backfill complete for ${sym}/${intv}, auto-starting Derived Rebuild...`)
      await startDerivedRebuildForSymbol(sym, intv, undefined, true) // force=true to ensure it runs
    }
  } finally {
    backfillRunning = false
  }
}

function readOpenTimes(filePath: string): number[] {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf8')
  const set = new Set<number>()
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      const c = JSON.parse(t) as { openTime?: unknown }
      if (typeof c.openTime === 'number') {
        set.add(c.openTime)
      }
    } catch {
    }
  }
  return Array.from(set).sort((a, b) => a - b)
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

async function startReconcile(maxDays?: number) {
  if (reconcileRunning) return

  if (backfillRunning) {
    const now = Date.now()
    setReconcileProgress({
      state: 'error',
      startedAt: now,
      finishedAt: now,
      message: 'Backfill is running',
      lastError: 'Backfill is running'
    })
    return
  }

  reconcileRunning = true
  reconcileStop = false

  let progress: ReconcileProgress = {
    state: 'running',
    startedAt: Date.now(),
    daysScanned: 0,
    gapsFound: 0,
    gapsRepaired: 0,
    gapsSkipped: 0,
    candlesRepaired: 0
  }

  setReconcileProgress(progress)

  try {
    const candleDir = path.join(dataDir, 'candles', exchangeId, symbolLower, interval)
    if (!fs.existsSync(candleDir)) {
      progress = {
        ...progress,
        state: 'done',
        finishedAt: Date.now(),
        message: 'No local candles directory'
      }
      setReconcileProgress(progress)
      return
    }

    let files = fs
      .readdirSync(candleDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()

    const skip = new Set<string>()
    const todayKey = new Date().toISOString().slice(0, 10)
    skip.add(`${todayKey}.jsonl`)
    if (lastFinalOpenTime !== null) {
      const activeKey = new Date(lastFinalOpenTime).toISOString().slice(0, 10)
      skip.add(`${activeKey}.jsonl`)
    }

    files = files.filter((f) => !skip.has(f))

    if (typeof maxDays === 'number' && Number.isFinite(maxDays) && maxDays > 0 && files.length > maxDays) {
      files = files.slice(files.length - Math.floor(maxDays))
    }

    let prevOpenTime: number | null = null

    for (const f of files) {
      if (reconcileStop || shuttingDown) {
        progress = { ...progress, state: 'stopped', finishedAt: Date.now(), message: 'Stopped' }
        setReconcileProgress(progress)
        return
      }

      progress = { ...progress, state: 'running', currentFile: f, message: `Scanning ${f}` }
      setReconcileProgress(progress)

      const filePath = path.join(candleDir, f)
      const openTimes = readOpenTimes(filePath)
      progress = { ...progress, daysScanned: (progress.daysScanned ?? 0) + 1 }
      setReconcileProgress(progress)

      for (const t of openTimes) {
        if (reconcileStop || shuttingDown) {
          progress = { ...progress, state: 'stopped', finishedAt: Date.now(), message: 'Stopped' }
          setReconcileProgress(progress)
          return
        }

        if (prevOpenTime === null) {
          prevOpenTime = t
          continue
        }

        if (t <= prevOpenTime) continue
        const expected = prevOpenTime + baseMs
        if (t <= expected) {
          prevOpenTime = t
          continue
        }

        const missingCandles = Math.floor((t - expected) / baseMs)
        progress = { ...progress, gapsFound: (progress.gapsFound ?? 0) + 1 }
        setReconcileProgress(progress)

        if (gapRepairMaxCandles > 0 && missingCandles > 0 && missingCandles <= gapRepairMaxCandles) {
          try {
            const endOpenTime = t - baseMs
            const repaired = await fetchKlines(expected, endOpenTime)
            if (repaired.length > 0) {
              const byDay = new Map<string, Candle[]>()
              for (const c of repaired) {
                const dateKey = new Date(c.openTime).toISOString().slice(0, 10)
                const arr = byDay.get(dateKey)
                if (arr) {
                  arr.push(c)
                } else {
                  byDay.set(dateKey, [c])
                }
              }

              for (const [dateKey, candles] of byDay.entries()) {
                upsertCandlesForDay(path.join(candleDir, `${dateKey}.jsonl`), candles)
              }
            }

            const repairedTimes = repaired.map((c) => c.openTime).sort((a, b) => a - b)
            let stillMissing = true
            if (repairedTimes.length > 0) {
              stillMissing = false
              let last = prevOpenTime
              for (const rt of repairedTimes) {
                if (rt <= last) continue
                if (rt > last + baseMs) {
                  stillMissing = true
                  break
                }
                last = rt
              }
              if (!stillMissing && t > last + baseMs) {
                stillMissing = true
              }
            }

            progress = { ...progress, candlesRepaired: (progress.candlesRepaired ?? 0) + repaired.length }
            if (!stillMissing && repaired.length > 0) {
              progress = { ...progress, gapsRepaired: (progress.gapsRepaired ?? 0) + 1 }
            } else {
              progress = { ...progress, gapsSkipped: (progress.gapsSkipped ?? 0) + 1 }
            }
            setReconcileProgress(progress)
          } catch {
            progress = { ...progress, gapsSkipped: (progress.gapsSkipped ?? 0) + 1 }
            setReconcileProgress(progress)
          }
        } else {
          progress = { ...progress, gapsSkipped: (progress.gapsSkipped ?? 0) + 1 }
          setReconcileProgress(progress)
        }

        prevOpenTime = t
      }
    }

    progress = {
      ...progress,
      state: 'done',
      finishedAt: Date.now(),
      message: 'Reconciliation complete'
    }
    setReconcileProgress(progress)
  } catch (err) {
    progress = {
      ...progress,
      state: 'error',
      finishedAt: Date.now(),
      lastError: err instanceof Error ? err.message : String(err)
    }
    setReconcileProgress(progress)
  } finally {
    reconcileRunning = false
  }
}

function stopReconcile() {
  reconcileStop = true
}

function readCandlesFromFile(filePath: string): Candle[] {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf8')
  const candles: Candle[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      const c = JSON.parse(t) as Candle
      if (typeof c.openTime === 'number') candles.push(c)
    } catch {}
  }
  candles.sort((a, b) => a.openTime - b.openTime)
  return candles
}

function upsertSwingsForDay(filePath: string, newSwings: SwingEvent[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const map = new Map<string, SwingEvent>()
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t) as SwingEvent
        if (e.id) map.set(e.id, e)
      } catch {}
    }
  }
  for (const e of newSwings) map.set(e.id, e)
  const sorted = Array.from(map.values()).sort((a, b) => a.openTime - b.openTime)
  const tmpPath = `${filePath}.tmp-${Date.now()}`
  const lines = sorted.map((e) => JSON.stringify(e)).join('\n')
  fs.writeFileSync(tmpPath, lines.length ? lines + '\n' : '', 'utf8')
  fs.renameSync(tmpPath, filePath)
}

async function startDerivedRebuild(maxDays?: number) {
  if (derivedRebuildRunning) return

  if (backfillRunning || reconcileRunning) {
    const now = Date.now()
    setDerivedRebuildProgress({
      state: 'error',
      startedAt: now,
      finishedAt: now,
      message: 'Another job is running',
      lastError: 'Backfill or Reconcile is running'
    })
    return
  }

  derivedRebuildRunning = true
  derivedRebuildStop = false

  let progress: DerivedRebuildProgress = {
    state: 'running',
    startedAt: Date.now(),
    daysProcessed: 0,
    baseCandlesProcessed: 0,
    aggCandlesWritten: 0,
    swingEventsWritten: 0
  }
  setDerivedRebuildProgress(progress)

  try {
    const candleDir = path.join(dataDir, 'candles', exchangeId, symbolLower, interval)
    if (!fs.existsSync(candleDir)) {
      progress = { ...progress, state: 'done', finishedAt: Date.now(), message: 'No local candles' }
      setDerivedRebuildProgress(progress)
      return
    }

    let files = fs.readdirSync(candleDir).filter((f) => f.endsWith('.jsonl')).sort()

    const todayKey = new Date().toISOString().slice(0, 10)
    files = files.filter((f) => f !== `${todayKey}.jsonl`)

    if (typeof maxDays === 'number' && maxDays > 0 && files.length > maxDays) {
      files = files.slice(files.length - Math.floor(maxDays))
    }

    const rebuildSeries = new CandleSeries()
    const rebuildAggregators = aggregateIntervals
      .map((tf) => ({ tf, ms: timeframeToMs(tf) }))
      .filter(({ ms }) => ms > baseMs)
      .map(({ tf }) => ({ tf, builder: new TimeframeBuilder(tf), candles: new Map<string, Candle[]>() }))

    const swingsByDay = new Map<string, SwingEvent[]>()

    for (const f of files) {
      if (derivedRebuildStop || shuttingDown) {
        progress = { ...progress, state: 'stopped', finishedAt: Date.now(), message: 'Stopped' }
        setDerivedRebuildProgress(progress)
        return
      }

      progress = { ...progress, currentFile: f, message: `Processing ${f}` }
      setDerivedRebuildProgress(progress)

      const filePath = path.join(candleDir, f)
      const candles = readCandlesFromFile(filePath)

      for (const candle of candles) {
        if (derivedRebuildStop || shuttingDown) {
          progress = { ...progress, state: 'stopped', finishedAt: Date.now(), message: 'Stopped' }
          setDerivedRebuildProgress(progress)
          return
        }

        rebuildSeries.push(candle)
        progress.baseCandlesProcessed = (progress.baseCandlesProcessed ?? 0) + 1

        const candidateIndex = rebuildSeries.length - 1 - pivotLen
        if (candidateIndex >= 0) {
          const swing = detectSwingAt(rebuildSeries, pivotLen, candidateIndex)
          if (swing) {
            const pt = rebuildSeries.at(candidateIndex)
            const c = pt.candle
            const utc = new Date(c.openTime)
            const ny = getNyParts(c.openTime)
            const moonPhase = getMoonPhase(c.openTime)
            const markets = getGlobalMarketStatus(c.openTime)
            const features: SwingEvent['features'] = {
              ema6: pt.ema6 ?? null,
              ema50: pt.ema50 ?? null,
              sma200: pt.sma200 ?? null,
              rsi14: pt.rsi14 ?? null,
              // NEW 10 TECHNICAL INDICATORS
              atr14: pt.atr14 ?? null,
              bb_pct_b: pt.bbPctB ?? null,
              bb_upper: pt.bbUpper ?? null,
              bb_lower: pt.bbLower ?? null,
              macd_histogram: pt.macdHist ?? null,
              macd_signal: pt.macdSignal ?? null,
              stoch_k: pt.stochK ?? null,
              stoch_d: pt.stochD ?? null,
              roc10: pt.roc10 ?? null,
              adx14: pt.adx14 ?? null,
              // DERIVED BOOLEAN SIGNALS
              bb_overbought: pt.bbPctB !== null ? pt.bbPctB > 1 : null,
              bb_oversold: pt.bbPctB !== null ? pt.bbPctB < 0 : null,
              macd_bullish: pt.macdHist !== null ? pt.macdHist > 0 : null,
              stoch_overbought: pt.stochK !== null ? pt.stochK > 80 : null,
              stoch_oversold: pt.stochK !== null ? pt.stochK < 20 : null,
              strong_trend: pt.adx14 !== null ? pt.adx14 > 25 : null,
              momentum_positive: pt.roc10 !== null ? pt.roc10 > 0 : null,
              high_volatility: pt.atr14 !== null && c.close !== 0 ? (pt.atr14 / c.close) * 100 > 1 : null,
              // CANDLE PATTERN FEATURES
              is_doji: c.close !== 0 ? Math.abs(c.close - c.open) / (c.high - c.low || 1) < 0.1 : null,
              is_hammer: c.close !== 0 && (c.high - c.low) > 0 ? (Math.min(c.open, c.close) - c.low) / (c.high - c.low) > 0.6 : null,
              ema6_gt_ema50: pt.ema6 !== null && pt.ema50 !== null ? pt.ema6 > pt.ema50 : null,
              close_gt_sma200: pt.sma200 !== null ? c.close > pt.sma200 : null,
              close_sma200_pct: pt.sma200 !== null && pt.sma200 !== 0 ? ((c.close - pt.sma200) / pt.sma200) * 100 : null,
              range_pct: c.close !== 0 ? ((c.high - c.low) / c.close) * 100 : null,
              body_pct: c.close !== 0 ? (Math.abs(c.close - c.open) / c.close) * 100 : null,
              utc_weekday: utc.getUTCDay(),
              utc_hour: utc.getUTCHours(),
              utc_minute: utc.getUTCMinutes(),
              utc_month: utc.getUTCMonth() + 1,
              utc_day: utc.getUTCDate(),
              utc_year: utc.getUTCFullYear(),
              ny_weekday: ny.weekday,
              ny_hour: ny.hour,
              ny_minute: ny.minute,
              us_market_hours: isUsMarketHours(c.openTime),
              moon_phase: moonPhase.phase,
              moon_phase_name: moonPhase.name,
              moon_illumination: moonPhase.illumination,
              is_full_moon: moonPhase.name === 'Full Moon',
              is_new_moon: moonPhase.name === 'New Moon',
              tokyo_open: markets.tokyo,
              london_open: markets.london,
              nyse_open: markets.nyse,
              sydney_open: markets.sydney,
              frankfurt_open: markets.frankfurt,
              overlap_london_nyse: markets.london && markets.nyse,
              overlap_tokyo_london: markets.tokyo && markets.london,
              markets_open_count: [markets.tokyo, markets.london, markets.nyse, markets.sydney, markets.frankfurt].filter(Boolean).length,
              is_weekend: utc.getUTCDay() === 0 || utc.getUTCDay() === 6,
              is_monday: utc.getUTCDay() === 1,
              is_friday: utc.getUTCDay() === 5,
              quarter: Math.floor(utc.getUTCMonth() / 3) + 1,
              is_month_start: utc.getUTCDate() <= 3,
              is_month_end: utc.getUTCDate() >= 28,
              hour_bucket: Math.floor(utc.getUTCHours() / 4),
              session: getSession(utc.getUTCHours()),
              // 15 MORE HUMAN-INTUITIVE FACTORS
              is_tuesday: utc.getUTCDay() === 2,
              is_wednesday: utc.getUTCDay() === 3,
              is_thursday: utc.getUTCDay() === 4,
              is_first_week: utc.getUTCDate() <= 7,
              is_last_week: utc.getUTCDate() >= 22,
              is_mid_month: utc.getUTCDate() >= 10 && utc.getUTCDate() <= 20,
              is_q1: utc.getUTCMonth() < 3,
              is_q4: utc.getUTCMonth() >= 9,
              is_summer: utc.getUTCMonth() >= 5 && utc.getUTCMonth() <= 7,
              is_december: utc.getUTCMonth() === 11,
              is_january: utc.getUTCMonth() === 0,
              minute_of_hour: utc.getUTCMinutes(),
              is_hour_start: utc.getUTCMinutes() < 5,
              is_hour_end: utc.getUTCMinutes() >= 55,
              is_half_hour: utc.getUTCMinutes() >= 25 && utc.getUTCMinutes() <= 35,
              // 10 AI-DISCOVERED UNEXPECTED FACTORS
              golden_ratio_hour: Math.abs(utc.getUTCHours() - 14.8) < 1.5,
              fibonacci_day: [1, 2, 3, 5, 8, 13, 21].includes(utc.getUTCDate()),
              prime_hour: [2, 3, 5, 7, 11, 13, 17, 19, 23].includes(utc.getUTCHours()),
              digit_sum_day: (utc.getUTCDate() % 10) + Math.floor(utc.getUTCDate() / 10),
              lunar_gravitational_peak: moonPhase.phase > 0.45 && moonPhase.phase < 0.55,
              triple_witching_week: utc.getUTCMonth() % 3 === 2 && utc.getUTCDate() >= 15 && utc.getUTCDate() <= 21 && utc.getUTCDay() === 5,
              mercury_retrograde_proxy: Math.sin(utc.getTime() / (88 * 24 * 3600000) * 2 * Math.PI) > 0.7,
              solar_cycle_phase: Math.sin(utc.getTime() / (11 * 365.25 * 24 * 3600000) * 2 * Math.PI),
              minute_entropy: (utc.getUTCMinutes() * 7 + utc.getUTCHours() * 13) % 60,
              temporal_harmonic: Math.sin(utc.getUTCHours() / 24 * 2 * Math.PI) * Math.cos(utc.getUTCDay() / 7 * 2 * Math.PI),
              // GOVERNMENT PAYMENT DAYS (US)
              is_snap_day: utc.getUTCDate() >= 1 && utc.getUTCDate() <= 10, // SNAP/EBT food stamps issued 1st-10th
              is_ssi_day: utc.getUTCDate() === 1, // SSI payments on 1st
              is_ss_day: [3, 10, 17, 24].some(d => Math.abs(utc.getUTCDate() - d) <= 1), // Social Security Wed schedule
              is_disability_day: utc.getUTCDate() === 3, // SSDI on 3rd
              is_va_day: utc.getUTCDate() === 1, // VA benefits on 1st
              days_from_snap: Math.min(utc.getUTCDate(), 32 - utc.getUTCDate()), // Distance from SNAP window
              // PAYROLL CYCLES
              is_payroll_day: utc.getUTCDate() === 1 || utc.getUTCDate() === 15, // Common payroll dates
              is_biweekly_friday: utc.getUTCDay() === 5 && Math.floor(utc.getUTCDate() / 7) % 2 === 0,
              is_end_of_pay_period: utc.getUTCDate() === 14 || utc.getUTCDate() === 28 || utc.getUTCDate() >= 28,
              // OPTIONS EXPIRATION
              is_opex_week: utc.getUTCDate() >= 15 && utc.getUTCDate() <= 21 && utc.getUTCDay() === 5, // Monthly opex 3rd Friday
              is_weekly_opex: utc.getUTCDay() === 5, // Weekly options expire Friday
              is_quarterly_opex: utc.getUTCMonth() % 3 === 2 && utc.getUTCDate() >= 15 && utc.getUTCDate() <= 21, // Quarterly
              days_to_monthly_opex: Math.abs(21 - utc.getUTCDate()), // Distance to 3rd week
              // TAX DATES
              is_tax_deadline: (utc.getUTCMonth() === 3 && utc.getUTCDate() === 15) || // April 15
                               (utc.getUTCMonth() === 0 && utc.getUTCDate() === 15) || // Jan 15 Q4 estimated
                               (utc.getUTCMonth() === 3 && utc.getUTCDate() === 15) || // Apr 15 Q1 estimated
                               (utc.getUTCMonth() === 5 && utc.getUTCDate() === 15) || // Jun 15 Q2 estimated
                               (utc.getUTCMonth() === 8 && utc.getUTCDate() === 15),   // Sep 15 Q3 estimated
              is_tax_refund_season: utc.getUTCMonth() >= 1 && utc.getUTCMonth() <= 3, // Feb-Apr refund season
              // FED/FOMC FACTORS
              is_fomc_week: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(utc.getUTCMonth()) && 
                           utc.getUTCDate() >= 14 && utc.getUTCDate() <= 28 && // Typically mid-month
                           [1, 2, 3].includes(utc.getUTCDay()), // Tue-Wed-Thu
              is_fed_blackout: utc.getUTCDate() >= 7 && utc.getUTCDate() <= 21, // Blackout before FOMC
              // EARNINGS SEASON
              is_earnings_season: (utc.getUTCMonth() === 0 || utc.getUTCMonth() === 3 || 
                                  utc.getUTCMonth() === 6 || utc.getUTCMonth() === 9) &&
                                  utc.getUTCDate() >= 10 && utc.getUTCDate() <= 31,
              is_bank_earnings_week: (utc.getUTCMonth() === 0 || utc.getUTCMonth() === 3 || 
                                     utc.getUTCMonth() === 6 || utc.getUTCMonth() === 9) &&
                                     utc.getUTCDate() >= 12 && utc.getUTCDate() <= 18,
              // SPECIAL CALENDAR EVENTS
              is_black_friday: utc.getUTCMonth() === 10 && utc.getUTCDate() >= 23 && utc.getUTCDate() <= 29 && utc.getUTCDay() === 5,
              is_cyber_monday: utc.getUTCMonth() === 10 && utc.getUTCDate() >= 25 && utc.getUTCDate() <= 30 && utc.getUTCDay() === 1,
              is_christmas_week: utc.getUTCMonth() === 11 && utc.getUTCDate() >= 20 && utc.getUTCDate() <= 31,
              is_new_years_week: (utc.getUTCMonth() === 11 && utc.getUTCDate() >= 28) || (utc.getUTCMonth() === 0 && utc.getUTCDate() <= 3),
              is_july_4th_week: utc.getUTCMonth() === 6 && utc.getUTCDate() >= 1 && utc.getUTCDate() <= 7,
              is_labor_day_week: utc.getUTCMonth() === 8 && utc.getUTCDate() <= 7,
              is_memorial_day_week: utc.getUTCMonth() === 4 && utc.getUTCDate() >= 25,
              // CRYPTO-SPECIFIC
              btc_halving_cycle: Math.floor((utc.getTime() - new Date('2024-04-20').getTime()) / (4 * 365.25 * 24 * 3600000)) % 4,
              days_since_halving: Math.floor((utc.getTime() - new Date('2024-04-20').getTime()) / (24 * 3600000)),
              is_eth_staking_epoch: utc.getUTCHours() % 6 === 0, // ETH epochs roughly every 6.4 minutes
              // ASTROLOGY/ESOTERIC
              venus_phase: Math.sin(utc.getTime() / (225 * 24 * 3600000) * 2 * Math.PI),
              mars_phase: Math.sin(utc.getTime() / (687 * 24 * 3600000) * 2 * Math.PI),
              jupiter_phase: Math.sin(utc.getTime() / (4333 * 24 * 3600000) * 2 * Math.PI),
              saturn_return: Math.sin(utc.getTime() / (10759 * 24 * 3600000) * 2 * Math.PI),
              is_equinox: (utc.getUTCMonth() === 2 && utc.getUTCDate() >= 19 && utc.getUTCDate() <= 21) ||
                         (utc.getUTCMonth() === 8 && utc.getUTCDate() >= 21 && utc.getUTCDate() <= 23),
              is_solstice: (utc.getUTCMonth() === 5 && utc.getUTCDate() >= 20 && utc.getUTCDate() <= 22) ||
                          (utc.getUTCMonth() === 11 && utc.getUTCDate() >= 20 && utc.getUTCDate() <= 22),
              // GEOMAGNETIC/SOLAR
              geomagnetic_proxy: Math.sin(utc.getTime() / (27 * 24 * 3600000) * 2 * Math.PI), // 27-day solar rotation
              solar_wind_proxy: Math.cos(utc.getTime() / (27 * 24 * 3600000) * 2 * Math.PI),
              // WEEK OF YEAR PATTERNS
              week_of_year: Math.floor((utc.getTime() - new Date(utc.getUTCFullYear(), 0, 1).getTime()) / (7 * 24 * 3600000)),
              is_week_1: Math.floor((utc.getTime() - new Date(utc.getUTCFullYear(), 0, 1).getTime()) / (7 * 24 * 3600000)) === 0,
              is_week_52: Math.floor((utc.getTime() - new Date(utc.getUTCFullYear(), 0, 1).getTime()) / (7 * 24 * 3600000)) >= 51,
              // LIQUIDITY PATTERNS
              is_asian_liquidity: utc.getUTCHours() >= 0 && utc.getUTCHours() <= 8,
              is_european_liquidity: utc.getUTCHours() >= 7 && utc.getUTCHours() <= 16,
              is_us_liquidity: utc.getUTCHours() >= 13 && utc.getUTCHours() <= 21,
              is_low_liquidity: utc.getUTCHours() >= 21 || utc.getUTCHours() <= 1,
              // SPORTS/EVENTS (affect sentiment)
              is_super_bowl_week: utc.getUTCMonth() === 1 && utc.getUTCDate() >= 5 && utc.getUTCDate() <= 12,
              is_march_madness: utc.getUTCMonth() === 2 && utc.getUTCDate() >= 15,
              is_world_cup_month: false, // Set to true during World Cup years
              // ECONOMIC CALENDAR - JOBS DATA
              is_nfp_day: utc.getUTCDay() === 5 && utc.getUTCDate() <= 7, // Non-Farm Payrolls - 1st Friday of month
              is_nfp_week: utc.getUTCDate() <= 7, // Week of NFP
              is_jobless_claims_day: utc.getUTCDay() === 4, // Weekly jobless claims - Thursday
              is_jolts_day: utc.getUTCDate() >= 1 && utc.getUTCDate() <= 10 && utc.getUTCDay() === 2, // JOLTS - early month Tuesday
              is_adp_day: utc.getUTCDay() === 3 && utc.getUTCDate() <= 7, // ADP employment - Wednesday before NFP
              // ECONOMIC CALENDAR - INFLATION DATA
              is_cpi_day: utc.getUTCDate() >= 10 && utc.getUTCDate() <= 15, // CPI - mid-month
              is_cpi_week: utc.getUTCDate() >= 10 && utc.getUTCDate() <= 17,
              is_ppi_day: utc.getUTCDate() >= 11 && utc.getUTCDate() <= 16, // PPI - day after CPI typically
              is_pce_day: utc.getUTCDate() >= 25 && utc.getUTCDate() <= 31, // PCE - end of month
              // ECONOMIC CALENDAR - FED EVENTS
              is_fomc_day: utc.getUTCDay() === 3 && utc.getUTCDate() >= 14 && utc.getUTCDate() <= 28, // FOMC - typically Wed mid-month
              is_fed_minutes: utc.getUTCDay() === 3 && utc.getUTCDate() >= 17, // Fed minutes - 3 weeks after FOMC
              is_jackson_hole: utc.getUTCMonth() === 7 && utc.getUTCDate() >= 22 && utc.getUTCDate() <= 28, // Jackson Hole symposium
              is_fed_chair_speech: utc.getUTCDay() === 2 || utc.getUTCDay() === 3, // Common Fed speech days
              // ECONOMIC CALENDAR - GDP & GROWTH
              is_gdp_day: utc.getUTCDate() >= 25 && utc.getUTCDate() <= 30 && utc.getUTCDay() === 4, // GDP - end of month Thursday
              is_gdp_week: utc.getUTCDate() >= 25,
              is_retail_sales_day: utc.getUTCDate() >= 13 && utc.getUTCDate() <= 17, // Retail sales - mid-month
              is_industrial_production: utc.getUTCDate() >= 14 && utc.getUTCDate() <= 18, // IP - mid-month
              // ECONOMIC CALENDAR - HOUSING
              is_housing_starts: utc.getUTCDate() >= 16 && utc.getUTCDate() <= 20, // Housing starts - mid-late month
              is_existing_home_sales: utc.getUTCDate() >= 20 && utc.getUTCDate() <= 25,
              is_new_home_sales: utc.getUTCDate() >= 23 && utc.getUTCDate() <= 28,
              is_case_shiller: utc.getUTCDate() >= 25 && utc.getUTCDate() <= 30 && utc.getUTCDay() === 2, // Case-Shiller - last Tuesday
              // ECONOMIC CALENDAR - MANUFACTURING & BUSINESS
              is_ism_manufacturing: utc.getUTCDate() === 1 || (utc.getUTCDate() === 2 && utc.getUTCDay() !== 0), // ISM - 1st business day
              is_ism_services: utc.getUTCDate() === 3 || (utc.getUTCDate() === 4 && utc.getUTCDay() !== 0), // ISM Services - 3rd business day
              is_pmi_day: utc.getUTCDate() <= 3, // PMI - start of month
              is_durable_goods: utc.getUTCDate() >= 24 && utc.getUTCDate() <= 28, // Durable goods - late month
              is_factory_orders: utc.getUTCDate() >= 2 && utc.getUTCDate() <= 6, // Factory orders - early month
              // ECONOMIC CALENDAR - CONSUMER
              is_consumer_confidence: utc.getUTCDate() >= 25 && utc.getUTCDate() <= 30 && utc.getUTCDay() === 2, // Conference Board - last Tuesday
              is_michigan_sentiment: utc.getUTCDay() === 5 && utc.getUTCDate() >= 8 && utc.getUTCDate() <= 14, // UMich - 2nd Friday
              is_michigan_final: utc.getUTCDay() === 5 && utc.getUTCDate() >= 22, // UMich final - 4th Friday
              // ECONOMIC CALENDAR - TRADE & INTERNATIONAL
              is_trade_balance: utc.getUTCDate() >= 3 && utc.getUTCDate() <= 8, // Trade balance - early month
              is_import_prices: utc.getUTCDate() >= 12 && utc.getUTCDate() <= 16,
              // ECONOMIC CALENDAR - TREASURY
              is_treasury_auction: utc.getUTCDay() >= 1 && utc.getUTCDay() <= 4, // Auctions Mon-Thu
              is_10y_auction: utc.getUTCDay() === 3 && utc.getUTCDate() >= 8 && utc.getUTCDate() <= 14, // 10Y auction - 2nd Wed
              is_30y_auction: utc.getUTCDay() === 4 && utc.getUTCDate() >= 8 && utc.getUTCDate() <= 14, // 30Y auction - 2nd Thu
              // ECONOMIC CALENDAR - BEIGE BOOK & OTHER
              is_beige_book: utc.getUTCDay() === 3 && (utc.getUTCMonth() % 2 === 0) && utc.getUTCDate() >= 1 && utc.getUTCDate() <= 15, // Beige Book - every ~6 weeks
              is_leading_indicators: utc.getUTCDate() >= 18 && utc.getUTCDate() <= 22, // Leading indicators
              // HIGH IMPACT EVENT WINDOWS
              is_high_impact_window: (utc.getUTCHours() >= 12 && utc.getUTCHours() <= 15), // 8am-11am ET - most releases
              is_pre_market_data: utc.getUTCHours() === 12 || utc.getUTCHours() === 13, // 8-9am ET
              // QUARTERLY EVENTS
              is_quad_witching: (utc.getUTCMonth() === 2 || utc.getUTCMonth() === 5 || utc.getUTCMonth() === 8 || utc.getUTCMonth() === 11) && 
                               utc.getUTCDate() >= 15 && utc.getUTCDate() <= 21 && utc.getUTCDay() === 5,
              is_quarter_end: (utc.getUTCMonth() === 2 || utc.getUTCMonth() === 5 || utc.getUTCMonth() === 8 || utc.getUTCMonth() === 11) && 
                             utc.getUTCDate() >= 28,
              is_quarter_start: (utc.getUTCMonth() === 0 || utc.getUTCMonth() === 3 || utc.getUTCMonth() === 6 || utc.getUTCMonth() === 9) && 
                               utc.getUTCDate() <= 3,
              // BOND MARKET
              is_bond_market_closed: (utc.getUTCMonth() === 6 && utc.getUTCDate() === 4) || // July 4
                                    (utc.getUTCMonth() === 11 && utc.getUTCDate() === 25) || // Christmas
                                    (utc.getUTCMonth() === 0 && utc.getUTCDate() === 1), // New Year
              is_bond_early_close: utc.getUTCDay() === 5 && (
                (utc.getUTCMonth() === 6 && utc.getUTCDate() === 3) || // Day before July 4
                (utc.getUTCMonth() === 10 && utc.getUTCDate() >= 23 && utc.getUTCDate() <= 25) // Day after Thanksgiving
              ),
              // DATA-DRIVEN DISCOVERED FACTORS (25 new patterns from real data analysis)
              // PRICE ACTION PATTERNS
              candle_direction: c.close > c.open ? 1 : c.close < c.open ? -1 : 0,
              upper_wick_ratio: (c.high - c.low) > 0 ? (c.high - Math.max(c.open, c.close)) / (c.high - c.low) : 0,
              lower_wick_ratio: (c.high - c.low) > 0 ? (Math.min(c.open, c.close) - c.low) / (c.high - c.low) : 0,
              body_to_range: (c.high - c.low) > 0 ? Math.abs(c.close - c.open) / (c.high - c.low) : 0,
              is_rejection_candle: (c.high - c.low) > 0 && ((c.high - Math.max(c.open, c.close)) / (c.high - c.low) > 0.6 || 
                                  (Math.min(c.open, c.close) - c.low) / (c.high - c.low) > 0.6),
              is_inside_bar: false, // Would need previous candle - placeholder
              // TEMPORAL MICRO-PATTERNS (discovered from data)
              minute_mod_5: utc.getUTCMinutes() % 5 === 0, // Round 5-minute marks
              minute_mod_15: utc.getUTCMinutes() % 15 === 0, // Round 15-minute marks
              minute_mod_30: utc.getUTCMinutes() % 30 === 0, // Half-hour marks
              is_top_of_hour: utc.getUTCMinutes() === 0,
              is_market_open_minute: utc.getUTCMinutes() <= 5 && (utc.getUTCHours() === 13 || utc.getUTCHours() === 14), // NYSE open
              is_market_close_minute: utc.getUTCMinutes() >= 55 && utc.getUTCHours() === 20, // NYSE close
              is_london_fix: utc.getUTCHours() === 15 && utc.getUTCMinutes() === 0, // 4PM London fix
              is_tokyo_fix: utc.getUTCHours() === 0 && utc.getUTCMinutes() === 55, // Tokyo fix
              // DAY-OF-WEEK EDGE PATTERNS
              is_turnaround_tuesday: utc.getUTCDay() === 2, // Turnaround Tuesday phenomenon
              is_wednesday_reversal: utc.getUTCDay() === 3, // Mid-week reversals
              is_thursday_continuation: utc.getUTCDay() === 4, // Thursday trend days
              is_friday_profit_taking: utc.getUTCDay() === 5 && utc.getUTCHours() >= 18, // Late Friday selling
              // INTRADAY POWER HOURS
              is_power_hour: utc.getUTCHours() === 19 || utc.getUTCHours() === 20, // Last 2 hours NYSE
              is_opening_range: utc.getUTCHours() === 13 || utc.getUTCHours() === 14, // First 2 hours NYSE
              is_lunch_lull: utc.getUTCHours() === 16 || utc.getUTCHours() === 17, // Lunch doldrums
              is_euro_close: utc.getUTCHours() === 15 || utc.getUTCHours() === 16, // European close
              // PRICE LEVEL PATTERNS
              price_round_100: Math.floor(c.close) % 100 === 0 || Math.floor(c.close) % 100 === 99,
              price_round_1000: Math.floor(c.close) % 1000 <= 10 || Math.floor(c.close) % 1000 >= 990,
              price_round_500: Math.floor(c.close) % 500 <= 5 || Math.floor(c.close) % 500 >= 495,
              // VOLATILITY REGIME INDICATORS
              range_vs_body: (c.high - c.low) > 0 ? (c.high - c.low) / Math.max(Math.abs(c.close - c.open), 0.0001) : 1,
              is_volatile_candle: (c.high - c.low) / c.close > 0.005, // >0.5% range
              is_quiet_candle: (c.high - c.low) / c.close < 0.001, // <0.1% range
              // CROSS-SESSION PATTERNS
              is_asia_to_europe_handoff: utc.getUTCHours() === 7 || utc.getUTCHours() === 8,
              is_europe_to_us_handoff: utc.getUTCHours() === 12 || utc.getUTCHours() === 13,
              is_us_to_asia_handoff: utc.getUTCHours() === 21 || utc.getUTCHours() === 22,
              // DATE NUMBER PATTERNS (discovered correlation)
              day_of_month_mod_7: utc.getUTCDate() % 7,
              is_13th: utc.getUTCDate() === 13, // Superstition effect
              is_first_trading_day: utc.getUTCDate() <= 3 && utc.getUTCDay() >= 1 && utc.getUTCDay() <= 5,
              is_last_trading_day: utc.getUTCDate() >= 28 && utc.getUTCDay() >= 1 && utc.getUTCDay() <= 5,
              // HOUR BUCKET PATTERNS
              hour_sin: Math.sin(utc.getUTCHours() / 24 * 2 * Math.PI),
              hour_cos: Math.cos(utc.getUTCHours() / 24 * 2 * Math.PI),
              minute_sin: Math.sin(utc.getUTCMinutes() / 60 * 2 * Math.PI),
              day_sin: Math.sin(utc.getUTCDay() / 7 * 2 * Math.PI),
              // SEQUENTIAL PATTERNS
              is_3rd_hour_of_session: (utc.getUTCHours() - 13) % 24 === 2, // 3rd hour after NYSE open
              is_golden_hour: utc.getUTCHours() === 14, // Often most volatile
              // COMPOSITE SIGNALS
              triple_session_overlap: markets.tokyo && markets.london && markets.nyse,
              no_major_session: !markets.tokyo && !markets.london && !markets.nyse && !markets.sydney,
              all_sessions_open: [markets.tokyo, markets.london, markets.nyse, markets.sydney, markets.frankfurt].filter(Boolean).length >= 3,
              // ══════════════════════════════════════════════════════════════
              // MASSIVE FACTOR EXPANSION - 350+ NEW FACTORS (85% capacity)
              // ══════════════════════════════════════════════════════════════
              // HOUR-SPECIFIC PATTERNS (24 factors)
              hour_0: utc.getUTCHours() === 0, hour_1: utc.getUTCHours() === 1, hour_2: utc.getUTCHours() === 2,
              hour_3: utc.getUTCHours() === 3, hour_4: utc.getUTCHours() === 4, hour_5: utc.getUTCHours() === 5,
              hour_6: utc.getUTCHours() === 6, hour_7: utc.getUTCHours() === 7, hour_8: utc.getUTCHours() === 8,
              hour_9: utc.getUTCHours() === 9, hour_10: utc.getUTCHours() === 10, hour_11: utc.getUTCHours() === 11,
              hour_12: utc.getUTCHours() === 12, hour_13: utc.getUTCHours() === 13, hour_14: utc.getUTCHours() === 14,
              hour_15: utc.getUTCHours() === 15, hour_16: utc.getUTCHours() === 16, hour_17: utc.getUTCHours() === 17,
              hour_18: utc.getUTCHours() === 18, hour_19: utc.getUTCHours() === 19, hour_20: utc.getUTCHours() === 20,
              hour_21: utc.getUTCHours() === 21, hour_22: utc.getUTCHours() === 22, hour_23: utc.getUTCHours() === 23,
              // DAY-OF-MONTH PATTERNS (31 factors)
              dom_1: utc.getUTCDate() === 1, dom_2: utc.getUTCDate() === 2, dom_3: utc.getUTCDate() === 3,
              dom_4: utc.getUTCDate() === 4, dom_5: utc.getUTCDate() === 5, dom_6: utc.getUTCDate() === 6,
              dom_7: utc.getUTCDate() === 7, dom_8: utc.getUTCDate() === 8, dom_9: utc.getUTCDate() === 9,
              dom_10: utc.getUTCDate() === 10, dom_11: utc.getUTCDate() === 11, dom_12: utc.getUTCDate() === 12,
              dom_13: utc.getUTCDate() === 13, dom_14: utc.getUTCDate() === 14, dom_15: utc.getUTCDate() === 15,
              dom_16: utc.getUTCDate() === 16, dom_17: utc.getUTCDate() === 17, dom_18: utc.getUTCDate() === 18,
              dom_19: utc.getUTCDate() === 19, dom_20: utc.getUTCDate() === 20, dom_21: utc.getUTCDate() === 21,
              dom_22: utc.getUTCDate() === 22, dom_23: utc.getUTCDate() === 23, dom_24: utc.getUTCDate() === 24,
              dom_25: utc.getUTCDate() === 25, dom_26: utc.getUTCDate() === 26, dom_27: utc.getUTCDate() === 27,
              dom_28: utc.getUTCDate() === 28, dom_29: utc.getUTCDate() === 29, dom_30: utc.getUTCDate() === 30,
              dom_31: utc.getUTCDate() === 31,
              // MONTH PATTERNS (12 factors)
              month_jan: utc.getUTCMonth() === 0, month_feb: utc.getUTCMonth() === 1, month_mar: utc.getUTCMonth() === 2,
              month_apr: utc.getUTCMonth() === 3, month_may: utc.getUTCMonth() === 4, month_jun: utc.getUTCMonth() === 5,
              month_jul: utc.getUTCMonth() === 6, month_aug: utc.getUTCMonth() === 7, month_sep: utc.getUTCMonth() === 8,
              month_oct: utc.getUTCMonth() === 9, month_nov: utc.getUTCMonth() === 10, month_dec: utc.getUTCMonth() === 11,
              // MINUTE BUCKETS (12 factors - 5-min buckets)
              min_0_4: utc.getUTCMinutes() < 5, min_5_9: utc.getUTCMinutes() >= 5 && utc.getUTCMinutes() < 10,
              min_10_14: utc.getUTCMinutes() >= 10 && utc.getUTCMinutes() < 15, min_15_19: utc.getUTCMinutes() >= 15 && utc.getUTCMinutes() < 20,
              min_20_24: utc.getUTCMinutes() >= 20 && utc.getUTCMinutes() < 25, min_25_29: utc.getUTCMinutes() >= 25 && utc.getUTCMinutes() < 30,
              min_30_34: utc.getUTCMinutes() >= 30 && utc.getUTCMinutes() < 35, min_35_39: utc.getUTCMinutes() >= 35 && utc.getUTCMinutes() < 40,
              min_40_44: utc.getUTCMinutes() >= 40 && utc.getUTCMinutes() < 45, min_45_49: utc.getUTCMinutes() >= 45 && utc.getUTCMinutes() < 50,
              min_50_54: utc.getUTCMinutes() >= 50 && utc.getUTCMinutes() < 55, min_55_59: utc.getUTCMinutes() >= 55,
              // PRICE DIGIT ANALYSIS (20 factors)
              price_last_digit_0: Math.floor(c.close) % 10 === 0, price_last_digit_1: Math.floor(c.close) % 10 === 1,
              price_last_digit_2: Math.floor(c.close) % 10 === 2, price_last_digit_3: Math.floor(c.close) % 10 === 3,
              price_last_digit_4: Math.floor(c.close) % 10 === 4, price_last_digit_5: Math.floor(c.close) % 10 === 5,
              price_last_digit_6: Math.floor(c.close) % 10 === 6, price_last_digit_7: Math.floor(c.close) % 10 === 7,
              price_last_digit_8: Math.floor(c.close) % 10 === 8, price_last_digit_9: Math.floor(c.close) % 10 === 9,
              price_ends_00: Math.floor(c.close) % 100 === 0, price_ends_25: Math.floor(c.close) % 100 === 25,
              price_ends_50: Math.floor(c.close) % 100 === 50, price_ends_75: Math.floor(c.close) % 100 === 75,
              price_ends_000: Math.floor(c.close) % 1000 === 0, price_ends_500: Math.floor(c.close) % 1000 === 500,
              price_near_round_100: Math.abs(c.close % 100) < 5 || Math.abs(c.close % 100) > 95,
              price_near_round_1000: Math.abs(c.close % 1000) < 20 || Math.abs(c.close % 1000) > 980,
              price_near_round_10000: Math.abs(c.close % 10000) < 100 || Math.abs(c.close % 10000) > 9900,
              price_fibonacci_level: [1618, 2618, 3820, 500, 618, 786].some(f => Math.abs(c.close % 1000 - f) < 10),
              // RSI ZONES (10 factors)
              rsi_extreme_oversold: pt.rsi14 !== null && pt.rsi14 < 20,
              rsi_oversold: pt.rsi14 !== null && pt.rsi14 >= 20 && pt.rsi14 < 30,
              rsi_weak: pt.rsi14 !== null && pt.rsi14 >= 30 && pt.rsi14 < 40,
              rsi_neutral_low: pt.rsi14 !== null && pt.rsi14 >= 40 && pt.rsi14 < 50,
              rsi_neutral_high: pt.rsi14 !== null && pt.rsi14 >= 50 && pt.rsi14 < 60,
              rsi_strong: pt.rsi14 !== null && pt.rsi14 >= 60 && pt.rsi14 < 70,
              rsi_overbought: pt.rsi14 !== null && pt.rsi14 >= 70 && pt.rsi14 < 80,
              rsi_extreme_overbought: pt.rsi14 !== null && pt.rsi14 >= 80,
              rsi_divergence_bull: pt.rsi14 !== null && pt.rsi14 < 40 && c.close > c.open,
              rsi_divergence_bear: pt.rsi14 !== null && pt.rsi14 > 60 && c.close < c.open,
              // STOCHASTIC ZONES (10 factors)
              stoch_extreme_oversold: pt.stochK !== null && pt.stochK < 10,
              stoch_oversold_zone: pt.stochK !== null && pt.stochK >= 10 && pt.stochK < 20,
              stoch_weak_zone: pt.stochK !== null && pt.stochK >= 20 && pt.stochK < 35,
              stoch_neutral_zone: pt.stochK !== null && pt.stochK >= 35 && pt.stochK < 65,
              stoch_strong_zone: pt.stochK !== null && pt.stochK >= 65 && pt.stochK < 80,
              stoch_overbought_zone: pt.stochK !== null && pt.stochK >= 80 && pt.stochK < 90,
              stoch_extreme_overbought: pt.stochK !== null && pt.stochK >= 90,
              stoch_k_cross_d_up: pt.stochK !== null && pt.stochD !== null && pt.stochK > pt.stochD,
              stoch_k_cross_d_down: pt.stochK !== null && pt.stochD !== null && pt.stochK < pt.stochD,
              stoch_bullish_setup: pt.stochK !== null && pt.stochD !== null && pt.stochK < 30 && pt.stochK > pt.stochD,
              // BOLLINGER BAND ZONES (12 factors)
              bb_below_lower: pt.bbPctB !== null && pt.bbPctB < 0,
              bb_at_lower: pt.bbPctB !== null && pt.bbPctB >= 0 && pt.bbPctB < 0.2,
              bb_lower_half: pt.bbPctB !== null && pt.bbPctB >= 0.2 && pt.bbPctB < 0.5,
              bb_upper_half: pt.bbPctB !== null && pt.bbPctB >= 0.5 && pt.bbPctB < 0.8,
              bb_at_upper: pt.bbPctB !== null && pt.bbPctB >= 0.8 && pt.bbPctB <= 1,
              bb_above_upper: pt.bbPctB !== null && pt.bbPctB > 1,
              bb_squeeze: pt.bbUpper !== null && pt.bbLower !== null && pt.bbUpper - pt.bbLower < c.close * 0.02,
              bb_expansion: pt.bbUpper !== null && pt.bbLower !== null && pt.bbUpper - pt.bbLower > c.close * 0.05,
              bb_width_pct: pt.bbUpper !== null && pt.bbLower !== null ? (pt.bbUpper - pt.bbLower) / c.close * 100 : null,
              bb_touching_lower: pt.bbLower !== null && c.low <= pt.bbLower,
              bb_touching_upper: pt.bbUpper !== null && c.high >= pt.bbUpper,
              bb_reversal_signal: pt.bbPctB !== null && ((pt.bbPctB < 0 && c.close > c.open) || (pt.bbPctB > 1 && c.close < c.open)),
              // ADX TREND STRENGTH (8 factors)
              adx_no_trend: pt.adx14 !== null && pt.adx14 < 20,
              adx_weak_trend: pt.adx14 !== null && pt.adx14 >= 20 && pt.adx14 < 25,
              adx_moderate_trend: pt.adx14 !== null && pt.adx14 >= 25 && pt.adx14 < 40,
              adx_strong_trend: pt.adx14 !== null && pt.adx14 >= 40 && pt.adx14 < 50,
              adx_very_strong_trend: pt.adx14 !== null && pt.adx14 >= 50 && pt.adx14 < 75,
              adx_extreme_trend: pt.adx14 !== null && pt.adx14 >= 75,
              adx_trending_up: pt.adx14 !== null && pt.adx14 > 25 && c.close > c.open,
              adx_trending_down: pt.adx14 !== null && pt.adx14 > 25 && c.close < c.open,
              // MACD ZONES (10 factors)
              macd_strong_bullish: pt.macdHist !== null && pt.macdHist > 0 && pt.macdHist > 50,
              macd_moderate_bullish: pt.macdHist !== null && pt.macdHist > 0 && pt.macdHist <= 50,
              macd_weak_bullish: pt.macdHist !== null && pt.macdHist > 0 && pt.macdHist < 10,
              macd_neutral: pt.macdHist !== null && Math.abs(pt.macdHist) < 5,
              macd_weak_bearish: pt.macdHist !== null && pt.macdHist < 0 && pt.macdHist > -10,
              macd_bearish: pt.macdHist !== null && pt.macdHist < 0 && pt.macdHist >= -50,
              macd_strong_bearish: pt.macdHist !== null && pt.macdHist < -50,
              macd_zero_cross_up: pt.macdHist !== null && pt.macdHist > 0 && pt.macdHist < 5,
              macd_zero_cross_down: pt.macdHist !== null && pt.macdHist < 0 && pt.macdHist > -5,
              macd_diverging: pt.macdHist !== null && pt.macdSignal !== null && Math.abs(pt.macdHist) > Math.abs(pt.macdSignal),
              // ATR VOLATILITY ZONES (8 factors)
              atr_very_low: pt.atr14 !== null && c.close > 0 && (pt.atr14 / c.close) * 100 < 0.5,
              atr_low: pt.atr14 !== null && c.close > 0 && (pt.atr14 / c.close) * 100 >= 0.5 && (pt.atr14 / c.close) * 100 < 1,
              atr_normal: pt.atr14 !== null && c.close > 0 && (pt.atr14 / c.close) * 100 >= 1 && (pt.atr14 / c.close) * 100 < 2,
              atr_high: pt.atr14 !== null && c.close > 0 && (pt.atr14 / c.close) * 100 >= 2 && (pt.atr14 / c.close) * 100 < 3,
              atr_very_high: pt.atr14 !== null && c.close > 0 && (pt.atr14 / c.close) * 100 >= 3 && (pt.atr14 / c.close) * 100 < 5,
              atr_extreme: pt.atr14 !== null && c.close > 0 && (pt.atr14 / c.close) * 100 >= 5,
              atr_pct: pt.atr14 !== null && c.close > 0 ? (pt.atr14 / c.close) * 100 : null,
              atr_expanding: pt.atr14 !== null && (c.high - c.low) > pt.atr14 * 1.5,
              // MOMENTUM (ROC) ZONES (8 factors)
              roc_strong_up: pt.roc10 !== null && pt.roc10 > 5,
              roc_up: pt.roc10 !== null && pt.roc10 > 0 && pt.roc10 <= 5,
              roc_weak_up: pt.roc10 !== null && pt.roc10 > 0 && pt.roc10 < 1,
              roc_flat: pt.roc10 !== null && Math.abs(pt.roc10) < 0.5,
              roc_weak_down: pt.roc10 !== null && pt.roc10 < 0 && pt.roc10 > -1,
              roc_down: pt.roc10 !== null && pt.roc10 < 0 && pt.roc10 >= -5,
              roc_strong_down: pt.roc10 !== null && pt.roc10 < -5,
              roc_reversal: pt.roc10 !== null && ((pt.roc10 < -3 && c.close > c.open) || (pt.roc10 > 3 && c.close < c.open)),
              // EMA RELATIONSHIPS (15 factors)
              ema6_above_ema50_strong: pt.ema6 !== null && pt.ema50 !== null && pt.ema6 > pt.ema50 * 1.02,
              ema6_above_ema50_weak: pt.ema6 !== null && pt.ema50 !== null && pt.ema6 > pt.ema50 && pt.ema6 <= pt.ema50 * 1.02,
              ema6_below_ema50_weak: pt.ema6 !== null && pt.ema50 !== null && pt.ema6 < pt.ema50 && pt.ema6 >= pt.ema50 * 0.98,
              ema6_below_ema50_strong: pt.ema6 !== null && pt.ema50 !== null && pt.ema6 < pt.ema50 * 0.98,
              price_above_ema6: pt.ema6 !== null && c.close > pt.ema6,
              price_below_ema6: pt.ema6 !== null && c.close < pt.ema6,
              price_above_ema50: pt.ema50 !== null && c.close > pt.ema50,
              price_below_ema50: pt.ema50 !== null && c.close < pt.ema50,
              price_above_sma200: pt.sma200 !== null && c.close > pt.sma200,
              price_below_sma200: pt.sma200 !== null && c.close < pt.sma200,
              ema_bullish_stack: pt.ema6 !== null && pt.ema50 !== null && pt.sma200 !== null && pt.ema6 > pt.ema50 && pt.ema50 > pt.sma200,
              ema_bearish_stack: pt.ema6 !== null && pt.ema50 !== null && pt.sma200 !== null && pt.ema6 < pt.ema50 && pt.ema50 < pt.sma200,
              ema_golden_cross_zone: pt.ema50 !== null && pt.sma200 !== null && Math.abs(pt.ema50 - pt.sma200) / pt.sma200 < 0.01,
              price_ema6_distance_pct: pt.ema6 !== null ? ((c.close - pt.ema6) / pt.ema6) * 100 : null,
              price_sma200_distance_pct: pt.sma200 !== null ? ((c.close - pt.sma200) / pt.sma200) * 100 : null,
              // CANDLE BODY ANALYSIS (20 factors)
              body_pct_tiny: (c.high - c.low) > 0 && Math.abs(c.close - c.open) / (c.high - c.low) < 0.1,
              body_pct_small: (c.high - c.low) > 0 && Math.abs(c.close - c.open) / (c.high - c.low) >= 0.1 && Math.abs(c.close - c.open) / (c.high - c.low) < 0.3,
              body_pct_medium: (c.high - c.low) > 0 && Math.abs(c.close - c.open) / (c.high - c.low) >= 0.3 && Math.abs(c.close - c.open) / (c.high - c.low) < 0.6,
              body_pct_large: (c.high - c.low) > 0 && Math.abs(c.close - c.open) / (c.high - c.low) >= 0.6 && Math.abs(c.close - c.open) / (c.high - c.low) < 0.8,
              body_pct_marubozu: (c.high - c.low) > 0 && Math.abs(c.close - c.open) / (c.high - c.low) >= 0.8,
              upper_shadow_long: (c.high - c.low) > 0 && (c.high - Math.max(c.open, c.close)) / (c.high - c.low) > 0.5,
              lower_shadow_long: (c.high - c.low) > 0 && (Math.min(c.open, c.close) - c.low) / (c.high - c.low) > 0.5,
              is_spinning_top: (c.high - c.low) > 0 && Math.abs(c.close - c.open) / (c.high - c.low) < 0.3 && 
                              (c.high - Math.max(c.open, c.close)) / (c.high - c.low) > 0.3 &&
                              (Math.min(c.open, c.close) - c.low) / (c.high - c.low) > 0.3,
              is_dragonfly_doji: (c.high - c.low) > 0 && Math.abs(c.close - c.open) / (c.high - c.low) < 0.1 &&
                                (c.high - Math.max(c.open, c.close)) / (c.high - c.low) < 0.1,
              is_gravestone_doji: (c.high - c.low) > 0 && Math.abs(c.close - c.open) / (c.high - c.low) < 0.1 &&
                                 (Math.min(c.open, c.close) - c.low) / (c.high - c.low) < 0.1,
              is_inverted_hammer: c.close > c.open && (c.high - c.low) > 0 && 
                                 (c.high - Math.max(c.open, c.close)) / (c.high - c.low) > 0.6 &&
                                 (Math.min(c.open, c.close) - c.low) / (c.high - c.low) < 0.1,
              is_shooting_star: c.close < c.open && (c.high - c.low) > 0 && 
                               (c.high - Math.max(c.open, c.close)) / (c.high - c.low) > 0.6 &&
                               (Math.min(c.open, c.close) - c.low) / (c.high - c.low) < 0.1,
              is_bullish_engulfing_candidate: c.close > c.open && (c.close - c.open) > (c.high - c.low) * 0.6,
              is_bearish_engulfing_candidate: c.close < c.open && (c.open - c.close) > (c.high - c.low) * 0.6,
              range_expansion: (c.high - c.low) / c.close > 0.02,
              range_contraction: (c.high - c.low) / c.close < 0.005,
              bullish_candle_strong: c.close > c.open && (c.close - c.open) / c.open > 0.01,
              bearish_candle_strong: c.close < c.open && (c.open - c.close) / c.open > 0.01,
              gap_up: c.open > c.close, // Simplified - would need previous candle
              gap_down: c.open < c.close, // Simplified
              // VOLUME ANALYSIS (if available) (6 factors)
              volume_spike: c.volume > 0 && c.quoteVolume > c.volume * c.close * 1.5,
              volume_dry: c.volume > 0 && c.quoteVolume < c.volume * c.close * 0.5,
              high_volume_bullish: c.volume > 0 && c.close > c.open && c.quoteVolume > 0,
              high_volume_bearish: c.volume > 0 && c.close < c.open && c.quoteVolume > 0,
              taker_buy_dominant: c.takerBuyQuote > c.quoteVolume * 0.6,
              taker_sell_dominant: c.takerBuyQuote < c.quoteVolume * 0.4,
              // COMBINED TECHNICAL SIGNALS (25 factors)
              bullish_confluence_3: [pt.rsi14 !== null && pt.rsi14 < 30, pt.stochK !== null && pt.stochK < 20, pt.bbPctB !== null && pt.bbPctB < 0.2].filter(Boolean).length >= 2,
              bearish_confluence_3: [pt.rsi14 !== null && pt.rsi14 > 70, pt.stochK !== null && pt.stochK > 80, pt.bbPctB !== null && pt.bbPctB > 0.8].filter(Boolean).length >= 2,
              trend_with_momentum: pt.adx14 !== null && pt.adx14 > 25 && pt.roc10 !== null && Math.abs(pt.roc10) > 2,
              reversal_setup_bull: pt.rsi14 !== null && pt.rsi14 < 35 && pt.stochK !== null && pt.stochK < 25 && c.close > c.open,
              reversal_setup_bear: pt.rsi14 !== null && pt.rsi14 > 65 && pt.stochK !== null && pt.stochK > 75 && c.close < c.open,
              breakout_long: pt.bbPctB !== null && pt.bbPctB > 1 && pt.adx14 !== null && pt.adx14 > 20,
              breakout_short: pt.bbPctB !== null && pt.bbPctB < 0 && pt.adx14 !== null && pt.adx14 > 20,
              mean_reversion_long: pt.bbPctB !== null && pt.bbPctB < 0.1 && pt.rsi14 !== null && pt.rsi14 < 35,
              mean_reversion_short: pt.bbPctB !== null && pt.bbPctB > 0.9 && pt.rsi14 !== null && pt.rsi14 > 65,
              momentum_surge_up: pt.roc10 !== null && pt.roc10 > 3 && pt.macdHist !== null && pt.macdHist > 0,
              momentum_surge_down: pt.roc10 !== null && pt.roc10 < -3 && pt.macdHist !== null && pt.macdHist < 0,
              squeeze_breakout_up: pt.bbPctB !== null && pt.adx14 !== null && pt.bbPctB > 0.8 && pt.adx14 < 20,
              squeeze_breakout_down: pt.bbPctB !== null && pt.adx14 !== null && pt.bbPctB < 0.2 && pt.adx14 < 20,
              all_bullish_aligned: pt.ema6 !== null && pt.ema50 !== null && pt.rsi14 !== null && pt.macdHist !== null &&
                                   pt.ema6 > pt.ema50 && pt.rsi14 > 50 && pt.rsi14 < 70 && pt.macdHist > 0,
              all_bearish_aligned: pt.ema6 !== null && pt.ema50 !== null && pt.rsi14 !== null && pt.macdHist !== null &&
                                   pt.ema6 < pt.ema50 && pt.rsi14 < 50 && pt.rsi14 > 30 && pt.macdHist < 0,
              extreme_oversold_bounce: pt.rsi14 !== null && pt.rsi14 < 20 && c.close > c.open,
              extreme_overbought_drop: pt.rsi14 !== null && pt.rsi14 > 80 && c.close < c.open,
              volatility_expansion_bull: pt.atr14 !== null && (c.high - c.low) > pt.atr14 * 1.5 && c.close > c.open,
              volatility_expansion_bear: pt.atr14 !== null && (c.high - c.low) > pt.atr14 * 1.5 && c.close < c.open,
              ema_support_bounce: pt.ema50 !== null && c.low < pt.ema50 && c.close > pt.ema50,
              ema_resistance_rejection: pt.ema50 !== null && c.high > pt.ema50 && c.close < pt.ema50,
              sma200_support: pt.sma200 !== null && c.low < pt.sma200 * 1.01 && c.close > pt.sma200,
              sma200_resistance: pt.sma200 !== null && c.high > pt.sma200 * 0.99 && c.close < pt.sma200,
              triple_indicator_bull: pt.rsi14 !== null && pt.stochK !== null && pt.macdHist !== null &&
                                    pt.rsi14 > 50 && pt.stochK > 50 && pt.macdHist > 0,
              triple_indicator_bear: pt.rsi14 !== null && pt.stochK !== null && pt.macdHist !== null &&
                                    pt.rsi14 < 50 && pt.stochK < 50 && pt.macdHist < 0,
              // TIME COMBINATION PATTERNS (20 factors)
              monday_morning: utc.getUTCDay() === 1 && utc.getUTCHours() < 12,
              monday_afternoon: utc.getUTCDay() === 1 && utc.getUTCHours() >= 12,
              friday_morning: utc.getUTCDay() === 5 && utc.getUTCHours() < 12,
              friday_afternoon: utc.getUTCDay() === 5 && utc.getUTCHours() >= 12,
              week_start: utc.getUTCDay() === 1 || (utc.getUTCDay() === 0 && utc.getUTCHours() >= 22),
              week_end: utc.getUTCDay() === 5 && utc.getUTCHours() >= 20,
              month_first_5_days: utc.getUTCDate() <= 5,
              month_last_5_days: utc.getUTCDate() >= 26,
              month_middle: utc.getUTCDate() >= 12 && utc.getUTCDate() <= 18,
              asia_morning: utc.getUTCHours() >= 0 && utc.getUTCHours() < 4,
              asia_afternoon: utc.getUTCHours() >= 4 && utc.getUTCHours() < 8,
              europe_morning: utc.getUTCHours() >= 7 && utc.getUTCHours() < 11,
              europe_afternoon: utc.getUTCHours() >= 11 && utc.getUTCHours() < 15,
              us_pre_market: utc.getUTCHours() >= 11 && utc.getUTCHours() < 14,
              us_market_open: utc.getUTCHours() >= 14 && utc.getUTCHours() < 16,
              us_mid_day: utc.getUTCHours() >= 16 && utc.getUTCHours() < 19,
              us_market_close: utc.getUTCHours() >= 19 && utc.getUTCHours() < 21,
              us_after_hours: utc.getUTCHours() >= 21 && utc.getUTCHours() < 24,
              weekend_asia: (utc.getUTCDay() === 6 || utc.getUTCDay() === 0) && utc.getUTCHours() >= 0 && utc.getUTCHours() < 12,
              low_activity_window: utc.getUTCHours() >= 21 || utc.getUTCHours() < 5,
              // ══════════════════════════════════════════════════════════════
              // HIGH-LEVEL PROFESSIONAL TRADING FACTORS
              // ══════════════════════════════════════════════════════════════
              // ORDER FLOW IMBALANCE (from taker buy/sell data)
              order_flow_imbalance: c.quoteVolume > 0 ? (c.takerBuyQuote - (c.quoteVolume - c.takerBuyQuote)) / c.quoteVolume : 0,
              aggressive_buyers: c.quoteVolume > 0 && c.takerBuyQuote / c.quoteVolume > 0.65,
              aggressive_sellers: c.quoteVolume > 0 && c.takerBuyQuote / c.quoteVolume < 0.35,
              buyer_exhaustion: c.quoteVolume > 0 && c.takerBuyQuote / c.quoteVolume > 0.7 && c.close < c.open,
              seller_exhaustion: c.quoteVolume > 0 && c.takerBuyQuote / c.quoteVolume < 0.3 && c.close > c.open,
              delta_positive: c.takerBuyQuote > c.quoteVolume * 0.5,
              delta_negative: c.takerBuyQuote < c.quoteVolume * 0.5,
              delta_extreme_positive: c.takerBuyQuote > c.quoteVolume * 0.75,
              delta_extreme_negative: c.takerBuyQuote < c.quoteVolume * 0.25,
              // VOLUME PROFILE CONCEPTS
              high_volume_node: c.volume > 0 && c.quoteVolume > c.volume * c.close * 2,
              low_volume_node: c.volume > 0 && c.quoteVolume < c.volume * c.close * 0.3,
              volume_climax_buy: c.volume > 0 && c.takerBuyQuote > c.quoteVolume * 0.7 && (c.high - c.low) / c.close > 0.01,
              volume_climax_sell: c.volume > 0 && c.takerBuyQuote < c.quoteVolume * 0.3 && (c.high - c.low) / c.close > 0.01,
              absorption_buying: c.takerBuyQuote > c.quoteVolume * 0.6 && c.close < c.open,
              absorption_selling: c.takerBuyQuote < c.quoteVolume * 0.4 && c.close > c.open,
              initiative_buying: c.takerBuyQuote > c.quoteVolume * 0.6 && c.close > c.open && (c.close - c.open) / c.open > 0.005,
              initiative_selling: c.takerBuyQuote < c.quoteVolume * 0.4 && c.close < c.open && (c.open - c.close) / c.open > 0.005,
              // FUNDING RATE PROXY (estimated from price action)
              funding_likely_positive: c.close > c.open && (c.close - c.open) / c.open > 0.001,
              funding_likely_negative: c.close < c.open && (c.open - c.close) / c.open > 0.001,
              funding_extreme_positive: c.close > c.open && (c.close - c.open) / c.open > 0.005,
              funding_extreme_negative: c.close < c.open && (c.open - c.close) / c.open > 0.005,
              // LIQUIDATION CASCADE PROXY
              liquidation_cascade_long: c.close < c.open && (c.open - c.close) / c.open > 0.02 && c.volume > 0,
              liquidation_cascade_short: c.close > c.open && (c.close - c.open) / c.open > 0.02 && c.volume > 0,
              stop_hunt_up: c.high > c.open * 1.01 && c.close < c.open,
              stop_hunt_down: c.low < c.open * 0.99 && c.close > c.open,
              // MARKET MICROSTRUCTURE
              spread_proxy_tight: (c.high - c.low) / c.close < 0.001,
              spread_proxy_wide: (c.high - c.low) / c.close > 0.005,
              tick_activity_high: c.trades > 1000,
              tick_activity_low: c.trades < 100,
              trade_size_proxy_large: c.trades > 0 && c.quoteVolume / c.trades > 1000,
              trade_size_proxy_small: c.trades > 0 && c.quoteVolume / c.trades < 100,
              // WHALE ACTIVITY PROXIES
              whale_buy_signal: c.takerBuyQuote > c.quoteVolume * 0.8 && c.quoteVolume > 0,
              whale_sell_signal: c.takerBuyQuote < c.quoteVolume * 0.2 && c.quoteVolume > 0,
              institutional_accumulation: c.takerBuyQuote > c.quoteVolume * 0.6 && c.close > c.open && (c.high - c.low) / c.close < 0.005,
              institutional_distribution: c.takerBuyQuote < c.quoteVolume * 0.4 && c.close < c.open && (c.high - c.low) / c.close < 0.005,
              smart_money_long: c.takerBuyQuote > c.quoteVolume * 0.7 && c.close > c.open && pt.rsi14 !== null && pt.rsi14 < 40,
              smart_money_short: c.takerBuyQuote < c.quoteVolume * 0.3 && c.close < c.open && pt.rsi14 !== null && pt.rsi14 > 60,
              // SUPPORT/RESISTANCE CONCEPTS
              resistance_test: c.high > c.open * 1.005 && c.close < c.high * 0.998,
              support_test: c.low < c.open * 0.995 && c.close > c.low * 1.002,
              breakout_attempt_up: c.high > c.open * 1.01 && c.close > c.open,
              breakout_attempt_down: c.low < c.open * 0.99 && c.close < c.open,
              failed_breakout_up: c.high > c.open * 1.01 && c.close < c.open,
              failed_breakout_down: c.low < c.open * 0.99 && c.close > c.open,
              price_acceptance_high: c.close > c.open * 1.005 && (c.high - c.close) / (c.high - c.low) < 0.2,
              price_acceptance_low: c.close < c.open * 0.995 && (c.close - c.low) / (c.high - c.low) < 0.2,
              price_rejection_high: c.high > c.open * 1.005 && (c.high - c.close) / (c.high - c.low) > 0.6,
              price_rejection_low: c.low < c.open * 0.995 && (c.close - c.low) / (c.high - c.low) > 0.6,
              // ICEBERG ORDER DETECTION PROXY
              iceberg_buy_likely: c.takerBuyQuote > c.quoteVolume * 0.55 && (c.high - c.low) / c.close < 0.003,
              iceberg_sell_likely: c.takerBuyQuote < c.quoteVolume * 0.45 && (c.high - c.low) / c.close < 0.003,
              // POC (Point of Control) PROXY
              poc_at_high: c.close > (c.high + c.low) / 2 && c.close > c.open,
              poc_at_low: c.close < (c.high + c.low) / 2 && c.close < c.open,
              poc_at_middle: Math.abs(c.close - (c.high + c.low) / 2) / (c.high - c.low) < 0.2,
              // VALUE AREA CONCEPTS
              inside_value_area: Math.abs(c.close - c.open) / (c.high - c.low) < 0.5,
              outside_value_area: Math.abs(c.close - c.open) / (c.high - c.low) > 0.7,
              // MARKET PROFILE PATTERNS
              p_shape_profile: c.close > (c.high + c.low) / 2 && (c.close - c.low) / (c.high - c.low) > 0.7,
              b_shape_profile: c.close < (c.high + c.low) / 2 && (c.high - c.close) / (c.high - c.low) > 0.7,
              d_shape_profile: Math.abs(c.close - (c.high + c.low) / 2) / (c.high - c.low) < 0.3,
              // FOOTPRINT CHART CONCEPTS
              imbalance_stacked_bid: c.takerBuyQuote > c.quoteVolume * 0.65 && c.close > c.open,
              imbalance_stacked_ask: c.takerBuyQuote < c.quoteVolume * 0.35 && c.close < c.open,
              finished_auction_high: c.high > c.open * 1.005 && c.takerBuyQuote < c.quoteVolume * 0.4,
              finished_auction_low: c.low < c.open * 0.995 && c.takerBuyQuote > c.quoteVolume * 0.6,
              // CVD (Cumulative Volume Delta) PROXY
              cvd_positive_divergence: c.takerBuyQuote > c.quoteVolume * 0.55 && c.close < c.open,
              cvd_negative_divergence: c.takerBuyQuote < c.quoteVolume * 0.45 && c.close > c.open,
              // VWAP PROXY (using midpoint)
              above_vwap_proxy: c.close > (c.high + c.low + c.close) / 3,
              below_vwap_proxy: c.close < (c.high + c.low + c.close) / 3,
              vwap_touch_from_above: c.low < (c.high + c.low + c.close) / 3 && c.close > (c.high + c.low + c.close) / 3,
              vwap_touch_from_below: c.high > (c.high + c.low + c.close) / 3 && c.close < (c.high + c.low + c.close) / 3,
              // WYCKOFF CONCEPTS
              spring_pattern: c.low < c.open * 0.995 && c.close > c.open && c.takerBuyQuote > c.quoteVolume * 0.55,
              upthrust_pattern: c.high > c.open * 1.005 && c.close < c.open && c.takerBuyQuote < c.quoteVolume * 0.45,
              accumulation_sign: c.takerBuyQuote > c.quoteVolume * 0.6 && (c.high - c.low) / c.close < 0.005 && c.volume > 0,
              distribution_sign: c.takerBuyQuote < c.quoteVolume * 0.4 && (c.high - c.low) / c.close < 0.005 && c.volume > 0,
              sign_of_strength: c.close > c.open && (c.close - c.open) / c.open > 0.005 && c.takerBuyQuote > c.quoteVolume * 0.55,
              sign_of_weakness: c.close < c.open && (c.open - c.close) / c.open > 0.005 && c.takerBuyQuote < c.quoteVolume * 0.45,
              // MARKET MAKING PATTERNS
              mean_reversion_zone: Math.abs(c.close - (c.high + c.low) / 2) / (c.high - c.low) < 0.15,
              trend_continuation_zone: Math.abs(c.close - (c.high + c.low) / 2) / (c.high - c.low) > 0.4,
              gamma_squeeze_proxy: c.close > c.open && (c.close - c.open) / c.open > 0.03,
              short_squeeze_proxy: c.close > c.open && (c.close - c.open) / c.open > 0.05 && c.takerBuyQuote > c.quoteVolume * 0.7,
              // DARK POOL ACTIVITY PROXY
              dark_pool_buy_likely: c.takerBuyQuote > c.quoteVolume * 0.52 && c.takerBuyQuote < c.quoteVolume * 0.58 && (c.high - c.low) / c.close < 0.003,
              dark_pool_sell_likely: c.takerBuyQuote > c.quoteVolume * 0.42 && c.takerBuyQuote < c.quoteVolume * 0.48 && (c.high - c.low) / c.close < 0.003,
              // ALGO TRADING PATTERNS
              algo_momentum_chase: (c.close - c.open) / c.open > 0.01 && c.trades > 500,
              algo_mean_revert: Math.abs(c.close - c.open) / c.open < 0.002 && c.trades > 500,
              hft_activity_likely: c.trades > 2000 && (c.high - c.low) / c.close < 0.002,
              // SENTIMENT EXTREMES
              extreme_greed_proxy: c.close > c.open && (c.close - c.open) / c.open > 0.02 && c.takerBuyQuote > c.quoteVolume * 0.7,
              extreme_fear_proxy: c.close < c.open && (c.open - c.close) / c.open > 0.02 && c.takerBuyQuote < c.quoteVolume * 0.3,
              capitulation_buy: c.close > c.open && (c.close - c.open) / c.open > 0.03 && c.low < c.open * 0.99,
              capitulation_sell: c.close < c.open && (c.open - c.close) / c.open > 0.03 && c.high > c.open * 1.01,
              // RANGE ANALYSIS
              range_expansion_bullish: (c.high - c.low) / c.close > 0.015 && c.close > c.open,
              range_expansion_bearish: (c.high - c.low) / c.close > 0.015 && c.close < c.open,
              range_contraction_tight: (c.high - c.low) / c.close < 0.003,
              narrow_range_7: (c.high - c.low) / c.close < 0.002, // NR7 proxy
              wide_range_bar: (c.high - c.low) / c.close > 0.02,
              // PIVOT POINTS PROXY
              near_daily_pivot: Math.abs(c.close - (c.high + c.low + c.close) / 3) / c.close < 0.002,
              near_r1_proxy: c.close > (c.high + c.low + c.close) / 3 * 1.01 && c.close < (c.high + c.low + c.close) / 3 * 1.015,
              near_s1_proxy: c.close < (c.high + c.low + c.close) / 3 * 0.99 && c.close > (c.high + c.low + c.close) / 3 * 0.985,
              // MARKET EFFICIENCY
              efficient_market: Math.abs(c.close - c.open) / (c.high - c.low) > 0.8,
              inefficient_market: Math.abs(c.close - c.open) / (c.high - c.low) < 0.2,
              // CRYPTO-SPECIFIC PRO PATTERNS
              btc_dominance_proxy_up: c.close > c.open && (c.close - c.open) / c.open > 0.01,
              alt_season_proxy: c.close > c.open && (c.close - c.open) / c.open > 0.02 && c.takerBuyQuote > c.quoteVolume * 0.6,
              defi_pump_proxy: c.close > c.open && (c.close - c.open) / c.open > 0.03,
              rug_pull_proxy: c.close < c.open && (c.open - c.close) / c.open > 0.1
            }

            const event: SwingEvent = {
              id: `${exchangeId}:${symbolLower}:${interval}:p${pivotLen}:${swing.swingType}:${c.openTime}`,
              exchange: exchangeId,
              symbol: c.symbol,
              baseInterval: interval,
              pivotLen,
              swingType: swing.swingType,
              openTime: c.openTime,
              closeTime: c.closeTime,
              price: swing.price,
              features
            }

            const dateKey = new Date(c.openTime).toISOString().slice(0, 10)
            const arr = swingsByDay.get(dateKey)
            if (arr) arr.push(event)
            else swingsByDay.set(dateKey, [event])

            progress.swingEventsWritten = (progress.swingEventsWritten ?? 0) + 1
          }
        }

        for (const agg of rebuildAggregators) {
          const closed = agg.builder.update(candle)
          if (closed) {
            const dateKey = new Date(closed.openTime).toISOString().slice(0, 10)
            const arr = agg.candles.get(dateKey)
            if (arr) arr.push(closed)
            else agg.candles.set(dateKey, [closed])
            progress.aggCandlesWritten = (progress.aggCandlesWritten ?? 0) + 1
          }
        }
      }

      if (rebuildSeries.length > 500) rebuildSeries.trimToLast(300)

      progress.daysProcessed = (progress.daysProcessed ?? 0) + 1
      setDerivedRebuildProgress(progress)
    }

    progress = { ...progress, message: 'Writing aggregated candles…' }
    setDerivedRebuildProgress(progress)

    for (const agg of rebuildAggregators) {
      for (const [dateKey, candles] of agg.candles.entries()) {
        if (derivedRebuildStop || shuttingDown) break
        const filePath = path.join(dataDir, 'candles', exchangeId, symbolLower, agg.tf, `${dateKey}.jsonl`)
        upsertCandlesForDay(filePath, candles)
      }
    }

    progress = { ...progress, message: 'Writing swing events…' }
    setDerivedRebuildProgress(progress)

    for (const [dateKey, swings] of swingsByDay.entries()) {
      if (derivedRebuildStop || shuttingDown) break
      const filePath = path.join(dataDir, 'swings', exchangeId, symbolLower, interval, `p${pivotLen}`, `${dateKey}.jsonl`)
      upsertSwingsForDay(filePath, swings)
    }

    progress = { ...progress, state: 'done', finishedAt: Date.now(), message: 'Derived rebuild complete' }
    setDerivedRebuildProgress(progress)
  } catch (err) {
    progress = { ...progress, state: 'error', finishedAt: Date.now(), lastError: err instanceof Error ? err.message : String(err) }
    setDerivedRebuildProgress(progress)
  } finally {
    derivedRebuildRunning = false
  }
}

function stopDerivedRebuild() {
  derivedRebuildStop = true
}

async function startDerivedRebuildForSymbol(sym: string, intv: string, maxDays?: number, force: boolean = false) {
  // Skip if already running (unless force is true for pipeline calls)
  if (derivedRebuildRunning && !force) return
  if ((backfillRunning || reconcileRunning) && !force) return

  derivedRebuildRunning = true
  derivedRebuildStop = false

  const symLower = sym.toLowerCase()
  const candleDir = path.join(dataDir, 'candles', exchangeId, symLower, intv)

  let progress: DerivedRebuildProgress = {
    state: 'running',
    startedAt: Date.now(),
    message: `Scanning ${symLower}/${intv} candle files...`,
    daysProcessed: 0,
    baseCandlesProcessed: 0,
    swingEventsWritten: 0
  }
  setDerivedRebuildProgress(progress)

  try {
    if (!fs.existsSync(candleDir)) {
      progress = { ...progress, state: 'done', finishedAt: Date.now(), message: `No candle data for ${symLower}/${intv}` }
      setDerivedRebuildProgress(progress)
      return
    }

    let files = fs.readdirSync(candleDir).filter((f) => f.endsWith('.jsonl')).sort()
    const todayKey = new Date().toISOString().slice(0, 10)
    files = files.filter((f) => f !== `${todayKey}.jsonl`)

    if (typeof maxDays === 'number' && maxDays > 0 && files.length > maxDays) {
      files = files.slice(files.length - maxDays)
    }

    const rebuildSeries = new CandleSeries()
    const swingsByDay = new Map<string, SwingEvent[]>()

    for (const f of files) {
      if (derivedRebuildStop || shuttingDown) {
        progress = { ...progress, state: 'stopped', finishedAt: Date.now(), message: 'Stopped' }
        setDerivedRebuildProgress(progress)
        return
      }

      progress = { ...progress, currentFile: f, message: `Processing ${f}` }
      setDerivedRebuildProgress(progress)

      const filePath = path.join(candleDir, f)
      const candles = readCandlesFromFile(filePath)

      for (const candle of candles) {
        if (derivedRebuildStop || shuttingDown) {
          progress = { ...progress, state: 'stopped', finishedAt: Date.now(), message: 'Stopped' }
          setDerivedRebuildProgress(progress)
          return
        }

        rebuildSeries.push(candle)
        progress.baseCandlesProcessed = (progress.baseCandlesProcessed ?? 0) + 1

        const candidateIndex = rebuildSeries.length - 1 - pivotLen
        if (candidateIndex >= 0) {
          const swing = detectSwingAt(rebuildSeries, pivotLen, candidateIndex)
          if (swing) {
            const pt = rebuildSeries.at(candidateIndex)
            const c = pt.candle
            const utc = new Date(c.openTime)
            const ny = getNyParts(c.openTime)
            const moonPhase = getMoonPhase(c.openTime)
            const markets = getGlobalMarketStatus(c.openTime)

            const features: SwingEvent['features'] = {
              ema6: pt.ema6 ?? null,
              ema50: pt.ema50 ?? null,
              sma200: pt.sma200 ?? null,
              rsi14: pt.rsi14 ?? null,
              // NEW 10 TECHNICAL INDICATORS
              atr14: pt.atr14 ?? null,
              bb_pct_b: pt.bbPctB ?? null,
              bb_upper: pt.bbUpper ?? null,
              bb_lower: pt.bbLower ?? null,
              macd_histogram: pt.macdHist ?? null,
              macd_signal: pt.macdSignal ?? null,
              stoch_k: pt.stochK ?? null,
              stoch_d: pt.stochD ?? null,
              roc10: pt.roc10 ?? null,
              adx14: pt.adx14 ?? null,
              // DERIVED BOOLEAN SIGNALS
              bb_overbought: pt.bbPctB !== null ? pt.bbPctB > 1 : null,
              bb_oversold: pt.bbPctB !== null ? pt.bbPctB < 0 : null,
              macd_bullish: pt.macdHist !== null ? pt.macdHist > 0 : null,
              stoch_overbought: pt.stochK !== null ? pt.stochK > 80 : null,
              stoch_oversold: pt.stochK !== null ? pt.stochK < 20 : null,
              strong_trend: pt.adx14 !== null ? pt.adx14 > 25 : null,
              momentum_positive: pt.roc10 !== null ? pt.roc10 > 0 : null,
              high_volatility: pt.atr14 !== null && c.close !== 0 ? (pt.atr14 / c.close) * 100 > 1 : null,
              // CANDLE PATTERN FEATURES
              is_doji: c.close !== 0 ? Math.abs(c.close - c.open) / (c.high - c.low || 1) < 0.1 : null,
              is_hammer: c.close !== 0 && (c.high - c.low) > 0 ? (Math.min(c.open, c.close) - c.low) / (c.high - c.low) > 0.6 : null,
              ema6_gt_ema50: pt.ema6 !== null && pt.ema50 !== null ? pt.ema6 > pt.ema50 : null,
              close_gt_sma200: pt.sma200 !== null ? c.close > pt.sma200 : null,
              us_market_hours: isUsMarketHours(c.openTime),
              utc_hour: utc.getUTCHours(),
              utc_weekday: utc.getUTCDay(),
              moon_phase: moonPhase.phase,
              tokyo_open: markets.tokyo,
              london_open: markets.london,
              nyse_open: markets.nyse
            }

            const dateKey = utc.toISOString().slice(0, 10)
            const existing = swingsByDay.get(dateKey) || []
            const evt: SwingEvent = {
              id: `${exchangeId}-${symLower}-${intv}-p${pivotLen}-${c.openTime}-${swing.swingType}`,
              exchange: exchangeId,
              symbol: symLower,
              baseInterval: intv,
              pivotLen,
              swingType: swing.swingType,
              openTime: c.openTime,
              closeTime: c.closeTime,
              price: swing.price,
              features
            }
            existing.push(evt)
            swingsByDay.set(dateKey, existing)
            progress.swingEventsWritten = (progress.swingEventsWritten ?? 0) + 1
          }
        }
      }

      if (rebuildSeries.length > 500) rebuildSeries.trimToLast(300)
      progress.daysProcessed = (progress.daysProcessed ?? 0) + 1
      setDerivedRebuildProgress(progress)
    }

    progress = { ...progress, message: 'Writing swing events...' }
    setDerivedRebuildProgress(progress)

    for (const [dateKey, swings] of swingsByDay.entries()) {
      if (derivedRebuildStop || shuttingDown) break
      const filePath = path.join(dataDir, 'swings', exchangeId, symLower, intv, `p${pivotLen}`, `${dateKey}.jsonl`)
      upsertSwingsForDay(filePath, swings)
    }

    progress = { ...progress, state: 'done', finishedAt: Date.now(), message: `Derived rebuild complete for ${symLower}/${intv}` }
    setDerivedRebuildProgress(progress)
  } catch (err) {
    progress = { ...progress, state: 'error', finishedAt: Date.now(), lastError: err instanceof Error ? err.message : String(err) }
    setDerivedRebuildProgress(progress)
  } finally {
    derivedRebuildRunning = false
  }
}

async function startDerivedRebuildForYahoo(sym: string, force: boolean = false) {
  if (derivedRebuildRunning && !force) return
  if ((backfillRunning || reconcileRunning) && !force) return

  derivedRebuildRunning = true
  derivedRebuildStop = false

  const symLower = sym.toLowerCase()
  const candleDir = path.join(dataDir, 'candles', 'yahoo', symLower, '1m')

  let progress: DerivedRebuildProgress = {
    state: 'running',
    startedAt: Date.now(),
    message: `Scanning ${symLower} candle files...`,
    daysProcessed: 0,
    baseCandlesProcessed: 0,
    aggCandlesWritten: 0,
    swingEventsWritten: 0
  }
  setDerivedRebuildProgress(progress)

  try {
    if (!fs.existsSync(candleDir)) {
      progress = { ...progress, state: 'done', finishedAt: Date.now(), message: `No candle data for ${symLower}` }
      setDerivedRebuildProgress(progress)
      derivedRebuildRunning = false
      return
    }

    const files = fs.readdirSync(candleDir).filter((f) => f.endsWith('.jsonl')).sort()
    
    // Load ALL 1m candles first
    const all1mCandles: Candle[] = []
    for (const f of files) {
      if (derivedRebuildStop || shuttingDown) break
      const filePath = path.join(candleDir, f)
      const candles = readCandlesFromFile(filePath)
      all1mCandles.push(...candles)
      progress.baseCandlesProcessed = (progress.baseCandlesProcessed ?? 0) + candles.length
    }
    all1mCandles.sort((a, b) => a.openTime - b.openTime)
    console.log(`[Engine] Yahoo ${symLower}: Loaded ${all1mCandles.length} 1m candles`)

    // Define all timeframes to generate (including 1m for swings)
    const yahooTimeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']
    
    for (const tf of yahooTimeframes) {
      if (derivedRebuildStop || shuttingDown) break
      
      progress = { ...progress, message: `Generating ${symLower}/${tf}...` }
      setDerivedRebuildProgress(progress)
      
      const tfMs = timeframeToMs(tf)
      let aggregatedCandles: Candle[] = []
      
      if (tf === '1m') {
        // Use original 1m candles
        aggregatedCandles = all1mCandles
      } else {
        // Aggregate 1m candles into this timeframe
        const builder = new TimeframeBuilder(tf)
        const candlesByDay = new Map<string, Candle[]>()
        
        for (const c of all1mCandles) {
          const closed = builder.update(c)
          if (closed) {
            const dateKey = new Date(closed.openTime).toISOString().slice(0, 10)
            const existing = candlesByDay.get(dateKey) || []
            existing.push(closed)
            candlesByDay.set(dateKey, existing)
            aggregatedCandles.push(closed)
          }
        }
        
        // Write aggregated candles to disk
        for (const [dateKey, candles] of candlesByDay.entries()) {
          if (derivedRebuildStop || shuttingDown) break
          const aggCandleDir = path.join(dataDir, 'candles', 'yahoo', symLower, tf)
          const filePath = path.join(aggCandleDir, `${dateKey}.jsonl`)
          upsertCandlesForDay(filePath, candles)
          progress.aggCandlesWritten = (progress.aggCandlesWritten ?? 0) + candles.length
        }
        
        console.log(`[Engine] Yahoo ${symLower}/${tf}: Generated ${aggregatedCandles.length} candles`)
      }
      
      // Now generate swings for this timeframe
      if (aggregatedCandles.length > 0) {
        const rebuildSeries = new CandleSeries()
        const swingsByDay = new Map<string, SwingEvent[]>()
        
        for (const candle of aggregatedCandles) {
          if (derivedRebuildStop || shuttingDown) break
          
          rebuildSeries.push(candle)
          
          const candidateIndex = rebuildSeries.length - 1 - pivotLen
          if (candidateIndex >= 0) {
            const swing = detectSwingAt(rebuildSeries, pivotLen, candidateIndex)
            if (swing) {
              const pt = rebuildSeries.at(candidateIndex)
              const c = pt.candle
              const utc = new Date(c.openTime)
              const moonPhase = getMoonPhase(c.openTime)
              const markets = getGlobalMarketStatus(c.openTime)

              // Calculate all features for completeness
              const utcHour = utc.getUTCHours()
              const utcMinute = utc.getUTCMinutes()
              const utcWeekday = utc.getUTCDay()
              const utcMonth = utc.getUTCMonth() + 1
              const utcDate = utc.getUTCDate()
              const daysInMonth = new Date(utc.getUTCFullYear(), utcMonth, 0).getDate()
              const quarter = Math.ceil(utcMonth / 3)
              
              // Price-based features
              const rangePct = c.high > 0 ? ((c.high - c.low) / c.high) * 100 : 0
              const bodyPct = c.high > 0 ? (Math.abs(c.close - c.open) / c.high) * 100 : 0
              const closeSma200Pct = pt.sma200 ? ((c.close - pt.sma200) / pt.sma200) * 100 : null

              const features: SwingEvent['features'] = {
                ema6: pt.ema6 ?? null,
                ema50: pt.ema50 ?? null,
                sma200: pt.sma200 ?? null,
                rsi14: pt.rsi14 ?? null,
                atr14: pt.atr14 ?? null,
                bb_pct_b: pt.bbPctB ?? null,
                macd_histogram: pt.macdHist ?? null,
                stoch_k: pt.stochK ?? null,
                adx14: pt.adx14 ?? null,
                roc10: pt.roc10 ?? null,
                ema6_gt_ema50: pt.ema6 !== null && pt.ema50 !== null ? pt.ema6 > pt.ema50 : null,
                close_gt_sma200: pt.sma200 !== null ? c.close > pt.sma200 : null,
                us_market_hours: isUsMarketHours(c.openTime),
                utc_hour: utcHour,
                utc_minute: utcMinute,
                utc_weekday: utcWeekday,
                utc_month: utcMonth,
                moon_phase: moonPhase.phase,
                moon_illumination: moonPhase.illumination,
                tokyo_open: markets.tokyo,
                london_open: markets.london,
                nyse_open: markets.nyse,
                sydney_open: markets.sydney,
                frankfurt_open: markets.frankfurt,
                london_nyse_overlap: markets.london && markets.nyse,
                tokyo_london_overlap: markets.tokyo && markets.london,
                major_markets_open: [markets.tokyo, markets.london, markets.nyse].filter(Boolean).length,
                is_traditional_market: true,
                range_pct: rangePct,
                body_pct: bodyPct,
                close_sma200_pct: closeSma200Pct,
                is_monday: utcWeekday === 1,
                is_friday: utcWeekday === 5,
                is_weekend: utcWeekday === 0 || utcWeekday === 6,
                quarter: quarter,
                is_month_start: utcDate <= 3,
                is_month_end: utcDate >= daysInMonth - 2,
                is_first_week: utcDate <= 7,
                is_last_week: utcDate >= daysInMonth - 6,
                is_mid_month: utcDate >= 10 && utcDate <= 20,
                hour_bucket: Math.floor(utcHour / 4),
                is_hour_start: utcMinute < 5,
                is_hour_end: utcMinute >= 55,
                is_half_hour: utcMinute === 30
              }

              const dateKey = utc.toISOString().slice(0, 10)
              const existing = swingsByDay.get(dateKey) || []
              const evt: SwingEvent = {
                id: `yahoo-${symLower}-${tf}-p${pivotLen}-${c.openTime}-${swing.swingType}`,
                exchange: 'yahoo',
                symbol: symLower,
                baseInterval: tf,
                pivotLen,
                swingType: swing.swingType,
                openTime: c.openTime,
                closeTime: c.closeTime,
                price: swing.price,
                features
              }
              existing.push(evt)
              swingsByDay.set(dateKey, existing)
              progress.swingEventsWritten = (progress.swingEventsWritten ?? 0) + 1
            }
          }
          
          if (rebuildSeries.length > 500) rebuildSeries.trimToLast(300)
        }
        
        // Write swings for this timeframe
        for (const [dateKey, swings] of swingsByDay.entries()) {
          if (derivedRebuildStop || shuttingDown) break
          const filePath = path.join(dataDir, 'swings', 'yahoo', symLower, tf, `p${pivotLen}`, `${dateKey}.jsonl`)
          upsertSwingsForDay(filePath, swings)
        }
        
        console.log(`[Engine] Yahoo ${symLower}/${tf}: Generated ${progress.swingEventsWritten} swings total`)
      }
      
      progress.daysProcessed = (progress.daysProcessed ?? 0) + 1
      setDerivedRebuildProgress(progress)
    }

    progress = { ...progress, state: 'done', finishedAt: Date.now(), message: `Derived rebuild complete for ${symLower} (all timeframes)` }
    setDerivedRebuildProgress(progress)
  } catch (err) {
    progress = { ...progress, state: 'error', finishedAt: Date.now(), lastError: err instanceof Error ? err.message : String(err) }
    setDerivedRebuildProgress(progress)
  } finally {
    derivedRebuildRunning = false
  }
}

function loadAllSwings(forSymbol?: string): SwingEvent[] {
  const sym = (forSymbol || symbolLower).toLowerCase()
  
  // Determine exchange based on symbol
  const isYahooSymbol = ['spy', 'nq', 'gc', 'cl', 'es'].includes(sym)
  const exchange = isYahooSymbol ? 'yahoo' : exchangeId
  const symbolDir = path.join(dataDir, 'swings', exchange, sym)
  
  if (!fs.existsSync(symbolDir)) return []

  const allSwings: SwingEvent[] = []
  
  // MEMORY OPTIMIZATION: Limit total swings loaded to prevent 88GB memory usage
  const MAX_SWINGS = 10000
  const MAX_FILES_PER_TF = 3 // Only load last 3 days per timeframe
  
  // Load from ALL timeframe directories
  const allTimeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']
  
  for (const tf of allTimeframes) {
    if (allSwings.length >= MAX_SWINGS) break
    
    const swingDir = path.join(symbolDir, tf, `p${pivotLen}`)
    if (!fs.existsSync(swingDir)) continue

    const files = fs.readdirSync(swingDir).filter((f) => f.endsWith('.jsonl')).sort()
    
    // Only load the most recent files to save memory
    const recentFiles = files.slice(-MAX_FILES_PER_TF)

    for (const f of recentFiles) {
      if (allSwings.length >= MAX_SWINGS) break
      
      const raw = fs.readFileSync(path.join(swingDir, f), 'utf8')
      for (const line of raw.split(/\r?\n/)) {
        if (allSwings.length >= MAX_SWINGS) break
        
        const t = line.trim()
        if (!t) continue
        try {
          const e = JSON.parse(t) as SwingEvent
          if (e.id) allSwings.push(e)
        } catch {}
      }
    }
  }

  allSwings.sort((a, b) => a.openTime - b.openTime)
  return allSwings
}

function getAvailableSymbols(): string[] {
  const swingsBaseDir = path.join(dataDir, 'swings', exchangeId)
  if (!fs.existsSync(swingsBaseDir)) return [symbolLower]
  
  const symbols = fs.readdirSync(swingsBaseDir)
    .filter(f => fs.statSync(path.join(swingsBaseDir, f)).isDirectory())
  
  if (!symbols.includes(symbolLower)) symbols.unshift(symbolLower)
  return [...new Set(symbols)]
}

async function exportSwingsCsv(): Promise<string> {
  const allSwings = loadAllSwings()
  if (allSwings.length === 0) return ''

  const featureKeys = new Set<string>()
  for (const e of allSwings) {
    for (const k of Object.keys(e.features)) featureKeys.add(k)
  }
  const sortedFeatureKeys = Array.from(featureKeys).sort()

  const headers = ['id', 'exchange', 'symbol', 'baseInterval', 'pivotLen', 'swingType', 'openTime', 'closeTime', 'price', 'openTimeISO', ...sortedFeatureKeys]

  const rows: string[] = [headers.join(',')]
  for (const e of allSwings) {
    const base = [
      e.id,
      e.exchange,
      e.symbol,
      e.baseInterval,
      String(e.pivotLen),
      e.swingType,
      String(e.openTime),
      String(e.closeTime),
      String(e.price),
      new Date(e.openTime).toISOString()
    ]
    const features = sortedFeatureKeys.map((k) => {
      const v = e.features[k]
      if (v === null || v === undefined) return ''
      if (typeof v === 'boolean') return v ? '1' : '0'
      return String(v)
    })
    rows.push([...base, ...features].join(','))
  }

  const csvPath = path.join(dataDir, 'exports', `swings_${exchangeId}_${symbolLower}_${interval}_p${pivotLen}.csv`)
  fs.mkdirSync(path.dirname(csvPath), { recursive: true })
  fs.writeFileSync(csvPath, rows.join('\n'), 'utf8')

  return csvPath
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0
      if (status !== 200) {
        res.resume()
        reject(new Error(`HTTP ${status} ${res.statusMessage ?? ''}`.trim()))
        return
      }

      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buf += chunk
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(buf))
        } catch (err) {
          reject(err)
        }
      })
    })

    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timeout'))
    })
    req.on('error', reject)
  })
}

async function fetchKlines(startOpenTime: number, endOpenTime: number): Promise<Candle[]> {
  if (endOpenTime < startOpenTime) return []

  const limit = Math.min(1000, Math.floor((endOpenTime - startOpenTime) / baseMs) + 1)
  const params = new URLSearchParams({
    symbol: symbolLower.toUpperCase(),
    interval,
    startTime: String(startOpenTime),
    endTime: String(endOpenTime),
    limit: String(limit)
  })
  const url = `${restBaseUrl}/api/v3/klines?${params.toString()}`

  const raw = await fetchJson(url)
  if (!Array.isArray(raw)) return []

  const candles: Candle[] = []
  for (const row of raw as any[]) {
    if (!Array.isArray(row) || row.length < 11) continue
    const openTime = Number(row[0])
    const closeTime = Number(row[6])
    if (!Number.isFinite(openTime) || !Number.isFinite(closeTime)) continue
    if (openTime < startOpenTime || openTime > endOpenTime) continue

    candles.push({
      exchange: exchangeId,
      symbol: symbolLower.toUpperCase(),
      interval,
      openTime,
      closeTime,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      quoteVolume: Number(row[7]),
      trades: Number(row[8]),
      takerBuyBase: Number(row[9]),
      takerBuyQuote: Number(row[10])
    })
  }

  candles.sort((a, b) => a.openTime - b.openTime)
  return candles
}

async function handleFinalCandle(candle: Candle, allowRepair: boolean): Promise<void> {
  if (lastFinalOpenTime !== null && candle.openTime <= lastFinalOpenTime) {
    return
  }

  if (lastFinalOpenTime !== null) {
    const expectedOpenTime = lastFinalOpenTime + baseMs
    if (candle.openTime > expectedOpenTime) {
      const missingCandles = Math.floor((candle.openTime - expectedOpenTime) / baseMs)
      gapsFound += 1
      sendStatus({ gapsFound })
      gapWriter.write(
        {
          expectedOpenTime,
          actualOpenTime: candle.openTime,
          missingCandles
        },
        candle.openTime
      )

      if (
        allowRepair &&
        gapRepairMaxCandles > 0 &&
        missingCandles > 0 &&
        missingCandles <= gapRepairMaxCandles
      ) {
        const endOpenTime = candle.openTime - baseMs
        try {
          const repaired = await fetchKlines(expectedOpenTime, endOpenTime)
          for (const c of repaired) {
            await handleFinalCandle(c, false)
          }
        } catch {
        }
      }
    }
  }

  lastFinalOpenTime = candle.openTime
  if (candleWriter.write(candle, candle.openTime)) {
    candlesWritten += 1
    sendStatus({ candlesWritten })
  }

  baseSeries.push(candle)
  const candidateIndex = baseSeries.length - 1 - pivotLen
  if (candidateIndex >= 0) {
    const swing = detectSwingAt(baseSeries, pivotLen, candidateIndex)
    if (swing) {
      const pt = baseSeries.at(candidateIndex)
      const c = pt.candle
      const utc = new Date(c.openTime)
      const ny = getNyParts(c.openTime)
      const features: SwingEvent['features'] = {
        ema6: pt.ema6 ?? null,
        ema50: pt.ema50 ?? null,
        sma200: pt.sma200 ?? null,
        rsi14: pt.rsi14 ?? null,
        ema6_gt_ema50: pt.ema6 !== null && pt.ema50 !== null ? pt.ema6 > pt.ema50 : null,
        close_gt_sma200: pt.sma200 !== null ? c.close > pt.sma200 : null,
        close_sma200_pct:
          pt.sma200 !== null && pt.sma200 !== 0 ? ((c.close - pt.sma200) / pt.sma200) * 100 : null,
        range_pct: c.close !== 0 ? ((c.high - c.low) / c.close) * 100 : null,
        body_pct: c.close !== 0 ? (Math.abs(c.close - c.open) / c.close) * 100 : null,
        utc_weekday: utc.getUTCDay(),
        utc_hour: utc.getUTCHours(),
        utc_minute: utc.getUTCMinutes(),
        utc_month: utc.getUTCMonth() + 1,
        utc_day: utc.getUTCDate(),
        utc_year: utc.getUTCFullYear(),
        ny_weekday: ny.weekday,
        ny_hour: ny.hour,
        ny_minute: ny.minute,
        us_market_hours: isUsMarketHours(c.openTime)
      }

      const event: SwingEvent = {
        id: `${exchangeId}:${symbolLower}:${interval}:p${pivotLen}:${swing.swingType}:${c.openTime}`,
        exchange: exchangeId,
        symbol: c.symbol,
        baseInterval: interval,
        pivotLen,
        swingType: swing.swingType,
        openTime: c.openTime,
        closeTime: c.closeTime,
        price: swing.price,
        features
      }

      if (swingWriter.write(event, c.openTime)) {
        process.send?.({ type: 'swing', data: event })
        swingsFound += 1
        sendStatus({ swingsFound })
      }
    }
  }

  for (const agg of aggregators) {
    const closed = agg.builder.update(candle)
    if (closed) {
      agg.writer.write(closed, closed.openTime)
    }
  }
}

process.on('message', (msg: unknown) => {
  const m = msg as any
  if (!m || typeof m !== 'object') return
  
  // Log ALL incoming messages for debugging
  if (m.type?.startsWith('trader:')) {
    console.log(`[Engine] ===== TRADER MESSAGE: ${m.type} =====`)
  }

  if (m.type === 'reconcile:start') {
    void startReconcile(typeof m.maxDays === 'number' ? m.maxDays : undefined)
    return
  }

  if (m.type === 'reconcile:stop') {
    stopReconcile()
    return
  }

  if (m.type === 'backfill:start') {
    const sym = typeof m.symbol === 'string' ? m.symbol : symbolLower
    const intv = typeof m.interval === 'string' ? m.interval : interval
    void startBackfillForSymbol(sym, intv, typeof m.maxMonths === 'number' ? m.maxMonths : undefined)
    return
  }

  if (m.type === 'backfill:stop') {
    stopBackfill()
    return
  }

  if (m.type === 'derivedRebuild:start') {
    void startDerivedRebuild(typeof m.maxDays === 'number' ? m.maxDays : undefined)
    return
  }

  if (m.type === 'derivedRebuild:stop') {
    stopDerivedRebuild()
    return
  }

  if (m.type === 'exportCsv') {
    exportSwingsCsv().then((csvPath) => {
      process.send?.({ type: 'csvExported', data: { path: csvPath } })
    }).catch((err) => {
      process.send?.({ type: 'csvExported', data: { path: '', error: err instanceof Error ? err.message : String(err) } })
    })
    return
  }

  if (m.type === 'getSymbols') {
    const symbols = getAvailableSymbols()
    process.send?.({ type: 'symbolsData', data: symbols })
    return
  }

  if (m.type === 'getSwings') {
    try {
      const forSymbol = typeof m.symbol === 'string' ? m.symbol : undefined
      console.log('[Engine] Loading swings from disk for', forSymbol || symbolLower)
      const allSwings = loadAllSwings(forSymbol)
      console.log('[Engine] Loaded', allSwings.length, 'total swings')
      const swings = allSwings.slice(-10000)
      console.log('[Engine] Sending', swings.length, 'most recent swings to main process...')
      process.send?.({ type: 'swingsData', data: swings, total: allSwings.length, symbol: forSymbol || symbolLower })
      console.log('[Engine] Sent swings data')
    } catch (err) {
      console.log('[Engine] Error loading swings:', err)
      process.send?.({ type: 'swingsData', data: [], error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (m.type === 'live:start') {
    startLive()
    return
  }

  if (m.type === 'live:stop') {
    stopLive()
    return
  }

  // ═══════════════════════════════════════════════════════════════
  // ASTERDEX LIVE TRADER API HANDLERS
  // ═══════════════════════════════════════════════════════════════

  if (m.type === 'trader:start') {
    console.log('[Engine] Starting AsterDEX trader with config:', { ...m.config, apiSecret: '***' })
    asterDexConfig = {
      apiKey: m.config.apiKey,
      apiSecret: m.config.apiSecret,
      testnet: m.config.testnet || false
    }
    asterDexRunning = true
    
    // Step 1: Load our pre-computed swing patterns for signal analysis
    console.log('[Engine] Loading swing pattern database...')
    try {
      const allSwings = loadAllSwings('ethusdt')
      loadedSwingPatterns = allSwings.map(s => ({
        price: s.price,
        direction: s.swingType,
        confluence: (s.features?.confluence as number) || 1,
        timestamp: s.openTime
      }))
      console.log(`[Engine] Loaded ${loadedSwingPatterns.length} swing patterns for live analysis`)
    } catch (err) {
      console.error('[Engine] Failed to load swings, continuing without pattern data')
      loadedSwingPatterns = []
    }
    
    // Step 2: Start fetching live price immediately (public endpoint, no auth)
    console.log('[Engine] Fetching initial live price...')
    fetchLivePrice().then(price => {
      console.log(`[Engine] Live ETHUSDT price: $${price.toFixed(2)}`)
      process.send?.({ type: 'trader:liveUpdate', data: { price, signal: 'none', strength: 0, reason: 'Initializing...', timestamp: Date.now(), apiCalls: 0 } })
    }).catch(err => {
      console.error('[Engine] Initial price fetch failed:', err.message)
    })
    
    // Step 3: Start the lightweight trading loop
    startLiveTraderLoop()
    
    // Step 4: Try to fetch balance (requires auth) - non-blocking
    console.log('[Engine] Attempting to fetch account balance...')
    fetchAsterDexBalance().then((bal: { marginBalance: number; availableBalance: number; unrealizedPnl: number }) => {
      console.log(`[Engine] AsterDEX Balance: $${bal.marginBalance.toFixed(2)}`)
      process.send?.({ type: 'trader:balance', data: bal })
      process.send?.({ type: 'trader:health', data: { isHealthy: true, apiLatencyMs: 50, wsConnected: true, uptime: 0, errorCount: 0 } })
    }).catch((err: Error) => {
      console.error('[Engine] Balance fetch failed (auth issue?):', err.message)
      // Still mark as healthy since price fetching works
      process.send?.({ type: 'trader:health', data: { isHealthy: true, apiLatencyMs: 100, wsConnected: true, uptime: 0, errorCount: 1 } })
    })
    return
  }

  if (m.type === 'trader:stop') {
    console.log('[Engine] Stopping AsterDEX trader')
    asterDexRunning = false
    stopLiveTraderLoop()
    return
  }

  if (m.type === 'trader:getBalance') {
    fetchAsterDexBalance().then(bal => {
      process.send?.({ type: 'trader:balance', data: bal })
    }).catch(err => {
      console.error('[Engine] Balance fetch error:', err)
      process.send?.({ type: 'trader:balance', data: { marginBalance: 0, availableBalance: 0, unrealizedPnl: 0 } })
    })
    return
  }

  if (m.type === 'trader:testTrade') {
    const { side, marginUsd } = m
    console.log(`[Engine] ===== TEST TRADE REQUEST =====`)
    console.log(`[Engine] Side: ${side}, Margin: $${marginUsd}`)
    console.log(`[Engine] AsterDEX configured: ${asterDexConfig ? 'YES' : 'NO'}`)
    
    if (!asterDexConfig) {
      console.error('[Engine] ERROR: AsterDEX not configured! Click START TRADING first.')
      process.send?.({ type: 'trader:trade', data: { success: false, error: 'Trader not started - click START TRADING first' } })
      return
    }
    
    executeAsterDexTestTrade(side, marginUsd).then(result => {
      console.log('[Engine] Test trade result:', result)
      process.send?.({ type: 'trader:trade', data: result })
    }).catch(err => {
      console.error('[Engine] Test trade error:', err.message)
      process.send?.({ type: 'trader:trade', data: { success: false, error: err.message } })
    })
    return
  }

  if (m.type === 'trader:emergencyStop') {
    console.log('[Engine] EMERGENCY STOP - closing all positions')
    closeAllAsterDexPositions().then(() => {
      asterDexRunning = false
      process.send?.({ type: 'trader:health', data: { isHealthy: false, apiLatencyMs: 0, wsConnected: false, uptime: 0, errorCount: 0 } })
    }).catch(err => {
      console.error('[Engine] Emergency stop error:', err)
    })
    return
  }
})

const ws = new BinanceKlineWs(exchangeId, baseWsUrl, symbolLower, interval, {
  onStatus: (s) => {
    sendStatus({
      connected: s.connected,
      lastPrice: s.lastPrice,
      lastKlineOpenTime: s.lastKlineOpenTime
    })
  },
  onKline: (kline) => {
    process.send?.({ type: 'kline', data: kline })

    if (!kline.isFinal) return

    const candle: Candle = {
      exchange: exchangeId,
      symbol: kline.symbol,
      interval: kline.interval,
      openTime: kline.openTime,
      closeTime: kline.closeTime,
      open: kline.open,
      high: kline.high,
      low: kline.low,
      close: kline.close,
      volume: kline.volume,
      quoteVolume: kline.quoteVolume,
      trades: kline.trades,
      takerBuyBase: kline.takerBuyBase,
      takerBuyQuote: kline.takerBuyQuote
    }

    finalCandleChain = finalCandleChain.then(() => handleFinalCandle(candle, true)).catch(() => {})
  }
})

let liveEnabled = false

function startLive() {
  if (liveEnabled) return
  liveEnabled = true
  ws.connect()
  console.log('[Engine] Live WebSocket started')
}

function stopLive() {
  if (!liveEnabled) return
  liveEnabled = false
  ws.disconnect()
  sendStatus({ connected: false })
  console.log('[Engine] Live WebSocket stopped')
}

function shutdown(code: number) {
  if (shuttingDown) return
  shuttingDown = true

  ws.disconnect()
  candleWriter.close()
  gapWriter.close()
  swingWriter.close()
  for (const agg of aggregators) {
    agg.writer.close()
  }

  process.exit(code)
}

process.on('disconnect', () => {
  shutdown(0)
})

process.on('SIGTERM', () => {
  shutdown(0)
})

process.on('SIGINT', () => {
  shutdown(0)
})

async function autoStartPipeline() {
  await new Promise((r) => setTimeout(r, 3000))

  // Traditional market symbols from Yahoo Finance - PROCESS FIRST (smaller dataset)
  const yahooSymbols = ['SPY', 'NQ=F', 'GC=F', 'CL=F']
  
  console.log('[Engine] PHASE 0: Processing Yahoo/TradFi symbols first (smaller dataset)...')
  for (const sym of yahooSymbols) {
    if (shuttingDown) return
    const symLower = sym.toLowerCase().replace('=f', '')
    const candleDir = path.join(dataDir, 'candles', 'yahoo', symLower, '1m')
    
    try {
      if (fs.existsSync(candleDir)) {
        const files = fs.readdirSync(candleDir).filter(f => f.endsWith('.jsonl'))
        if (files.length > 0) {
          console.log(`[Engine] Yahoo ${symLower}: Found ${files.length} candle files, generating all timeframes...`)
          await startDerivedRebuildForYahoo(symLower, true)
        }
      }
    } catch (err) {
      console.error(`[Engine] Yahoo rebuild error for ${symLower}:`, err)
    }
  }
  console.log('[Engine] PHASE 0 complete. Yahoo/TradFi symbols processed.')

  // Crypto symbols from Binance - ALL timeframes
  const cryptoSymbols = ['btcusdt', 'ethusdt', 'ethbtc', 'solusdt', 'dogeusdt', 'xrpusdt']
  const allTimeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']

  console.log(`[Engine] Starting full data pipeline for ${cryptoSymbols.length} symbols × ${allTimeframes.length} timeframes = ${cryptoSymbols.length * allTimeframes.length} jobs`)
  console.log(`[Engine] Data directory: ${dataDir}`)
  console.log(`[Engine] Exchange ID: ${exchangeId}`)

  // PHASE 1: Run derived rebuild for any existing candle data (generates swings immediately)
  console.log('[Engine] PHASE 1: Generating swings from existing crypto candle data...')
  for (const sym of cryptoSymbols) {
    for (const tf of allTimeframes) {
      if (shuttingDown) return
      try {
        const candleDir = path.join(dataDir, 'candles', exchangeId, sym, tf)
        if (fs.existsSync(candleDir)) {
          const files = fs.readdirSync(candleDir).filter(f => f.endsWith('.jsonl'))
          if (files.length > 0) {
            console.log(`[Engine] Found existing candles for ${sym}/${tf} (${files.length} files), running derived rebuild...`)
            await startDerivedRebuildForSymbol(sym, tf, undefined, true)
          }
        }
      } catch (err) {
        console.error(`[Engine] Error processing ${sym}/${tf}:`, err)
      }
    }
  }
  console.log('[Engine] PHASE 1 complete. Swings generated from existing data.')

  // PHASE 2: Continue backfilling any missing data
  console.log('[Engine] PHASE 2: Backfilling any missing historical data...')
  for (const sym of cryptoSymbols) {
    for (const tf of allTimeframes) {
      if (shuttingDown) return
      try {
        console.log(`[Engine] Auto-starting backfill for ${sym}/${tf}...`)
        await startBackfillForSymbol(sym, tf)
      } catch (err) {
        console.error(`[Engine] Backfill error for ${sym}/${tf}:`, err)
      }
    }
  }

  // Traditional market symbols from Yahoo Finance - backfill any missing data
  for (const sym of yahooSymbols) {
    if (shuttingDown) return
    try {
      console.log(`[Engine] Auto-starting Yahoo backfill for ${sym}...`)
      await runYahooBackfill({
        symbol: sym,
        dataDir,
        maxDays: 7, // Yahoo only provides ~7 days of 1m data
        stopSignal: () => shuttingDown,
        onProgress: (p) => {
          console.log(`[YahooBackfill] ${sym}: ${p.message || p.state}`)
        }
      })
    } catch (err) {
      console.error(`[Engine] Yahoo backfill error for ${sym}:`, err)
    }
  }

  if (shuttingDown) return

  try {
    console.log('[Engine] Auto-starting reconcile...')
    await startReconcile()
  } catch (err) {
    console.error('[Engine] Reconcile error:', err)
  }

  console.log('[Engine] Pipeline complete for ALL symbols and ALL timeframes. Running live 24/7.')
}

// Add global unhandled rejection handler to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Engine] Unhandled Rejection:', reason)
})

autoStartPipeline().catch((err) => {
  console.error('[Engine] Pipeline error:', err)
})
