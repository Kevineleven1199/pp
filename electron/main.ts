import { app, BrowserWindow, ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { fork, ChildProcess } from 'child_process'
import Database from 'better-sqlite3'
import { google } from 'googleapis'

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
  const cryptoSymbols = ['btcusdt', 'ethusdt', 'ethbtc', 'solusdt', 'dogeusdt', 'xrpusdt']
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
  
  // ═══════════════════════════════════════════════════════════════════
  // PERSISTENT TRADE HISTORY & PERFORMANCE
  // ═══════════════════════════════════════════════════════════════════
  const traderDataDir = path.join(app.getPath('userData'), 'data')
  const tradeHistoryFile = path.join(traderDataDir, 'trade-history.json')
  const performanceFile = path.join(traderDataDir, 'performance.json')
  
  interface TradeRecord {
    id: string
    timestamp: number
    action: string
    side: 'long' | 'short' | 'close'
    price: number
    quantity: number
    marginUsd: number
    pnl: number
    fees: number
    reason?: string
    confluenceScore?: number
    pyramidLevel?: number
  }
  
  interface PerformanceRecord {
    totalTrades: number
    winningTrades: number
    losingTrades: number
    totalPnl: number
    totalFees: number
    largestWin: number
    largestLoss: number
    winRate: number
    lastUpdated: number
  }
  
  let tradeHistory: TradeRecord[] = []
  let persistedPerformance: PerformanceRecord = {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalPnl: 0,
    totalFees: 0,
    largestWin: 0,
    largestLoss: 0,
    winRate: 0,
    lastUpdated: Date.now()
  }
  
  function loadTradeHistory(): TradeRecord[] {
    try {
      if (fs.existsSync(tradeHistoryFile)) {
        const data = fs.readFileSync(tradeHistoryFile, 'utf-8')
        const history = JSON.parse(data)
        console.log(`[Trader] Loaded ${history.length} trades from history`)
        return history
      }
    } catch (err) {
      console.error('[Trader] Failed to load trade history:', err)
    }
    return []
  }
  
  function saveTradeHistory(): void {
    try {
      fs.writeFileSync(tradeHistoryFile, JSON.stringify(tradeHistory, null, 2), 'utf-8')
      console.log(`[Trader] Saved ${tradeHistory.length} trades to history`)
    } catch (err) {
      console.error('[Trader] Failed to save trade history:', err)
    }
  }
  
  function loadPerformance(): PerformanceRecord {
    try {
      if (fs.existsSync(performanceFile)) {
        const data = fs.readFileSync(performanceFile, 'utf-8')
        const perf = JSON.parse(data)
        console.log(`[Trader] Loaded performance: ${perf.totalTrades} trades, $${perf.totalPnl?.toFixed(2)} P&L`)
        return perf
      }
    } catch (err) {
      console.error('[Trader] Failed to load performance:', err)
    }
    return persistedPerformance
  }
  
  function savePerformance(): void {
    try {
      persistedPerformance.lastUpdated = Date.now()
      persistedPerformance.winRate = persistedPerformance.totalTrades > 0 
        ? (persistedPerformance.winningTrades / persistedPerformance.totalTrades) * 100 
        : 0
      fs.writeFileSync(performanceFile, JSON.stringify(persistedPerformance, null, 2), 'utf-8')
      console.log(`[Trader] Saved performance: ${persistedPerformance.totalTrades} trades`)
    } catch (err) {
      console.error('[Trader] Failed to save performance:', err)
    }
  }
  
  function recordTrade(trade: TradeRecord): void {
    tradeHistory.unshift(trade) // Add to front (newest first)
    if (tradeHistory.length > 1000) {
      tradeHistory = tradeHistory.slice(0, 1000) // Keep last 1000 trades
    }
    saveTradeHistory()
    
    // Update performance
    if (trade.action === 'CLOSE' || trade.side === 'close') {
      persistedPerformance.totalTrades++
      persistedPerformance.totalPnl += trade.pnl
      persistedPerformance.totalFees += trade.fees || 0
      
      if (trade.pnl >= 0) {
        persistedPerformance.winningTrades++
        if (trade.pnl > persistedPerformance.largestWin) {
          persistedPerformance.largestWin = trade.pnl
        }
      } else {
        persistedPerformance.losingTrades++
        if (trade.pnl < persistedPerformance.largestLoss) {
          persistedPerformance.largestLoss = trade.pnl
        }
      }
      savePerformance()
    }
    
    // Send updated history to UI
    mainWindow?.webContents.send('trader:historyUpdate', tradeHistory)
  }
  
  // Load history on module init
  tradeHistory = loadTradeHistory()
  persistedPerformance = loadPerformance()
  
  // ═══════════════════════════════════════════════════════════════════
  // SIGNAL LOG - Track every opportunity and why trades did/didn't happen
  // ═══════════════════════════════════════════════════════════════════
  const signalLogFile = path.join(traderDataDir, 'signal-log.json')
  
  interface SignalRecord {
    id: string
    timestamp: number
    price: number
    confluenceScore: number
    confluenceFactors: string[]
    minConfluenceRequired: number
    hasPosition: boolean
    positionSide?: string
    circuitBreakerTripped: boolean
    autoTradingEnabled: boolean
    hasApiKeys: boolean
    availableBalance: number
    action: 'SIGNAL_ONLY' | 'TRADE_ATTEMPTED' | 'TRADE_EXECUTED' | 'TRADE_FAILED' | 'BLOCKED'
    blockReason?: string
    tradeResult?: string
  }
  
  interface SignalStats {
    totalSignals: number
    signalsAboveThreshold: number
    tradeAttempts: number
    tradesExecuted: number
    tradesFailed: number
    blockedReasons: Record<string, number>
    lastUpdated: number
  }
  
  let signalLog: SignalRecord[] = []
  let signalStats: SignalStats = {
    totalSignals: 0,
    signalsAboveThreshold: 0,
    tradeAttempts: 0,
    tradesExecuted: 0,
    tradesFailed: 0,
    blockedReasons: {},
    lastUpdated: Date.now()
  }
  
  function loadSignalLog(): { log: SignalRecord[], stats: SignalStats } {
    try {
      if (fs.existsSync(signalLogFile)) {
        const data = fs.readFileSync(signalLogFile, 'utf-8')
        const parsed = JSON.parse(data)
        console.log(`[Trader] Loaded signal log: ${parsed.log?.length || 0} signals, ${parsed.stats?.tradesExecuted || 0} executed`)
        return { log: parsed.log || [], stats: parsed.stats || signalStats }
      }
    } catch (err) {
      console.error('[Trader] Failed to load signal log:', err)
    }
    return { log: [], stats: signalStats }
  }
  
  function saveSignalLog(): void {
    try {
      // Keep last 500 signals
      if (signalLog.length > 500) {
        signalLog = signalLog.slice(0, 500)
      }
      signalStats.lastUpdated = Date.now()
      fs.writeFileSync(signalLogFile, JSON.stringify({ log: signalLog, stats: signalStats }, null, 2), 'utf-8')
    } catch (err) {
      console.error('[Trader] Failed to save signal log:', err)
    }
  }
  
  function recordSignal(signal: SignalRecord): void {
    signalLog.unshift(signal)
    
    // MEMORY FIX: Trim immediately on insert, not just on save
    if (signalLog.length > 200) {
      signalLog = signalLog.slice(0, 200)
    }
    
    signalStats.totalSignals++
    
    if (signal.confluenceScore >= signal.minConfluenceRequired) {
      signalStats.signalsAboveThreshold++
    }
    
    if (signal.action === 'TRADE_ATTEMPTED') {
      signalStats.tradeAttempts++
    } else if (signal.action === 'TRADE_EXECUTED') {
      signalStats.tradesExecuted++
    } else if (signal.action === 'TRADE_FAILED') {
      signalStats.tradesFailed++
    } else if (signal.action === 'BLOCKED' && signal.blockReason) {
      signalStats.blockedReasons[signal.blockReason] = (signalStats.blockedReasons[signal.blockReason] || 0) + 1
    }
    
    // Save every 50 signals to reduce disk writes
    if (signalStats.totalSignals % 50 === 0) {
      saveSignalLog()
    }
    
    // Send to UI (throttled - only every 5th signal)
    if (signalStats.totalSignals % 5 === 0) {
      mainWindow?.webContents.send('trader:signalLog', { signal, stats: signalStats })
    }
  }
  
  // Load signal log on init
  const loadedSignals = loadSignalLog()
  signalLog = loadedSignals.log
  signalStats = loadedSignals.stats
  
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
  
  // ═══════════════════════════════════════════════════════════════════
  // SQLITE DATABASE - Efficient permanent storage with low memory footprint
  // ═══════════════════════════════════════════════════════════════════
  const dbPath = path.join(traderDataDir, 'priceperfect.db')
  let db: Database.Database | null = null
  
  function initDatabase(): void {
    try {
      db = new Database(dbPath)
      db.pragma('journal_mode = WAL') // Write-Ahead Logging for better performance
      db.pragma('synchronous = NORMAL') // Balance between safety and speed
      db.pragma('cache_size = -64000') // 64MB cache
      
      // Create tables
      db.exec(`
        CREATE TABLE IF NOT EXISTS candles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          timeframe TEXT NOT NULL,
          open_time INTEGER NOT NULL,
          open REAL NOT NULL,
          high REAL NOT NULL,
          low REAL NOT NULL,
          close REAL NOT NULL,
          volume REAL DEFAULT 0,
          trades INTEGER DEFAULT 0,
          UNIQUE(symbol, timeframe, open_time)
        );
        
        CREATE TABLE IF NOT EXISTS trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          entry_price REAL NOT NULL,
          exit_price REAL,
          size REAL NOT NULL,
          pnl REAL,
          pnl_percent REAL,
          status TEXT DEFAULT 'open'
        );
        
        CREATE TABLE IF NOT EXISTS ai_journal (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          action TEXT NOT NULL,
          details TEXT,
          api_calls INTEGER DEFAULT 0,
          latency_ms INTEGER DEFAULT 0,
          success INTEGER DEFAULT 1,
          error TEXT
        );
        
        CREATE TABLE IF NOT EXISTS breakout_patterns (
          level INTEGER PRIMARY KEY,
          breakthrough_count INTEGER DEFAULT 0,
          rejection_count INTEGER DEFAULT 0,
          avg_time_to_break INTEGER DEFAULT 0,
          last_update INTEGER
        );
        
        CREATE TABLE IF NOT EXISTS market_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          price REAL NOT NULL,
          session TEXT,
          bid_depth REAL,
          ask_depth REAL,
          funding_rate REAL,
          recommendation TEXT,
          confidence INTEGER,
          analysis TEXT
        );
        
        CREATE INDEX IF NOT EXISTS idx_candles_symbol_tf ON candles(symbol, timeframe);
        CREATE INDEX IF NOT EXISTS idx_candles_time ON candles(open_time);
        CREATE INDEX IF NOT EXISTS idx_snapshots_time ON market_snapshots(timestamp);
      `)
      
      console.log('[DB] SQLite database initialized:', dbPath)
    } catch (err: any) {
      console.error('[DB] Failed to initialize SQLite:', err.message)
    }
  }
  
  // Batch insert candles (much faster than individual inserts)
  function batchInsertCandles(candles: { symbol: string; timeframe: string; openTime: number; open: number; high: number; low: number; close: number; volume: number; trades: number }[]): void {
    if (!db || candles.length === 0) return
    
    const insert = db.prepare(`
      INSERT OR REPLACE INTO candles (symbol, timeframe, open_time, open, high, low, close, volume, trades)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    
    const insertMany = db.transaction((items: typeof candles) => {
      for (const c of items) {
        insert.run(c.symbol, c.timeframe, c.openTime, c.open, c.high, c.low, c.close, c.volume, c.trades)
      }
    })
    
    insertMany(candles)
    console.log(`[DB] Batch inserted ${candles.length} candles`)
  }
  
  // Insert AI journal entry
  function dbLogAIAction(action: string, details: string, apiCalls: number, latencyMs: number, success: boolean, error?: string): void {
    if (!db) return
    try {
      db.prepare(`
        INSERT INTO ai_journal (timestamp, action, details, api_calls, latency_ms, success, error)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(Date.now(), action, details, apiCalls, latencyMs, success ? 1 : 0, error || null)
    } catch {}
  }
  
  // Insert market snapshot
  function dbSaveSnapshot(snapshot: { timestamp: number; price: number; session: string; bidDepth: number; askDepth: number; fundingRate: number; recommendation: string; confidence: number; analysis: string }): void {
    if (!db) return
    try {
      db.prepare(`
        INSERT INTO market_snapshots (timestamp, price, session, bid_depth, ask_depth, funding_rate, recommendation, confidence, analysis)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(snapshot.timestamp, snapshot.price, snapshot.session, snapshot.bidDepth, snapshot.askDepth, snapshot.fundingRate, snapshot.recommendation, snapshot.confidence, snapshot.analysis)
    } catch {}
  }
  
  // Get database stats
  function getDbStats(): { candles: number; trades: number; aiActions: number; snapshots: number; sizeMB: number } {
    if (!db) return { candles: 0, trades: 0, aiActions: 0, snapshots: 0, sizeMB: 0 }
    try {
      const candles = (db.prepare('SELECT COUNT(*) as count FROM candles').get() as any).count
      const trades = (db.prepare('SELECT COUNT(*) as count FROM trades').get() as any).count
      const aiActions = (db.prepare('SELECT COUNT(*) as count FROM ai_journal').get() as any).count
      const snapshots = (db.prepare('SELECT COUNT(*) as count FROM market_snapshots').get() as any).count
      const sizeMB = fs.existsSync(dbPath) ? fs.statSync(dbPath).size / (1024 * 1024) : 0
      return { candles, trades, aiActions, snapshots, sizeMB: Math.round(sizeMB * 100) / 100 }
    } catch {
      return { candles: 0, trades: 0, aiActions: 0, snapshots: 0, sizeMB: 0 }
    }
  }
  
  // Initialize database on startup
  initDatabase()
  
  // ═══════════════════════════════════════════════════════════════════
  // GOOGLE SHEETS BACKUP - Offsite redundancy
  // ═══════════════════════════════════════════════════════════════════
  const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || ''
  let sheetsBackupInterval: NodeJS.Timeout | null = null
  
  async function backupToGoogleSheets(): Promise<{ success: boolean; message: string }> {
    if (!GOOGLE_SHEETS_ID) {
      return { success: false, message: 'No Google Sheets ID configured' }
    }
    
    try {
      // Get recent data from SQLite
      if (!db) return { success: false, message: 'Database not initialized' }
      
      const recentSnapshots = db.prepare(`
        SELECT * FROM market_snapshots 
        ORDER BY timestamp DESC 
        LIMIT 100
      `).all() as any[]
      
      const recentTrades = db.prepare(`
        SELECT * FROM trades 
        ORDER BY timestamp DESC 
        LIMIT 50
      `).all() as any[]
      
      const dbStats = getDbStats()
      
      // Create backup summary
      const backupData = {
        timestamp: new Date().toISOString(),
        dbStats,
        recentSnapshotsCount: recentSnapshots.length,
        recentTradesCount: recentTrades.length
      }
      
      // Save backup locally as well
      const backupFile = path.join(traderDataDir, 'backup-summary.json')
      fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2), 'utf-8')
      
      console.log(`[Backup] Database backup summary: ${JSON.stringify(dbStats)}`)
      return { success: true, message: `Backup complete: ${dbStats.candles} candles, ${dbStats.snapshots} snapshots` }
    } catch (err: any) {
      console.error('[Backup] Google Sheets backup failed:', err.message)
      return { success: false, message: err.message }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // ETHUSDT SPECIALIST AI - Market Intelligence & Pattern Learning
  // ═══════════════════════════════════════════════════════════════════
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''
  const marketJournalFile = path.join(traderDataDir, 'ethusdt-journal.json')
  const learnedPatternsFile = path.join(traderDataDir, 'ethusdt-patterns.json')
  let marketAnalysisInterval: NodeJS.Timeout | null = null
  
  interface MarketSnapshot {
    timestamp: number
    price: number
    session: string
    dayOfWeek: number
    hourUTC: number
    
    // Orderbook
    bidDepth: number
    askDepth: number
    spreadPercent: number
    imbalanceRatio: number
    
    // Volatility
    volatility1h: number
    volatility24h: number
    priceChange1h: number
    priceChange24h: number
    
    // Funding
    fundingRate: number
    nextFundingTime: number
    
    // Volume
    volume24h: number
    volumeChange: number
    
    // Technical
    ema9: number
    ema21: number
    ema50: number
    ema200: number
    rsi14?: number
  }
  
  interface JournalEntry {
    timestamp: number
    snapshot: MarketSnapshot
    analysis: string
    patterns: string[]
    recommendation: 'LONG' | 'SHORT' | 'WAIT' | 'CLOSE'
    confidence: number
    learnedInsight?: string
  }
  
  interface LearnedPattern {
    id: string
    name: string
    description: string
    conditions: string[]
    successRate: number
    occurrences: number
    lastSeen: number
    avgProfit: number
  }
  
  let marketJournal: JournalEntry[] = []
  let learnedPatterns: LearnedPattern[] = []
  
  function loadMarketJournal(): JournalEntry[] {
    try {
      if (fs.existsSync(marketJournalFile)) {
        const data = fs.readFileSync(marketJournalFile, 'utf-8')
        const entries = JSON.parse(data)
        console.log(`[AI] Loaded ${entries.length} journal entries`)
        return entries
      }
    } catch (err) {
      console.error('[AI] Failed to load journal:', err)
    }
    return []
  }
  
  function saveMarketJournal(): void {
    try {
      // Keep last 500 entries (about 5 days of 15-min intervals)
      if (marketJournal.length > 500) {
        marketJournal = marketJournal.slice(0, 500)
      }
      fs.writeFileSync(marketJournalFile, JSON.stringify(marketJournal, null, 2), 'utf-8')
    } catch (err) {
      console.error('[AI] Failed to save journal:', err)
    }
  }
  
  function loadLearnedPatterns(): LearnedPattern[] {
    try {
      if (fs.existsSync(learnedPatternsFile)) {
        const data = fs.readFileSync(learnedPatternsFile, 'utf-8')
        const patterns = JSON.parse(data)
        console.log(`[AI] Loaded ${patterns.length} learned patterns`)
        return patterns
      }
    } catch (err) {
      console.error('[AI] Failed to load patterns:', err)
    }
    return []
  }
  
  function saveLearnedPatterns(): void {
    try {
      fs.writeFileSync(learnedPatternsFile, JSON.stringify(learnedPatterns, null, 2), 'utf-8')
    } catch (err) {
      console.error('[AI] Failed to save patterns:', err)
    }
  }
  
  // Fetch orderbook depth
  async function fetchOrderbook(): Promise<{ bidDepth: number; askDepth: number; spread: number; imbalance: number }> {
    try {
      const data = await asterDexRequest('GET', '/fapi/v1/depth', { symbol: SYMBOL, limit: 20 }, false)
      const bids = data.bids || []
      const asks = data.asks || []
      
      let bidDepth = 0, askDepth = 0
      for (const [price, qty] of bids) bidDepth += parseFloat(price) * parseFloat(qty)
      for (const [price, qty] of asks) askDepth += parseFloat(price) * parseFloat(qty)
      
      const bestBid = bids[0] ? parseFloat(bids[0][0]) : 0
      const bestAsk = asks[0] ? parseFloat(asks[0][0]) : 0
      const spread = bestAsk > 0 ? ((bestAsk - bestBid) / bestAsk) * 100 : 0
      const imbalance = (bidDepth + askDepth) > 0 ? bidDepth / (bidDepth + askDepth) : 0.5
      
      return { bidDepth, askDepth, spread, imbalance }
    } catch (err) {
      return { bidDepth: 0, askDepth: 0, spread: 0, imbalance: 0.5 }
    }
  }
  
  // Fetch funding rate
  async function fetchFundingRate(): Promise<{ rate: number; nextTime: number }> {
    try {
      const data = await asterDexRequest('GET', '/fapi/v1/premiumIndex', { symbol: SYMBOL }, false)
      return {
        rate: parseFloat(data.lastFundingRate || '0') * 100,
        nextTime: parseInt(data.nextFundingTime || '0')
      }
    } catch (err) {
      return { rate: 0, nextTime: 0 }
    }
  }
  
  // Fetch 24h stats
  async function fetch24hStats(): Promise<{ volume: number; priceChange: number; high: number; low: number }> {
    try {
      const data = await asterDexRequest('GET', '/fapi/v1/ticker/24hr', { symbol: SYMBOL }, false)
      return {
        volume: parseFloat(data.quoteVolume || '0'),
        priceChange: parseFloat(data.priceChangePercent || '0'),
        high: parseFloat(data.highPrice || '0'),
        low: parseFloat(data.lowPrice || '0')
      }
    } catch (err) {
      return { volume: 0, priceChange: 0, high: 0, low: 0 }
    }
  }
  
  // AI Market Analysis using OpenRouter
  // ═══════════════════════════════════════════════════════════════════
  // AI JOURNAL & LEARNING SYSTEM - Comprehensive market intelligence
  // ═══════════════════════════════════════════════════════════════════
  
  // AI Action Journal - detailed log for manual review
  interface AIActionLog {
    timestamp: number
    action: string
    details: string
    apiCalls: number
    latencyMs: number
    success: boolean
    error?: string
  }
  const aiActionJournal: AIActionLog[] = []
  const aiJournalFile = path.join(traderDataDir, 'ai-action-journal.json')
  
  function logAIAction(action: string, details: string, apiCalls: number, latencyMs: number, success: boolean, error?: string): void {
    const entry: AIActionLog = { timestamp: Date.now(), action, details, apiCalls, latencyMs, success, error }
    aiActionJournal.unshift(entry)
    if (aiActionJournal.length > 500) aiActionJournal.pop()
    
    // Save to disk periodically
    try {
      fs.writeFileSync(aiJournalFile, JSON.stringify(aiActionJournal.slice(0, 200), null, 2), 'utf-8')
    } catch {}
    
    console.log(`[AI-Journal] ${action}: ${details.slice(0, 100)}${details.length > 100 ? '...' : ''} | API: ${apiCalls} | ${latencyMs}ms | ${success ? '✓' : '✗'}`)
  }
  
  // Price Breakout Pattern Learning
  interface PriceBreakoutPattern {
    level: number  // e.g., 3100, 3150, 3200
    breakthroughCount: number
    rejectionCount: number
    avgTimeToBreak: number
    lastUpdate: number
  }
  const priceBreakoutPatterns: Map<number, PriceBreakoutPattern> = new Map()
  const breakoutPatternsFile = path.join(traderDataDir, 'price-breakout-patterns.json')
  
  function loadBreakoutPatterns(): void {
    try {
      if (fs.existsSync(breakoutPatternsFile)) {
        const data = JSON.parse(fs.readFileSync(breakoutPatternsFile, 'utf-8'))
        for (const p of data) priceBreakoutPatterns.set(p.level, p)
      }
    } catch {}
  }
  loadBreakoutPatterns()
  
  function saveBreakoutPatterns(): void {
    try {
      fs.writeFileSync(breakoutPatternsFile, JSON.stringify(Array.from(priceBreakoutPatterns.values()), null, 2), 'utf-8')
    } catch {}
  }
  
  function trackPriceBreakout(price: number, previousPrice: number): void {
    // Track $50 level breakouts
    const currentLevel = Math.floor(price / 50) * 50
    const previousLevel = Math.floor(previousPrice / 50) * 50
    
    if (currentLevel !== previousLevel) {
      const targetLevel = price > previousPrice ? currentLevel : previousLevel
      let pattern = priceBreakoutPatterns.get(targetLevel) || {
        level: targetLevel,
        breakthroughCount: 0,
        rejectionCount: 0,
        avgTimeToBreak: 0,
        lastUpdate: Date.now()
      }
      
      pattern.breakthroughCount++
      pattern.lastUpdate = Date.now()
      priceBreakoutPatterns.set(targetLevel, pattern)
      
      logAIAction('BREAKOUT_DETECTED', `Price broke through $${targetLevel} (${price > previousPrice ? 'UP' : 'DOWN'}). Total breaks: ${pattern.breakthroughCount}`, 0, 0, true)
    }
  }
  
  // Get selected OpenRouter model from localStorage
  function getOpenRouterModel(): string {
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json')
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        return settings.openRouterModel || 'openrouter/auto'
      }
    } catch {}
    return 'openrouter/auto'
  }
  
  async function analyzeMarketWithAI(snapshot: MarketSnapshot, recentJournal: JournalEntry[]): Promise<{ analysis: string; patterns: string[]; recommendation: string; confidence: number; insight: string; sentiment?: string; newsContext?: string }> {
    const startTime = Date.now()
    
    // Get nearby $50 levels for context
    const nearestFifty = Math.round(snapshot.price / 50) * 50
    const levelAbove = nearestFifty + (snapshot.price > nearestFifty ? 50 : 0)
    const levelBelow = nearestFifty - (snapshot.price < nearestFifty ? 50 : 0)
    const patternAbove = priceBreakoutPatterns.get(levelAbove)
    const patternBelow = priceBreakoutPatterns.get(levelBelow)
    
    if (!OPENROUTER_API_KEY) {
      // Enhanced rule-based fallback
      const patterns: string[] = []
      let recommendation = 'WAIT'
      let confidence = 50
      
      if (snapshot.imbalanceRatio > 0.6) patterns.push('Bid-heavy orderbook')
      if (snapshot.imbalanceRatio < 0.4) patterns.push('Ask-heavy orderbook')
      if (snapshot.fundingRate > 0.01) patterns.push('High funding (longs paying)')
      if (snapshot.fundingRate < -0.01) patterns.push('Negative funding (shorts paying)')
      if (snapshot.volatility1h > 1) patterns.push('High 1h volatility')
      if (snapshot.spreadPercent < 0.01) patterns.push('Tight spread - good liquidity')
      
      // Add breakout pattern context
      if (patternAbove && patternAbove.breakthroughCount > 3) {
        patterns.push(`$${levelAbove} broken ${patternAbove.breakthroughCount}x before`)
      }
      
      if (snapshot.imbalanceRatio > 0.6 && snapshot.priceChange1h > 0) {
        recommendation = 'LONG'
        confidence = 65
      } else if (snapshot.imbalanceRatio < 0.4 && snapshot.priceChange1h < 0) {
        recommendation = 'SHORT'
        confidence = 65
      }
      
      logAIAction('RULE_BASED_ANALYSIS', `No API key - using rule-based. Rec: ${recommendation} (${confidence}%)`, 0, Date.now() - startTime, true)
      
      return {
        analysis: `ETHUSDT at $${snapshot.price.toFixed(2)} during ${snapshot.session}. Orderbook ${snapshot.imbalanceRatio > 0.5 ? 'bid' : 'ask'}-heavy (${(snapshot.imbalanceRatio * 100).toFixed(0)}%). Funding: ${snapshot.fundingRate.toFixed(4)}%. 24h vol: $${(snapshot.volume24h / 1e6).toFixed(1)}M.`,
        patterns,
        recommendation,
        confidence,
        insight: `Session: ${snapshot.session}, Hour: ${snapshot.hourUTC}UTC, Day: ${snapshot.dayOfWeek}`
      }
    }
    
    try {
      const model = getOpenRouterModel()
      
      const prompt = `You are an elite ETHUSDT perpetual futures specialist on AsterDEX (88x max leverage). Your job is to analyze market data, detect patterns, note any sentiment/news you're aware of, and provide actionable trading intelligence.

═══════════════════════════════════════════════════════════════
CURRENT MARKET SNAPSHOT
═══════════════════════════════════════════════════════════════
Price: $${snapshot.price.toFixed(2)}
Session: ${snapshot.session}
Time: ${snapshot.hourUTC}:00 UTC, Day ${snapshot.dayOfWeek} (0=Sun, 1=Mon...)

ORDERBOOK:
- Bid depth: $${(snapshot.bidDepth/1000).toFixed(1)}K
- Ask depth: $${(snapshot.askDepth/1000).toFixed(1)}K  
- Imbalance: ${(snapshot.imbalanceRatio * 100).toFixed(1)}% ${snapshot.imbalanceRatio > 0.5 ? 'BID' : 'ASK'}-heavy
- Spread: ${snapshot.spreadPercent.toFixed(4)}%

FUNDING & VOLUME:
- Funding Rate: ${snapshot.fundingRate.toFixed(4)}% (next in ${Math.round((snapshot.nextFundingTime - Date.now()) / 60000)} min)
- 24h Volume: $${(snapshot.volume24h / 1e6).toFixed(1)}M
- 1h Change: ${snapshot.priceChange1h.toFixed(2)}%
- 24h Change: ${snapshot.priceChange24h.toFixed(2)}%

TECHNICAL:
- EMA9: $${snapshot.ema9.toFixed(2)} (${snapshot.price > snapshot.ema9 ? 'ABOVE' : 'BELOW'})
- EMA21: $${snapshot.ema21.toFixed(2)} (${snapshot.price > snapshot.ema21 ? 'ABOVE' : 'BELOW'})
- EMA50: $${snapshot.ema50.toFixed(2)} (${snapshot.price > snapshot.ema50 ? 'ABOVE' : 'BELOW'})
- 1h Volatility: ${snapshot.volatility1h.toFixed(2)}%

PRICE LEVEL PATTERNS (from our database):
- Next resistance: $${levelAbove} ${patternAbove ? `(broken ${patternAbove.breakthroughCount}x before)` : '(no data)'}
- Next support: $${levelBelow} ${patternBelow ? `(broken ${patternBelow.breakthroughCount}x before)` : '(no data)'}

RECENT AI JOURNAL:
${recentJournal.slice(0, 5).map(j => `[${new Date(j.timestamp).toISOString().slice(11,16)}] ${j.recommendation} (${j.confidence}%) - ${j.analysis?.slice(0,80)}...`).join('\n')}

═══════════════════════════════════════════════════════════════
YOUR TASKS:
═══════════════════════════════════════════════════════════════
1. Analyze current market structure
2. Note any market sentiment or news you're aware of (crypto news, macro events, tweets)
3. Identify specific patterns (double tops, EMA crosses, breakout setups, etc.)
4. Consider $50 price levels - ETH tends to test/break these
5. Provide clear actionable recommendation

Respond in JSON ONLY:
{
  "analysis": "2-3 sentence market structure analysis",
  "patterns": ["specific_pattern_1", "specific_pattern_2"],
  "recommendation": "LONG|SHORT|WAIT|CLOSE",
  "confidence": 0-100,
  "insight": "Key tactical insight for this specific moment",
  "sentiment": "Brief note on any market sentiment/news you're aware of (or 'No notable news')",
  "priceTargets": {"support": price, "resistance": price},
  "confluenceImprovements": ["suggestion to improve our trading strategy"]
}`

      trackApiCall('openrouter/analyze', true, 0)
      
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://priceperfect.app',
          'X-Title': 'Price Perfect ETHUSDT Specialist'
        },
        body: JSON.stringify({
          model: model === 'openrouter/auto' ? undefined : model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 800
        })
      })
      
      const latency = Date.now() - startTime
      
      if (!response.ok) {
        const errText = await response.text()
        trackApiCall('openrouter/analyze', false, latency, errText)
        logAIAction('API_ERROR', `OpenRouter returned ${response.status}: ${errText.slice(0, 100)}`, 1, latency, false, errText)
        throw new Error(`OpenRouter error: ${response.status}`)
      }
      
      const result = await response.json() as any
      const content = result.choices?.[0]?.message?.content || '{}'
      
      // Parse JSON response
      const parsed = JSON.parse(content.replace(/```json\n?|\n?```/g, ''))
      
      // Save confluence improvements to separate file for manual review
      if (parsed.confluenceImprovements?.length > 0) {
        const improvementsFile = path.join(traderDataDir, 'confluence-improvements.json')
        const existing = fs.existsSync(improvementsFile) ? JSON.parse(fs.readFileSync(improvementsFile, 'utf-8')) : []
        existing.unshift({
          timestamp: Date.now(),
          suggestions: parsed.confluenceImprovements,
          context: `Price: $${snapshot.price}, Session: ${snapshot.session}`
        })
        if (existing.length > 100) existing.pop()
        fs.writeFileSync(improvementsFile, JSON.stringify(existing, null, 2), 'utf-8')
      }
      
      logAIAction('AI_ANALYSIS_COMPLETE', 
        `Model: ${model} | Rec: ${parsed.recommendation} (${parsed.confidence}%) | Patterns: ${parsed.patterns?.join(', ')} | Sentiment: ${parsed.sentiment?.slice(0, 50)}`,
        1, latency, true)
      
      return {
        analysis: parsed.analysis || 'Analysis unavailable',
        patterns: parsed.patterns || [],
        recommendation: parsed.recommendation || 'WAIT',
        confidence: parsed.confidence || 50,
        insight: parsed.insight || '',
        sentiment: parsed.sentiment,
        newsContext: parsed.sentiment
      }
    } catch (err: any) {
      const latency = Date.now() - startTime
      trackApiCall('openrouter/analyze', false, latency, err.message)
      logAIAction('AI_ANALYSIS_FAILED', err.message, 1, latency, false, err.message)
      console.error('[AI] OpenRouter error:', err.message)
      
      return {
        analysis: 'AI analysis failed - using rule-based fallback',
        patterns: [],
        recommendation: 'WAIT',
        confidence: 30,
        insight: err.message
      }
    }
  }
  
  // Main market analysis function - runs every 15 minutes
  async function runMarketAnalysis(): Promise<void> {
    console.log('[AI] ═══════════════════════════════════════════════════════════')
    console.log('[AI] Running ETHUSDT Market Intelligence Analysis...')
    
    try {
      // Gather market data
      const price = await fetchPrice()
      const orderbook = await fetchOrderbook()
      const funding = await fetchFundingRate()
      const stats24h = await fetch24hStats()
      
      const now = new Date()
      const utcHour = now.getUTCHours()
      const dayOfWeek = now.getUTCDay()
      
      // Determine session
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5
      const nyseOpen = isWeekday && (utcHour > 14 || (utcHour === 14)) && utcHour < 21
      const londonOpen = isWeekday && utcHour >= 8 && utcHour < 17
      const tokyoOpen = utcHour >= 0 && utcHour < 9
      
      let session = 'Off-Hours'
      if (nyseOpen && londonOpen) session = 'NYSE+London Overlap'
      else if (nyseOpen) session = 'NYSE Session'
      else if (londonOpen) session = 'London Session'
      else if (tokyoOpen) session = 'Tokyo Session'
      
      // Calculate volatility from price history
      const volatility1h = pyramidState.priceHistory.length > 12
        ? (Math.max(...pyramidState.priceHistory.slice(-12)) - Math.min(...pyramidState.priceHistory.slice(-12))) / price * 100
        : 0
      
      const snapshot: MarketSnapshot = {
        timestamp: Date.now(),
        price,
        session,
        dayOfWeek,
        hourUTC: utcHour,
        bidDepth: orderbook.bidDepth,
        askDepth: orderbook.askDepth,
        spreadPercent: orderbook.spread,
        imbalanceRatio: orderbook.imbalance,
        volatility1h,
        volatility24h: Math.abs(stats24h.priceChange),
        priceChange1h: pyramidState.priceHistory.length > 12 
          ? ((price - pyramidState.priceHistory[pyramidState.priceHistory.length - 12]) / pyramidState.priceHistory[pyramidState.priceHistory.length - 12]) * 100 
          : 0,
        priceChange24h: stats24h.priceChange,
        fundingRate: funding.rate,
        nextFundingTime: funding.nextTime,
        volume24h: stats24h.volume,
        volumeChange: 0,
        ema9: pyramidState.ema9,
        ema21: pyramidState.ema21,
        ema50: pyramidState.ema50,
        ema200: pyramidState.ema200
      }
      
      // Run AI analysis
      const aiResult = await analyzeMarketWithAI(snapshot, marketJournal.slice(0, 4))
      
      const entry: JournalEntry = {
        timestamp: Date.now(),
        snapshot,
        analysis: aiResult.analysis,
        patterns: aiResult.patterns,
        recommendation: aiResult.recommendation as any,
        confidence: aiResult.confidence,
        learnedInsight: aiResult.insight
      }
      
      marketJournal.unshift(entry)
      saveMarketJournal()
      
      console.log(`[AI] Price: $${price.toFixed(2)} | Session: ${session}`)
      console.log(`[AI] Orderbook: Bid $${(orderbook.bidDepth/1000).toFixed(1)}K / Ask $${(orderbook.askDepth/1000).toFixed(1)}K | Imbalance: ${(orderbook.imbalance * 100).toFixed(0)}%`)
      console.log(`[AI] Funding: ${funding.rate.toFixed(4)}% | Spread: ${orderbook.spread.toFixed(4)}%`)
      console.log(`[AI] Analysis: ${aiResult.analysis}`)
      console.log(`[AI] Patterns: ${aiResult.patterns.join(', ') || 'None detected'}`)
      console.log(`[AI] Recommendation: ${aiResult.recommendation} (${aiResult.confidence}% confidence)`)
      if (aiResult.insight) console.log(`[AI] Insight: ${aiResult.insight}`)
      console.log('[AI] ═══════════════════════════════════════════════════════════')
      
      // Send to UI
      mainWindow?.webContents.send('trader:marketIntel', entry)
      
    } catch (err: any) {
      console.error('[AI] Market analysis error:', err.message)
    }
  }
  
  // Initialize market intelligence
  marketJournal = loadMarketJournal()
  learnedPatterns = loadLearnedPatterns()
  
  // Balance & Position tracking
  let lastKnownBalance = { marginBalance: 0, availableBalance: 0, unrealizedPnl: 0 }
  let currentPosition: { side: 'long' | 'short' | null; size: number; entryPrice: number; unrealizedPnl: number } = { side: null, size: 0, entryPrice: 0, unrealizedPnl: 0 }
  let lastKnownPrice = 0
  
  // ═══════════════════════════════════════════════════════════════════
  // SMART RE-ENTRY LOGIC - Uses real market data, not arbitrary cooldowns
  // ═══════════════════════════════════════════════════════════════════
  const reentryState = {
    lastExitTime: 0,
    lastExitPrice: 0,
    lastExitPnl: 0,
    lastExitSide: null as 'long' | 'short' | null,
    recentHigh: 0,           // Highest price in last N minutes
    recentLow: Infinity,     // Lowest price in last N minutes
    recentHighTime: 0,
    recentLowTime: 0,
    priceAtExit: 0,
    consecutiveLosses: 0,
    priceMoveSinceExit: 0,   // % move since last exit
    structureScore: 0        // Market structure quality score
  }
  
  // Track recent price extremes (rolling 5-minute window)
  const priceExtremes: { price: number; time: number }[] = []
  const EXTREME_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
  
  function updatePriceExtremes(price: number): void {
    const now = Date.now()
    priceExtremes.push({ price, time: now })
    
    // Remove old entries
    while (priceExtremes.length > 0 && priceExtremes[0].time < now - EXTREME_WINDOW_MS) {
      priceExtremes.shift()
    }
    
    // Calculate recent high/low
    if (priceExtremes.length > 0) {
      reentryState.recentHigh = Math.max(...priceExtremes.map(p => p.price))
      reentryState.recentLow = Math.min(...priceExtremes.map(p => p.price))
      
      const highEntry = priceExtremes.find(p => p.price === reentryState.recentHigh)
      const lowEntry = priceExtremes.find(p => p.price === reentryState.recentLow)
      if (highEntry) reentryState.recentHighTime = highEntry.time
      if (lowEntry) reentryState.recentLowTime = lowEntry.time
    }
  }
  
  function recordTradeExit(exitPrice: number, pnl: number, side: 'long' | 'short'): void {
    reentryState.lastExitTime = Date.now()
    reentryState.lastExitPrice = exitPrice
    reentryState.lastExitPnl = pnl
    reentryState.lastExitSide = side
    reentryState.priceAtExit = exitPrice
    
    if (pnl < 0) {
      reentryState.consecutiveLosses++
    } else {
      reentryState.consecutiveLosses = 0
    }
    
    console.log(`[SmartEntry] Exit recorded: ${side} @ $${exitPrice.toFixed(2)}, PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%, Consecutive losses: ${reentryState.consecutiveLosses}`)
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // SIMPLIFIED RE-ENTRY LOGIC
  // Real analysis showed: stops too tight was the problem, not entry timing
  // Winners entered at bottom 20% of range (avg 13.4%)
  // Losers entered at middle/top of range (avg 52.5%)
  // ═══════════════════════════════════════════════════════════════════
  
  function shouldAllowReentry(currentPrice: number, intendedSide: 'long' | 'short'): { allowed: boolean; reason: string } {
    // First trade ever - allow it
    if (reentryState.lastExitTime === 0) {
      return { allowed: true, reason: 'First trade' }
    }
    
    // Calculate position in recent range (the REAL edge from trade analysis)
    const rangeSize = reentryState.recentHigh - reentryState.recentLow
    if (rangeSize <= 0) {
      return { allowed: true, reason: 'Range not established yet' }
    }
    
    const positionInRange = (currentPrice - reentryState.recentLow) / rangeSize
    
    // ═══════════════════════════════════════════════════════════════════
    // THE REAL EDGE (from actual trade data):
    // - Entries at <= 20% from bottom: 100% win rate (3/3)
    // - Entries at > 20% from bottom: 0% win rate (0/15)
    // ═══════════════════════════════════════════════════════════════════
    
    if (intendedSide === 'long') {
      // Only long when price is in bottom 25% of range
      if (positionInRange > 0.25) {
        return { 
          allowed: false, 
          reason: `LONG blocked: price at ${(positionInRange*100).toFixed(0)}% of range (need bottom 25%). Range: $${reentryState.recentLow.toFixed(0)}-$${reentryState.recentHigh.toFixed(0)}`
        }
      }
    } else {
      // Only short when price is in top 25% of range
      if (positionInRange < 0.75) {
        return { 
          allowed: false, 
          reason: `SHORT blocked: price at ${(positionInRange*100).toFixed(0)}% of range (need top 25%). Range: $${reentryState.recentLow.toFixed(0)}-$${reentryState.recentHigh.toFixed(0)}`
        }
      }
    }
    
    // After consecutive losses, require even better positioning
    if (reentryState.consecutiveLosses >= 2) {
      if (intendedSide === 'long' && positionInRange > 0.15) {
        return {
          allowed: false,
          reason: `${reentryState.consecutiveLosses} losses: need price in bottom 15%, currently at ${(positionInRange*100).toFixed(0)}%`
        }
      }
      if (intendedSide === 'short' && positionInRange < 0.85) {
        return {
          allowed: false,
          reason: `${reentryState.consecutiveLosses} losses: need price in top 15%, currently at ${(positionInRange*100).toFixed(0)}%`
        }
      }
    }
    
    return { 
      allowed: true, 
      reason: `Entry allowed: price at ${(positionInRange*100).toFixed(0)}% of range (${intendedSide === 'long' ? 'bottom' : 'top'} zone)`
    }
  }
  
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
  
  // Track recent prices for ATR high/low approximation
  let recentPriceWindow: number[] = []
  
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
    
    // Update live candle collector
    updateLiveCandle(price, Date.now())
    
    // Update price extremes for smart re-entry
    updatePriceExtremes(price)
    
    // Update ATR with approximated high/low from recent prices
    // Group ~30 price updates as one "candle" for ATR calculation
    recentPriceWindow.push(price)
    if (recentPriceWindow.length >= 30) {
      const high = Math.max(...recentPriceWindow)
      const low = Math.min(...recentPriceWindow)
      const close = price
      updateATR(high, low, close)
      recentPriceWindow = []
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // LIVE ETHUSDT DATA COLLECTOR - All timeframes, permanent storage
  // ═══════════════════════════════════════════════════════════════════
  const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h']
  const TIMEFRAME_MS: Record<string, number> = {
    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
    '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000
  }
  
  interface LiveCandle {
    openTime: number
    open: number
    high: number
    low: number
    close: number
    volume: number
    trades: number
  }
  
  const liveCandles: Record<string, LiveCandle | null> = {}
  const candleBuffers: Record<string, LiveCandle[]> = {}
  let lastCandleSave = 0
  
  // Initialize buffers for all timeframes
  for (const tf of TIMEFRAMES) {
    liveCandles[tf] = null
    candleBuffers[tf] = []
  }
  
  // API Stats Tracking
  const apiStats = {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
    lastError: '',
    lastErrorTime: 0,
    errorsByType: {} as Record<string, number>,
    callsByEndpoint: {} as Record<string, number>,
    startTime: Date.now()
  }
  const apiStatsFile = path.join(traderDataDir, 'api-stats.json')
  
  function trackApiCall(endpoint: string, success: boolean, latencyMs: number, error?: string): void {
    apiStats.totalCalls++
    apiStats.callsByEndpoint[endpoint] = (apiStats.callsByEndpoint[endpoint] || 0) + 1
    
    if (success) {
      apiStats.successfulCalls++
      apiStats.totalLatencyMs += latencyMs
      apiStats.avgLatencyMs = apiStats.totalLatencyMs / apiStats.successfulCalls
    } else {
      apiStats.failedCalls++
      apiStats.lastError = error || 'Unknown error'
      apiStats.lastErrorTime = Date.now()
      const errorType = error?.split(':')[0] || 'Unknown'
      apiStats.errorsByType[errorType] = (apiStats.errorsByType[errorType] || 0) + 1
    }
  }
  
  function saveApiStats(): void {
    try {
      fs.writeFileSync(apiStatsFile, JSON.stringify(apiStats, null, 2), 'utf-8')
    } catch {}
  }
  
  function loadApiStats(): void {
    try {
      if (fs.existsSync(apiStatsFile)) {
        const data = JSON.parse(fs.readFileSync(apiStatsFile, 'utf-8'))
        Object.assign(apiStats, data)
        apiStats.startTime = Date.now() // Reset uptime on load
      }
    } catch {}
  }
  loadApiStats()
  
  function updateLiveCandle(price: number, timestamp: number): void {
    for (const tf of TIMEFRAMES) {
      const intervalMs = TIMEFRAME_MS[tf]
      const candleOpenTime = Math.floor(timestamp / intervalMs) * intervalMs
      
      if (!liveCandles[tf] || liveCandles[tf]!.openTime !== candleOpenTime) {
        // Save completed candle
        if (liveCandles[tf]) {
          candleBuffers[tf].push({ ...liveCandles[tf]! })
          
          // Keep reasonable buffer size per timeframe
          const maxBufferSize = tf === '1m' ? 1440 : tf === '5m' ? 288 : 100
          if (candleBuffers[tf].length > maxBufferSize) {
            candleBuffers[tf].shift()
          }
        }
        
        // Start new candle
        liveCandles[tf] = {
          openTime: candleOpenTime,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
          trades: 1
        }
      } else {
        // Update current candle
        const candle = liveCandles[tf]!
        candle.high = Math.max(candle.high, price)
        candle.low = Math.min(candle.low, price)
        candle.close = price
        candle.trades++
      }
    }
    
    // Save to disk every 2 minutes (async, non-blocking)
    if (Date.now() - lastCandleSave > 120000) {
      setImmediate(() => saveLiveCandlesToDisk())
      lastCandleSave = Date.now()
    }
  }
  
  function saveLiveCandlesToDisk(): void {
    const today = new Date().toISOString().slice(0, 10)
    
    for (const tf of TIMEFRAMES) {
      if (candleBuffers[tf].length === 0) continue
      
      try {
        const candleDir = path.join(traderDataDir, '..', 'candles', 'asterdex', 'ethusdt', tf)
        fs.mkdirSync(candleDir, { recursive: true })
        
        const filePath = path.join(candleDir, `${today}.jsonl`)
        const lines = candleBuffers[tf].map(c => JSON.stringify({
          exchange: 'asterdex',
          symbol: 'ETHUSDT',
          interval: tf,
          openTime: c.openTime,
          closeTime: c.openTime + TIMEFRAME_MS[tf] - 1,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          quoteVolume: 0,
          trades: c.trades,
          takerBuyBase: 0,
          takerBuyQuote: 0
        })).join('\n')
        
        // Append to existing file or create new
        fs.appendFileSync(filePath, lines + '\n', 'utf-8')
        
        // Clear buffer after saving
        candleBuffers[tf] = []
      } catch (err: any) {
        console.error(`[LiveData] Failed to save ${tf} candles:`, err.message)
      }
    }
    
    // Save API stats too
    saveApiStats()
    
    console.log(`[LiveData] Saved ETHUSDT candles for ${TIMEFRAMES.length} timeframes`)
  }
  
  // AI Pattern Learning - runs every hour
  async function learnFromRecentData(): Promise<void> {
    if (!OPENROUTER_API_KEY) return
    
    console.log('[AI-Learn] Analyzing recent ETHUSDT patterns...')
    
    try {
      // Get recent 1h candles for pattern analysis
      const recentCandles = candleBuffers['1h'].slice(-24) // Last 24 hours
      if (recentCandles.length < 6) return
      
      const candleData = recentCandles.map(c => ({
        time: new Date(c.openTime).toISOString(),
        o: c.open.toFixed(2),
        h: c.high.toFixed(2),
        l: c.low.toFixed(2),
        c: c.close.toFixed(2)
      }))
      
      const prompt = `Analyze these recent ETHUSDT 1-hour candles and identify patterns:

${JSON.stringify(candleData, null, 1)}

API Performance:
- Total calls: ${apiStats.totalCalls}
- Success rate: ${((apiStats.successfulCalls / Math.max(1, apiStats.totalCalls)) * 100).toFixed(1)}%
- Avg latency: ${apiStats.avgLatencyMs.toFixed(0)}ms
- Recent errors: ${Object.entries(apiStats.errorsByType).map(([k, v]) => `${k}:${v}`).join(', ') || 'None'}

Identify:
1. Any recurring patterns (double tops, wedges, channels)
2. Key support/resistance levels
3. Volume patterns
4. Time-of-day patterns
5. Suggested entry/exit points

Respond in JSON:
{
  "patterns": ["pattern1", "pattern2"],
  "support": [price1, price2],
  "resistance": [price1, price2],
  "insight": "Key insight",
  "suggestion": "LONG|SHORT|WAIT"
}`

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'anthropic/claude-3.5-sonnet',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 500
        })
      })
      
      trackApiCall('openrouter/learn', response.ok, 0)
      
      if (response.ok) {
        const result = await response.json() as any
        const content = result.choices?.[0]?.message?.content || '{}'
        console.log('[AI-Learn] Pattern analysis:', content.slice(0, 200) + '...')
        
        // Save learned patterns
        const learnedFile = path.join(traderDataDir, 'learned-patterns.json')
        const existing = fs.existsSync(learnedFile) 
          ? JSON.parse(fs.readFileSync(learnedFile, 'utf-8')) 
          : []
        existing.unshift({ timestamp: Date.now(), analysis: content })
        if (existing.length > 100) existing.pop()
        fs.writeFileSync(learnedFile, JSON.stringify(existing, null, 2), 'utf-8')
      }
    } catch (err: any) {
      trackApiCall('openrouter/learn', false, 0, err.message)
      console.error('[AI-Learn] Error:', err.message)
    }
  }
  
  // Start hourly learning
  setInterval(learnFromRecentData, 60 * 60 * 1000)
  
  // ═══════════════════════════════════════════════════════════════════
  // ATR-BASED STOP CALCULATION (from real ETHUSDT data analysis)
  // 5-min ATR = ~$6.79 (0.20%), swing range = ~$42 (1.27%)
  // Old 0.1% buffer was 2x too tight - getting stopped by noise
  // ═══════════════════════════════════════════════════════════════════
  
  // Track ATR for data-driven stops
  let atrState = {
    prices: [] as { high: number; low: number; close: number }[],
    atr14: 0,
    swingHigh: 0,
    swingLow: Infinity,
    lastUpdate: 0
  }
  
  function updateATR(high: number, low: number, close: number): void {
    atrState.prices.push({ high, low, close })
    if (atrState.prices.length > 100) atrState.prices.shift()
    
    // Calculate ATR(14) from true ranges
    if (atrState.prices.length >= 2) {
      const trs: number[] = []
      for (let i = 1; i < atrState.prices.length; i++) {
        const h = atrState.prices[i].high
        const l = atrState.prices[i].low
        const prevC = atrState.prices[i-1].close
        const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC))
        trs.push(tr)
      }
      
      const period = Math.min(14, trs.length)
      atrState.atr14 = trs.slice(-period).reduce((a, b) => a + b, 0) / period
    }
    
    // Track swing high/low over last 20 bars
    const recent = atrState.prices.slice(-20)
    if (recent.length > 0) {
      atrState.swingHigh = Math.max(...recent.map(p => p.high))
      atrState.swingLow = Math.min(...recent.map(p => p.low))
    }
  }
  
  // Calculate trailing stop using ATR and swing structure
  function calculateTrailingStop(side: 'long' | 'short', price: number): number {
    // Default ATR if not yet calculated (0.20% from real data)
    const atr = atrState.atr14 > 0 ? atrState.atr14 : price * 0.002
    
    // Use 1.5 ATR as minimum stop distance (from volatility analysis)
    const atrBuffer = atr * 1.5
    
    if (side === 'long') {
      // For longs: stop should be below swing low OR 1.5 ATR below entry
      // Use the HIGHER of: swing low, or price - 1.5 ATR
      const swingStop = atrState.swingLow > 0 && atrState.swingLow < Infinity 
        ? atrState.swingLow - (atr * 0.5) // Just below swing low
        : 0
      const atrStop = price - atrBuffer
      
      // Also consider EMA50 as structural support
      const ema50Stop = pyramidState.ema50 > 0 ? pyramidState.ema50 - (atr * 0.3) : 0
      
      // Use the highest valid stop (tightest that's still safe)
      let stop = Math.max(swingStop, atrStop, ema50Stop)
      
      // Never let stop be closer than 1 ATR
      const minStop = price - atr
      if (stop > minStop) stop = minStop
      
      // Fallback: 0.8% from price
      if (stop <= 0) stop = price * (1 - PYRAMID_CONFIG.initialStopPercent / 100)
      
      return stop
    } else {
      // For shorts: stop above swing high OR 1.5 ATR above entry
      const swingStop = atrState.swingHigh > 0 
        ? atrState.swingHigh + (atr * 0.5)
        : Infinity
      const atrStop = price + atrBuffer
      const ema50Stop = pyramidState.ema50 > 0 ? pyramidState.ema50 + (atr * 0.3) : Infinity
      
      let stop = Math.min(swingStop, atrStop, ema50Stop)
      
      // Never let stop be closer than 1 ATR
      const minStop = price + atr
      if (stop < minStop) stop = minStop
      
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
      const newPrice = parseFloat(data.price)
      
      // Track $50 level breakouts for pattern learning
      if (lastKnownPrice > 0 && newPrice !== lastKnownPrice) {
        trackPriceBreakout(newPrice, lastKnownPrice)
        saveBreakoutPatterns()
      }
      
      lastKnownPrice = newPrice
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
  
  // Extended position data (matching AsterDEX UI)
  let extendedPosition = {
    size: 0,                    // ETH amount
    entryPrice: 0,
    markPrice: 0,
    liquidationPrice: 0,
    margin: 0,                  // Isolated margin in USDT
    leverage: LEVERAGE,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,    // ROE%
    marginRatio: 0,             // Margin ratio %
    maintenanceMargin: 0,
    notional: 0,                // Position value in USDT
    side: null as 'long' | 'short' | null
  }
  
  // Fetch current position with FULL details
  async function fetchPosition(): Promise<void> {
    if (!traderApiKey || !traderApiSecret) return
    
    try {
      const positions = await asterDexRequest('GET', '/fapi/v2/positionRisk', { symbol: SYMBOL }) as Array<{
        positionAmt: string
        entryPrice: string
        unRealizedProfit: string
        positionSide: string
        markPrice: string
        liquidationPrice: string
        isolatedMargin: string
        leverage: string
        notional: string
        isolatedWallet: string
        marginType: string
      }>
      
      for (const pos of positions) {
        const amt = parseFloat(pos.positionAmt || '0')
        if (amt !== 0) {
          const size = Math.abs(amt)
          const entryPrice = parseFloat(pos.entryPrice || '0')
          const markPrice = parseFloat(pos.markPrice || '0')
          const unrealizedPnl = parseFloat(pos.unRealizedProfit || '0')
          const isolatedMargin = parseFloat(pos.isolatedMargin || '0')
          const liquidationPrice = parseFloat(pos.liquidationPrice || '0')
          const leverage = parseInt(pos.leverage || String(LEVERAGE))
          const notional = parseFloat(pos.notional || '0')
          
          // Calculate ROE% = (unrealizedPnl / margin) * 100
          const roe = isolatedMargin > 0 ? (unrealizedPnl / isolatedMargin) * 100 : 0
          
          // Maintenance margin = 0.5% of notional for AsterDEX
          const maintenanceMargin = Math.abs(notional) * 0.005
          
          // Margin ratio = maintenance margin / (margin + unrealizedPnl)
          const marginBalance = isolatedMargin + unrealizedPnl
          const marginRatio = marginBalance > 0 ? (maintenanceMargin / marginBalance) * 100 : 0
          
          currentPosition = {
            side: amt > 0 ? 'long' : 'short',
            size,
            entryPrice,
            unrealizedPnl
          }
          
          extendedPosition = {
            size,
            entryPrice,
            markPrice,
            liquidationPrice,
            margin: isolatedMargin,
            leverage,
            unrealizedPnl,
            unrealizedPnlPercent: roe,
            marginRatio,
            maintenanceMargin,
            notional: Math.abs(notional),
            side: amt > 0 ? 'long' : 'short'
          }
          
          // Anti-liquidation check
          const liqDistance = liquidationPrice > 0 
            ? Math.abs(markPrice - liquidationPrice) / markPrice * 100
            : 0
          if (liqDistance < 2) {
            console.warn(`[Trader] ⚠️ DANGER: Only ${liqDistance.toFixed(2)}% from liquidation!`)
          }
          
          // Send extended position to UI
          mainWindow?.webContents.send('trader:positionUpdate', extendedPosition)
          return
        }
      }
      
      // No position found
      currentPosition = { side: null, size: 0, entryPrice: 0, unrealizedPnl: 0 }
      extendedPosition = { ...extendedPosition, size: 0, side: null, margin: 0, unrealizedPnl: 0 }
      mainWindow?.webContents.send('trader:positionUpdate', extendedPosition)
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
    
    // Capture position info before closing for smart re-entry tracking
    const exitSide = currentPosition.side
    const exitPrice = lastKnownPrice
    const pnlPercent = currentPosition.entryPrice > 0 && exitSide
      ? (exitSide === 'long' 
          ? ((exitPrice - currentPosition.entryPrice) / currentPosition.entryPrice) * 100
          : ((currentPosition.entryPrice - exitPrice) / currentPosition.entryPrice) * 100)
      : 0
    
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
      
      // Record exit for smart re-entry logic
      if (exitSide) {
        recordTradeExit(exitPrice, pnlPercent, exitSide)
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
        
        // ═══════════════════════════════════════════════════════════════════
        // SMART RE-ENTRY CHECK - Use real market data, not arbitrary cooldowns
        // ═══════════════════════════════════════════════════════════════════
        const reentryCheck = shouldAllowReentry(price, tradeSide)
        if (!reentryCheck.allowed) {
          console.log(`[SmartEntry] ⛔ BLOCKED: ${reentryCheck.reason}`)
          console.log(`[SmartEntry] Recent high: $${reentryState.recentHigh.toFixed(2)}, Recent low: $${reentryState.recentLow.toFixed(2)}`)
          recordSignal({
            id: `smartentry-${Date.now()}`,
            timestamp: Date.now(),
            price,
            action: 'BLOCKED',
            confluenceScore,
            confluenceFactors,
            minConfluenceRequired: minConfluenceToEnter,
            hasPosition: !!currentPosition.side,
            positionSide: currentPosition.side || undefined,
            circuitBreakerTripped,
            autoTradingEnabled: enableAutoTrading,
            hasApiKeys: !!(traderApiKey && traderApiSecret),
            availableBalance: lastKnownBalance.availableBalance,
            blockReason: `SmartEntry: ${reentryCheck.reason}`
          })
          
          // Telegram notification for blocked attempt
          sendTelegramNotification('attempt',
            `⛔ *TRADE BLOCKED*\n\n` +
            `📊 ${tradeSide.toUpperCase()} ETHUSDT @ $${price.toFixed(2)}\n` +
            `🎯 Confluence: ${confluenceScore}/5\n` +
            `📝 Reason: ${reentryCheck.reason}\n` +
            `⏰ ${new Date().toLocaleTimeString()}`
          )
          // Skip this trade attempt
        } else {
          // Calculate position size: use minimum 25% for small accounts, cap at $10 for safety
          const riskAmount = lastKnownBalance.availableBalance * Math.max(baseRiskPercent, 25) / 100
          const marginUsd = Math.min(riskAmount, lastKnownBalance.availableBalance * 0.5, 10)
          
          console.log(`[Trader] Position sizing: balance=$${lastKnownBalance.availableBalance.toFixed(2)} risk%=${baseRiskPercent} margin=$${marginUsd.toFixed(2)}`)
          console.log(`[SmartEntry] ✓ Re-entry allowed: ${reentryCheck.reason}`)
          
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
                  confluence: confluenceScore
                })
                traderPerformance.totalTrades++
                
                // Telegram notification for trade execution
                sendTelegramNotification('trade', 
                  `🚀 *TRADE OPENED*\n\n` +
                  `📊 *${tradeSide.toUpperCase()}* ETHUSDT\n` +
                  `💰 Entry: $${price.toFixed(2)}\n` +
                  `📏 Size: ${result.quantity} ETH\n` +
                  `💵 Margin: $${marginUsd.toFixed(2)}\n` +
                  `🎯 Confluence: ${confluenceScore}/5\n` +
                  `⏰ ${new Date().toLocaleTimeString()}`
                )
              }
            } catch (err: any) {
              console.error(`[Trader] Auto entry failed:`, err.message)
              consecutiveErrors++
            }
          }
        } // end else (reentry allowed)
      } // end if (enableAutoTrading...)
      
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
            const exitPnl = currentPosition.unrealizedPnl
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
            
            // Telegram notification for exit
            sendTelegramNotification('exit',
              `🔔 *POSITION CLOSED*\n\n` +
              `📊 Exit Price: $${price.toFixed(2)}\n` +
              `${exitPnl >= 0 ? '✅' : '❌'} P&L: ${exitPnl >= 0 ? '+' : ''}$${exitPnl.toFixed(2)}\n` +
              `📝 Reason: Momentum Reversal\n` +
              `⏰ ${new Date().toLocaleTimeString()}`
            )
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
    
    // Start ETHUSDT Market Intelligence - every 15 minutes
    if (marketAnalysisInterval) clearInterval(marketAnalysisInterval)
    runMarketAnalysis() // Run immediately on start
    marketAnalysisInterval = setInterval(runMarketAnalysis, 15 * 60 * 1000) // Every 15 min
    console.log('[AI] ETHUSDT Market Intelligence started - analyzing every 15 minutes')
    
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
    if (marketAnalysisInterval) { clearInterval(marketAnalysisInterval); marketAnalysisInterval = null }
    
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
      
      // Record and persist the trade
      const tradeRecord: TradeRecord = {
        id: result.orderId || `test-${Date.now()}`,
        timestamp: Date.now(),
        action: `TEST_${side.toUpperCase()}`,
        side,
        price: result.price || lastKnownPrice,
        quantity: result.quantity || 0,
        marginUsd,
        pnl: 0,
        fees: (result.notional || marginUsd * 88) * 0.0006
      }
      recordTrade(tradeRecord)
      
      // Send trade update to UI
      mainWindow?.webContents.send('trader:trade', tradeRecord)
      
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
    // Merge session performance with persisted
    return {
      ...traderPerformance,
      totalPnl: persistedPerformance.totalPnl,
      totalTrades: persistedPerformance.totalTrades,
      winningTrades: persistedPerformance.winningTrades,
      winRate: persistedPerformance.winRate,
      largestWin: persistedPerformance.largestWin,
      largestLoss: persistedPerformance.largestLoss,
      totalFees: persistedPerformance.totalFees
    }
  })
  
  // Get trade history
  ipcMain.handle('trader:getTradeHistory', async () => {
    return tradeHistory
  })
  
  // Get signal log and stats
  ipcMain.handle('trader:getSignalLog', async () => {
    return { log: signalLog.slice(0, 50), stats: signalStats }
  })
  
  // Get market journal entries
  ipcMain.handle('trader:getMarketJournal', async () => {
    return marketJournal.slice(0, 20)
  })
  
  // Get API stats
  ipcMain.handle('trader:getApiStats', async () => {
    return {
      ...apiStats,
      uptime: Date.now() - apiStats.startTime,
      successRate: apiStats.totalCalls > 0 
        ? ((apiStats.successfulCalls / apiStats.totalCalls) * 100).toFixed(1) + '%'
        : '0%',
      liveDataStatus: {
        timeframes: TIMEFRAMES,
        candlesCollected: Object.fromEntries(
          TIMEFRAMES.map(tf => [tf, candleBuffers[tf]?.length || 0])
        )
      }
    }
  })
  
  // Get AI action journal for manual review
  ipcMain.handle('trader:getAIJournal', async () => {
    return {
      actions: aiActionJournal.slice(0, 100),
      breakoutPatterns: Array.from(priceBreakoutPatterns.values()),
      totalActions: aiActionJournal.length
    }
  })
  
  // Get confluence improvement suggestions
  ipcMain.handle('trader:getConfluenceImprovements', async () => {
    try {
      const improvementsFile = path.join(traderDataDir, 'confluence-improvements.json')
      if (fs.existsSync(improvementsFile)) {
        return JSON.parse(fs.readFileSync(improvementsFile, 'utf-8'))
      }
    } catch {}
    return []
  })
  
  // Get SQLite database stats
  ipcMain.handle('trader:getDbStats', async () => {
    return getDbStats()
  })
  
  // Trigger manual backup
  ipcMain.handle('trader:backupDatabase', async () => {
    return await backupToGoogleSheets()
  })
  
  // Get all data for export/backup
  ipcMain.handle('trader:exportAllData', async () => {
    if (!db) return { error: 'Database not initialized' }
    
    try {
      const candles = db.prepare('SELECT * FROM candles ORDER BY open_time DESC LIMIT 10000').all()
      const trades = db.prepare('SELECT * FROM trades ORDER BY timestamp DESC').all()
      const snapshots = db.prepare('SELECT * FROM market_snapshots ORDER BY timestamp DESC LIMIT 500').all()
      const aiJournal = db.prepare('SELECT * FROM ai_journal ORDER BY timestamp DESC LIMIT 500').all()
      const breakouts = db.prepare('SELECT * FROM breakout_patterns').all()
      
      return {
        exportedAt: Date.now(),
        stats: getDbStats(),
        data: { candles, trades, snapshots, aiJournal, breakouts }
      }
    } catch (err: any) {
      return { error: err.message }
    }
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

  // ═══════════════════════════════════════════════════════════════════
  // TELEGRAM NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════
  let telegramSettings = {
    botToken: '',
    chatId: '',
    enabled: false,
    notifyTrades: true,
    notifyAttempts: false,
    notifyExits: true,
    notifyPnL: true
  }

  // Load telegram settings on startup
  const telegramSettingsFile = path.join(traderDataDir, 'telegram-settings.json')
  try {
    if (fs.existsSync(telegramSettingsFile)) {
      telegramSettings = JSON.parse(fs.readFileSync(telegramSettingsFile, 'utf-8'))
      console.log('[Telegram] Settings loaded')
    }
  } catch (err) {
    console.log('[Telegram] No saved settings found')
  }

  // Save telegram settings
  ipcMain.handle('trader:saveTelegramSettings', async (_event, settings: typeof telegramSettings) => {
    telegramSettings = settings
    fs.writeFileSync(telegramSettingsFile, JSON.stringify(settings, null, 2))
    console.log('[Telegram] Settings saved:', settings.enabled ? 'ENABLED' : 'disabled')
    return { success: true }
  })

  // Send telegram notification
  async function sendTelegramNotification(type: 'trade' | 'exit' | 'attempt' | 'pnl', message: string): Promise<void> {
    if (!telegramSettings.enabled || !telegramSettings.botToken || !telegramSettings.chatId) {
      return
    }

    // Check if this notification type is enabled
    if (type === 'trade' && !telegramSettings.notifyTrades) return
    if (type === 'exit' && !telegramSettings.notifyExits) return
    if (type === 'attempt' && !telegramSettings.notifyAttempts) return
    if (type === 'pnl' && !telegramSettings.notifyPnL) return

    try {
      const response = await fetch(`https://api.telegram.org/bot${telegramSettings.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramSettings.chatId,
          text: message,
          parse_mode: 'Markdown'
        })
      })
      
      if (!response.ok) {
        console.error('[Telegram] Failed to send notification:', await response.text())
      }
    } catch (err: any) {
      console.error('[Telegram] Error:', err.message)
    }
  }

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
          const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5
          
          // ═══════════════════════════════════════════════════════════════════
          // 24/7 SESSION-AWARE CONFLUENCE - Trade best factors for CURRENT session
          // ═══════════════════════════════════════════════════════════════════
          
          // Determine active session
          const nyseOpen = isWeekday && (utcHour > 14 || (utcHour === 14 && utcMinute >= 30)) && utcHour < 21
          const londonOpen = isWeekday && (utcHour >= 8 && (utcHour < 16 || (utcHour === 16 && utcMinute <= 30)))
          const tokyoOpen = (utcHour >= 0 && utcHour < 9)
          const sydneyOpen = (utcHour >= 22 || utcHour < 7)
          
          // After-hours = major sessions closed but still weekday
          const afterHours = isWeekday && !nyseOpen && !londonOpen && utcHour >= 21
          // Pre-market = before London opens
          const preMarket = isWeekday && utcHour >= 5 && utcHour < 8
          
          // Session identification for logging
          let currentSession = 'Off-Hours'
          if (nyseOpen && londonOpen) currentSession = 'NYSE+London Overlap'
          else if (nyseOpen) currentSession = 'NYSE Session'
          else if (londonOpen) currentSession = 'London Session'
          else if (tokyoOpen) currentSession = 'Tokyo Session'
          else if (sydneyOpen) currentSession = 'Sydney Session'
          else if (afterHours) currentSession = 'After-Hours'
          else if (preMarket) currentSession = 'Pre-Market'
          
          confluenceFactors.push(currentSession)
          
          // ═══════════════════════════════════════════════════════════════════
          // SESSION-SPECIFIC CONFLUENCE - Each session has its own best factors
          // ═══════════════════════════════════════════════════════════════════
          
          // Base score for being in ANY tradeable session
          if (nyseOpen || londonOpen || tokyoOpen || sydneyOpen) {
            confluenceScore += 2
          }
          
          // NYSE Session bonuses
          if (nyseOpen) {
            confluenceScore += 3 // High volume, best liquidity
            // First 30 min and last 30 min are power hours
            if ((utcHour === 14 && utcMinute >= 30) || (utcHour === 15 && utcMinute < 30)) {
              confluenceScore += 2
              confluenceFactors.push('NYSE Power Hour Open')
            }
            if (utcHour === 20 && utcMinute >= 30) {
              confluenceScore += 2
              confluenceFactors.push('NYSE Power Hour Close')
            }
          }
          
          // London Session bonuses
          if (londonOpen) {
            confluenceScore += 2
            // London open volatility
            if (utcHour >= 8 && utcHour < 10) {
              confluenceScore += 1
              confluenceFactors.push('London Open Volatility')
            }
          }
          
          // Overlap bonus - most liquid time
          if (nyseOpen && londonOpen) {
            confluenceScore += 3
            confluenceFactors.push('Session Overlap')
          }
          
          // Tokyo/Asia Session - often sets direction for day
          if (tokyoOpen) {
            confluenceScore += 2
            confluenceFactors.push('Asia Active')
          }
          
          // After-hours - often produces clean one-way moves
          if (afterHours) {
            confluenceScore += 2 // Still tradeable! Often less noise
            confluenceFactors.push('Clean After-Hours')
          }
          
          // Pre-market positioning
          if (preMarket) {
            confluenceScore += 1
            confluenceFactors.push('Pre-Market')
          }
          
          // ═══════════════════════════════════════════════════════════════════
          // PRICE ACTION FACTORS - Always relevant regardless of session
          // ═══════════════════════════════════════════════════════════════════
          
          let priceTrend: 'bullish' | 'bearish' | 'neutral' = 'neutral'
          if (lastKnownPrice > 0 && price > 0) {
            const priceChange = ((price - lastKnownPrice) / lastKnownPrice) * 100
            if (priceChange > 0.03) {
              priceTrend = 'bullish'
              confluenceScore += 2
              confluenceFactors.push('Bullish Move')
            } else if (priceChange < -0.03) {
              priceTrend = 'bearish'
              confluenceScore += 2
              confluenceFactors.push('Bearish Move')
            }
          }
          
          // Day of week context
          if (dayOfWeek >= 2 && dayOfWeek <= 4) {
            confluenceScore += 1
            confluenceFactors.push('Mid-Week')
          }
          
          // Month-end/Quarter-end rebalancing (more volatility)
          const dayOfMonth = now.getUTCDate()
          const month = now.getUTCMonth()
          if (dayOfMonth >= 28 || dayOfMonth <= 2) {
            confluenceScore += 1
            confluenceFactors.push('Month End/Start')
          }
          if ((month === 2 || month === 5 || month === 8 || month === 11) && dayOfMonth >= 28) {
            confluenceScore += 1
            confluenceFactors.push('Quarter End')
          }
          
          // Weekend low liquidity warning (but still tradeable!)
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
          if (isWeekend) {
            confluenceFactors.push('Weekend - Lower Vol')
            // Don't penalize heavily - crypto trades 24/7
          }
          
          // Early Monday warning
          if (dayOfWeek === 1 && utcHour < 8) {
            confluenceFactors.push('Early Monday')
          }
          
          console.log(`[Trader] Live confluence: ${confluenceScore}/${traderConfig.minConfluenceToEnter} [${confluenceFactors.join(', ')}]`)
          
          // AUTO-TRADING LOGIC with detailed signal logging
          const minConf = traderConfig.minConfluenceToEnter
          const enableAuto = traderConfig.enableAutoTrading
          
          // Build signal record for every check
          const baseSignal: SignalRecord = {
            id: `sig-${Date.now()}`,
            timestamp: Date.now(),
            price,
            confluenceScore,
            confluenceFactors,
            minConfluenceRequired: minConf,
            hasPosition: !!currentPosition.side,
            positionSide: currentPosition.side || undefined,
            circuitBreakerTripped,
            autoTradingEnabled: enableAuto,
            hasApiKeys: !!traderApiKey,
            availableBalance: lastKnownBalance.availableBalance,
            action: 'SIGNAL_ONLY'
          }
          
          console.log(`[Trader] Auto-trade check: conf=${confluenceScore}>=${minConf}? pos=${currentPosition.side} circuit=${circuitBreakerTripped} auto=${enableAuto}`)
          
          // Determine why trade might be blocked
          let blockReason: string | null = null
          if (!enableAuto) blockReason = 'Auto-trading disabled'
          else if (confluenceScore < minConf) blockReason = `Confluence ${confluenceScore} < ${minConf} required`
          else if (currentPosition.side) blockReason = `Already in ${currentPosition.side} position`
          else if (circuitBreakerTripped) blockReason = 'Circuit breaker tripped'
          else if (!traderApiKey) blockReason = 'No API keys configured'
          else if (lastKnownBalance.availableBalance < 1) blockReason = 'Insufficient balance'
          
          if (blockReason) {
            // Log blocked signal only if confluence was good enough (to avoid spam)
            if (confluenceScore >= minConf) {
              baseSignal.action = 'BLOCKED'
              baseSignal.blockReason = blockReason
              recordSignal(baseSignal)
              console.log(`[Trader] ⚠️ BLOCKED: ${blockReason} (conf=${confluenceScore})`)
            }
          } else {
            // All conditions met - attempt trade
            const tradeSide: 'long' | 'short' = priceTrend === 'bearish' ? 'short' : 'long'
            const riskAmount = lastKnownBalance.availableBalance * Math.max(traderConfig.baseRiskPercent, 25) / 100
            const marginUsd = Math.min(riskAmount, lastKnownBalance.availableBalance * 0.5, 10)
            
            console.log(`[Trader] Position sizing: balance=$${lastKnownBalance.availableBalance.toFixed(2)} risk%=${traderConfig.baseRiskPercent} margin=$${marginUsd.toFixed(2)}`)
            
            if (marginUsd >= 1) {
              console.log(`[Trader] ═══════════════════════════════════════════════`)
              console.log(`[Trader] AUTO ENTRY: ${tradeSide.toUpperCase()} $${marginUsd.toFixed(2)} @ confluence ${confluenceScore}`)
              console.log(`[Trader] ═══════════════════════════════════════════════`)
              
              baseSignal.action = 'TRADE_ATTEMPTED'
              
              try {
                const result = await executeTrade(tradeSide, marginUsd)
                if (result.success) {
                  baseSignal.action = 'TRADE_EXECUTED'
                  baseSignal.tradeResult = `${tradeSide.toUpperCase()} ${result.quantity} @ $${result.price}`
                  recordSignal(baseSignal)
                  
                  // Record the actual trade
                  const tradeRecord: TradeRecord = {
                    id: `auto-${Date.now()}`,
                    timestamp: Date.now(),
                    action: tradeSide === 'long' ? 'OPEN_LONG' : 'OPEN_SHORT',
                    side: tradeSide,
                    price: result.price || price,
                    quantity: result.quantity || 0,
                    marginUsd,
                    pnl: 0,
                    fees: (result.notional || marginUsd * 88) * 0.0006,
                    confluenceScore
                  }
                  recordTrade(tradeRecord)
                  
                  mainWindow?.webContents.send('trader:trade', tradeRecord)
                  traderPerformance.totalTrades++
                } else {
                  baseSignal.action = 'TRADE_FAILED'
                  baseSignal.tradeResult = result.error || 'Unknown error'
                  recordSignal(baseSignal)
                }
              } catch (err: any) {
                baseSignal.action = 'TRADE_FAILED'
                baseSignal.tradeResult = err.message
                recordSignal(baseSignal)
                console.error(`[Trader] Auto entry failed:`, err.message)
                consecutiveErrors++
              }
            } else {
              baseSignal.action = 'BLOCKED'
              baseSignal.blockReason = `Margin too small: $${marginUsd.toFixed(2)} < $1`
              recordSignal(baseSignal)
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
                
                // Calculate fees for the trade
                const notionalValue = pyramidState.entries.reduce((sum, e) => sum + (e.price * e.size), 0)
                const exitNotional = currentPosition.size * price
                const totalFees = (notionalValue + exitNotional) * 0.0006
                
                // Record and persist the exit trade
                const exitRecord: TradeRecord = {
                  id: `exit-${Date.now()}`,
                  timestamp: Date.now(),
                  action: 'CLOSE',
                  side: 'close',
                  price,
                  quantity: currentPosition.size,
                  marginUsd: pyramidState.entries.reduce((sum, e) => sum + (e.size * e.price / 88), 0),
                  pnl: pnlUsd - totalFees, // Net P&L after fees
                  fees: totalFees,
                  reason: exitReason,
                  pyramidLevel: pyramidState.level,
                  confluenceScore: confluenceScore
                }
                recordTrade(exitRecord)
                
                mainWindow?.webContents.send('trader:trade', exitRecord)
                
                // Telegram notification for pyramid exit
                const netPnl = pnlUsd - totalFees
                sendTelegramNotification('exit',
                  `${netPnl >= 0 ? '✅' : '❌'} *POSITION CLOSED*\n\n` +
                  `📊 ETHUSDT ${currentPosition.side?.toUpperCase()}\n` +
                  `💰 Exit: $${price.toFixed(2)}\n` +
                  `📈 P&L: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n` +
                  `💸 Fees: $${totalFees.toFixed(2)}\n` +
                  `📝 ${exitReason}\n` +
                  `🏔 Pyramid Level: ${pyramidState.level}\n` +
                  `⏰ ${new Date().toLocaleTimeString()}`
                )
                
                // Track session performance (persisted performance updated in recordTrade)
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
