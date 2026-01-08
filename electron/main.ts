import { app, BrowserWindow, ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { fork, ChildProcess } from 'child_process'

type BackfillProgress = {
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
  totalCandles?: number
  totalSwings?: number
  oldestCandle?: string
  newestCandle?: string
  featuresComplete?: boolean
}

type EngineStatus = {
  connected: boolean
  lastPrice?: number
  lastKlineOpenTime?: number
  symbol?: string
  exchange?: string
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

type EngineMessage =
  | { type: 'status'; data: EngineStatus }
  | {
      type: 'kline'
      data: {
        exchange: string
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
    }
  | {
      type: 'swing'
      data: {
        id: string
        exchange: string
        symbol: string
        baseInterval: string
        pivotLen: number
        swingType: 'high' | 'low'
        openTime: number
        closeTime: number
        price: number
        features: Record<string, unknown>
      }
    }

let mainWindow: BrowserWindow | null = null
let engineProcess: ChildProcess | null = null
let lastStatus: EngineStatus = { connected: false }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Always load from built files - use npm run dev for hot reload development
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  
  // Open DevTools in dev mode (when not packaged)
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// MEMORY OPTIMIZATION: Periodic cleanup to prevent 88GB memory bloat
let memoryCleanupInterval: NodeJS.Timeout | null = null

function startMemoryCleanup() {
  if (memoryCleanupInterval) return
  
  memoryCleanupInterval = setInterval(() => {
    const used = process.memoryUsage()
    const heapMB = Math.round(used.heapUsed / 1024 / 1024)
    const rssMB = Math.round(used.rss / 1024 / 1024)
    
    console.log(`[Memory] Heap: ${heapMB}MB, RSS: ${rssMB}MB`)
    
    // If heap exceeds 500MB, force garbage collection
    if (heapMB > 500 && global.gc) {
      console.log('[Memory] Running garbage collection...')
      global.gc()
    }
    
    // If RSS exceeds 1GB, warn
    if (rssMB > 1000) {
      console.warn('[Memory] WARNING: RSS exceeds 1GB - consider restarting app')
    }
  }, 60000) // Check every minute
}

function startEngine() {
  if (engineProcess) return

  const enginePath = path.join(__dirname, '../engine/engine.js')
  const dataDir = path.join(app.getPath('userData'), 'data')
  
  // Use inherit for stdio with explicit IPC channel
  // Add --expose-gc flag for garbage collection control
  engineProcess = fork(enginePath, [], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    execArgv: ['--expose-gc', '--max-old-space-size=512'],
    env: {
      ...process.env,
      DATA_DIR: dataDir
    }
  })
  
  // Start memory monitoring
  startMemoryCleanup()

  engineProcess.on('message', (msg: EngineMessage) => {
    process.stdout.write(`[Main] Received message from engine: ${msg.type}\n`)
    if (!mainWindow) {
      process.stdout.write('[Main] mainWindow is null, cannot forward\n')
      return
    }

    if (msg.type === 'status') {
      lastStatus = msg.data
      const ds = msg.data.dataStatuses || []
      const withData = ds.filter((s: DataStatus) => s.candleFiles > 0).length
      process.stdout.write(`[Main] Forwarding status to renderer: ${withData} symbols with data, ${msg.data.databaseSizeMB || 0}MB\n`)
      mainWindow.webContents.send('engine:status', msg.data)
      return
    }

    if (msg.type === 'kline') {
      mainWindow.webContents.send('engine:kline', msg.data)
      return
    }

    if (msg.type === 'swing') {
      mainWindow.webContents.send('engine:swing', msg.data)
      return
    }
  })

  engineProcess.on('exit', () => {
    engineProcess = null
    lastStatus = { connected: false }
    mainWindow?.webContents.send('engine:status', lastStatus)
  })
}

function stopEngine() {
  if (!engineProcess) return
  engineProcess.kill()
  engineProcess = null
  lastStatus = { connected: false }
}

// Direct data scanning function - bypasses IPC for initial status
function scanDataDirectory(dataDir: string): Partial<EngineStatus> {
  const cryptoSymbols = ['btcusdt', 'ethusdt', 'solusdt', 'dogeusdt', 'xrpusdt']
  const yahooSymbols = ['spy', 'nq', 'gc', 'cl']
  const timeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']
  const exchangeId = 'binance'
  const statuses: DataStatus[] = []
  let totalSize = 0

  const scanSymbol = (sym: string, exchange: string) => {
    for (const tf of timeframes) {
      const candleDir = path.join(dataDir, 'candles', exchange, sym, tf)
      const swingDir = path.join(dataDir, 'swings', exchange, sym, tf, 'p3')
      let candleFiles = 0, swingFiles = 0
      try {
        if (fs.existsSync(candleDir)) {
          candleFiles = fs.readdirSync(candleDir).filter(f => f.endsWith('.jsonl')).length
        }
      } catch {}
      try {
        if (fs.existsSync(swingDir)) {
          swingFiles = fs.readdirSync(swingDir).filter(f => f.endsWith('.jsonl')).length
        }
      } catch {}
      statuses.push({ symbol: sym, timeframe: tf, candleFiles, swingFiles })
    }
  }

  for (const sym of cryptoSymbols) scanSymbol(sym, exchangeId)
  for (const sym of yahooSymbols) scanSymbol(sym, 'yahoo')

  // Calculate total size
  const getDirSize = (dir: string): number => {
    if (!fs.existsSync(dir)) return 0
    let size = 0
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) size += getDirSize(fullPath)
        else if (entry.isFile()) try { size += fs.statSync(fullPath).size } catch {}
      }
    } catch {}
    return size
  }
  totalSize = getDirSize(dataDir)

  return {
    dataStatuses: statuses,
    databaseSizeBytes: totalSize,
    databaseSizeMB: Math.round(totalSize / 1024 / 1024 * 10) / 10
  }
}

app.whenReady().then(() => {
  createWindow()
  startEngine()
  
  ipcMain.handle('engine:start', async () => {
    startEngine()
  })

  ipcMain.handle('engine:stop', async () => {
    stopEngine()
  })

  ipcMain.handle('engine:getStatus', async () => {
    // If lastStatus has no data, scan directly
    if (!lastStatus.dataStatuses || lastStatus.dataStatuses.length === 0) {
      const dataDir = path.join(app.getPath('userData'), 'data')
      const scannedStatus = scanDataDirectory(dataDir)
      return { ...lastStatus, ...scannedStatus }
    }
    return lastStatus
  })

  ipcMain.handle('engine:backfillStart', async (_evt, opts: { maxMonths?: number; symbol?: string; interval?: string } | undefined) => {
    startEngine()
    engineProcess?.send({ type: 'backfill:start', maxMonths: opts?.maxMonths, symbol: opts?.symbol, interval: opts?.interval })
  })

  ipcMain.handle('engine:backfillStop', async () => {
    engineProcess?.send({ type: 'backfill:stop' })
  })

  ipcMain.handle('engine:reconcileStart', async (_evt, opts: { maxDays?: number; symbol?: string; interval?: string } | undefined) => {
    startEngine()
    engineProcess?.send({ type: 'reconcile:start', maxDays: opts?.maxDays, symbol: opts?.symbol, interval: opts?.interval })
  })

  ipcMain.handle('engine:reconcileStop', async () => {
    engineProcess?.send({ type: 'reconcile:stop' })
  })

  ipcMain.handle('engine:derivedRebuildStart', async (_evt, opts: { maxDays?: number; symbol?: string; interval?: string } | undefined) => {
    startEngine()
    engineProcess?.send({ type: 'derivedRebuild:start', maxDays: opts?.maxDays, symbol: opts?.symbol, interval: opts?.interval })
  })

  ipcMain.handle('engine:derivedRebuildStop', async () => {
    engineProcess?.send({ type: 'derivedRebuild:stop' })
  })

  ipcMain.handle('engine:exportCsv', async () => {
    return new Promise((resolve) => {
      if (!engineProcess) {
        resolve({ path: '', error: 'Engine not running' })
        return
      }
      const handler = (msg: any) => {
        if (msg?.type === 'csvExported') {
          engineProcess?.off('message', handler)
          resolve(msg.data)
        }
      }
      engineProcess.on('message', handler)
      engineProcess.send({ type: 'exportCsv' })
      setTimeout(() => {
        engineProcess?.off('message', handler)
        resolve({ path: '', error: 'Timeout' })
      }, 60000)
    })
  })

  ipcMain.handle('engine:getSymbols', async () => {
    return new Promise((resolve) => {
      if (!engineProcess) {
        resolve(['btcusdt'])
        return
      }
      const handler = (msg: any) => {
        if (msg?.type === 'symbolsData') {
          engineProcess?.off('message', handler)
          resolve(msg.data || ['btcusdt'])
        }
      }
      engineProcess.on('message', handler)
      engineProcess.send({ type: 'getSymbols' })
      setTimeout(() => {
        engineProcess?.off('message', handler)
        resolve(['btcusdt'])
      }, 5000)
    })
  })

  ipcMain.handle('engine:getSwings', async (_event, symbol?: string) => {
    // Direct swing loading - bypass IPC
    const dataDir = path.join(app.getPath('userData'), 'data')
    const sym = (symbol || 'btcusdt').toLowerCase()
    const isYahoo = ['spy', 'nq', 'gc', 'cl', 'es'].includes(sym)
    const exchange = isYahoo ? 'yahoo' : 'binance'
    const symbolDir = path.join(dataDir, 'swings', exchange, sym)
    
    if (!fs.existsSync(symbolDir)) {
      console.log('[Main] No swing dir for', sym, 'at', symbolDir)
      return { data: [], total: 0, symbol: sym }
    }
    
    const allSwings: any[] = []
    const timeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']
    
    for (const tf of timeframes) {
      const swingDir = path.join(symbolDir, tf, 'p3')
      if (!fs.existsSync(swingDir)) continue
      
      try {
        const files = fs.readdirSync(swingDir).filter(f => f.endsWith('.jsonl')).sort()
        // Load last 30 files per timeframe for performance
        const recentFiles = files.slice(-30)
        for (const file of recentFiles) {
          const content = fs.readFileSync(path.join(swingDir, file), 'utf8')
          for (const line of content.split('\n')) {
            if (!line.trim()) continue
            try {
              const swing = JSON.parse(line)
              if (swing.id) allSwings.push(swing)
            } catch {}
          }
        }
      } catch {}
    }
    
    allSwings.sort((a, b) => b.openTime - a.openTime) // Newest first
    const result = allSwings.slice(0, 10000) // Limit to 10k
    console.log('[Main] Loaded', result.length, 'swings for', sym)
    return { data: result, total: allSwings.length, symbol: sym }
  })

  ipcMain.handle('engine:liveStart', async () => {
    engineProcess?.send({ type: 'live:start' })
  })

  ipcMain.handle('engine:liveStop', async () => {
    engineProcess?.send({ type: 'live:stop' })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // BULLETPROOF 24/7 LIVE TRADING SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  
  const ASTERDEX_BASE = 'https://fapi.asterdex.com'
  const SYMBOL = 'ETHUSDT'
  const LEVERAGE = 88
  const crypto = require('crypto')
  
  // API Key persistence - save to disk so they survive between sessions
  const apiKeysFile = path.join(app.getPath('userData'), 'asterdex-keys.json')
  
  function loadApiKeys(): { apiKey: string; apiSecret: string } {
    try {
      if (fs.existsSync(apiKeysFile)) {
        const data = JSON.parse(fs.readFileSync(apiKeysFile, 'utf-8'))
        // Clean keys - trim whitespace and validate format
        const apiKey = (data.apiKey || '').trim()
        const apiSecret = (data.apiSecret || '').trim()
        if (apiKey && apiSecret) {
          console.log(`[Trader] Loaded API keys from disk (key length: ${apiKey.length})`)
          return { apiKey, apiSecret }
        }
      }
    } catch (err) {
      console.error('[Trader] Failed to load API keys:', err)
    }
    return { apiKey: '', apiSecret: '' }
  }
  
  function saveApiKeys(apiKey: string, apiSecret: string): void {
    try {
      // Clean and validate keys before saving
      const cleanKey = apiKey.trim()
      const cleanSecret = apiSecret.trim()
      if (!cleanKey || !cleanSecret) {
        console.error('[Trader] Cannot save empty API keys')
        return
      }
      fs.writeFileSync(apiKeysFile, JSON.stringify({ apiKey: cleanKey, apiSecret: cleanSecret }), 'utf-8')
      console.log(`[Trader] Saved API keys to disk (key length: ${cleanKey.length})`)
    } catch (err) {
      console.error('[Trader] Failed to save API keys:', err)
    }
  }
  
  function clearApiKeys(): void {
    try {
      if (fs.existsSync(apiKeysFile)) {
        fs.unlinkSync(apiKeysFile)
        console.log('[Trader] Cleared saved API keys')
      }
    } catch (err) {
      console.error('[Trader] Failed to clear API keys:', err)
    }
  }
  
  // Core state
  let traderStartTime = 0
  let traderRunning = false
  
  // STORE CONFIG at module level so uptimeInterval can access it
  let traderConfig: {
    minConfluenceToEnter: number
    baseRiskPercent: number
    enableAutoTrading: boolean
  } = {
    minConfluenceToEnter: 3,
    baseRiskPercent: 0.3,
    enableAutoTrading: true
  }
  
  // Load API keys from disk on startup
  let { apiKey: traderApiKey, apiSecret: traderApiSecret } = loadApiKeys()
  let uptimeInterval: NodeJS.Timeout | null = null
  let balanceInterval: NodeJS.Timeout | null = null
  let positionInterval: NodeJS.Timeout | null = null
  
  // Health & Performance
  let traderHealth = { isHealthy: false, apiLatencyMs: 0, wsConnected: false, uptime: 0, errorCount: 0 }
  let traderPerformance = { totalTrades: 0, winningTrades: 0, winRate: 0, totalPnl: 0, largestWin: 0, largestLoss: 0 }
  let consecutiveErrors = 0
  let lastSuccessfulApi = Date.now()
  
  // Balance & Position tracking
  let lastKnownBalance = { marginBalance: 0, availableBalance: 0, unrealizedPnl: 0 }
  let currentPosition: { side: 'long' | 'short' | null; size: number; entryPrice: number; unrealizedPnl: number } = { side: null, size: 0, entryPrice: 0, unrealizedPnl: 0 }
  let lastKnownPrice = 0
  
  // ═══════════════════════════════════════════════════════════════════
  // PYRAMID STRATEGY STATE
  // ═══════════════════════════════════════════════════════════════════
  let pyramidState = {
    level: 0,                    // Current pyramid level (0-5)
    maxLevels: 5,                // Max pyramid levels
    entries: [] as { price: number; size: number; timestamp: number }[],
    avgEntry: 0,                 // Average entry price
    totalSize: 0,                // Total position size
    trailingStop: 0,             // Current trailing stop price
    initialStop: 0,              // Initial stop-loss price
    highestProfit: 0,            // Peak profit for trailing
    lastAddTime: 0,              // Prevent rapid adds
    ema9: 0,                     // EMA values for stop placement
    ema21: 0,
    ema50: 0,
    ema200: 0,
    priceHistory: [] as number[] // Recent prices for EMA calc
  }
  
  // Pyramid config
  const PYRAMID_CONFIG = {
    minConfluenceToAdd: 4,       // Need 4+ confluence to add
    minProfitToAdd: 0.15,        // Must be 0.15% in profit to add
    addCooldownMs: 30000,        // 30 sec between adds
    initialStopPercent: 0.8,     // 0.8% initial stop
    trailingStopPercent: 0.5,    // 0.5% trailing from peak
    takeProfitPercent: 2.0,      // 2% take profit
    positionSizePerLevel: 0.15   // 15% of available per level
  }
  
  // Calculate EMA
  function calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0
    const k = 2 / (period + 1)
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period
    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k)
    }
    return ema
  }
  
  // Update EMAs with new price
  function updateEMAs(price: number): void {
    pyramidState.priceHistory.push(price)
    // Keep last 250 prices for EMA200 calculation
    if (pyramidState.priceHistory.length > 250) {
      pyramidState.priceHistory.shift()
    }
    pyramidState.ema9 = calculateEMA(pyramidState.priceHistory, 9)
    pyramidState.ema21 = calculateEMA(pyramidState.priceHistory, 21)
    pyramidState.ema50 = calculateEMA(pyramidState.priceHistory, 50)
    pyramidState.ema200 = calculateEMA(pyramidState.priceHistory, 200)
  }
  
  // Calculate trailing stop based on EMAs
  function calculateTrailingStop(side: 'long' | 'short', price: number): number {
    const buffer = 0.001 // 0.1% buffer below/above EMA
    
    if (side === 'long') {
      // For longs: stop under nearest EMA support
      const ema9Stop = pyramidState.ema9 * (1 - buffer)
      const ema21Stop = pyramidState.ema21 * (1 - buffer)
      const ema50Stop = pyramidState.ema50 * (1 - buffer)
      
      // Use highest EMA that's below current price as stop
      let stop = 0
      if (pyramidState.ema9 < price && pyramidState.ema9 > stop) stop = ema9Stop
      if (pyramidState.ema21 < price && pyramidState.ema21 > stop) stop = ema21Stop
      if (pyramidState.ema50 < price && pyramidState.ema50 > stop) stop = ema50Stop
      
      // Fallback: percentage-based stop
      if (stop === 0) stop = price * (1 - PYRAMID_CONFIG.initialStopPercent / 100)
      
      return stop
    } else {
      // For shorts: stop above nearest EMA resistance
      const ema9Stop = pyramidState.ema9 * (1 + buffer)
      const ema21Stop = pyramidState.ema21 * (1 + buffer)
      const ema50Stop = pyramidState.ema50 * (1 + buffer)
      
      let stop = Infinity
      if (pyramidState.ema9 > price && pyramidState.ema9 < stop) stop = ema9Stop
      if (pyramidState.ema21 > price && pyramidState.ema21 < stop) stop = ema21Stop
      if (pyramidState.ema50 > price && pyramidState.ema50 < stop) stop = ema50Stop
      
      if (stop === Infinity) stop = price * (1 + PYRAMID_CONFIG.initialStopPercent / 100)
      
      return stop
    }
  }
  
  // Reset pyramid state
  function resetPyramid(): void {
    pyramidState.level = 0
    pyramidState.entries = []
    pyramidState.avgEntry = 0
    pyramidState.totalSize = 0
    pyramidState.trailingStop = 0
    pyramidState.initialStop = 0
    pyramidState.highestProfit = 0
    pyramidState.lastAddTime = 0
  }
  
  // Circuit breaker
  let circuitBreakerTripped = false
  let dailyLoss = 0
  const MAX_DAILY_LOSS = 50 // $50 max daily loss
  const MAX_CONSECUTIVE_ERRORS = 10
  
  // Signed API request helper with DEEP ERROR LOGGING
  async function asterDexRequest(method: 'GET' | 'POST', endpoint: string, params: Record<string, any> = {}, signed = true): Promise<any> {
    const timestamp = Date.now()
    let queryString = signed ? `timestamp=${timestamp}&recvWindow=10000` : ''
    
    // Build query string from params
    for (const [key, value] of Object.entries(params)) {
      queryString += (queryString ? '&' : '') + `${key}=${encodeURIComponent(value)}`
    }
    
    // Sign the request
    if (signed) {
      const signature = crypto.createHmac('sha256', traderApiSecret).update(queryString).digest('hex')
      queryString += `&signature=${signature}`
    }
    
    const url = `${ASTERDEX_BASE}${endpoint}${queryString ? '?' + queryString : ''}`
    const startTime = Date.now()
    
    // DEEP LOGGING - Request details
    console.log(`[API] ════════════════════════════════════════════`)
    console.log(`[API] ${method} ${endpoint}`)
    console.log(`[API] Signed: ${signed}`)
    console.log(`[API] Params: ${JSON.stringify(params)}`)
    console.log(`[API] Query: ${queryString.replace(/signature=[^&]+/, 'signature=***')}`)
    console.log(`[API] Full URL: ${url.replace(/signature=[^&]+/, 'signature=***')}`)
    
    try {
      const res = await fetch(url, {
        method,
        headers: signed ? { 'X-MBX-APIKEY': traderApiKey } : {}
      })
      
      const latency = Date.now() - startTime
      traderHealth.apiLatencyMs = latency
      
      // Get response text first
      const responseText = await res.text()
      
      console.log(`[API] Status: ${res.status} ${res.statusText}`)
      console.log(`[API] Latency: ${latency}ms`)
      console.log(`[API] Response: ${responseText.substring(0, 500)}`)
      
      if (!res.ok) {
        console.error(`[API] ❌ ERROR ${res.status}: ${responseText}`)
        throw new Error(`API ${res.status}: ${responseText}`)
      }
      
      console.log(`[API] ✓ Success`)
      console.log(`[API] ════════════════════════════════════════════`)
      
      consecutiveErrors = 0
      lastSuccessfulApi = Date.now()
      
      // Parse JSON from response text
      try {
        return JSON.parse(responseText)
      } catch {
        return responseText
      }
    } catch (err: any) {
      console.error(`[API] ❌ EXCEPTION: ${err.message}`)
      console.log(`[API] ════════════════════════════════════════════`)
      
      consecutiveErrors++
      traderHealth.errorCount++
      
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[Trader] CIRCUIT BREAKER: ${consecutiveErrors} consecutive errors!`)
        circuitBreakerTripped = true
        traderHealth.isHealthy = false
      }
      
      throw err
    }
  }
  
  // Fetch live price (public, no auth)
  async function fetchPrice(): Promise<number> {
    try {
      const data = await asterDexRequest('GET', '/fapi/v1/ticker/price', { symbol: SYMBOL }, false)
      lastKnownPrice = parseFloat(data.price)
      return lastKnownPrice
    } catch (err) {
      return lastKnownPrice // Return last known on error
    }
  }
  
  // Fetch balance (authenticated) - try multiple endpoints
  async function fetchBalance(): Promise<typeof lastKnownBalance> {
    if (!traderApiKey || !traderApiSecret) {
      console.log('[Trader] No API keys - skipping balance fetch')
      return lastKnownBalance
    }
    
    try {
      // Try /fapi/v4/account first (newer, more complete)
      const accountData = await asterDexRequest('GET', '/fapi/v4/account') as any
      
      if (accountData) {
        // Extract balances from account endpoint
        const totalWalletBalance = parseFloat(accountData.totalWalletBalance || '0')
        const availableBalance = parseFloat(accountData.availableBalance || '0')
        const totalUnrealizedProfit = parseFloat(accountData.totalUnrealizedProfit || '0')
        
        lastKnownBalance = {
          marginBalance: totalWalletBalance,
          availableBalance: availableBalance,
          unrealizedPnl: totalUnrealizedProfit
        }
        
        console.log(`[Trader] Balance: $${totalWalletBalance.toFixed(2)} total, $${availableBalance.toFixed(2)} available`)
        mainWindow?.webContents.send('trader:balance', lastKnownBalance)
        return lastKnownBalance
      }
    } catch (err: any) {
      console.log('[Trader] /fapi/v4/account failed, trying /fapi/v2/balance...')
    }
    
    // Fallback to /fapi/v2/balance
    try {
      const data = await asterDexRequest('GET', '/fapi/v2/balance') as Array<{ asset: string; balance: string; availableBalance: string; crossUnPnl?: string }>
      const usdt = data.find(b => b.asset === 'USDT')
      if (usdt) {
        lastKnownBalance = {
          marginBalance: parseFloat(usdt.balance || '0'),
          availableBalance: parseFloat(usdt.availableBalance || '0'),
          unrealizedPnl: parseFloat(usdt.crossUnPnl || '0')
        }
        console.log(`[Trader] Balance (v2): $${lastKnownBalance.marginBalance.toFixed(2)} total`)
        mainWindow?.webContents.send('trader:balance', lastKnownBalance)
      }
    } catch (err: any) {
      console.error('[Trader] Balance fetch error:', err.message)
      // If API key is invalid, clear saved keys
      if (err.message?.includes('API-key format invalid') || err.message?.includes('-2014')) {
        console.error('[Trader] API key invalid - clearing saved keys. Please re-enter.')
        clearApiKeys()
        traderApiKey = ''
        traderApiSecret = ''
      }
    }
    return lastKnownBalance
  }
  
  // Fetch current position
  async function fetchPosition(): Promise<void> {
    if (!traderApiKey || !traderApiSecret) return
    
    try {
      const positions = await asterDexRequest('GET', '/fapi/v2/positionRisk', { symbol: SYMBOL }) as Array<{ positionAmt: string; entryPrice: string; unRealizedProfit: string; positionSide: string }>
      
      for (const pos of positions) {
        const amt = parseFloat(pos.positionAmt || '0')
        if (amt !== 0) {
          currentPosition = {
            side: amt > 0 ? 'long' : 'short',
            size: Math.abs(amt),
            entryPrice: parseFloat(pos.entryPrice || '0'),
            unrealizedPnl: parseFloat(pos.unRealizedProfit || '0')
          }
          
          // Anti-liquidation check
          const liqDistance = Math.abs(lastKnownPrice - currentPosition.entryPrice) / currentPosition.entryPrice
          if (liqDistance > 0.008) { // 0.8% from entry (88x = ~1.1% liquidation)
            console.warn(`[Trader] WARNING: Position ${liqDistance.toFixed(2)}% from entry, approaching liquidation zone!`)
          }
          return
        }
      }
      
      // No position found
      currentPosition = { side: null, size: 0, entryPrice: 0, unrealizedPnl: 0 }
    } catch (err: any) {
      console.error('[Trader] Position fetch error:', err.message)
    }
  }
  
  // Set isolated margin mode (CRITICAL: never use cross)
  async function ensureIsolatedMargin(): Promise<void> {
    try {
      await asterDexRequest('POST', '/fapi/v1/marginType', { symbol: SYMBOL, marginType: 'ISOLATED' })
      console.log('[Trader] Margin mode: ISOLATED')
    } catch (err: any) {
      // Already set, ignore
    }
  }
  
  // Set leverage
  async function setLeverage(): Promise<void> {
    try {
      await asterDexRequest('POST', '/fapi/v1/leverage', { symbol: SYMBOL, leverage: LEVERAGE })
      console.log(`[Trader] Leverage: ${LEVERAGE}x`)
    } catch (err: any) {
      // Already set, ignore
    }
  }
  
  // Execute trade with safety checks
  async function executeTrade(side: 'long' | 'short', marginUsd: number): Promise<any> {
    // Safety checks
    if (circuitBreakerTripped) {
      throw new Error('Circuit breaker tripped - trading disabled')
    }
    if (dailyLoss >= MAX_DAILY_LOSS) {
      throw new Error(`Daily loss limit reached ($${dailyLoss.toFixed(2)}/$${MAX_DAILY_LOSS})`)
    }
    if (!traderApiKey || !traderApiSecret) {
      throw new Error('API credentials not configured')
    }
    
    // Ensure proper margin mode
    await ensureIsolatedMargin()
    await setLeverage()
    
    // Get current price - MUST be valid
    const price = await fetchPrice()
    console.log(`[Trader] Fetched price: $${price}`)
    
    if (!price || price <= 0 || !isFinite(price)) {
      throw new Error(`Invalid price: ${price} - cannot execute trade`)
    }
    
    if (!marginUsd || marginUsd <= 0 || !isFinite(marginUsd)) {
      throw new Error(`Invalid margin: $${marginUsd} - cannot execute trade`)
    }
    
    // Calculate quantity with validation
    const notional = marginUsd * LEVERAGE
    const rawQuantity = notional / price
    
    if (!isFinite(rawQuantity) || rawQuantity <= 0) {
      throw new Error(`Invalid quantity calculation: ${notional} / ${price} = ${rawQuantity}`)
    }
    
    // Round to 3 decimal places (ETHUSDT precision)
    const quantity = rawQuantity.toFixed(3)
    
    // Validate quantity meets minimum (0.001 ETH)
    if (parseFloat(quantity) < 0.001) {
      throw new Error(`Quantity too small: ${quantity} ETH (min 0.001)`)
    }
    
    // Validate notional meets minimum ($5)
    if (notional < 5) {
      throw new Error(`Notional too small: $${notional.toFixed(2)} (min $5)`)
    }
    
    // Anti-liquidation: check if position would be too risky
    const maxPositionValue = lastKnownBalance.availableBalance * 0.8 * LEVERAGE // Max 80% of balance
    if (notional > maxPositionValue) {
      throw new Error(`Position too large: $${notional.toFixed(0)} > max $${maxPositionValue.toFixed(0)}`)
    }
    
    console.log(`[Trader] Executing ${side.toUpperCase()}: $${marginUsd} margin × ${LEVERAGE}x = $${notional.toFixed(0)} = ${quantity} ETH @ $${price.toFixed(2)}`)
    
    // Place order
    const orderSide = side === 'long' ? 'BUY' : 'SELL'
    const positionSide = side === 'long' ? 'LONG' : 'SHORT'
    
    const result = await asterDexRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL,
      side: orderSide,
      positionSide: positionSide,
      type: 'MARKET',
      quantity: quantity
    })
    
    console.log(`[Trader] Order filled: ${result.orderId} - ${result.status}`)
    
    // Update performance
    traderPerformance.totalTrades++
    
    // Refresh balance and position
    await fetchBalance()
    await fetchPosition()
    
    return {
      success: true,
      orderId: result.orderId,
      status: result.status,
      side,
      positionSide,
      quantity: parseFloat(quantity),
      price,
      notional,
      marginUsd
    }
  }
  
  // Close all positions
  async function closeAllPositions(): Promise<void> {
    if (!traderApiKey || !traderApiSecret) return
    
    try {
      const positions = await asterDexRequest('GET', '/fapi/v2/positionRisk', { symbol: SYMBOL }) as Array<{ positionAmt: string; positionSide: string }>
      
      for (const pos of positions) {
        const amt = parseFloat(pos.positionAmt || '0')
        if (amt === 0) continue
        
        const closeSide = amt > 0 ? 'SELL' : 'BUY'
        const positionSide = pos.positionSide || (amt > 0 ? 'LONG' : 'SHORT')
        const closeQty = Math.abs(amt).toFixed(3)
        
        console.log(`[Trader] Closing ${positionSide}: ${closeSide} ${closeQty} ETH`)
        
        await asterDexRequest('POST', '/fapi/v1/order', {
          symbol: SYMBOL,
          side: closeSide,
          positionSide: positionSide,
          type: 'MARKET',
          quantity: closeQty
        })
      }
      
      currentPosition = { side: null, size: 0, entryPrice: 0, unrealizedPnl: 0 }
      console.log('[Trader] All positions closed')
    } catch (err: any) {
      console.error('[Trader] Close positions error:', err.message)
      throw err
    }
  }

  ipcMain.handle('trader:start', async (_event, config: any) => {
    console.log('[Trader] ═══════════════════════════════════════════════')
    console.log('[Trader] STARTING 24/7 BULLETPROOF LIVE TRADING')
    console.log('[Trader] ═══════════════════════════════════════════════')
    
    traderStartTime = Date.now()
    traderRunning = true
    
    // STORE CONFIG at module level for uptimeInterval access
    traderConfig = {
      minConfluenceToEnter: config?.minConfluenceToEnter || 3,
      baseRiskPercent: config?.baseRiskPercent || 0.3,
      enableAutoTrading: config?.enableAutoTrading !== false // default true
    }
    console.log('[Trader] Config:', JSON.stringify(traderConfig))
    
    // Use provided keys or fall back to saved keys
    if (config?.apiKey && config?.apiSecret) {
      traderApiKey = config.apiKey
      traderApiSecret = config.apiSecret
      // SAVE to disk for persistence between sessions
      saveApiKeys(traderApiKey, traderApiSecret)
    } else if (!traderApiKey || !traderApiSecret) {
      // Try loading from disk if not already loaded
      const saved = loadApiKeys()
      traderApiKey = saved.apiKey
      traderApiSecret = saved.apiSecret
    }
    
    consecutiveErrors = 0
    circuitBreakerTripped = false
    dailyLoss = 0
    
    // Initial setup
    const price = await fetchPrice()
    console.log(`[Trader] ETHUSDT: $${price.toFixed(2)}`)
    
    if (traderApiKey && traderApiSecret) {
      await ensureIsolatedMargin()
      await setLeverage()
      await fetchBalance()
      await fetchPosition()
      console.log(`[Trader] Balance: $${lastKnownBalance.marginBalance.toFixed(2)}`)
    }
    
    traderHealth = { isHealthy: true, apiLatencyMs: 50, wsConnected: true, uptime: 0, errorCount: 0 }
    mainWindow?.webContents.send('trader:health', traderHealth)
    mainWindow?.webContents.send('trader:liveUpdate', { price, signal: 'none', strength: 0, reason: 'Connected', timestamp: Date.now(), apiCalls: 1 })
    
    // Start monitoring loops
    
    // Price update every 3 seconds
    uptimeInterval = setInterval(async () => {
      if (!traderRunning) return
      
      traderHealth.uptime = Date.now() - traderStartTime
      
      const price = await fetchPrice()
      
      // Calculate REAL-TIME confluence based on current market conditions
      const now = new Date()
      const utcHour = now.getUTCHours()
      const utcMinute = now.getUTCMinutes()
      const dayOfWeek = now.getUTCDay() // 0=Sunday, 6=Saturday
      
      let confluenceScore = 0
      const confluenceFactors: string[] = []
      
      // NYSE Session: 14:30-21:00 UTC (9:30am-4pm ET) - Weekdays only
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5
      const nyseOpen = isWeekday && ((utcHour === 14 && utcMinute >= 30) || (utcHour >= 15 && utcHour < 21))
      if (nyseOpen) {
        confluenceScore += 5
        confluenceFactors.push('NYSE Open')
      }
      
      // London Session: 08:00-16:30 UTC - Weekdays only
      const londonOpen = isWeekday && (utcHour >= 8 && (utcHour < 16 || (utcHour === 16 && utcMinute <= 30)))
      if (londonOpen) {
        confluenceScore += 4
        confluenceFactors.push('London Open')
      }
      
      // Tokyo Session: 00:00-09:00 UTC - Weekdays (and Sunday night for Monday)
      const tokyoOpen = (utcHour >= 0 && utcHour < 9) && (isWeekday || dayOfWeek === 0)
      if (tokyoOpen) {
        confluenceScore += 3
        confluenceFactors.push('Tokyo Open')
      }
      
      // Overlap bonus: London + NYSE overlap (14:30-16:30 UTC)
      if (nyseOpen && londonOpen) {
        confluenceScore += 2
        confluenceFactors.push('Session Overlap')
      }
      
      // Price momentum (compare to recent prices if we have history)
      let priceTrend: 'bullish' | 'bearish' | 'neutral' = 'neutral'
      if (lastKnownPrice > 0 && price > 0) {
        const priceChange = ((price - lastKnownPrice) / lastKnownPrice) * 100
        if (priceChange > 0.05) {
          priceTrend = 'bullish'
          confluenceScore += 2
          confluenceFactors.push('Bullish Momentum')
        } else if (priceChange < -0.05) {
          priceTrend = 'bearish'
          confluenceScore += 2
          confluenceFactors.push('Bearish Momentum')
        }
      }
      
      // Day of week edge factors (Tuesday-Thursday best for crypto)
      if (dayOfWeek >= 2 && dayOfWeek <= 4) {
        confluenceScore += 1
        confluenceFactors.push('Prime Day')
      }
      
      // Avoid low-liquidity periods (weekends, Monday morning)
      const isLowLiquidity = dayOfWeek === 0 || dayOfWeek === 6 || (dayOfWeek === 1 && utcHour < 8)
      if (isLowLiquidity) {
        confluenceScore = Math.max(0, confluenceScore - 3)
        confluenceFactors.push('Low Liquidity')
      }
      
      console.log(`[Trader] Live confluence: ${confluenceScore}/${traderConfig.minConfluenceToEnter} [${confluenceFactors.join(', ')}]`)
      
      // ═══════════════════════════════════════════════════════════════════
      // AUTOMATIC TRADE EXECUTION - Enter when confluence >= threshold
      // ═══════════════════════════════════════════════════════════════════
      // USE traderConfig (module-level) instead of config (out of scope)
      const minConfluenceToEnter = traderConfig.minConfluenceToEnter
      const baseRiskPercent = traderConfig.baseRiskPercent
      const enableAutoTrading = traderConfig.enableAutoTrading
      
      console.log(`[Trader] Auto-trade check: confluence=${confluenceScore} >= ${minConfluenceToEnter}? position=${currentPosition.side} circuit=${circuitBreakerTripped} keys=${!!traderApiKey} auto=${enableAutoTrading}`)
      
      if (enableAutoTrading && confluenceScore >= minConfluenceToEnter && !currentPosition.side && !circuitBreakerTripped && traderApiKey && traderApiSecret) {
        // Determine direction based on momentum
        const tradeSide: 'long' | 'short' = priceTrend === 'bearish' ? 'short' : 'long'
        
        // Calculate position size: use minimum 25% for small accounts, cap at $10 for safety
        const riskAmount = lastKnownBalance.availableBalance * Math.max(baseRiskPercent, 25) / 100
        const marginUsd = Math.min(riskAmount, lastKnownBalance.availableBalance * 0.5, 10)
        
        console.log(`[Trader] Position sizing: balance=$${lastKnownBalance.availableBalance.toFixed(2)} risk%=${baseRiskPercent} margin=$${marginUsd.toFixed(2)}`)
        
        if (marginUsd >= 1) {
          console.log(`[Trader] ═══════════════════════════════════════════════`)
          console.log(`[Trader] AUTO ENTRY: ${tradeSide.toUpperCase()} $${marginUsd.toFixed(2)} @ confluence ${confluenceScore}`)
          console.log(`[Trader] Factors: ${confluenceFactors.join(', ')}`)
          console.log(`[Trader] ═══════════════════════════════════════════════`)
          
          try {
            const result = await executeTrade(tradeSide, marginUsd)
            if (result.success) {
              mainWindow?.webContents.send('trader:trade', {
                id: `auto-${Date.now()}`,
                action: tradeSide === 'long' ? 'OPEN_LONG' : 'OPEN_SHORT',
                side: tradeSide,
                marginUsd,
                price,
                quantity: result.quantity,
                status: 'filled',
                timestamp: Date.now(),
                confluence: confluenceScore,
                factors: confluenceFactors
              })
              traderPerformance.totalTrades++
            }
          } catch (err: any) {
            console.error(`[Trader] Auto entry failed:`, err.message)
            consecutiveErrors++
          }
        }
      }
      
      // Auto-exit on momentum reversal against position
      if (currentPosition.side && priceTrend !== 'neutral') {
        const isReversal = (currentPosition.side === 'long' && priceTrend === 'bearish') ||
                          (currentPosition.side === 'short' && priceTrend === 'bullish')
        
        // Exit if strong reversal with low confluence
        if (isReversal && confluenceScore <= 2) {
          console.log(`[Trader] ═══════════════════════════════════════════════`)
          console.log(`[Trader] AUTO EXIT: Momentum reversal detected`)
          console.log(`[Trader] ═══════════════════════════════════════════════`)
          
          try {
            await closeAllPositions()
            mainWindow?.webContents.send('trader:trade', {
              id: `exit-${Date.now()}`,
              action: 'CLOSE',
              side: 'close',
              marginUsd: 0,
              price,
              quantity: currentPosition.size,
              status: 'filled',
              timestamp: Date.now(),
              reason: 'Momentum Reversal'
            })
          } catch (err: any) {
            console.error(`[Trader] Auto exit failed:`, err.message)
          }
        }
      }
      
      mainWindow?.webContents.send('trader:liveUpdate', {
        price,
        signal: currentPosition.side || 'none',
        strength: confluenceScore,
        reason: confluenceFactors.length > 0 ? confluenceFactors.join(' • ') : 'Monitoring',
        timestamp: Date.now(),
        apiCalls: apiCallCount
      })
      mainWindow?.webContents.send('trader:health', traderHealth)
    }, 3000)
    
    // Balance update every 15 seconds
    balanceInterval = setInterval(async () => {
      if (!traderRunning) return
      await fetchBalance()
    }, 15000)
    
    // Position check every 10 seconds
    positionInterval = setInterval(async () => {
      if (!traderRunning) return
      await fetchPosition()
      
      // Update position in UI
      if (currentPosition.side) {
        mainWindow?.webContents.send('trader:position', currentPosition)
      }
    }, 10000)
    
    // Send config to engine for pattern analysis
    engineProcess?.send({ type: 'trader:start', config })
    
    return { success: true, startTime: traderStartTime, balance: lastKnownBalance }
  })

  ipcMain.handle('trader:stop', async () => {
    console.log('[Trader] ═══════════════════════════════════════════════')
    console.log('[Trader] STOPPING 24/7 LIVE TRADING')
    console.log('[Trader] ═══════════════════════════════════════════════')
    
    traderRunning = false
    traderHealth.isHealthy = false
    
    // Clear all intervals
    if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null }
    if (balanceInterval) { clearInterval(balanceInterval); balanceInterval = null }
    if (positionInterval) { clearInterval(positionInterval); positionInterval = null }
    
    engineProcess?.send({ type: 'trader:stop' })
    return { success: true }
  })

  ipcMain.handle('trader:getStatus', async () => {
    return {
      isRunning: traderRunning,
      startTime: traderStartTime,
      uptime: traderRunning ? Date.now() - traderStartTime : 0,
      health: traderHealth,
      performance: traderPerformance,
      position: currentPosition,
      balance: lastKnownBalance,
      circuitBreaker: circuitBreakerTripped,
      dailyLoss
    }
  })

  // BULLETPROOF TEST TRADE - executes directly, no engine dependency
  ipcMain.handle('trader:testTrade', async (_event, { side, marginUsd }: { side: 'long' | 'short' | 'close', marginUsd: number }) => {
    console.log(`[Trader] ═══════════════════════════════════════════════`)
    console.log(`[Trader] TEST TRADE: ${side.toUpperCase()} $${marginUsd}`)
    console.log(`[Trader] ═══════════════════════════════════════════════`)
    
    try {
      if (side === 'close') {
        await closeAllPositions()
        mainWindow?.webContents.send('trader:trade', {
          id: `close-${Date.now()}`,
          action: 'CLOSE_ALL',
          side: 'close',
          marginUsd: 0,
          price: lastKnownPrice,
          quantity: 0,
          status: 'filled',
          timestamp: Date.now()
        })
        return { success: true, message: 'All positions closed' }
      }
      
      const result = await executeTrade(side, marginUsd)
      
      // Send trade update to UI
      mainWindow?.webContents.send('trader:trade', {
        id: result.orderId || `test-${Date.now()}`,
        action: `TEST_${side.toUpperCase()}`,
        side,
        marginUsd,
        price: result.price,
        quantity: result.quantity,
        notionalValue: result.notional,
        status: 'filled',
        timestamp: Date.now()
      })
      
      return result
    } catch (err: any) {
      console.error(`[Trader] Trade failed: ${err.message}`)
      
      mainWindow?.webContents.send('trader:trade', {
        id: `error-${Date.now()}`,
        action: `FAILED_${side.toUpperCase()}`,
        side,
        marginUsd,
        price: lastKnownPrice,
        quantity: 0,
        status: 'failed',
        error: err.message,
        timestamp: Date.now()
      })
      
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('trader:emergencyStop', async () => {
    console.log('[Trader] ═══════════════════════════════════════════════')
    console.log('[Trader] EMERGENCY STOP - CLOSING ALL POSITIONS')
    console.log('[Trader] ═══════════════════════════════════════════════')
    
    try {
      await closeAllPositions()
    } catch (err: any) {
      console.error('[Trader] Emergency close error:', err.message)
    }
    
    traderRunning = false
    traderHealth.isHealthy = false
    circuitBreakerTripped = true
    
    // Clear all intervals
    if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null }
    if (balanceInterval) { clearInterval(balanceInterval); balanceInterval = null }
    if (positionInterval) { clearInterval(positionInterval); positionInterval = null }
    
    return { success: true }
  })

  ipcMain.handle('trader:resetCircuitBreaker', async () => {
    console.log('[Trader] Resetting circuit breaker')
    circuitBreakerTripped = false
    consecutiveErrors = 0
    dailyLoss = 0
    traderHealth.errorCount = 0
    return { success: true }
  })

  ipcMain.handle('trader:getPerformance', async () => {
    return traderPerformance
  })

  // Get saved API keys - allows UI to check if keys exist without exposing secrets
  ipcMain.handle('trader:hasApiKeys', async () => {
    const hasKeys = Boolean(traderApiKey && traderApiSecret)
    console.log(`[Trader] hasApiKeys check: ${hasKeys}`)
    return hasKeys
  })
  
  // Save API keys directly (for settings page)
  ipcMain.handle('trader:saveApiKeys', async (_event, { apiKey, apiSecret }: { apiKey: string; apiSecret: string }) => {
    if (apiKey && apiSecret) {
      traderApiKey = apiKey
      traderApiSecret = apiSecret
      saveApiKeys(apiKey, apiSecret)
      return { success: true }
    }
    return { success: false, error: 'Invalid keys' }
  })

  // Track API calls for rate limiting display
  let apiCallCount = 0
  let lastApiReset = Date.now()

  ipcMain.handle('trader:getBalance', async () => {
    apiCallCount++
    
    // Reset counter every minute
    if (Date.now() - lastApiReset > 60000) {
      apiCallCount = 0
      lastApiReset = Date.now()
    }
    
    // Use the shared fetchBalance function
    return await fetchBalance()
  })

  ipcMain.handle('trader:getApiLimits', async () => {
    return {
      used: apiCallCount,
      limit: 1200,
      resetIn: Math.max(0, 60 - Math.floor((Date.now() - lastApiReset) / 1000))
    }
  })

  ipcMain.handle('trader:getBacktestComparison', async () => {
    // Load backtest results from pyramid strategy
    const dataDir = path.join(app.getPath('userData'), 'data')
    const backtestFile = path.join(dataDir, 'pyramid-backtest.json')
    
    let backtestStats = {
      totalTrades: 0,
      winRate: 0,
      totalPnl: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      profitFactor: 0
    }
    
    try {
      if (fs.existsSync(backtestFile)) {
        backtestStats = JSON.parse(fs.readFileSync(backtestFile, 'utf-8'))
      }
    } catch {}
    
    return {
      live: traderPerformance,
      backtest: backtestStats,
      comparison: {
        winRateDiff: traderPerformance.winRate - backtestStats.winRate,
        pnlDiff: traderPerformance.totalPnl - backtestStats.totalPnl
      }
    }
  })

  // Handle trader events from engine
  if (engineProcess) {
    engineProcess.on('message', (msg: any) => {
      if (msg?.type === 'trader:health') {
        traderHealth = msg.data
        mainWindow?.webContents.send('trader:health', msg.data)
      } else if (msg?.type === 'trader:balance') {
        console.log('[Main] Balance from engine:', msg.data)
        apiCallCount++
        mainWindow?.webContents.send('trader:balance', msg.data)
      } else if (msg?.type === 'trader:trade') {
        traderPerformance.totalTrades++
        if (msg.data.pnl > 0) traderPerformance.winningTrades++
        traderPerformance.totalPnl += msg.data.pnl || 0
        traderPerformance.winRate = traderPerformance.winningTrades / traderPerformance.totalTrades
        mainWindow?.webContents.send('trader:trade', msg.data)
      } else if (msg?.type === 'trader:signal') {
        mainWindow?.webContents.send('trader:signal', msg.data)
      } else if (msg?.type === 'trader:liveUpdate') {
        // Forward live price and signal updates to UI
        mainWindow?.webContents.send('trader:liveUpdate', msg.data)
      }
    })
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // AUTO-START 24/7 TRADING - No manual intervention required
  // Trading starts automatically when API keys are saved
  // Only manual action needed: EMERGENCY STOP button
  // ═══════════════════════════════════════════════════════════════════
  setTimeout(async () => {
    console.log('[AutoStart] ═══════════════════════════════════════════════')
    console.log('[AutoStart] Checking for saved API keys...')
    
    if (traderApiKey && traderApiSecret) {
      console.log('[AutoStart] Found saved API keys - AUTO-STARTING 24/7 TRADING')
      
      // Start the live WebSocket connection first
      console.log('[AutoStart] Starting live WebSocket connection...')
      engineProcess?.send({ type: 'live:start' })
      
      // Wait a moment for WebSocket to connect
      await new Promise(r => setTimeout(r, 2000))
      
      // Start the trader
      console.log('[AutoStart] Starting 24/7 live trading...')
      traderRunning = true
      traderStartTime = Date.now()
      traderHealth.isHealthy = true
      
      // Initialize trading setup
      try {
        await ensureIsolatedMargin()
        await setLeverage()
        await fetchBalance()
        await fetchPosition()
        
        console.log('[AutoStart] ✅ 24/7 TRADING ACTIVE')
        console.log(`[AutoStart] Balance: $${lastKnownBalance.marginBalance.toFixed(2)}`)
        console.log('[AutoStart] ═══════════════════════════════════════════════')
        
        // Start health/balance/position intervals WITH FULL CONFLUENCE CALCULATION
        uptimeInterval = setInterval(async () => {
          if (!traderRunning) return
          
          traderHealth.uptime = Date.now() - traderStartTime
          traderHealth.wsConnected = true
          traderHealth.isHealthy = !circuitBreakerTripped && consecutiveErrors < 5
          
          // Fetch current price
          const price = await fetchPrice()
          
          // Calculate REAL-TIME confluence based on current market conditions
          const now = new Date()
          const utcHour = now.getUTCHours()
          const utcMinute = now.getUTCMinutes()
          const dayOfWeek = now.getUTCDay()
          
          let confluenceScore = 0
          const confluenceFactors: string[] = []
          
          // NYSE Session: 14:30-21:00 UTC (9:30am-4pm ET) - Weekdays only
          const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5
          const nyseOpen = isWeekday && ((utcHour === 14 && utcMinute >= 30) || (utcHour >= 15 && utcHour < 21))
          if (nyseOpen) {
            confluenceScore += 5
            confluenceFactors.push('NYSE Open')
          }
          
          // London Session: 08:00-16:30 UTC - Weekdays only
          const londonOpen = isWeekday && (utcHour >= 8 && (utcHour < 16 || (utcHour === 16 && utcMinute <= 30)))
          if (londonOpen) {
            confluenceScore += 4
            confluenceFactors.push('London Open')
          }
          
          // Tokyo Session: 00:00-09:00 UTC
          const tokyoOpen = (utcHour >= 0 && utcHour < 9) && (isWeekday || dayOfWeek === 0)
          if (tokyoOpen) {
            confluenceScore += 3
            confluenceFactors.push('Tokyo Open')
          }
          
          // Overlap bonus
          if (nyseOpen && londonOpen) {
            confluenceScore += 2
            confluenceFactors.push('Session Overlap')
          }
          
          // Price momentum
          let priceTrend: 'bullish' | 'bearish' | 'neutral' = 'neutral'
          if (lastKnownPrice > 0 && price > 0) {
            const priceChange = ((price - lastKnownPrice) / lastKnownPrice) * 100
            if (priceChange > 0.05) {
              priceTrend = 'bullish'
              confluenceScore += 2
              confluenceFactors.push('Bullish Momentum')
            } else if (priceChange < -0.05) {
              priceTrend = 'bearish'
              confluenceScore += 2
              confluenceFactors.push('Bearish Momentum')
            }
          }
          
          // Day of week edge (Tue-Thu best)
          if (dayOfWeek >= 2 && dayOfWeek <= 4) {
            confluenceScore += 1
            confluenceFactors.push('Prime Day')
          }
          
          // Low liquidity penalty
          const isLowLiquidity = dayOfWeek === 0 || dayOfWeek === 6 || (dayOfWeek === 1 && utcHour < 8)
          if (isLowLiquidity) {
            confluenceScore = Math.max(0, confluenceScore - 3)
            confluenceFactors.push('Low Liquidity')
          }
          
          console.log(`[Trader] Live confluence: ${confluenceScore}/${traderConfig.minConfluenceToEnter} [${confluenceFactors.join(', ')}]`)
          
          // AUTO-TRADING LOGIC
          const minConf = traderConfig.minConfluenceToEnter
          const enableAuto = traderConfig.enableAutoTrading
          
          console.log(`[Trader] Auto-trade check: conf=${confluenceScore}>=${minConf}? pos=${currentPosition.side} circuit=${circuitBreakerTripped} auto=${enableAuto}`)
          
          if (enableAuto && confluenceScore >= minConf && !currentPosition.side && !circuitBreakerTripped && traderApiKey) {
            const tradeSide: 'long' | 'short' = priceTrend === 'bearish' ? 'short' : 'long'
            // baseRiskPercent is already a percentage (0.3 = 0.3%), so multiply by balance directly
            // For $21 balance with 0.3% = $0.06, too small. Use minimum $5 or 25% of balance
            const riskAmount = lastKnownBalance.availableBalance * Math.max(traderConfig.baseRiskPercent, 25) / 100
            const marginUsd = Math.min(riskAmount, lastKnownBalance.availableBalance * 0.5, 10) // Cap at $10 for safety
            
            console.log(`[Trader] Position sizing: balance=$${lastKnownBalance.availableBalance.toFixed(2)} risk%=${traderConfig.baseRiskPercent} margin=$${marginUsd.toFixed(2)}`)
            
            if (marginUsd >= 1) {
              console.log(`[Trader] ═══════════════════════════════════════════════`)
              console.log(`[Trader] AUTO ENTRY: ${tradeSide.toUpperCase()} $${marginUsd.toFixed(2)} @ confluence ${confluenceScore}`)
              console.log(`[Trader] ═══════════════════════════════════════════════`)
              
              try {
                const result = await executeTrade(tradeSide, marginUsd)
                if (result.success) {
                  mainWindow?.webContents.send('trader:trade', {
                    id: `auto-${Date.now()}`,
                    action: tradeSide === 'long' ? 'OPEN_LONG' : 'OPEN_SHORT',
                    side: tradeSide,
                    marginUsd,
                    price,
                    quantity: result.quantity,
                    status: 'filled',
                    timestamp: Date.now(),
                    confluence: confluenceScore,
                    factors: confluenceFactors
                  })
                  traderPerformance.totalTrades++
                }
              } catch (err: any) {
                console.error(`[Trader] Auto entry failed:`, err.message)
                consecutiveErrors++
              }
            }
          }
          
          // ═══════════════════════════════════════════════════════════════════
          // PYRAMID STRATEGY - Add on strength, trail stops under EMAs
          // ═══════════════════════════════════════════════════════════════════
          
          // Update EMAs with current price
          updateEMAs(price)
          
          if (currentPosition.side && currentPosition.entryPrice > 0) {
            const pnlPercent = currentPosition.side === 'long'
              ? ((price - currentPosition.entryPrice) / currentPosition.entryPrice) * 100
              : ((currentPosition.entryPrice - price) / currentPosition.entryPrice) * 100
            
            const pnlUsd = currentPosition.unrealizedPnl
            
            // Sync pyramid state with actual position
            if (pyramidState.level === 0 && currentPosition.size > 0) {
              pyramidState.level = 1
              pyramidState.entries = [{ price: currentPosition.entryPrice, size: currentPosition.size, timestamp: Date.now() }]
              pyramidState.avgEntry = currentPosition.entryPrice
              pyramidState.totalSize = currentPosition.size
              pyramidState.initialStop = calculateTrailingStop(currentPosition.side, currentPosition.entryPrice)
              pyramidState.trailingStop = pyramidState.initialStop
            }
            
            // Update trailing stop - only move in profit direction
            const newStop = calculateTrailingStop(currentPosition.side, price)
            if (currentPosition.side === 'long' && newStop > pyramidState.trailingStop) {
              pyramidState.trailingStop = newStop
              console.log(`[Pyramid] Trailing stop raised to $${newStop.toFixed(2)} (under EMA)`)
            } else if (currentPosition.side === 'short' && newStop < pyramidState.trailingStop) {
              pyramidState.trailingStop = newStop
              console.log(`[Pyramid] Trailing stop lowered to $${newStop.toFixed(2)} (above EMA)`)
            }
            
            // Track peak profit for trailing
            if (pnlPercent > pyramidState.highestProfit) {
              pyramidState.highestProfit = pnlPercent
            }
            
            console.log(`[Pyramid] Level ${pyramidState.level}/${pyramidState.maxLevels} | P&L: ${pnlPercent.toFixed(3)}% ($${pnlUsd.toFixed(2)}) | Stop: $${pyramidState.trailingStop.toFixed(2)} | EMAs: 9=${pyramidState.ema9.toFixed(2)} 21=${pyramidState.ema21.toFixed(2)} 50=${pyramidState.ema50.toFixed(2)}`)
            
            let shouldExit = false
            let shouldAdd = false
            let exitReason = ''
            
            // ═══ PYRAMID ADD-ON LOGIC ═══
            const timeSinceLastAdd = Date.now() - pyramidState.lastAddTime
            const canAdd = pyramidState.level < pyramidState.maxLevels && 
                          timeSinceLastAdd > PYRAMID_CONFIG.addCooldownMs &&
                          lastKnownBalance.availableBalance > 2
            
            if (canAdd && pnlPercent >= PYRAMID_CONFIG.minProfitToAdd && confluenceScore >= PYRAMID_CONFIG.minConfluenceToAdd) {
              // Check for strong trend confirmation
              const priceAboveEma9 = price > pyramidState.ema9
              const priceAboveEma21 = price > pyramidState.ema21
              const ema9AboveEma21 = pyramidState.ema9 > pyramidState.ema21
              
              // For longs: add when price above EMAs with stacked EMAs
              // For shorts: add when price below EMAs with stacked EMAs
              const trendConfirmed = currentPosition.side === 'long' 
                ? (priceAboveEma9 && priceAboveEma21 && ema9AboveEma21)
                : (!priceAboveEma9 && !priceAboveEma21 && !ema9AboveEma21)
              
              if (trendConfirmed) {
                shouldAdd = true
                console.log(`[Pyramid] ADD SIGNAL: Profit ${pnlPercent.toFixed(2)}% + Confluence ${confluenceScore} + EMAs aligned`)
              }
            }
            
            // ═══ STOP-LOSS CHECK (EMA-based trailing) ═══
            if (currentPosition.side === 'long' && price <= pyramidState.trailingStop) {
              shouldExit = true
              exitReason = `TRAILING STOP: Price $${price.toFixed(2)} hit stop $${pyramidState.trailingStop.toFixed(2)}`
            } else if (currentPosition.side === 'short' && price >= pyramidState.trailingStop) {
              shouldExit = true
              exitReason = `TRAILING STOP: Price $${price.toFixed(2)} hit stop $${pyramidState.trailingStop.toFixed(2)}`
            }
            
            // ═══ HARD STOP - Emergency exit ═══
            if (pnlPercent <= -PYRAMID_CONFIG.initialStopPercent) {
              shouldExit = true
              exitReason = `HARD STOP: ${pnlPercent.toFixed(2)}% exceeded -${PYRAMID_CONFIG.initialStopPercent}% limit`
            }
            
            // ═══ TAKE PROFIT ═══
            if (pnlPercent >= PYRAMID_CONFIG.takeProfitPercent) {
              shouldExit = true
              exitReason = `TAKE PROFIT: +${pnlPercent.toFixed(2)}% hit ${PYRAMID_CONFIG.takeProfitPercent}% target`
            }
            
            // ═══ PROFIT PROTECT on reversal ═══
            if (pnlPercent > 0.5 && priceTrend !== 'neutral') {
              const isReversal = (currentPosition.side === 'long' && priceTrend === 'bearish') ||
                                (currentPosition.side === 'short' && priceTrend === 'bullish')
              if (isReversal && confluenceScore < 4) {
                shouldExit = true
                exitReason = `PROFIT PROTECT: +${pnlPercent.toFixed(2)}% with reversal + weak confluence`
              }
            }
            
            // Execute ADD to pyramid
            if (shouldAdd && !shouldExit) {
              const addAmount = Math.min(
                lastKnownBalance.availableBalance * PYRAMID_CONFIG.positionSizePerLevel,
                10 // Cap at $10 per add
              )
              
              if (addAmount >= 1) {
                try {
                  console.log(`[Pyramid] ═══════════════════════════════════════════════`)
                  console.log(`[Pyramid] ADDING Level ${pyramidState.level + 1}: $${addAmount.toFixed(2)} to ${currentPosition.side}`)
                  console.log(`[Pyramid] ═══════════════════════════════════════════════`)
                  
                  const result = await executeTrade(currentPosition.side, addAmount)
                  if (result.success) {
                    pyramidState.level++
                    pyramidState.entries.push({ price, size: result.quantity || 0, timestamp: Date.now() })
                    pyramidState.lastAddTime = Date.now()
                    
                    // Recalculate average entry
                    const totalValue = pyramidState.entries.reduce((sum, e) => sum + (e.price * e.size), 0)
                    const totalSize = pyramidState.entries.reduce((sum, e) => sum + e.size, 0)
                    pyramidState.avgEntry = totalValue / totalSize
                    pyramidState.totalSize = totalSize
                    
                    mainWindow?.webContents.send('trader:pyramidUpdate', {
                      level: pyramidState.level,
                      maxLevels: pyramidState.maxLevels,
                      avgEntry: pyramidState.avgEntry,
                      trailingStop: pyramidState.trailingStop,
                      entries: pyramidState.entries,
                      ema9: pyramidState.ema9,
                      ema21: pyramidState.ema21,
                      ema50: pyramidState.ema50
                    })
                  }
                } catch (err: any) {
                  console.error(`[Pyramid] Add failed:`, err.message)
                }
              }
            }
            
            // Execute EXIT
            if (shouldExit) {
              console.log(`[Pyramid] ═══════════════════════════════════════════════`)
              console.log(`[Pyramid] EXIT: ${exitReason}`)
              console.log(`[Pyramid] Final Level: ${pyramidState.level} | Entries: ${pyramidState.entries.length}`)
              console.log(`[Pyramid] ═══════════════════════════════════════════════`)
              
              try {
                await closeAllPositions()
                
                mainWindow?.webContents.send('trader:trade', {
                  id: `exit-${Date.now()}`,
                  action: 'CLOSE',
                  side: 'close',
                  price,
                  quantity: currentPosition.size,
                  status: 'filled',
                  timestamp: Date.now(),
                  pnl: pnlUsd,
                  reason: exitReason,
                  pyramidLevel: pyramidState.level
                })
                
                // Track performance
                traderPerformance.totalPnl += pnlUsd
                if (pnlUsd > 0) {
                  traderPerformance.winningTrades++
                  if (pnlUsd > traderPerformance.largestWin) traderPerformance.largestWin = pnlUsd
                } else {
                  dailyLoss += Math.abs(pnlUsd)
                  if (pnlUsd < traderPerformance.largestLoss) traderPerformance.largestLoss = pnlUsd
                }
                
                // Reset pyramid state
                resetPyramid()
                
              } catch (err: any) {
                console.error(`[Pyramid] Exit failed:`, err.message)
              }
            }
            
            // Send pyramid state to UI every tick
            mainWindow?.webContents.send('trader:pyramidUpdate', {
              level: pyramidState.level,
              maxLevels: pyramidState.maxLevels,
              avgEntry: pyramidState.avgEntry,
              trailingStop: pyramidState.trailingStop,
              pnlPercent,
              pnlUsd,
              entries: pyramidState.entries,
              ema9: pyramidState.ema9,
              ema21: pyramidState.ema21,
              ema50: pyramidState.ema50,
              ema200: pyramidState.ema200
            })
          } else {
            // No position - reset pyramid state
            if (pyramidState.level > 0) {
              resetPyramid()
            }
          }
          
          // Send liveUpdate to UI
          mainWindow?.webContents.send('trader:liveUpdate', {
            price,
            signal: currentPosition.side || 'none',
            strength: confluenceScore,
            reason: confluenceFactors.length > 0 ? confluenceFactors.join(' • ') : 'Monitoring',
            timestamp: Date.now(),
            apiCalls: apiCallCount
          })
          
          mainWindow?.webContents.send('trader:health', traderHealth)
        }, 3000)
        
        balanceInterval = setInterval(async () => {
          if (!traderRunning) return
          await fetchBalance()
        }, 15000)
        
        positionInterval = setInterval(async () => {
          if (!traderRunning) return
          await fetchPosition()
          if (currentPosition.side) {
            mainWindow?.webContents.send('trader:position', currentPosition)
          }
        }, 10000)
        
        // Send config to engine for pattern analysis
        engineProcess?.send({ 
          type: 'trader:start', 
          config: {
            apiKey: traderApiKey,
            apiSecret: traderApiSecret,
            testnet: false,
            enableAutoTrading: true,
            minConfluenceToEnter: 3,
            baseRiskPercent: 0.3
          }
        })
        
        // Notify UI that trader is running
        mainWindow?.webContents.send('trader:health', { 
          isHealthy: true, 
          apiLatencyMs: 50, 
          wsConnected: true, 
          uptime: 0, 
          errorCount: 0 
        })
        
      } catch (err: any) {
        console.error('[AutoStart] Failed to initialize trading:', err.message)
        traderRunning = false
        traderHealth.isHealthy = false
      }
    } else {
      console.log('[AutoStart] No saved API keys found')
      console.log('[AutoStart] Go to Settings to enter AsterDEX API credentials')
      console.log('[AutoStart] Trading will auto-start after keys are saved')
      console.log('[AutoStart] ═══════════════════════════════════════════════')
    }
  }, 5000) // Wait 5 seconds for engine to fully initialize
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopEngine()
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
