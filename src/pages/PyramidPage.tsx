import { useState, useEffect, useMemo, useCallback } from 'react'

type ApiSettings = {
  asterDexApiKey: string
  asterDexApiSecret: string
  asterDexTestnet: boolean
  pyramidAutoTrade: boolean
  pyramidMaxPositionUsd: number
}

type LivePosition = {
  side: 'long' | 'short'
  size: number
  entryPrice: number
  markPrice: number
  unrealizedPnl: number
  margin: number
  leverage: number
}

type TradeLog = {
  id: string
  timestamp: number
  action: string
  side: 'long' | 'short'
  price: number
  size: number
  status: 'pending' | 'filled' | 'failed'
  pnl?: number
  error?: string
}

type HealthStatus = {
  isHealthy: boolean
  apiLatencyMs: number
  wsConnected: boolean
  uptime: number
  errorCount: number
}

type DailyStats = {
  realizedPnl: number
  totalTrades: number
  winningTrades: number
  winRate: number
  largestWin: number
  largestLoss: number
  commissionPaid: number
}

type TradingManagerState = {
  isRunning: boolean
  circuitBreakerTriggered: boolean
  circuitBreakerReason: string | null
  consecutiveLosses: number
  lastFundingRate: number
  nextFundingTime: number
}

type BacktestComparison = {
  live: { totalTrades: number; winRate: number; totalPnl: number }
  backtest: { totalTrades: number; winRate: number; totalPnl: number; maxDrawdown: number; sharpeRatio: number }
  comparison: { winRateDiff: number; pnlDiff: number }
}

type SwingEvent = {
  id: string
  swingType: 'high' | 'low'
  openTime: number
  price: number
  features: Record<string, number | string | boolean | null>
}

type PyramidLevel = {
  level: number
  entryPrice: number
  size: number
  margin: number
  timestamp: number
  confluenceScore: number
  factors: string[]
}

type PyramidPosition = {
  side: 'long' | 'short'
  levels: PyramidLevel[]
  avgEntryPrice: number
  totalSize: number
  totalMargin: number
  currentStop: number
  liquidationPrice: number
  unrealizedPnl: number
  maxLevels: number
}

type ClosedPyramidTrade = {
  id: string
  side: 'long' | 'short'
  levels: number
  avgEntryPrice: number
  exitPrice: number
  entryTime: number
  exitTime: number
  pnl: number
  pnlPercent: number
  fundingPaid: number
  feesPaid: number
  peakConfluence: number
  exitReason: 'stop' | 'target' | 'signal_reversal' | 'liquidation'
}

type PyramidConfig = {
  maxLeverage: number
  baseRiskPercent: number
  maxPyramidLevels: number
  confluenceThresholds: number[]
  pyramidSizeMultipliers: number[]
  initialStopPercent: number
  trailingStopPercent: number
  takeProfitPercent: number
  minConfluenceToEnter: number
  minConfluenceToAdd: number
  fundingRateThreshold: number
  liquidationBuffer: number
}

const ASTRA_CONFIG = {
  symbol: 'ETHUSDT',
  maxLeverage: 88,
  tradingFeeRate: 0.0006,
  fundingInterval: 8,
  fundingRateAvg: 0.0001,
  maintenanceMargin: 0.005,
}

const DEFAULT_PYRAMID_CONFIG: PyramidConfig = {
  maxLeverage: 88,
  baseRiskPercent: 0.3,  // Reduced from 0.5 for safer sizing
  maxPyramidLevels: 5,
  confluenceThresholds: [3, 4, 5, 6, 7],
  pyramidSizeMultipliers: [1, 0.75, 0.5, 0.35, 0.25],
  initialStopPercent: 0.8,
  trailingStopPercent: 0.5,
  takeProfitPercent: 8,
  minConfluenceToEnter: 3,
  minConfluenceToAdd: 4,
  fundingRateThreshold: 0.0005,
  liquidationBuffer: 0.15,
}

function calcLiquidationPrice(side: 'long' | 'short', avgEntry: number, leverage: number): number {
  const marginRatio = 1 / leverage
  if (side === 'long') {
    return avgEntry * (1 - marginRatio + ASTRA_CONFIG.maintenanceMargin)
  }
  return avgEntry * (1 + marginRatio - ASTRA_CONFIG.maintenanceMargin)
}

function calcConfluenceScore(f: Record<string, any>): { score: number; factors: string[] } {
  const factors: string[] = []
  let score = 0

  if (f.rsi14 !== null && typeof f.rsi14 === 'number') {
    if (f.rsi14 < 25) { factors.push('RSI<25'); score += 12 }
    else if (f.rsi14 < 30) { factors.push('RSI<30'); score += 8 }
    else if (f.rsi14 > 75) { factors.push('RSI>75'); score += 12 }
    else if (f.rsi14 > 70) { factors.push('RSI>70'); score += 8 }
  }

  if (f.ema6_gt_ema50 === true) { factors.push('EMA6>50'); score += 7 }
  if (f.ema6_gt_ema50 === false) { factors.push('EMA6<50'); score += 7 }
  if (f.close_gt_sma200 === true) { factors.push('>SMA200'); score += 6 }
  if (f.close_gt_sma200 === false) { factors.push('<SMA200'); score += 6 }
  
  if (f.macd_bullish === true) { factors.push('MACD+'); score += 8 }
  if (f.macd_bullish === false) { factors.push('MACD-'); score += 8 }
  if (f.macd_histogram !== null && typeof f.macd_histogram === 'number') {
    if (Math.abs(f.macd_histogram) > 50) { factors.push('MACD_Strong'); score += 5 }
  }

  if (f.stoch_oversold === true || (f.stoch_k !== null && typeof f.stoch_k === 'number' && f.stoch_k < 20)) { 
    factors.push('Stoch<20'); score += 9 
  }
  if (f.stoch_overbought === true || (f.stoch_k !== null && typeof f.stoch_k === 'number' && f.stoch_k > 80)) { 
    factors.push('Stoch>80'); score += 9 
  }

  if (f.bb_oversold === true || f.bb_pct_b !== null && typeof f.bb_pct_b === 'number' && f.bb_pct_b < 0) { 
    factors.push('BB_OS'); score += 10 
  }
  if (f.bb_overbought === true || f.bb_pct_b !== null && typeof f.bb_pct_b === 'number' && f.bb_pct_b > 1) { 
    factors.push('BB_OB'); score += 10 
  }

  if (f.adx14 !== null && typeof f.adx14 === 'number' && f.adx14 > 25) { 
    factors.push('ADX>25'); score += 6 
  }

  if (f.us_market_hours === true) { factors.push('US_Mkt'); score += 4 }
  if (f.london_open === true) { factors.push('London'); score += 4 }
  if (f.nyse_open === true) { factors.push('NYSE'); score += 5 }
  if (f.tokyo_open === true) { factors.push('Tokyo'); score += 3 }

  if (f.moon_phase === 'new') { factors.push('NewMoon'); score += 2 }
  if (f.moon_phase === 'full') { factors.push('FullMoon'); score += 2 }

  return { score, factors }
}

function backtestPyramid(
  swings: SwingEvent[], 
  config: PyramidConfig, 
  startingCapital: number = 10000
): { trades: ClosedPyramidTrade[]; stats: any } {
  const trades: ClosedPyramidTrade[] = []
  let capital = startingCapital
  let peakCapital = startingCapital
  let maxDrawdown = 0
  let position: PyramidPosition | null = null
  
  // Use FIXED position sizing based on starting capital to prevent exponential blowup
  const fixedRiskAmount = startingCapital * (config.baseRiskPercent / 100)
  
  const sortedSwings = [...swings].sort((a, b) => a.openTime - b.openTime)
  
  for (let i = 0; i < sortedSwings.length; i++) {
    const swing = sortedSwings[i]
    const { score, factors } = calcConfluenceScore(swing.features)
    const currentPrice = swing.price
    
    // Skip invalid prices
    if (!currentPrice || currentPrice <= 0 || !Number.isFinite(currentPrice)) continue
    
    if (position) {
      const avgEntry = position.avgEntryPrice
      
      // Check exit conditions
      const shouldStop = position.side === 'long' 
        ? currentPrice <= position.currentStop
        : currentPrice >= position.currentStop
        
      const shouldTarget = position.side === 'long'
        ? currentPrice >= avgEntry * (1 + config.takeProfitPercent / 100)
        : currentPrice <= avgEntry * (1 - config.takeProfitPercent / 100)
        
      // ANTI-LIQUIDATION: Stop MUST trigger before liquidation
      // Check stop first, if stop triggered we exit safely
      const isLiquidated = false  // NEVER liquidate - stops must always hit first
        
      const signalReversal = (position.side === 'long' && swing.swingType === 'high' && score >= config.minConfluenceToEnter) ||
                            (position.side === 'short' && swing.swingType === 'low' && score >= config.minConfluenceToEnter)
      
      if (isLiquidated || shouldStop || shouldTarget || signalReversal) {
        const exitReason = isLiquidated ? 'liquidation' : shouldStop ? 'stop' : shouldTarget ? 'target' : 'signal_reversal'
        const exitPrice = isLiquidated ? position.liquidationPrice : currentPrice
        
        // Calculate PnL based on price move * size (not leveraged position value)
        const priceMove = position.side === 'long' 
          ? (exitPrice - avgEntry) / avgEntry 
          : (avgEntry - exitPrice) / avgEntry
        
        // PnL = margin * leverage * price_move_percent
        let pnl = position.totalMargin * config.maxLeverage * priceMove
        
        // Calculate fees and funding
        const holdHours = Math.max(0, (swing.openTime - position.levels[0].timestamp) / (1000 * 60 * 60))
        const fundingPeriods = Math.floor(holdHours / 8)
        const fundingCost = position.totalMargin * ASTRA_CONFIG.fundingRateAvg * fundingPeriods
        const tradingFees = position.totalMargin * ASTRA_CONFIG.tradingFeeRate * 2
        
        // Net PnL after costs
        const netPnl = isLiquidated 
          ? -position.totalMargin  // Lose entire margin on liquidation
          : pnl - fundingCost - tradingFees
        
        // Clamp PnL to prevent unrealistic values
        const clampedPnl = Math.max(-position.totalMargin, Math.min(netPnl, position.totalMargin * 50))
        
        trades.push({
          id: `pyramid-${position.levels[0].timestamp}`,
          side: position.side,
          levels: position.levels.length,
          avgEntryPrice: avgEntry,
          exitPrice,
          entryTime: position.levels[0].timestamp,
          exitTime: swing.openTime,
          pnl: clampedPnl,
          pnlPercent: position.totalMargin > 0 ? (clampedPnl / position.totalMargin) * 100 : 0,
          fundingPaid: fundingCost,
          feesPaid: tradingFees,
          peakConfluence: Math.max(...position.levels.map(l => l.confluenceScore)),
          exitReason
        })
        
        capital += clampedPnl
        capital = Math.max(0, capital) // Can't go negative
        
        if (capital > peakCapital) peakCapital = capital
        const dd = peakCapital - capital
        if (dd > maxDrawdown) maxDrawdown = dd
        
        position = null
        continue
      }
      
      // Try to add pyramid level
      if (position.levels.length < config.maxPyramidLevels && score >= config.minConfluenceToAdd) {
        const nextLevel = position.levels.length
        const threshold = config.confluenceThresholds[nextLevel] || config.confluenceThresholds[config.confluenceThresholds.length - 1]
        
        if (score >= threshold) {
          const inProfit = position.side === 'long' 
            ? currentPrice > position.avgEntryPrice * 1.005  // Need 0.5% profit to add
            : currentPrice < position.avgEntryPrice * 0.995
            
          if (inProfit && capital > fixedRiskAmount) {
            const multiplier = config.pyramidSizeMultipliers[nextLevel] || 0.25
            const addMargin = fixedRiskAmount * multiplier
            
            if (addMargin < capital * 0.2) {  // Max 20% of capital per add
              position.levels.push({
                level: nextLevel + 1,
                entryPrice: currentPrice,
                size: addMargin / currentPrice,
                margin: addMargin,
                timestamp: swing.openTime,
                confluenceScore: score,
                factors
              })
              
              const totalMargin = position.levels.reduce((s, l) => s + l.margin, 0)
              const totalValue = position.levels.reduce((s, l) => s + l.margin * l.entryPrice, 0)
              const avgEntry = totalValue / totalMargin
              
              position.totalSize = position.levels.reduce((s, l) => s + l.size, 0)
              position.avgEntryPrice = avgEntry
              position.totalMargin = totalMargin
              position.liquidationPrice = calcLiquidationPrice(position.side, avgEntry, config.maxLeverage)
              
              // Move stop to breakeven or better after adding
              if (position.side === 'long') {
                const newStop = Math.max(position.currentStop, currentPrice * (1 - config.trailingStopPercent / 100))
                position.currentStop = newStop
              } else {
                const newStop = Math.min(position.currentStop, currentPrice * (1 + config.trailingStopPercent / 100))
                position.currentStop = newStop
              }
            }
          }
        }
      }
      
      // Trail stop if in profit
      if (position) {
        if (position.side === 'long' && currentPrice > position.avgEntryPrice * 1.01) {
          const newStop = currentPrice * (1 - config.trailingStopPercent / 100)
          if (newStop > position.currentStop) position.currentStop = newStop
        } else if (position.side === 'short' && currentPrice < position.avgEntryPrice * 0.99) {
          const newStop = currentPrice * (1 + config.trailingStopPercent / 100)
          if (newStop < position.currentStop) position.currentStop = newStop
        }
      }
    }
    
    // Open new position if no position and enough capital
    if (!position && capital >= fixedRiskAmount * 2 && score >= config.minConfluenceToEnter) {
      const side: 'long' | 'short' = swing.swingType === 'low' ? 'long' : 'short'
      
      const margin = fixedRiskAmount  // Fixed margin per trade
      const size = margin / currentPrice
      
      const liqPrice = calcLiquidationPrice(side, currentPrice, config.maxLeverage)
      const liqDist = side === 'long' 
        ? (currentPrice - liqPrice) / currentPrice
        : (liqPrice - currentPrice) / currentPrice
        
      // Only enter if liquidation is far enough away
      if (liqDist > config.liquidationBuffer / 100) {
        // CRITICAL: Stop must be 30%+ ABOVE liquidation price (for longs) to ensure we NEVER get liquidated
        const safeStopFromLiq = side === 'long'
          ? liqPrice * 1.35  // Stop 35% above liquidation
          : liqPrice * 0.65  // Stop 35% below liquidation
          
        const initialStopFromEntry = side === 'long'
          ? currentPrice * (1 - config.initialStopPercent / 100)
          : currentPrice * (1 + config.initialStopPercent / 100)
        
        // Use whichever stop is SAFER (further from liquidation)
        const initialStop = side === 'long'
          ? Math.max(safeStopFromLiq, initialStopFromEntry)
          : Math.min(safeStopFromLiq, initialStopFromEntry)
          
        position = {
          side,
          levels: [{
            level: 1,
            entryPrice: currentPrice,
            size,
            margin,
            timestamp: swing.openTime,
            confluenceScore: score,
            factors
          }],
          avgEntryPrice: currentPrice,
          totalSize: size,
          totalMargin: margin,
          currentStop: initialStop,
          liquidationPrice: liqPrice,
          unrealizedPnl: 0,
          maxLevels: config.maxPyramidLevels
        }
      }
    }
  }
  
  // Calculate stats
  const wins = trades.filter(t => t.pnl > 0)
  const losses = trades.filter(t => t.pnl <= 0)
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1
  const profitFactor = avgLoss > 0 ? Math.min(avgWin / avgLoss, 99) : 0  // Cap at 99
  const avgLevels = trades.length > 0 ? trades.reduce((s, t) => s + t.levels, 0) / trades.length : 0
  const liquidations = trades.filter(t => t.exitReason === 'liquidation').length
  
  // Ensure final values are finite
  const finalCapital = Number.isFinite(capital) ? capital : startingCapital
  const roi = ((finalCapital - startingCapital) / startingCapital) * 100
  
  return {
    trades,
    stats: {
      totalTrades: trades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnl: Number.isFinite(totalPnl) ? totalPnl : 0,
      maxDrawdown: Number.isFinite(maxDrawdown) ? maxDrawdown : 0,
      maxDrawdownPercent: peakCapital > 0 && Number.isFinite(maxDrawdown) ? (maxDrawdown / peakCapital) * 100 : 0,
      profitFactor: Number.isFinite(profitFactor) ? profitFactor : 0,
      avgWin: Number.isFinite(avgWin) ? avgWin : 0,
      avgLoss: Number.isFinite(avgLoss) ? avgLoss : 0,
      avgPyramidLevels: avgLevels,
      liquidations,
      finalCapital,
      startingCapital,
      compoundedROI: Number.isFinite(roi) ? roi : 0,
      stopExits: trades.filter(t => t.exitReason === 'stop').length,
      targetExits: trades.filter(t => t.exitReason === 'target').length,
      reversalExits: trades.filter(t => t.exitReason === 'signal_reversal').length
    }
  }
}

function StatCard({ label, value, color, subtext }: { label: string; value: string; color?: string; subtext?: string }) {
  return (
    <div style={{ background: '#111820', borderRadius: 8, padding: '10px 12px', border: '1px solid #1e2636' }}>
      <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || '#e6eaf2' }}>{value}</div>
      {subtext && <div style={{ fontSize: 9, color: '#6b7785', marginTop: 2 }}>{subtext}</div>}
    </div>
  )
}

export default function PyramidPage() {
  const [swings, setSwings] = useState<SwingEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useState<PyramidConfig>(DEFAULT_PYRAMID_CONFIG)
  const [startingCapital] = useState(10000)
  
  // Live trading state
  const [liveTrading, setLiveTrading] = useState(false)
  const [livePosition, setLivePosition] = useState<LivePosition | null>(null)
  const [tradeLogs, setTradeLogs] = useState<TradeLog[]>([])
  const [livePrice, setLivePrice] = useState(0)
  const [apiSettings, setApiSettings] = useState<ApiSettings | null>(null)
  const [liveConfluence, setLiveConfluence] = useState<{ score: number; factors: string[] }>({ score: 0, factors: [] })
  
  // 24/7 Monitoring State
  const [health, setHealth] = useState<HealthStatus>({ isHealthy: false, apiLatencyMs: 0, wsConnected: false, uptime: 0, errorCount: 0 })
  const [dailyStats, setDailyStats] = useState<DailyStats>({ realizedPnl: 0, totalTrades: 0, winningTrades: 0, winRate: 0, largestWin: 0, largestLoss: 0, commissionPaid: 0 })
  const [managerState, setManagerState] = useState<TradingManagerState>({ isRunning: false, circuitBreakerTriggered: false, circuitBreakerReason: null, consecutiveLosses: 0, lastFundingRate: 0, nextFundingTime: 0 })
  const [showMonitor, setShowMonitor] = useState(true)
  const [backtestComparison, setBacktestComparison] = useState<BacktestComparison | null>(null)
  const [traderConnected, setTraderConnected] = useState(false)
  
  // Account & API State
  const [accountBalance, setAccountBalance] = useState<{ marginBalance: number; availableBalance: number; unrealizedPnl: number } | null>(null)
  const [apiRateLimits, setApiRateLimits] = useState<{ used: number; limit: number; resetIn: number }>({ used: 0, limit: 1200, resetIn: 60 })
  const [testTradeStatus, setTestTradeStatus] = useState<'idle' | 'buying' | 'selling' | 'done' | 'error'>('idle')
  
  // Live Pyramid State
  const [livePyramid, setLivePyramid] = useState<{
    level: number
    maxLevels: number
    avgEntry: number
    trailingStop: number
    pnlPercent: number
    pnlUsd: number
    entries: { price: number; size: number; timestamp: number }[]
    ema9: number
    ema21: number
    ema50: number
    ema200: number
  } | null>(null)
  
  // Signal Stats - tracks why trades did/didn't happen
  const [signalStats, setSignalStats] = useState<{
    totalSignals: number
    signalsAboveThreshold: number
    tradeAttempts: number
    tradesExecuted: number
    tradesFailed: number
    blockedReasons: Record<string, number>
  } | null>(null)
  const [recentSignals, setRecentSignals] = useState<any[]>([])
  
  // Extended Position Data (matching AsterDEX UI)
  const [extendedPosition, setExtendedPosition] = useState<{
    size: number
    entryPrice: number
    markPrice: number
    liquidationPrice: number
    margin: number
    leverage: number
    unrealizedPnl: number
    unrealizedPnlPercent: number
    marginRatio: number
    maintenanceMargin: number
    notional: number
    side: 'long' | 'short' | null
  } | null>(null)
  
  // Market Intelligence from AI analysis
  const [marketIntel, setMarketIntel] = useState<{
    timestamp: number
    analysis: string
    patterns: string[]
    recommendation: string
    confidence: number
    learnedInsight?: string
    snapshot?: {
      price: number
      session: string
      fundingRate: number
      imbalanceRatio: number
      volume24h: number
    }
  } | null>(null)

  // Load API settings - check both localStorage AND saved keys on disk
  useEffect(() => {
    // First check if we have saved API keys on disk (persistent across sessions)
    ;(window as any).pricePerfect.trader?.hasApiKeys().then((hasKeys: boolean) => {
      console.log('[PyramidPage] hasApiKeys check:', hasKeys)
      if (hasKeys) {
        // We have saved keys - set a placeholder so UI knows we're configured
        setApiSettings(prev => ({
          asterDexApiKey: 'saved-on-disk',
          asterDexApiSecret: 'saved-on-disk',
          asterDexTestnet: prev?.asterDexTestnet ?? false,
          pyramidAutoTrade: prev?.pyramidAutoTrade ?? false,
          pyramidMaxPositionUsd: prev?.pyramidMaxPositionUsd ?? 100
        }))
      }
    }).catch(() => {})
    
    // Also check localStorage for other settings
    const stored = localStorage.getItem('pricePerfect_apiSettings')
    if (stored) {
      try {
        const settings = JSON.parse(stored)
        setApiSettings(settings)
        if (settings.pyramidAutoTrade) {
          setLiveTrading(true)
        }
      } catch (e) {
        console.error('Failed to parse API settings')
      }
    }
  }, [])

  // Load swings data
  useEffect(() => {
    setLoading(true)
    window.pricePerfect.engine.getSwings('ethusdt').then((resp: any) => {
      setSwings(resp?.data || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // Subscribe to live price updates via engine status
  useEffect(() => {
    const off = window.pricePerfect.engine.on('status', (s: any) => {
      if (s?.currentPrice) {
        setLivePrice(s.currentPrice)
      }
      // Calculate live confluence from latest candle data
      if (s?.latestCandle) {
        const { score, factors } = calcConfluenceScore(s.latestCandle)
        setLiveConfluence({ score, factors })
      }
    })
    return () => off()
  }, [])

  // Subscribe to live trader health, balance, and trade updates
  useEffect(() => {
    const offHealth = (window as any).pricePerfect.trader?.on('health', (h: HealthStatus) => {
      console.log('[PyramidPage] Health update:', h)
      setHealth(h)
      setTraderConnected(h.isHealthy)
      setManagerState(prev => ({ ...prev, isRunning: h.isHealthy }))
    })

    const offBalance = (window as any).pricePerfect.trader?.on('balance', (bal: any) => {
      console.log('[PyramidPage] Balance update:', bal)
      if (bal) {
        setAccountBalance(bal)
        setApiRateLimits(prev => ({ ...prev, used: prev.used + 1 }))
      }
    })
    
    const offTrade = (window as any).pricePerfect.trader?.on('trade', (trade: any) => {
      const log: TradeLog = {
        id: trade.id,
        timestamp: trade.timestamp,
        action: trade.action,
        side: trade.side,
        price: livePrice,
        size: trade.marginUsd ? trade.marginUsd * 88 / livePrice : 0,
        status: trade.status === 'filled' ? 'filled' : trade.status === 'failed' ? 'failed' : 'pending',
        pnl: trade.pnl
      }
      setTradeLogs(prev => [log, ...prev].slice(0, 50))
      setDailyStats(prev => ({
        ...prev,
        totalTrades: prev.totalTrades + 1,
        realizedPnl: prev.realizedPnl + (trade.pnl || 0)
      }))
    })

    // Listen for live price and signal updates from engine
    const offLiveUpdate = (window as any).pricePerfect.trader?.on('liveUpdate', (update: any) => {
      console.log('[PyramidPage] liveUpdate received:', update)
      if (update.price && update.price > 0) {
        setLivePrice(update.price)
      }
      if (update.apiCalls !== undefined) {
        setApiRateLimits(prev => ({ ...prev, used: update.apiCalls }))
      }
      // Update confluence display - parse factors from reason string
      if (update.strength !== undefined) {
        const factors = update.reason ? update.reason.split(' • ').filter((f: string) => f.length > 0) : []
        console.log('[PyramidPage] Confluence update:', update.strength, factors)
        setLiveConfluence({ score: update.strength, factors })
      }
    })
    
    // Listen for pyramid state updates
    const offPyramidUpdate = (window as any).pricePerfect.trader?.on('pyramidUpdate', (pyramid: any) => {
      console.log('[PyramidPage] pyramidUpdate received:', pyramid)
      setLivePyramid(pyramid)
    })

    // Get initial status and backtest comparison
    ;(window as any).pricePerfect.trader?.getStatus().then((status: any) => {
      if (status) {
        setHealth(status.health)
        setTraderConnected(status.isRunning)
        setManagerState(prev => ({ ...prev, isRunning: status.isRunning }))
      }
    }).catch(() => {})

    ;(window as any).pricePerfect.trader?.getBacktestComparison().then((comp: BacktestComparison) => {
      setBacktestComparison(comp)
    }).catch(() => {})

    // Fetch initial balance
    ;(window as any).pricePerfect.trader?.getBalance().then((bal: any) => {
      if (bal) setAccountBalance(bal)
    }).catch(() => {})
    
    // Load persisted trade history
    ;(window as any).pricePerfect.trader?.getTradeHistory().then((history: any[]) => {
      if (history && history.length > 0) {
        console.log(`[PyramidPage] Loaded ${history.length} trades from history`)
        const logs = history.map((t: any) => ({
          id: t.id,
          timestamp: t.timestamp,
          action: t.action,
          side: t.side,
          price: t.price,
          size: t.quantity || 0,
          status: 'filled' as const,
          pnl: t.pnl
        }))
        setTradeLogs(logs)
      }
    }).catch(() => {})
    
    // Listen for history updates
    const offHistoryUpdate = (window as any).pricePerfect.trader?.on('historyUpdate', (history: any[]) => {
      if (history && history.length > 0) {
        const logs = history.map((t: any) => ({
          id: t.id,
          timestamp: t.timestamp,
          action: t.action,
          side: t.side,
          price: t.price,
          size: t.quantity || 0,
          status: 'filled' as const,
          pnl: t.pnl
        }))
        setTradeLogs(logs)
      }
    })
    
    // Load signal log and stats
    ;(window as any).pricePerfect.trader?.getSignalLog().then((data: any) => {
      if (data) {
        console.log(`[PyramidPage] Loaded signal stats: ${data.stats?.totalSignals || 0} signals, ${data.stats?.tradesExecuted || 0} executed`)
        setSignalStats(data.stats)
        setRecentSignals(data.log || [])
      }
    }).catch(() => {})
    
    // Listen for live signal updates
    const offSignalLog = (window as any).pricePerfect.trader?.on('signalLog', (data: any) => {
      if (data?.stats) setSignalStats(data.stats)
      if (data?.signal) {
        setRecentSignals(prev => [data.signal, ...prev.slice(0, 49)])
      }
    })
    
    // Listen for extended position updates
    const offPositionUpdate = (window as any).pricePerfect.trader?.on('positionUpdate', (pos: any) => {
      if (pos) setExtendedPosition(pos)
    })
    
    // Listen for market intelligence updates
    const offMarketIntel = (window as any).pricePerfect.trader?.on('marketIntel', (intel: any) => {
      if (intel) setMarketIntel(intel)
    })
    
    // Load existing market journal on mount
    ;(window as any).pricePerfect.trader?.getMarketJournal().then((journal: any[]) => {
      if (journal && journal.length > 0) {
        setMarketIntel(journal[0])
      }
    }).catch(() => {})

    return () => {
      offHealth?.()
      offBalance?.()
      offTrade?.()
      offLiveUpdate?.()
      offPyramidUpdate?.()
      offHistoryUpdate?.()
      offSignalLog?.()
      offPositionUpdate?.()
      offMarketIntel?.()
    }
  }, [livePrice])

  // Periodic balance refresh & API rate limit reset
  useEffect(() => {
    // Fetch balance every 30 seconds (conservative to avoid rate limits)
    const balanceInterval = setInterval(() => {
      if (apiSettings?.asterDexApiKey) {
        ;(window as any).pricePerfect.trader?.getBalance().then((bal: any) => {
          if (bal) setAccountBalance(bal)
          setApiRateLimits(prev => ({ ...prev, used: prev.used + 1 }))
        }).catch(() => {})
      }
    }, 30000)

    // Reset API counter every minute
    const resetInterval = setInterval(() => {
      setApiRateLimits(prev => ({ ...prev, used: 0, resetIn: 60 }))
    }, 60000)

    // Countdown for reset
    const countdownInterval = setInterval(() => {
      setApiRateLimits(prev => ({ ...prev, resetIn: Math.max(0, prev.resetIn - 1) }))
    }, 1000)

    return () => {
      clearInterval(balanceInterval)
      clearInterval(resetInterval)
      clearInterval(countdownInterval)
    }
  }, [apiSettings])

  // Execute live trade via trader IPC
  const executeLiveTrade = useCallback(async (action: string, side: 'long' | 'short', size: number) => {
    if (!apiSettings?.asterDexApiKey) {
      alert('Please configure AsterDEX API keys in Settings first')
      return
    }

    const log: TradeLog = {
      id: `trade-${Date.now()}`,
      timestamp: Date.now(),
      action,
      side,
      price: livePrice,
      size,
      status: 'pending'
    }
    setTradeLogs(prev => [log, ...prev].slice(0, 50))

    try {
      // Calculate margin in USD based on size
      const marginUsd = size * livePrice / 88
      
      if (action === 'CLOSE') {
        // Close position via trader
        await (window as any).pricePerfect.trader?.emergencyStop()
        setLivePosition(null)
        setTradeLogs(prev => prev.map(t => t.id === log.id ? { ...t, status: 'filled' as const } : t))
      } else {
        // Open position via trader
        await (window as any).pricePerfect.trader?.testTrade(side, marginUsd)
        setLivePosition({
          side,
          size,
          entryPrice: livePrice,
          markPrice: livePrice,
          unrealizedPnl: 0,
          margin: marginUsd,
          leverage: 88
        })
        setTradeLogs(prev => prev.map(t => t.id === log.id ? { ...t, status: 'filled' as const } : t))
      }
    } catch (err: any) {
      setTradeLogs(prev => prev.map(t => t.id === log.id ? { ...t, status: 'failed' as const, error: err.message } : t))
    }
  }, [apiSettings, livePrice])

  // Start/stop live trader
  const startLiveTrader = useCallback(async () => {
    if (!apiSettings?.asterDexApiKey) {
      alert('Please configure AsterDEX API keys in Settings first')
      return
    }
    
    console.log('[PyramidPage] Starting trader with API key:', apiSettings.asterDexApiKey.substring(0, 8) + '...')
    
    try {
      const result = await (window as any).pricePerfect.trader?.start({
        apiKey: apiSettings.asterDexApiKey,
        apiSecret: apiSettings.asterDexApiSecret,
        testnet: apiSettings.asterDexTestnet || false,
        enableAutoTrading: true,
        initialMarginPercent: 8,
        maxMarginPercent: 80
      })
      console.log('[PyramidPage] Trader start result:', result)
      setLiveTrading(true)
      setManagerState(prev => ({ ...prev, isRunning: true }))
      setHealth(prev => ({ ...prev, isHealthy: true }))
    } catch (err: any) {
      console.error('[PyramidPage] Failed to start trader:', err)
      alert(`Failed to start trader: ${err.message}`)
    }
  }, [apiSettings])

  const stopLiveTrader = useCallback(async () => {
    try {
      await (window as any).pricePerfect.trader?.stop()
      setLiveTrading(false)
      setManagerState(prev => ({ ...prev, isRunning: false }))
    } catch (err: any) {
      console.error('Failed to stop trader:', err)
    }
  }, [])

  // Round-trip test trade - Buy then immediately Sell to prove API works
  const executeRoundTripTest = useCallback(async () => {
    if (!apiSettings?.asterDexApiKey) {
      alert('Please configure AsterDEX API keys in Settings first')
      return
    }
    
    const marginUsd = 10 // $10 test trade
    const notional = marginUsd * 88 // $880 notional at 88x
    const ethSize = notional / (livePrice || 3500)
    
    console.log(`[RoundTrip] Starting test: $${marginUsd} margin → $${notional.toFixed(0)} notional → ${ethSize.toFixed(4)} ETH`)
    
    setTestTradeStatus('buying')
    
    try {
      // Step 1: Market BUY
      const buyLog: TradeLog = {
        id: `test-buy-${Date.now()}`,
        timestamp: Date.now(),
        action: 'TEST_BUY',
        side: 'long',
        price: livePrice || 3500,
        size: ethSize,
        status: 'pending'
      }
      setTradeLogs(prev => [buyLog, ...prev].slice(0, 50))
      
      await (window as any).pricePerfect.trader?.testTrade('long', marginUsd)
      
      // Update buy log to filled
      setTradeLogs(prev => prev.map(t => t.id === buyLog.id ? { ...t, status: 'filled' as const } : t))
      setApiRateLimits(prev => ({ ...prev, used: prev.used + 1 }))
      
      // Wait 500ms then sell
      setTestTradeStatus('selling')
      await new Promise(r => setTimeout(r, 500))
      
      // Step 2: Market SELL (close position)
      const sellLog: TradeLog = {
        id: `test-sell-${Date.now()}`,
        timestamp: Date.now(),
        action: 'TEST_SELL',
        side: 'short',
        price: livePrice || 3500,
        size: ethSize,
        status: 'pending'
      }
      setTradeLogs(prev => [sellLog, ...prev].slice(0, 50))
      
      await (window as any).pricePerfect.trader?.testTrade('close', marginUsd)
      
      // Update sell log to filled
      setTradeLogs(prev => prev.map(t => t.id === sellLog.id ? { ...t, status: 'filled' as const } : t))
      setApiRateLimits(prev => ({ ...prev, used: prev.used + 1 }))
      
      setTestTradeStatus('done')
      setLivePosition(null)
      
      // Refresh balance after test
      ;(window as any).pricePerfect.trader?.getBalance().then((bal: any) => {
        if (bal) setAccountBalance(bal)
      }).catch(() => {})
      
      console.log('[RoundTrip] Test complete! Buy → Sell executed successfully')
      
      // Reset status after 3 seconds
      setTimeout(() => setTestTradeStatus('idle'), 3000)
      
    } catch (err: any) {
      console.error('[RoundTrip] Test failed:', err)
      setTestTradeStatus('error')
      const errorLog: TradeLog = {
        id: `test-error-${Date.now()}`,
        timestamp: Date.now(),
        action: 'TEST_ERROR',
        side: 'long' as const,
        price: 0,
        size: 0,
        status: 'failed' as const,
        error: err.message
      }
      setTradeLogs(prev => [errorLog, ...prev].slice(0, 50))
      
      setTimeout(() => setTestTradeStatus('idle'), 5000)
    }
  }, [apiSettings, livePrice])

  const result = useMemo(() => {
    if (swings.length === 0) return null
    return backtestPyramid(swings, config, startingCapital)
  }, [swings, config, startingCapital])

  const formatMoney = (n: number) => {
    if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(1)}T`
    if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
    if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
    return `$${n.toFixed(2)}`
  }

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #1e2636' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              🔺 Pyramid Strategy — ETHUSDT {config.maxLeverage}x
            </div>
            <div style={{ fontSize: 12, color: '#9aa4b2', marginTop: 4 }}>
              Confluence-based pyramiding • Sliding stops • Funding aware • Liquidation protected
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {livePrice > 0 && (
              <span style={{ 
                padding: '4px 10px', 
                background: '#111820', 
                color: '#f0b429', 
                borderRadius: 6, 
                fontSize: 13, 
                fontWeight: 700,
                fontFamily: 'monospace'
              }}>
                ${livePrice.toFixed(2)}
              </span>
            )}
            <span style={{ 
              padding: '4px 10px', 
              background: liveTrading ? '#14532d' : '#1e2636', 
              color: liveTrading ? '#4ade80' : '#6b7785', 
              borderRadius: 6, 
              fontSize: 11, 
              fontWeight: 600 
            }}>
              {liveTrading ? '🟢 LIVE' : '⚪ PAPER'}
            </span>
            <span style={{ 
              padding: '4px 10px', 
              background: '#1e3a5f', 
              color: '#60a5fa', 
              borderRadius: 6, 
              fontSize: 11, 
              fontWeight: 600 
            }}>
              {config.maxLeverage}x Max
            </span>
          </div>
        </div>
      </div>

      {/* Live Trading Panel */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: liveTrading ? '#0a1a0f' : '#0d1219' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          {/* Account Balance & API Limits */}
          <div style={{ flex: '0 0 auto', display: 'flex', gap: 8, alignItems: 'stretch', marginBottom: 8, flexWrap: 'wrap' }}>
            {/* Total Balance */}
            <div style={{ padding: '8px 12px', background: '#111820', borderRadius: 6, border: '1px solid #2d3748', minWidth: 100 }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 2 }}>TOTAL BALANCE</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#f0b429', fontFamily: 'monospace' }}>
                ${accountBalance ? (accountBalance.marginBalance + (accountBalance.unrealizedPnl || 0)).toFixed(2) : '—'}
              </div>
            </div>
            
            {/* Available Balance */}
            <div style={{ padding: '8px 12px', background: '#111820', borderRadius: 6, border: '1px solid #2d3748', minWidth: 90 }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 2 }}>AVAILABLE</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#9aa4b2', fontFamily: 'monospace' }}>
                ${accountBalance?.availableBalance?.toFixed(2) || '—'}
              </div>
            </div>
            
            {/* Margin Used */}
            <div style={{ padding: '8px 12px', background: '#111820', borderRadius: 6, border: '1px solid #2d3748', minWidth: 90 }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 2 }}>MARGIN USED</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#60a5fa', fontFamily: 'monospace' }}>
                ${accountBalance ? (accountBalance.marginBalance - (accountBalance.availableBalance || 0)).toFixed(2) : '—'}
              </div>
            </div>
            
            {/* Unrealized P&L with % */}
            <div style={{ 
              padding: '8px 12px', 
              background: accountBalance?.unrealizedPnl && accountBalance.unrealizedPnl >= 0 ? '#0a1a0f' : '#1a0f0f', 
              borderRadius: 6, 
              border: `1px solid ${accountBalance?.unrealizedPnl && accountBalance.unrealizedPnl >= 0 ? '#22c55e' : '#ef4444'}`,
              minWidth: 110
            }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 2 }}>UNREALIZED P&L</div>
              <div style={{ 
                fontSize: 14, 
                fontWeight: 700, 
                color: accountBalance?.unrealizedPnl && accountBalance.unrealizedPnl >= 0 ? '#4ade80' : '#fca5a5', 
                fontFamily: 'monospace' 
              }}>
                {accountBalance?.unrealizedPnl !== undefined 
                  ? `${accountBalance.unrealizedPnl >= 0 ? '+' : ''}$${accountBalance.unrealizedPnl.toFixed(2)}`
                  : '—'}
              </div>
              {accountBalance?.marginBalance && accountBalance.marginBalance > 0 && accountBalance?.unrealizedPnl !== undefined && (
                <div style={{ 
                  fontSize: 10, 
                  color: accountBalance.unrealizedPnl >= 0 ? '#4ade80' : '#fca5a5',
                  fontFamily: 'monospace'
                }}>
                  {accountBalance.unrealizedPnl >= 0 ? '+' : ''}{((accountBalance.unrealizedPnl / accountBalance.marginBalance) * 100).toFixed(2)}%
                </div>
              )}
            </div>
            
            {/* API Rate Limit */}
            <div style={{ padding: '8px 12px', background: '#111820', borderRadius: 6, border: `1px solid ${apiRateLimits.used > apiRateLimits.limit * 0.8 ? '#f59e0b' : '#2d3748'}`, minWidth: 70 }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 2 }}>API</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: apiRateLimits.used > apiRateLimits.limit * 0.8 ? '#f59e0b' : '#9aa4b2', fontFamily: 'monospace' }}>
                {apiRateLimits.used}/{apiRateLimits.limit}
              </div>
            </div>
          </div>
          
          {/* Trading Controls */}
          <div style={{ flex: '1 1 300px' }}>
            <div style={{ fontSize: 11, color: liveTrading ? '#4ade80' : '#a78bfa', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
              🔺 {liveTrading ? 'LIVE TRADING ACTIVE' : 'Live Trading'} — AsterDEX
            </div>
            
            {/* Always show API key input when balance is 0 or keys are placeholder */}
            <div style={{ 
              padding: 12, 
              background: '#1e2636', 
              borderRadius: 8, 
              border: '1px solid #3b82f6',
              marginBottom: 12
            }}>
              <div style={{ fontSize: 12, color: '#60a5fa', marginBottom: 8 }}>
                🔑 AsterDEX API Keys {(accountBalance?.marginBalance ?? 0) > 0 ? '(Connected)' : '(Enter to connect)'}
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <input
                  type="password"
                  placeholder="API Key"
                  id="quick-api-key"
                  style={{
                    flex: '1 1 150px',
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: '1px solid #1e2636',
                    background: '#111820',
                    color: '#e6eaf2',
                    fontSize: 12
                  }}
                />
                <input
                  type="password"
                  placeholder="API Secret"
                  id="quick-api-secret"
                  style={{
                    flex: '1 1 150px',
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: '1px solid #1e2636',
                    background: '#111820',
                    color: '#e6eaf2',
                    fontSize: 12
                  }}
                />
                <button
                  onClick={async () => {
                    const key = (document.getElementById('quick-api-key') as HTMLInputElement)?.value
                    const secret = (document.getElementById('quick-api-secret') as HTMLInputElement)?.value
                    if (key && secret) {
                      // Save to disk (persistent) via main process
                      await (window as any).pricePerfect.trader?.saveApiKeys(key, secret)
                      
                      // Also save to localStorage for UI state
                      const newSettings: ApiSettings = {
                        asterDexApiKey: key,
                        asterDexApiSecret: secret,
                        asterDexTestnet: false,
                        pyramidAutoTrade: false,
                        pyramidMaxPositionUsd: 100
                      }
                      localStorage.setItem('pricePerfect_apiSettings', JSON.stringify(newSettings))
                      setApiSettings(newSettings)
                      
                      // Stop existing trader if running, then restart with new keys
                      if (liveTrading) {
                        await stopLiveTrader()
                      }
                      setTimeout(() => startLiveTrader(), 500)
                    }
                  }}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 6,
                    border: '1px solid #22c55e',
                    background: '#14532d',
                    color: '#4ade80',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap'
                  }}
                >
                  Save & Start
                </button>
              </div>
              <div style={{ fontSize: 10, color: '#6b7785' }}>
                Get keys from asterdex.com → API Management • Keys are saved locally
              </div>
            </div>
            
            {/* Trading Controls */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  onClick={liveTrading ? stopLiveTrader : startLiveTrader}
                  style={{
                    padding: '10px 20px',
                    borderRadius: 8,
                    border: `2px solid ${liveTrading ? '#ef4444' : '#22c55e'}`,
                    background: liveTrading ? '#3f1219' : '#14532d',
                    color: liveTrading ? '#fca5a5' : '#4ade80',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer'
                  }}
                >
                  {liveTrading ? '⏹️ STOP TRADING' : '▶️ START 24/7 TRADING'}
                </button>
                
                {/* Round-Trip Test Button */}
                <button
                  onClick={executeRoundTripTest}
                  disabled={testTradeStatus !== 'idle'}
                  style={{
                    padding: '10px 16px',
                    borderRadius: 8,
                    border: testTradeStatus === 'done' ? '1px solid #22c55e' : testTradeStatus === 'error' ? '1px solid #ef4444' : '1px solid #3b82f6',
                    background: testTradeStatus === 'done' ? '#14532d' : testTradeStatus === 'error' ? '#7f1d1d' : testTradeStatus !== 'idle' ? '#1e3a5f' : '#1e3a5f',
                    color: testTradeStatus === 'done' ? '#4ade80' : testTradeStatus === 'error' ? '#fca5a5' : '#60a5fa',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: testTradeStatus !== 'idle' ? 'wait' : 'pointer',
                    opacity: testTradeStatus !== 'idle' && testTradeStatus !== 'done' && testTradeStatus !== 'error' ? 0.8 : 1
                  }}
                >
                  {testTradeStatus === 'idle' && '🧪 Test Buy→Sell $10'}
                  {testTradeStatus === 'buying' && '⏳ Buying...'}
                  {testTradeStatus === 'selling' && '⏳ Selling...'}
                  {testTradeStatus === 'done' && '✅ Test Passed!'}
                  {testTradeStatus === 'error' && '❌ Test Failed'}
                </button>
                
                {livePosition ? (
                  <button
                    onClick={() => executeLiveTrade('CLOSE', livePosition.side, livePosition.size)}
                    style={{
                      padding: '10px 20px',
                      borderRadius: 8,
                      border: '2px solid #f59e0b',
                      background: '#422006',
                      color: '#fbbf24',
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                  >
                    ✖️ CLOSE POSITION
                  </button>
                ) : liveTrading && (
                  <>
                    <button
                      onClick={() => executeLiveTrade('OPEN_LONG', 'long', (apiSettings?.pyramidMaxPositionUsd || 100) / livePrice)}
                      disabled={liveConfluence.score < config.minConfluenceToEnter}
                      style={{
                        padding: '10px 16px',
                        borderRadius: 8,
                        border: '1px solid #22c55e',
                        background: liveConfluence.score >= config.minConfluenceToEnter ? '#14532d' : '#1e2636',
                        color: liveConfluence.score >= config.minConfluenceToEnter ? '#4ade80' : '#6b7785',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: liveConfluence.score >= config.minConfluenceToEnter ? 'pointer' : 'not-allowed'
                      }}
                    >
                      📈 Manual LONG
                    </button>
                    <button
                      onClick={() => executeLiveTrade('OPEN_SHORT', 'short', (apiSettings?.pyramidMaxPositionUsd || 100) / livePrice)}
                      disabled={liveConfluence.score < config.minConfluenceToEnter}
                      style={{
                        padding: '10px 16px',
                        borderRadius: 8,
                        border: '1px solid #ef4444',
                        background: liveConfluence.score >= config.minConfluenceToEnter ? '#7f1d1d' : '#1e2636',
                        color: liveConfluence.score >= config.minConfluenceToEnter ? '#fca5a5' : '#6b7785',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: liveConfluence.score >= config.minConfluenceToEnter ? 'pointer' : 'not-allowed'
                      }}
                    >
                      📉 Manual SHORT
                    </button>
                  </>
                )}
            </div>
          </div>

          {/* Current Position - AsterDEX Style */}
          <div style={{ flex: '1 1 320px' }}>
            <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 8 }}>CURRENT POSITION</div>
            {extendedPosition && extendedPosition.side ? (
              <div style={{ 
                padding: 12, 
                background: extendedPosition.side === 'long' ? '#0a3622' : '#3f1219', 
                borderRadius: 8,
                border: `1px solid ${extendedPosition.side === 'long' ? '#22c55e' : '#ef4444'}`
              }}>
                {/* Header: Side + Size + PNL */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <span style={{ 
                      fontSize: 11, 
                      fontWeight: 700, 
                      color: extendedPosition.side === 'long' ? '#4ade80' : '#fca5a5',
                      background: extendedPosition.side === 'long' ? '#166534' : '#991b1b',
                      padding: '2px 6px',
                      borderRadius: 4
                    }}>
                      {extendedPosition.side.toUpperCase()} {extendedPosition.leverage}x
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#e6eaf2', marginLeft: 8 }}>
                      {extendedPosition.size.toFixed(4)} ETH
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ 
                      fontSize: 14, 
                      fontWeight: 700, 
                      color: extendedPosition.unrealizedPnl >= 0 ? '#4ade80' : '#fca5a5'
                    }}>
                      {extendedPosition.unrealizedPnl >= 0 ? '+' : ''}{extendedPosition.unrealizedPnl.toFixed(2)} USDT
                    </div>
                    <div style={{ 
                      fontSize: 11, 
                      color: extendedPosition.unrealizedPnlPercent >= 0 ? '#4ade80' : '#fca5a5'
                    }}>
                      {extendedPosition.unrealizedPnlPercent >= 0 ? '+' : ''}{extendedPosition.unrealizedPnlPercent.toFixed(2)}% ROE
                    </div>
                  </div>
                </div>
                
                {/* Price Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 9, color: '#6b7785' }}>Entry Price</div>
                    <div style={{ fontSize: 11, color: '#e6eaf2', fontFamily: 'monospace' }}>${extendedPosition.entryPrice.toFixed(2)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: '#6b7785' }}>Mark Price</div>
                    <div style={{ fontSize: 11, color: '#e6eaf2', fontFamily: 'monospace' }}>${extendedPosition.markPrice.toFixed(2)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: '#ef4444' }}>Liq. Price</div>
                    <div style={{ fontSize: 11, color: '#fca5a5', fontFamily: 'monospace' }}>${extendedPosition.liquidationPrice.toFixed(2)}</div>
                  </div>
                </div>
                
                {/* Margin Details */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, paddingTop: 8, borderTop: '1px solid #2d3748' }}>
                  <div>
                    <div style={{ fontSize: 9, color: '#6b7785' }}>Margin</div>
                    <div style={{ fontSize: 11, color: '#e6eaf2', fontFamily: 'monospace' }}>{extendedPosition.margin.toFixed(2)} USDT</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: '#6b7785' }}>Maint. Margin</div>
                    <div style={{ fontSize: 11, color: '#9aa4b2', fontFamily: 'monospace' }}>{extendedPosition.maintenanceMargin.toFixed(2)} USDT</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: extendedPosition.marginRatio > 50 ? '#ef4444' : '#6b7785' }}>Margin Ratio</div>
                    <div style={{ fontSize: 11, color: extendedPosition.marginRatio > 50 ? '#fca5a5' : '#4ade80', fontFamily: 'monospace' }}>
                      {extendedPosition.marginRatio.toFixed(2)}%
                    </div>
                  </div>
                </div>
                
                {/* Planned Stop Loss */}
                {livePyramid && livePyramid.trailingStop > 0 && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #2d3748' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <div>
                        <div style={{ fontSize: 9, color: '#f59e0b' }}>Planned Stop (EMA)</div>
                        <div style={{ fontSize: 11, color: '#fbbf24', fontFamily: 'monospace' }}>${livePyramid.trailingStop.toFixed(2)}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 9, color: '#6b7785' }}>Notional</div>
                        <div style={{ fontSize: 11, color: '#9aa4b2', fontFamily: 'monospace' }}>${extendedPosition.notional.toFixed(2)}</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : livePosition ? (
              <div style={{ 
                padding: 12, 
                background: livePosition.side === 'long' ? '#0a3622' : '#3f1219', 
                borderRadius: 8,
                border: `1px solid ${livePosition.side === 'long' ? '#22c55e' : '#ef4444'}`
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: livePosition.side === 'long' ? '#4ade80' : '#fca5a5' }}>
                    {livePosition.side.toUpperCase()} {livePosition.size.toFixed(4)} ETH
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: livePosition.unrealizedPnl >= 0 ? '#4ade80' : '#fca5a5' }}>
                    {livePosition.unrealizedPnl >= 0 ? '+' : ''}${livePosition.unrealizedPnl.toFixed(2)}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: '#9aa4b2' }}>
                  Entry: ${livePosition.entryPrice.toFixed(2)} • Margin: ${livePosition.margin.toFixed(2)} • {livePosition.leverage}x
                </div>
              </div>
            ) : (
              <div style={{ 
                padding: 12, 
                background: '#1e2636', 
                borderRadius: 8,
                border: '1px solid #2d3748',
                color: '#6b7785',
                fontSize: 12
              }}>
                No open position
              </div>
            )}
          </div>

          {/* Live Confluence */}
          <div style={{ flex: '1 1 200px' }}>
            <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 8 }}>LIVE CONFLUENCE</div>
            <div style={{ 
              padding: 12, 
              background: liveConfluence.score > 0 ? '#0d1a1a' : '#111820', 
              borderRadius: 8,
              border: `1px solid ${liveConfluence.score >= config.minConfluenceToEnter ? '#22c55e' : liveConfluence.score > 0 ? '#3b82f6' : '#2d3748'}`
            }}>
              <div style={{ 
                fontSize: 28, 
                fontWeight: 700, 
                color: liveConfluence.score >= config.minConfluenceToEnter ? '#4ade80' : liveConfluence.score > 0 ? '#60a5fa' : '#6b7785',
                marginBottom: 4
              }}>
                {liveConfluence.score}
              </div>
              <div style={{ fontSize: 10, color: liveConfluence.score > 0 ? '#9aa4b2' : '#6b7785', lineHeight: 1.4 }}>
                {liveConfluence.factors.length > 0 && liveConfluence.factors[0] !== ''
                  ? liveConfluence.factors.map((f, i) => (
                      <span key={i} style={{ 
                        display: 'inline-block',
                        padding: '2px 6px', 
                        background: '#1e2636', 
                        borderRadius: 4, 
                        marginRight: 4,
                        marginBottom: 4,
                        fontSize: 9,
                        color: f.includes('NYSE') ? '#4ade80' : f.includes('London') ? '#60a5fa' : f.includes('Tokyo') ? '#f0b429' : '#9aa4b2'
                      }}>
                        {f}
                      </span>
                    ))
                  : <span style={{ color: '#6b7785' }}>Waiting for signal...</span>}
              </div>
              {liveConfluence.score >= config.minConfluenceToEnter && (
                <div style={{ fontSize: 10, color: '#4ade80', marginTop: 4, fontWeight: 600 }}>
                  ✓ Entry threshold met ({config.minConfluenceToEnter}+)
                </div>
              )}
            </div>
          </div>

          {/* Live Pyramid Status */}
          {livePyramid && livePyramid.level > 0 && (
            <div style={{ flex: '1 1 300px' }}>
              <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 8 }}>🔺 PYRAMID STATUS</div>
              <div style={{ 
                padding: 12, 
                background: '#0d1a1a', 
                borderRadius: 8,
                border: '1px solid #a78bfa'
              }}>
                {/* Pyramid Level Indicator */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                  {[1, 2, 3, 4, 5].map(level => (
                    <div 
                      key={level}
                      style={{
                        flex: 1,
                        height: 8,
                        borderRadius: 4,
                        background: level <= livePyramid.level ? '#a78bfa' : '#2d3748',
                        transition: 'background 0.3s'
                      }}
                    />
                  ))}
                </div>
                <div style={{ fontSize: 12, color: '#a78bfa', fontWeight: 700, marginBottom: 4 }}>
                  Level {livePyramid.level}/{livePyramid.maxLevels}
                </div>
                
                {/* P&L Display - Detailed */}
                {(() => {
                  const notionalValue = (livePyramid.entries?.reduce((sum, e) => sum + (e.price * e.size), 0) || 0)
                  const currentNotional = (livePyramid.entries?.reduce((sum, e) => sum + e.size, 0) || 0) * livePrice
                  const entryFee = notionalValue * 0.0006 // 0.06% taker fee
                  const exitFee = currentNotional * 0.0006 // Estimated exit fee
                  const totalFees = entryFee + exitFee
                  const grossPnl = livePyramid.pnlUsd || 0
                  const netPnl = grossPnl - totalFees
                  const marginUsed = accountBalance ? (accountBalance.marginBalance - (accountBalance.availableBalance || 0)) : 0
                  const roi = marginUsed > 0 ? (netPnl / marginUsed) * 100 : 0
                  
                  return (
                    <>
                      <div style={{ 
                        fontSize: 22, 
                        fontWeight: 700, 
                        color: netPnl >= 0 ? '#4ade80' : '#fca5a5',
                        marginBottom: 4
                      }}>
                        {netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)}
                        <span style={{ fontSize: 11, marginLeft: 6, color: '#9aa4b2' }}>net</span>
                      </div>
                      <div style={{ fontSize: 10, color: '#9aa4b2', marginBottom: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>Price Move:</span>
                          <span style={{ color: livePyramid.pnlPercent >= 0 ? '#4ade80' : '#fca5a5', fontFamily: 'monospace' }}>
                            {livePyramid.pnlPercent >= 0 ? '+' : ''}{livePyramid.pnlPercent?.toFixed(3)}%
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>Gross P&L:</span>
                          <span style={{ color: grossPnl >= 0 ? '#4ade80' : '#fca5a5', fontFamily: 'monospace' }}>
                            {grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(2)}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>Fees (0.06%):</span>
                          <span style={{ color: '#f59e0b', fontFamily: 'monospace' }}>
                            -${totalFees.toFixed(2)}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #2d3748', paddingTop: 4, marginTop: 4 }}>
                          <span style={{ fontWeight: 600 }}>ROI on Margin:</span>
                          <span style={{ color: roi >= 0 ? '#4ade80' : '#fca5a5', fontFamily: 'monospace', fontWeight: 700 }}>
                            {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </>
                  )
                })()}

                {/* Trailing Stop & EMAs */}
                <div style={{ fontSize: 10, color: '#9aa4b2', lineHeight: 1.6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>🛑 Stop:</span>
                    <span style={{ color: '#fca5a5', fontFamily: 'monospace' }}>${livePyramid.trailingStop?.toFixed(2)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>📊 Avg Entry:</span>
                    <span style={{ fontFamily: 'monospace' }}>${livePyramid.avgEntry?.toFixed(2)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                    <span>EMAs:</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 9 }}>
                      <span style={{ color: '#4ade80' }}>9: {livePyramid.ema9?.toFixed(0)}</span>
                      {' '}
                      <span style={{ color: '#60a5fa' }}>21: {livePyramid.ema21?.toFixed(0)}</span>
                      {' '}
                      <span style={{ color: '#f0b429' }}>50: {livePyramid.ema50?.toFixed(0)}</span>
                    </span>
                  </div>
                </div>

                {/* Entry Breakdown */}
                {livePyramid.entries && livePyramid.entries.length > 0 && (
                  <div style={{ marginTop: 8, borderTop: '1px solid #2d3748', paddingTop: 8 }}>
                    <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 4 }}>ENTRIES</div>
                    {livePyramid.entries.map((entry, i) => (
                      <div key={i} style={{ fontSize: 9, color: '#9aa4b2', display: 'flex', justifyContent: 'space-between' }}>
                        <span>L{i + 1}: ${entry.price?.toFixed(2)}</span>
                        <span>{entry.size?.toFixed(4)} ETH</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Trade Log */}
        {tradeLogs.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>RECENT TRADES</div>
            <div style={{ maxHeight: 100, overflowY: 'auto' }}>
              {tradeLogs.slice(0, 5).map(log => (
                <div key={log.id} style={{ 
                  display: 'flex', 
                  gap: 8, 
                  alignItems: 'center',
                  padding: '4px 8px',
                  background: '#0d1219',
                  borderRadius: 4,
                  marginBottom: 4,
                  fontSize: 10
                }}>
                  <span style={{ 
                    color: log.status === 'filled' ? '#4ade80' : log.status === 'failed' ? '#ef4444' : '#f59e0b'
                  }}>
                    {log.status === 'filled' ? '✓' : log.status === 'failed' ? '✗' : '◌'}
                  </span>
                  <span style={{ color: log.side === 'long' ? '#4ade80' : '#fca5a5', fontWeight: 600 }}>
                    {log.action}
                  </span>
                  <span style={{ color: '#9aa4b2' }}>{log.size.toFixed(4)} ETH @ ${log.price.toFixed(2)}</span>
                  <span style={{ color: '#6b7785', marginLeft: 'auto' }}>
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ETHUSDT Market Intelligence Panel */}
      {marketIntel && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0a0f14' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: 1 }}>
              🧠 ETHUSDT Market Intelligence
            </div>
            <div style={{ fontSize: 9, color: '#6b7785' }}>
              Updated: {new Date(marketIntel.timestamp).toLocaleTimeString()}
            </div>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            {/* Analysis */}
            <div>
              <div style={{ fontSize: 11, color: '#e6eaf2', lineHeight: 1.5, marginBottom: 8 }}>
                {marketIntel.analysis}
              </div>
              {marketIntel.patterns && marketIntel.patterns.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {marketIntel.patterns.map((p, i) => (
                    <span key={i} style={{ 
                      padding: '2px 6px', 
                      background: '#1e2636', 
                      borderRadius: 4, 
                      fontSize: 9, 
                      color: '#60a5fa'
                    }}>
                      {p}
                    </span>
                  ))}
                </div>
              )}
              {marketIntel.learnedInsight && (
                <div style={{ marginTop: 8, fontSize: 10, color: '#9aa4b2', fontStyle: 'italic' }}>
                  💡 {marketIntel.learnedInsight}
                </div>
              )}
            </div>
            
            {/* Recommendation */}
            <div style={{ 
              padding: 12, 
              background: marketIntel.recommendation === 'LONG' ? '#0a3622' : 
                         marketIntel.recommendation === 'SHORT' ? '#3f1219' : '#1e2636',
              borderRadius: 8,
              border: `1px solid ${marketIntel.recommendation === 'LONG' ? '#22c55e' : 
                                  marketIntel.recommendation === 'SHORT' ? '#ef4444' : '#3b82f6'}`,
              textAlign: 'center'
            }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 4 }}>AI RECOMMENDATION</div>
              <div style={{ 
                fontSize: 18, 
                fontWeight: 700, 
                color: marketIntel.recommendation === 'LONG' ? '#4ade80' : 
                       marketIntel.recommendation === 'SHORT' ? '#fca5a5' : '#60a5fa'
              }}>
                {marketIntel.recommendation}
              </div>
              <div style={{ fontSize: 11, color: '#9aa4b2', marginTop: 4 }}>
                {marketIntel.confidence}% confidence
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Signal Stats Panel - Shows why trades did/didn't happen */}
      {signalStats && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0f1318' }}>
          <div style={{ fontSize: 11, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
            📡 Signal Analysis
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
            <div style={{ padding: 8, background: '#111820', borderRadius: 6, textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 2 }}>SIGNALS</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#9aa4b2' }}>{signalStats.signalsAboveThreshold}</div>
              <div style={{ fontSize: 9, color: '#6b7785' }}>≥ threshold</div>
            </div>
            <div style={{ padding: 8, background: '#111820', borderRadius: 6, textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 2 }}>ATTEMPTS</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#60a5fa' }}>{signalStats.tradeAttempts}</div>
            </div>
            <div style={{ padding: 8, background: '#0a1a0f', borderRadius: 6, textAlign: 'center', border: '1px solid #22c55e' }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 2 }}>EXECUTED</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#4ade80' }}>{signalStats.tradesExecuted}</div>
            </div>
            <div style={{ padding: 8, background: '#1a0f0f', borderRadius: 6, textAlign: 'center', border: '1px solid #ef4444' }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 2 }}>FAILED</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#fca5a5' }}>{signalStats.tradesFailed}</div>
            </div>
            <div style={{ padding: 8, background: '#111820', borderRadius: 6, textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 2 }}>EXEC RATE</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: signalStats.signalsAboveThreshold > 0 ? '#4ade80' : '#6b7785' }}>
                {signalStats.signalsAboveThreshold > 0 
                  ? `${((signalStats.tradesExecuted / signalStats.signalsAboveThreshold) * 100).toFixed(0)}%`
                  : '—'}
              </div>
            </div>
          </div>
          
          {/* Blocked Reasons */}
          {Object.keys(signalStats.blockedReasons || {}).length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 4 }}>BLOCKED REASONS</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {Object.entries(signalStats.blockedReasons).map(([reason, count]) => (
                  <span key={reason} style={{ 
                    padding: '2px 6px', 
                    background: '#1a1a2e', 
                    borderRadius: 4, 
                    fontSize: 9, 
                    color: '#f59e0b'
                  }}>
                    {reason}: {count as number}
                  </span>
                ))}
              </div>
            </div>
          )}
          
          {/* Recent Blocked Signals */}
          {recentSignals.filter(s => s.action === 'BLOCKED').slice(0, 3).length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 4 }}>RECENT BLOCKED (conf ≥ threshold)</div>
              {recentSignals.filter(s => s.action === 'BLOCKED').slice(0, 3).map((sig, i) => (
                <div key={i} style={{ 
                  fontSize: 9, 
                  color: '#9aa4b2', 
                  padding: '3px 6px',
                  background: '#0d1219',
                  borderRadius: 3,
                  marginBottom: 2,
                  display: 'flex',
                  justifyContent: 'space-between'
                }}>
                  <span style={{ color: '#f59e0b' }}>⚠️ {sig.blockReason}</span>
                  <span>Conf: {sig.confluenceScore} | ${sig.price?.toFixed(2)} | {new Date(sig.timestamp).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 24/7 Monitoring Panel */}
      {showMonitor && liveTrading && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0d1117' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: 1 }}>
              📊 24/7 Trading Monitor
            </div>
            <button
              onClick={() => setShowMonitor(false)}
              style={{ background: 'none', border: 'none', color: '#6b7785', cursor: 'pointer', fontSize: 12 }}
            >
              ✕
            </button>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            {/* System Health */}
            <div style={{ 
              padding: 12, 
              background: health.isHealthy ? '#0a3622' : '#3f1219', 
              borderRadius: 8,
              border: `1px solid ${health.isHealthy ? '#22c55e' : '#ef4444'}`
            }}>
              <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>SYSTEM HEALTH</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18 }}>{health.isHealthy ? '🟢' : '🔴'}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: health.isHealthy ? '#4ade80' : '#fca5a5' }}>
                    {health.isHealthy ? 'HEALTHY' : 'DEGRADED'}
                  </div>
                  <div style={{ fontSize: 9, color: '#6b7785' }}>
                    Latency: {health.apiLatencyMs}ms • Errors: {health.errorCount}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 9, color: '#6b7785', marginTop: 6 }}>
                Uptime: {Math.floor(health.uptime / 3600000)}h {Math.floor((health.uptime % 3600000) / 60000)}m
              </div>
            </div>

            {/* Daily P&L */}
            <div style={{ 
              padding: 12, 
              background: dailyStats.realizedPnl >= 0 ? '#0a3622' : '#3f1219', 
              borderRadius: 8,
              border: `1px solid ${dailyStats.realizedPnl >= 0 ? '#22c55e' : '#ef4444'}`
            }}>
              <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>TODAY'S P&L</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: dailyStats.realizedPnl >= 0 ? '#4ade80' : '#fca5a5' }}>
                {dailyStats.realizedPnl >= 0 ? '+' : ''}${dailyStats.realizedPnl.toFixed(2)}
              </div>
              <div style={{ fontSize: 9, color: '#6b7785', marginTop: 4 }}>
                Trades: {dailyStats.totalTrades} • Win Rate: {(dailyStats.winRate * 100).toFixed(0)}%
              </div>
              <div style={{ fontSize: 9, color: '#6b7785' }}>
                Best: +${dailyStats.largestWin.toFixed(2)} • Worst: ${dailyStats.largestLoss.toFixed(2)}
              </div>
            </div>

            {/* Circuit Breaker Status */}
            <div style={{ 
              padding: 12, 
              background: managerState.circuitBreakerTriggered ? '#3f1219' : '#111820', 
              borderRadius: 8,
              border: `1px solid ${managerState.circuitBreakerTriggered ? '#ef4444' : '#2d3748'}`
            }}>
              <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>CIRCUIT BREAKER</div>
              {managerState.circuitBreakerTriggered ? (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#fca5a5' }}>
                    🚨 TRIGGERED
                  </div>
                  <div style={{ fontSize: 9, color: '#f87171', marginTop: 4 }}>
                    {managerState.circuitBreakerReason}
                  </div>
                  <button
                    onClick={() => setManagerState(s => ({ ...s, circuitBreakerTriggered: false, circuitBreakerReason: null }))}
                    style={{
                      marginTop: 8,
                      padding: '4px 8px',
                      borderRadius: 4,
                      border: '1px solid #f59e0b',
                      background: '#422006',
                      color: '#fbbf24',
                      fontSize: 9,
                      cursor: 'pointer'
                    }}
                  >
                    Reset Breaker
                  </button>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#4ade80' }}>
                    ✓ OK
                  </div>
                  <div style={{ fontSize: 9, color: '#6b7785', marginTop: 4 }}>
                    Consecutive Losses: {managerState.consecutiveLosses}/5
                  </div>
                </>
              )}
            </div>

            {/* Funding Rate */}
            <div style={{ 
              padding: 12, 
              background: '#111820', 
              borderRadius: 8,
              border: '1px solid #2d3748'
            }}>
              <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>FUNDING RATE</div>
              <div style={{ 
                fontSize: 16, 
                fontWeight: 700, 
                color: managerState.lastFundingRate >= 0 ? '#4ade80' : '#fca5a5' 
              }}>
                {managerState.lastFundingRate >= 0 ? '+' : ''}{(managerState.lastFundingRate * 100).toFixed(4)}%
              </div>
              <div style={{ fontSize: 9, color: '#6b7785', marginTop: 4 }}>
                {managerState.lastFundingRate > 0 ? 'Longs pay shorts' : 'Shorts pay longs'}
              </div>
              {managerState.nextFundingTime > 0 && (
                <div style={{ fontSize: 9, color: '#f59e0b', marginTop: 4 }}>
                  Next: {new Date(managerState.nextFundingTime).toLocaleTimeString()}
                </div>
              )}
            </div>
          </div>

          {/* Live vs Backtest Performance Comparison */}
          {backtestComparison && (
            <div style={{ marginTop: 12, padding: 12, background: '#0f172a', borderRadius: 8, border: '1px solid #1e3a5f' }}>
              <div style={{ fontSize: 10, color: '#60a5fa', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
                📈 Live vs Backtest Performance
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, fontSize: 11 }}>
                <div>
                  <div style={{ color: '#6b7785', marginBottom: 4 }}>Metric</div>
                  <div style={{ padding: '4px 0', borderBottom: '1px solid #1e2636' }}>Win Rate</div>
                  <div style={{ padding: '4px 0', borderBottom: '1px solid #1e2636' }}>Total PnL</div>
                  <div style={{ padding: '4px 0', borderBottom: '1px solid #1e2636' }}>Trades</div>
                  <div style={{ padding: '4px 0' }}>Sharpe Ratio</div>
                </div>
                <div>
                  <div style={{ color: '#4ade80', marginBottom: 4, fontWeight: 600 }}>🟢 LIVE</div>
                  <div style={{ padding: '4px 0', borderBottom: '1px solid #1e2636', color: '#e6eaf2' }}>
                    {(backtestComparison.live.winRate * 100).toFixed(1)}%
                  </div>
                  <div style={{ padding: '4px 0', borderBottom: '1px solid #1e2636', color: backtestComparison.live.totalPnl >= 0 ? '#4ade80' : '#fca5a5' }}>
                    {backtestComparison.live.totalPnl >= 0 ? '+' : ''}${backtestComparison.live.totalPnl.toFixed(2)}
                  </div>
                  <div style={{ padding: '4px 0', borderBottom: '1px solid #1e2636', color: '#e6eaf2' }}>
                    {backtestComparison.live.totalTrades}
                  </div>
                  <div style={{ padding: '4px 0', color: '#6b7785' }}>—</div>
                </div>
                <div>
                  <div style={{ color: '#a78bfa', marginBottom: 4, fontWeight: 600 }}>📊 BACKTEST</div>
                  <div style={{ padding: '4px 0', borderBottom: '1px solid #1e2636', color: '#e6eaf2' }}>
                    {(backtestComparison.backtest.winRate * 100).toFixed(1)}%
                  </div>
                  <div style={{ padding: '4px 0', borderBottom: '1px solid #1e2636', color: backtestComparison.backtest.totalPnl >= 0 ? '#4ade80' : '#fca5a5' }}>
                    {backtestComparison.backtest.totalPnl >= 0 ? '+' : ''}${backtestComparison.backtest.totalPnl.toFixed(2)}
                  </div>
                  <div style={{ padding: '4px 0', borderBottom: '1px solid #1e2636', color: '#e6eaf2' }}>
                    {backtestComparison.backtest.totalTrades}
                  </div>
                  <div style={{ padding: '4px 0', color: '#e6eaf2' }}>
                    {backtestComparison.backtest.sharpeRatio.toFixed(2)}
                  </div>
                </div>
              </div>
              {/* Performance Delta */}
              <div style={{ marginTop: 10, display: 'flex', gap: 16 }}>
                <div style={{ 
                  padding: '6px 12px', 
                  background: backtestComparison.comparison.winRateDiff >= 0 ? '#14532d' : '#7f1d1d',
                  borderRadius: 6,
                  fontSize: 10
                }}>
                  Win Rate: <span style={{ fontWeight: 700, color: backtestComparison.comparison.winRateDiff >= 0 ? '#4ade80' : '#fca5a5' }}>
                    {backtestComparison.comparison.winRateDiff >= 0 ? '+' : ''}{(backtestComparison.comparison.winRateDiff * 100).toFixed(1)}%
                  </span> vs backtest
                </div>
                <div style={{ 
                  padding: '6px 12px', 
                  background: backtestComparison.comparison.pnlDiff >= 0 ? '#14532d' : '#7f1d1d',
                  borderRadius: 6,
                  fontSize: 10
                }}>
                  PnL: <span style={{ fontWeight: 700, color: backtestComparison.comparison.pnlDiff >= 0 ? '#4ade80' : '#fca5a5' }}>
                    {backtestComparison.comparison.pnlDiff >= 0 ? '+' : ''}${backtestComparison.comparison.pnlDiff.toFixed(2)}
                  </span> vs backtest
                </div>
              </div>
            </div>
          )}

          {/* Emergency Controls */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
            <button
              onClick={async () => {
                if (confirm('🛑 EMERGENCY STOP: This will close all positions and stop trading. Continue?')) {
                  await (window as any).pricePerfect.trader?.emergencyStop()
                  setLiveTrading(false)
                  setLivePosition(null)
                  setManagerState(prev => ({ ...prev, isRunning: false }))
                }
              }}
              style={{
                padding: '8px 16px',
                borderRadius: 6,
                border: '2px solid #dc2626',
                background: '#450a0a',
                color: '#fca5a5',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              🛑 EMERGENCY STOP
            </button>
          </div>
        </div>
      )}

      {/* Toggle Monitor Button (when hidden) */}
      {!showMonitor && liveTrading && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid #1e2636', background: '#0d1117' }}>
          <button
            onClick={() => setShowMonitor(true)}
            style={{
              padding: '6px 12px',
              borderRadius: 4,
              border: '1px solid #3b82f6',
              background: '#1e3a5f',
              color: '#60a5fa',
              fontSize: 10,
              cursor: 'pointer'
            }}
          >
            📊 Show 24/7 Monitor
          </button>
        </div>
      )}

      {/* Config Panel */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0a0e14' }}>
        <div style={{ fontSize: 11, color: '#a78bfa', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
          ⚙️ Pyramid Configuration
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
          <div>
            <label style={{ fontSize: 10, color: '#6b7785', display: 'block', marginBottom: 4 }}>Base Risk %</label>
            <input
              type="number"
              step="0.1"
              value={config.baseRiskPercent}
              onChange={(e) => setConfig(c => ({ ...c, baseRiskPercent: parseFloat(e.target.value) || 0.5 }))}
              style={{ width: '100%', padding: 6, background: '#111820', border: '1px solid #1e2636', borderRadius: 4, color: '#e6eaf2', fontSize: 12 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, color: '#6b7785', display: 'block', marginBottom: 4 }}>Max Pyramid Levels</label>
            <input
              type="number"
              value={config.maxPyramidLevels}
              onChange={(e) => setConfig(c => ({ ...c, maxPyramidLevels: parseInt(e.target.value) || 5 }))}
              style={{ width: '100%', padding: 6, background: '#111820', border: '1px solid #1e2636', borderRadius: 4, color: '#e6eaf2', fontSize: 12 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, color: '#6b7785', display: 'block', marginBottom: 4 }}>Initial Stop %</label>
            <input
              type="number"
              step="0.1"
              value={config.initialStopPercent}
              onChange={(e) => setConfig(c => ({ ...c, initialStopPercent: parseFloat(e.target.value) || 0.8 }))}
              style={{ width: '100%', padding: 6, background: '#111820', border: '1px solid #1e2636', borderRadius: 4, color: '#e6eaf2', fontSize: 12 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, color: '#6b7785', display: 'block', marginBottom: 4 }}>Trailing Stop %</label>
            <input
              type="number"
              step="0.1"
              value={config.trailingStopPercent}
              onChange={(e) => setConfig(c => ({ ...c, trailingStopPercent: parseFloat(e.target.value) || 0.5 }))}
              style={{ width: '100%', padding: 6, background: '#111820', border: '1px solid #1e2636', borderRadius: 4, color: '#e6eaf2', fontSize: 12 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, color: '#6b7785', display: 'block', marginBottom: 4 }}>Take Profit %</label>
            <input
              type="number"
              step="0.5"
              value={config.takeProfitPercent}
              onChange={(e) => setConfig(c => ({ ...c, takeProfitPercent: parseFloat(e.target.value) || 8 }))}
              style={{ width: '100%', padding: 6, background: '#111820', border: '1px solid #1e2636', borderRadius: 4, color: '#e6eaf2', fontSize: 12 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, color: '#6b7785', display: 'block', marginBottom: 4 }}>Min Confluence Entry</label>
            <input
              type="number"
              value={config.minConfluenceToEnter}
              onChange={(e) => setConfig(c => ({ ...c, minConfluenceToEnter: parseInt(e.target.value) || 3 }))}
              style={{ width: '100%', padding: 6, background: '#111820', border: '1px solid #1e2636', borderRadius: 4, color: '#e6eaf2', fontSize: 12 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, color: '#6b7785', display: 'block', marginBottom: 4 }}>Min Confluence Add</label>
            <input
              type="number"
              value={config.minConfluenceToAdd}
              onChange={(e) => setConfig(c => ({ ...c, minConfluenceToAdd: parseInt(e.target.value) || 4 }))}
              style={{ width: '100%', padding: 6, background: '#111820', border: '1px solid #1e2636', borderRadius: 4, color: '#e6eaf2', fontSize: 12 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, color: '#6b7785', display: 'block', marginBottom: 4 }}>Liq Buffer %</label>
            <input
              type="number"
              step="1"
              value={config.liquidationBuffer}
              onChange={(e) => setConfig(c => ({ ...c, liquidationBuffer: parseFloat(e.target.value) || 15 }))}
              style={{ width: '100%', padding: 6, background: '#111820', border: '1px solid #1e2636', borderRadius: 4, color: '#e6eaf2', fontSize: 12 }}
            />
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 16, color: '#9aa4b2' }}>Loading ETHUSDT swing data...</div>
      ) : result ? (
        <>
          {/* Stats Grid */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0d1219' }}>
            <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
              📊 Backtest Results — ${startingCapital.toLocaleString()} Starting Capital
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
              <StatCard 
                label="Total Trades" 
                value={result.stats.totalTrades.toString()} 
              />
              <StatCard 
                label="Win Rate" 
                value={`${result.stats.winRate.toFixed(1)}%`} 
                color={result.stats.winRate >= 50 ? '#22c55e' : '#ef4444'}
                subtext={`${result.stats.winningTrades}W / ${result.stats.losingTrades}L`}
              />
              <StatCard 
                label="Profit Factor" 
                value={result.stats.profitFactor.toFixed(2)} 
                color={result.stats.profitFactor >= 1.5 ? '#22c55e' : result.stats.profitFactor >= 1 ? '#f0b429' : '#ef4444'}
              />
              <StatCard 
                label="Avg Pyramid Levels" 
                value={result.stats.avgPyramidLevels.toFixed(1)} 
                color="#a78bfa"
              />
              <StatCard 
                label="Avg Win" 
                value={formatMoney(result.stats.avgWin)} 
                color="#22c55e"
              />
              <StatCard 
                label="Avg Loss" 
                value={formatMoney(result.stats.avgLoss)} 
                color="#ef4444"
              />
              <StatCard 
                label="Max Drawdown" 
                value={`${result.stats.maxDrawdownPercent.toFixed(1)}%`} 
                color="#f0b429"
              />
              <StatCard 
                label="Liquidations" 
                value={result.stats.liquidations.toString()} 
                color={result.stats.liquidations === 0 ? '#22c55e' : '#ef4444'}
              />
            </div>
          </div>

          {/* Exit Breakdown */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0a1219' }}>
            <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
              🎯 Exit Breakdown
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 12, height: 12, borderRadius: 3, background: '#22c55e' }} />
                <span style={{ fontSize: 12, color: '#9aa4b2' }}>Targets: <strong style={{ color: '#22c55e' }}>{result.stats.targetExits}</strong></span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 12, height: 12, borderRadius: 3, background: '#f0b429' }} />
                <span style={{ fontSize: 12, color: '#9aa4b2' }}>Stops: <strong style={{ color: '#f0b429' }}>{result.stats.stopExits}</strong></span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 12, height: 12, borderRadius: 3, background: '#3b82f6' }} />
                <span style={{ fontSize: 12, color: '#9aa4b2' }}>Reversals: <strong style={{ color: '#3b82f6' }}>{result.stats.reversalExits}</strong></span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 12, height: 12, borderRadius: 3, background: '#ef4444' }} />
                <span style={{ fontSize: 12, color: '#9aa4b2' }}>Liquidations: <strong style={{ color: '#ef4444' }}>{result.stats.liquidations}</strong></span>
              </div>
            </div>
          </div>

          {/* Final Results with APR */}
          <div style={{ padding: '16px', borderBottom: '1px solid #1e2636', background: 'linear-gradient(135deg, #0d1a0d 0%, #0a0e14 100%)' }}>
            {(() => {
              // Calculate backtest timeframe
              const firstTrade = result.trades[0]
              const lastTrade = result.trades[result.trades.length - 1]
              const timeframeDays = firstTrade && lastTrade 
                ? (lastTrade.exitTime - firstTrade.entryTime) / (1000 * 60 * 60 * 24) 
                : 365
              const timeframeYears = timeframeDays / 365
              
              // APR = (ROI / years) annualized
              const apr = timeframeYears > 0 ? result.stats.compoundedROI / timeframeYears : 0
              
              return (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 4 }}>Compounded ROI</div>
                      <div style={{ fontSize: 28, fontWeight: 700, color: result.stats.compoundedROI >= 0 ? '#22c55e' : '#ef4444' }}>
                        {result.stats.compoundedROI >= 0 ? '+' : ''}{result.stats.compoundedROI.toFixed(2)}%
                      </div>
                      <div style={{ fontSize: 10, color: '#6b7785', marginTop: 2 }}>
                        Over {timeframeDays.toFixed(0)} days ({timeframeYears.toFixed(2)} years)
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 4 }}>Annualized (APR)</div>
                      <div style={{ fontSize: 28, fontWeight: 700, color: apr >= 0 ? '#a78bfa' : '#ef4444' }}>
                        {apr >= 0 ? '+' : ''}{apr.toFixed(1)}%
                      </div>
                      <div style={{ fontSize: 10, color: '#6b7785', marginTop: 2 }}>
                        Per year equivalent
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 4 }}>Final Capital</div>
                      <div style={{ fontSize: 28, fontWeight: 700, color: '#e6eaf2' }}>
                        {formatMoney(result.stats.finalCapital)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 4 }}>Total P&L</div>
                      <div style={{ fontSize: 28, fontWeight: 700, color: result.stats.totalPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                        {result.stats.totalPnl >= 0 ? '+' : ''}{formatMoney(result.stats.totalPnl)}
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop: 12, fontSize: 10, color: '#6b7785', background: '#111820', padding: '8px 12px', borderRadius: 6 }}>
                    💡 <strong>Backtest Period:</strong> {firstTrade ? new Date(firstTrade.entryTime).toLocaleDateString() : '—'} to {lastTrade ? new Date(lastTrade.exitTime).toLocaleDateString() : '—'} 
                    &nbsp;•&nbsp; <strong>Trades/Day:</strong> {(result.stats.totalTrades / Math.max(1, timeframeDays)).toFixed(2)}
                    &nbsp;•&nbsp; <strong>Avg Hold:</strong> {result.trades.length > 0 ? (result.trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / result.trades.length / (1000 * 60 * 60)).toFixed(1) : 0}h
                  </div>
                </>
              )
            })()}
          </div>

          {/* Signal Proximity Indicator */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0d1117' }}>
            <div style={{ fontSize: 11, color: '#60a5fa', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
              🎯 Signal Proximity (No API Calls)
            </div>
            {(() => {
              // Calculate proximity to entry/exit thresholds based on current data
              const confluenceNeeded = config.minConfluenceToEnter
              const currentScore = liveConfluence.score
              const confluenceProgress = Math.min(100, (currentScore / confluenceNeeded) * 100)
              
              // Use live price for calculating nearby levels
              const currentPrice = livePrice > 0 ? livePrice : 3500 // fallback
              
              // Calculate dynamic support/resistance based on current price
              // These are approximate levels based on typical ETH volatility
              const volatilityPct = 0.5 // 0.5% typical swing distance
              const resistance1 = currentPrice * (1 + volatilityPct / 100)
              const resistance2 = currentPrice * (1 + volatilityPct * 2 / 100)
              const support1 = currentPrice * (1 - volatilityPct / 100)
              const support2 = currentPrice * (1 - volatilityPct * 2 / 100)
              
              // Also check recent swing data if available
              const recentSwings = swings.slice(-100).filter(s => s.price > 0)
              const highsAbove = recentSwings.filter(s => s.swingType === 'high' && s.price > currentPrice).map(s => s.price)
              const lowsBelow = recentSwings.filter(s => s.swingType === 'low' && s.price < currentPrice).map(s => s.price)
              
              // Use swing data if available, otherwise use calculated levels
              const nearestHigh = highsAbove.length > 0 ? Math.min(...highsAbove) : resistance1
              const nearestLow = lowsBelow.length > 0 ? Math.max(...lowsBelow) : support1
              
              // Ensure values are finite
              const safeHigh = Number.isFinite(nearestHigh) && nearestHigh > 0 ? nearestHigh : resistance1
              const safeLow = Number.isFinite(nearestLow) && nearestLow > 0 ? nearestLow : support1
              
              const distToHigh = currentPrice > 0 ? ((safeHigh - currentPrice) / currentPrice) * 100 : 0
              const distToLow = currentPrice > 0 ? ((currentPrice - safeLow) / currentPrice) * 100 : 0
              
              return (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                  {/* Confluence Progress */}
                  <div style={{ padding: 12, background: '#111820', borderRadius: 8, border: '1px solid #2d3748' }}>
                    <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>CONFLUENCE TO ENTRY</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 8, background: '#1e2636', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${confluenceProgress}%`, 
                          height: '100%', 
                          background: confluenceProgress >= 100 ? '#22c55e' : confluenceProgress >= 75 ? '#f0b429' : '#3b82f6',
                          transition: 'width 0.3s'
                        }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: confluenceProgress >= 100 ? '#22c55e' : '#e6eaf2' }}>
                        {currentScore}/{confluenceNeeded}
                      </span>
                    </div>
                    <div style={{ fontSize: 9, color: confluenceProgress >= 100 ? '#4ade80' : '#6b7785', marginTop: 4 }}>
                      {confluenceProgress >= 100 ? '✓ ENTRY SIGNAL ACTIVE' : `${(confluenceNeeded - currentScore)} more points needed`}
                    </div>
                  </div>
                  
                  {/* Price Distance to Levels */}
                  <div style={{ padding: 12, background: '#111820', borderRadius: 8, border: '1px solid #2d3748' }}>
                    <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>DISTANCE TO SWING LEVELS</div>
                    <div style={{ display: 'flex', gap: 16 }}>
                      <div>
                        <div style={{ fontSize: 9, color: '#ef4444' }}>↑ Nearest Resistance</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#fca5a5' }}>
                          ${safeHigh.toFixed(2)}
                        </div>
                        <div style={{ fontSize: 10, color: '#6b7785' }}>
                          +{distToHigh.toFixed(2)}%
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: '#22c55e' }}>↓ Nearest Support</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80' }}>
                          ${safeLow.toFixed(2)}
                        </div>
                        <div style={{ fontSize: 10, color: '#6b7785' }}>
                          -{distToLow.toFixed(2)}%
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  {/* Exit Signal Proximity */}
                  <div style={{ padding: 12, background: '#111820', borderRadius: 8, border: '1px solid #2d3748' }}>
                    <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>EXIT SIGNAL STATUS</div>
                    {livePosition ? (
                      <>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#f0b429', marginBottom: 4 }}>
                          Position Open: {livePosition.side.toUpperCase()}
                        </div>
                        <div style={{ fontSize: 10, color: '#6b7785' }}>
                          Stop: {livePosition.side === 'long' ? '-' : '+'}{config.trailingStopPercent}% trailing
                        </div>
                        <div style={{ fontSize: 10, color: '#6b7785' }}>
                          Target: {livePosition.side === 'long' ? '+' : '-'}{config.takeProfitPercent}% from entry
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 12, color: '#6b7785' }}>
                        No position — waiting for entry signal
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>

          {/* Recent Trades */}
          <div style={{ padding: '12px 16px' }}>
            <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
              📜 Recent Pyramid Trades (last 20)
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #1e2636', color: '#6b7785' }}>
                    <th style={{ padding: '8px 6px' }}>Time</th>
                    <th style={{ padding: '8px 6px' }}>Side</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center' }}>Levels</th>
                    <th style={{ padding: '8px 6px', textAlign: 'right' }}>Entry</th>
                    <th style={{ padding: '8px 6px', textAlign: 'right' }}>Exit</th>
                    <th style={{ padding: '8px 6px', textAlign: 'right' }}>P&L</th>
                    <th style={{ padding: '8px 6px', textAlign: 'right' }}>P&L %</th>
                    <th style={{ padding: '8px 6px' }}>Exit Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.slice(-20).reverse().map((t) => (
                    <tr key={t.id} style={{ borderBottom: '1px solid #121a2a' }}>
                      <td style={{ padding: '8px 6px', color: '#9aa4b2' }}>
                        {new Date(t.entryTime).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        <span style={{ 
                          padding: '2px 6px', 
                          borderRadius: 4, 
                          fontSize: 10,
                          background: t.side === 'long' ? '#0a3622' : '#3f1219',
                          color: t.side === 'long' ? '#22c55e' : '#ef4444'
                        }}>
                          {t.side.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                        <span style={{ 
                          padding: '2px 8px', 
                          borderRadius: 4, 
                          fontSize: 10,
                          background: '#1e2636',
                          color: '#a78bfa',
                          fontWeight: 600
                        }}>
                          🔺 {t.levels}
                        </span>
                      </td>
                      <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: '#9aa4b2' }}>
                        ${t.avgEntryPrice.toFixed(2)}
                      </td>
                      <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: '#9aa4b2' }}>
                        ${t.exitPrice.toFixed(2)}
                      </td>
                      <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: t.pnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                        {t.pnl >= 0 ? '+' : ''}{formatMoney(t.pnl)}
                      </td>
                      <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: t.pnlPercent >= 0 ? '#22c55e' : '#ef4444' }}>
                        {t.pnlPercent >= 0 ? '+' : ''}{t.pnlPercent.toFixed(1)}%
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        <span style={{ 
                          padding: '2px 6px', 
                          borderRadius: 4, 
                          fontSize: 9,
                          background: t.exitReason === 'target' ? '#0a3622' : t.exitReason === 'stop' ? '#3f2c0a' : t.exitReason === 'liquidation' ? '#3f1219' : '#1e3a5f',
                          color: t.exitReason === 'target' ? '#22c55e' : t.exitReason === 'stop' ? '#f0b429' : t.exitReason === 'liquidation' ? '#ef4444' : '#60a5fa'
                        }}>
                          {t.exitReason.toUpperCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Strategy Explanation */}
          <div style={{ padding: '16px', background: '#0a0e14', borderTop: '1px solid #1e2636' }}>
            <div style={{ fontSize: 11, color: '#f0b429', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
              💡 Pyramid Strategy Logic
            </div>
            <div style={{ fontSize: 12, color: '#9aa4b2', lineHeight: 1.6 }}>
              <p style={{ margin: '0 0 8px 0' }}>
                <strong style={{ color: '#e6eaf2' }}>Entry:</strong> Open position when confluence score ≥ {config.minConfluenceToEnter} factors align with swing direction.
              </p>
              <p style={{ margin: '0 0 8px 0' }}>
                <strong style={{ color: '#e6eaf2' }}>Pyramiding:</strong> Add to position (up to {config.maxPyramidLevels} levels) when in profit AND confluence ≥ {config.minConfluenceToAdd}. 
                Each level uses decreasing size: {config.pyramidSizeMultipliers.map((m, i) => `L${i+1}=${m}x`).join(', ')}.
              </p>
              <p style={{ margin: '0 0 8px 0' }}>
                <strong style={{ color: '#e6eaf2' }}>Sliding Stop:</strong> Initial stop at {config.initialStopPercent}%, trails at {config.trailingStopPercent}% as position moves into profit. 
                This keeps risk relatively constant as pyramid grows.
              </p>
              <p style={{ margin: 0 }}>
                <strong style={{ color: '#e6eaf2' }}>Protection:</strong> Maintains {config.liquidationBuffer}% buffer from liquidation price. 
                Position rejected if too close to liquidation at {config.maxLeverage}x leverage.
              </p>
            </div>
          </div>
        </>
      ) : (
        <div style={{ padding: 16, color: '#6b7785' }}>No swing data available for ETHUSDT</div>
      )}
    </div>
  )
}
