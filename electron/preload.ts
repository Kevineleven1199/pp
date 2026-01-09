import { contextBridge, ipcRenderer } from 'electron'

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

type EngineKline = {
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

type EngineSwing = {
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

type EngineEventMap = {
  status: EngineStatus
  kline: EngineKline
  swing: EngineSwing
  traderStatus: any
  traderHealth: any
  traderSignal: any
  traderTrade: any
}

type LiveTraderConfig = {
  apiKey: string
  apiSecret: string
  testnet: boolean
  enableAutoTrading: boolean
  initialMarginPercent: number
  maxMarginPercent: number
}

contextBridge.exposeInMainWorld('pricePerfect', {
  engine: {
    start: () => ipcRenderer.invoke('engine:start'),
    stop: () => ipcRenderer.invoke('engine:stop'),
    getStatus: () => ipcRenderer.invoke('engine:getStatus') as Promise<EngineStatus>,
    startBackfill: (opts?: { maxMonths?: number; symbol?: string; interval?: string }) => ipcRenderer.invoke('engine:backfillStart', opts),
    stopBackfill: () => ipcRenderer.invoke('engine:backfillStop'),
    startReconcile: (opts?: { maxDays?: number; symbol?: string; interval?: string }) => ipcRenderer.invoke('engine:reconcileStart', opts),
    stopReconcile: () => ipcRenderer.invoke('engine:reconcileStop'),
    startDerivedRebuild: (opts?: { maxDays?: number; symbol?: string; interval?: string }) => ipcRenderer.invoke('engine:derivedRebuildStart', opts),
    stopDerivedRebuild: () => ipcRenderer.invoke('engine:derivedRebuildStop'),
    exportCsv: () => ipcRenderer.invoke('engine:exportCsv') as Promise<{ path: string; error?: string }>,
    getSymbols: () => ipcRenderer.invoke('engine:getSymbols') as Promise<string[]>,
    getSwings: (symbol?: string) => ipcRenderer.invoke('engine:getSwings', symbol) as Promise<{ data: any[]; total: number; symbol?: string }>,
    startLive: () => ipcRenderer.invoke('engine:liveStart'),
    stopLive: () => ipcRenderer.invoke('engine:liveStop'),
    on: <K extends keyof EngineEventMap>(event: K, callback: (payload: EngineEventMap[K]) => void) => {
      const channel = `engine:${event}`
      const listener = (_: unknown, payload: EngineEventMap[K]) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  trader: {
    start: (config: LiveTraderConfig) => ipcRenderer.invoke('trader:start', config),
    stop: () => ipcRenderer.invoke('trader:stop'),
    getStatus: () => ipcRenderer.invoke('trader:getStatus'),
    getBalance: () => ipcRenderer.invoke('trader:getBalance'),
    testTrade: (side: 'long' | 'short' | 'close', marginUsd: number) => ipcRenderer.invoke('trader:testTrade', { side, marginUsd }),
    emergencyStop: () => ipcRenderer.invoke('trader:emergencyStop'),
    resetCircuitBreaker: () => ipcRenderer.invoke('trader:resetCircuitBreaker'),
    getPerformance: () => ipcRenderer.invoke('trader:getPerformance'),
    getBacktestComparison: () => ipcRenderer.invoke('trader:getBacktestComparison'),
    getApiLimits: () => ipcRenderer.invoke('trader:getApiLimits'),
    getTradeHistory: () => ipcRenderer.invoke('trader:getTradeHistory'),
    getSignalLog: () => ipcRenderer.invoke('trader:getSignalLog'),
    getMarketJournal: () => ipcRenderer.invoke('trader:getMarketJournal'),
    hasApiKeys: () => ipcRenderer.invoke('trader:hasApiKeys') as Promise<boolean>,
    saveApiKeys: (apiKey: string, apiSecret: string) => ipcRenderer.invoke('trader:saveApiKeys', { apiKey, apiSecret }),
    saveTelegramSettings: (settings: { botToken: string; chatId: string; enabled: boolean; notifyTrades: boolean; notifyAttempts: boolean; notifyExits: boolean; notifyPnL: boolean }) => ipcRenderer.invoke('trader:saveTelegramSettings', settings),
    on: (event: string, callback: (payload: any) => void) => {
      const channel = `trader:${event}`
      const listener = (_: unknown, payload: any) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  }
})
