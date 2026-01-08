import type { SwingEvent } from './types'

// Astra DEX Perp Configuration
export const ASTRA_CONFIG = {
  symbol: 'ETHUSDT',
  maxLeverage: 88,
  defaultLeverage: 20, // Conservative default
  tradingFeeRate: 0.0006, // 0.06% taker fee
  fundingInterval: 8, // hours
  fundingRateAvg: 0.0001, // 0.01% avg funding rate per 8h
  maintenanceMargin: 0.005, // 0.5% maintenance margin
  initialMargin: 0.01, // 1% initial margin at 100x
  minPositionSize: 0.001, // Min ETH
  maxPositionSize: 1000, // Max ETH
}

export type PositionSide = 'long' | 'short'

export type TradeSignal = {
  timestamp: number
  side: PositionSide
  entryPrice: number
  confidence: number
  confluenceFactors: string[]
  swingId: string
}

export type Position = {
  id: string
  side: PositionSide
  entryPrice: number
  entryTime: number
  size: number // in ETH
  leverage: number
  marginUsed: number // in USDT
  liquidationPrice: number
  takeProfitPrice: number
  stopLossPrice: number
  fundingPaid: number
  feesPaid: number
}

export type ClosedTrade = {
  id: string
  side: PositionSide
  entryPrice: number
  exitPrice: number
  entryTime: number
  exitTime: number
  size: number
  leverage: number
  pnl: number // realized PnL in USDT
  pnlPercent: number
  fundingPaid: number
  feesPaid: number
  exitReason: 'tp' | 'sl' | 'signal' | 'liquidation'
  confluenceFactors: string[]
}

export type StrategyConfig = {
  id: string
  name: string
  description: string
  leverage: number
  riskPerTrade: number // % of capital per trade
  takeProfitPercent: number
  stopLossPercent: number
  minConfluence: number // minimum confluence factors required
  requiredFactors: string[] // must have these factors
  preferredSide: 'long' | 'short' | 'both'
  maxOpenPositions: number
  compoundProfits: boolean
}

export type StrategyResult = {
  config: StrategyConfig
  trades: ClosedTrade[]
  stats: {
    totalTrades: number
    winningTrades: number
    losingTrades: number
    winRate: number
    totalPnl: number
    totalPnlPercent: number
    maxDrawdown: number
    maxDrawdownPercent: number
    sharpeRatio: number
    profitFactor: number
    avgWin: number
    avgLoss: number
    avgHoldTime: number
    totalFundingPaid: number
    totalFeesPaid: number
    compoundedROI: number
    finalCapital: number
    startingCapital: number
  }
}

// Calculate liquidation price
function calcLiquidationPrice(
  side: PositionSide,
  entryPrice: number,
  leverage: number,
  maintenanceMargin: number = ASTRA_CONFIG.maintenanceMargin
): number {
  const marginRatio = 1 / leverage
  if (side === 'long') {
    // Long liquidation: price drops below entry by (1/leverage - maintenance)
    return entryPrice * (1 - marginRatio + maintenanceMargin)
  } else {
    // Short liquidation: price rises above entry by (1/leverage - maintenance)
    return entryPrice * (1 + marginRatio - maintenanceMargin)
  }
}

// Calculate position size to never get liquidated
function calcSafePositionSize(
  capital: number,
  entryPrice: number,
  leverage: number,
  riskPercent: number,
  stopLossPercent: number
): { size: number; margin: number } {
  // Risk amount in USDT
  const riskAmount = capital * (riskPercent / 100)
  
  // Position size based on stop loss
  const stopLossMove = stopLossPercent / 100
  const positionValue = riskAmount / stopLossMove
  const size = positionValue / entryPrice
  
  // Margin required
  const margin = (size * entryPrice) / leverage
  
  // Ensure we don't use more than available capital
  const maxMargin = capital * 0.9 // Keep 10% buffer
  if (margin > maxMargin) {
    const adjustedMargin = maxMargin
    const adjustedSize = (adjustedMargin * leverage) / entryPrice
    return { size: adjustedSize, margin: adjustedMargin }
  }
  
  return { size, margin }
}

// Calculate funding payment
function calcFunding(
  size: number,
  entryPrice: number,
  holdTimeHours: number,
  side: PositionSide,
  fundingRate: number = ASTRA_CONFIG.fundingRateAvg
): number {
  const fundingPeriods = Math.floor(holdTimeHours / ASTRA_CONFIG.fundingInterval)
  const positionValue = size * entryPrice
  
  // Longs pay shorts when funding is positive (usually the case)
  const fundingMultiplier = side === 'long' ? 1 : -1
  return positionValue * fundingRate * fundingPeriods * fundingMultiplier
}

// Calculate trading fees
function calcFees(size: number, price: number): number {
  return size * price * ASTRA_CONFIG.tradingFeeRate * 2 // entry + exit
}

// Generate trade signals from swing events
function generateSignals(swings: SwingEvent[], config: StrategyConfig): TradeSignal[] {
  const signals: TradeSignal[] = []
  
  for (const swing of swings) {
    const factors: string[] = []
    let confidence = 0
    
    // Check each feature for confluence
    const f = swing.features
    
    // Technical indicators
    if (f.rsi14 !== null && typeof f.rsi14 === 'number' && f.rsi14 < 30) { factors.push('RSI<30'); confidence += 10 }
    if (f.rsi14 !== null && typeof f.rsi14 === 'number' && f.rsi14 > 70) { factors.push('RSI>70'); confidence += 10 }
    if (f.ema6_gt_ema50 === true) { factors.push('EMA6>50'); confidence += 8 }
    if (f.ema6_gt_ema50 === false) { factors.push('EMA6<50'); confidence += 8 }
    if (f.close_gt_sma200 === true) { factors.push('Cls>SMA200'); confidence += 7 }
    if (f.macd_bullish === true) { factors.push('MACD+'); confidence += 8 }
    if (f.macd_bullish === false) { factors.push('MACD-'); confidence += 8 }
    if (f.stoch_oversold === true) { factors.push('Stoch<20'); confidence += 9 }
    if (f.stoch_overbought === true) { factors.push('Stoch>80'); confidence += 9 }
    if (f.bb_oversold === true) { factors.push('BB_OS'); confidence += 10 }
    if (f.bb_overbought === true) { factors.push('BB_OB'); confidence += 10 }
    if (f.strong_trend === true) { factors.push('StrongTrend'); confidence += 7 }
    if (f.momentum_positive === true) { factors.push('Mom+'); confidence += 6 }
    if (f.momentum_positive === false) { factors.push('Mom-'); confidence += 6 }
    
    // Time-based factors
    if (f.us_market_hours === true) { factors.push('US_Mkt'); confidence += 5 }
    if (f.london_open === true) { factors.push('London'); confidence += 5 }
    if (f.nyse_open === true) { factors.push('NYSE'); confidence += 5 }
    if (f.is_opex_week === true) { factors.push('OpEx'); confidence += 6 }
    if (f.is_fomc_week === true) { factors.push('FOMC'); confidence += 7 }
    if (f.is_earnings_season === true) { factors.push('Earnings'); confidence += 5 }
    
    // Moon/astro factors
    if (f.is_full_moon === true) { factors.push('FullMoon'); confidence += 3 }
    if (f.is_new_moon === true) { factors.push('NewMoon'); confidence += 3 }
    if (f.lunar_gravitational_peak === true) { factors.push('LunarPeak'); confidence += 4 }
    
    // Government payment factors
    if (f.is_snap_day === true) { factors.push('SNAP'); confidence += 4 }
    if (f.is_payroll_day === true) { factors.push('Payroll'); confidence += 4 }
    
    // Candle patterns
    if (f.is_doji === true) { factors.push('Doji'); confidence += 6 }
    if (f.is_hammer === true) { factors.push('Hammer'); confidence += 7 }
    
    // Check if meets minimum confluence
    if (factors.length < config.minConfluence) continue
    
    // Check required factors
    const hasRequired = config.requiredFactors.every(rf => factors.includes(rf))
    if (!hasRequired && config.requiredFactors.length > 0) continue
    
    // Determine side based on swing type and factors
    let side: PositionSide
    if (swing.swingType === 'low') {
      // Swing low = potential long entry
      if (config.preferredSide === 'short') continue
      side = 'long'
    } else {
      // Swing high = potential short entry
      if (config.preferredSide === 'long') continue
      side = 'short'
    }
    
    signals.push({
      timestamp: swing.openTime,
      side,
      entryPrice: swing.price,
      confidence,
      confluenceFactors: factors,
      swingId: swing.id
    })
  }
  
  return signals.sort((a, b) => a.timestamp - b.timestamp)
}

// Backtest a strategy against real swing data
export function backtestStrategy(
  swings: SwingEvent[],
  config: StrategyConfig,
  startingCapital: number = 10000
): StrategyResult {
  const signals = generateSignals(swings, config)
  const trades: ClosedTrade[] = []
  let capital = startingCapital
  let maxCapital = startingCapital
  let maxDrawdown = 0
  let openPosition: Position | null = null
  
  for (let i = 0; i < signals.length; i++) {
    const signal = signals[i]
    
    // Close existing position if opposite signal
    if (openPosition && openPosition.side !== signal.side) {
      const holdTimeMs = signal.timestamp - openPosition.entryTime
      const holdTimeHours = holdTimeMs / (1000 * 60 * 60)
      
      const funding = calcFunding(
        openPosition.size,
        openPosition.entryPrice,
        holdTimeHours,
        openPosition.side
      )
      
      const fees = calcFees(openPosition.size, signal.entryPrice)
      
      let pnl: number
      if (openPosition.side === 'long') {
        pnl = (signal.entryPrice - openPosition.entryPrice) * openPosition.size
      } else {
        pnl = (openPosition.entryPrice - signal.entryPrice) * openPosition.size
      }
      
      // Apply leverage to PnL
      const leveragedPnl = pnl * openPosition.leverage
      const netPnl = leveragedPnl - funding - fees
      const pnlPercent = (netPnl / openPosition.marginUsed) * 100
      
      trades.push({
        id: openPosition.id,
        side: openPosition.side,
        entryPrice: openPosition.entryPrice,
        exitPrice: signal.entryPrice,
        entryTime: openPosition.entryTime,
        exitTime: signal.timestamp,
        size: openPosition.size,
        leverage: openPosition.leverage,
        pnl: netPnl,
        pnlPercent,
        fundingPaid: funding,
        feesPaid: fees,
        exitReason: 'signal',
        confluenceFactors: signal.confluenceFactors
      })
      
      // Update capital
      if (config.compoundProfits) {
        capital += netPnl
      } else {
        capital = startingCapital + trades.reduce((sum, t) => sum + t.pnl, 0)
      }
      
      // Track drawdown
      if (capital > maxCapital) maxCapital = capital
      const drawdown = maxCapital - capital
      if (drawdown > maxDrawdown) maxDrawdown = drawdown
      
      openPosition = null
    }
    
    // Open new position if no position and we have capital
    if (!openPosition && capital > 100) {
      const { size, margin } = calcSafePositionSize(
        capital,
        signal.entryPrice,
        config.leverage,
        config.riskPerTrade,
        config.stopLossPercent
      )
      
      if (size >= ASTRA_CONFIG.minPositionSize) {
        const liqPrice = calcLiquidationPrice(signal.side, signal.entryPrice, config.leverage)
        
        let tp: number, sl: number
        if (signal.side === 'long') {
          tp = signal.entryPrice * (1 + config.takeProfitPercent / 100)
          sl = signal.entryPrice * (1 - config.stopLossPercent / 100)
          // Ensure SL is above liquidation
          if (sl < liqPrice * 1.1) sl = liqPrice * 1.1
        } else {
          tp = signal.entryPrice * (1 - config.takeProfitPercent / 100)
          sl = signal.entryPrice * (1 + config.stopLossPercent / 100)
          // Ensure SL is below liquidation
          if (sl > liqPrice * 0.9) sl = liqPrice * 0.9
        }
        
        openPosition = {
          id: `trade-${signal.timestamp}`,
          side: signal.side,
          entryPrice: signal.entryPrice,
          entryTime: signal.timestamp,
          size,
          leverage: config.leverage,
          marginUsed: margin,
          liquidationPrice: liqPrice,
          takeProfitPrice: tp,
          stopLossPrice: sl,
          fundingPaid: 0,
          feesPaid: calcFees(size, signal.entryPrice) / 2 // Entry fee only
        }
      }
    }
  }
  
  // Calculate stats
  const winningTrades = trades.filter(t => t.pnl > 0)
  const losingTrades = trades.filter(t => t.pnl <= 0)
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0)
  const totalFunding = trades.reduce((sum, t) => sum + t.fundingPaid, 0)
  const totalFees = trades.reduce((sum, t) => sum + t.feesPaid, 0)
  
  const avgWin = winningTrades.length > 0 
    ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length 
    : 0
  const avgLoss = losingTrades.length > 0 
    ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length)
    : 0
  
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0
  
  const avgHoldTime = trades.length > 0
    ? trades.reduce((sum, t) => sum + (t.exitTime - t.entryTime), 0) / trades.length / (1000 * 60 * 60)
    : 0
  
  // Calculate Sharpe ratio (simplified)
  const returns = trades.map(t => t.pnlPercent)
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0
  const stdDev = returns.length > 1
    ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
    : 0
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(365) : 0
  
  const finalCapital = config.compoundProfits ? capital : startingCapital + totalPnl
  const compoundedROI = ((finalCapital - startingCapital) / startingCapital) * 100
  
  return {
    config,
    trades,
    stats: {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0,
      totalPnl,
      totalPnlPercent: (totalPnl / startingCapital) * 100,
      maxDrawdown,
      maxDrawdownPercent: (maxDrawdown / maxCapital) * 100,
      sharpeRatio,
      profitFactor,
      avgWin,
      avgLoss,
      avgHoldTime,
      totalFundingPaid: totalFunding,
      totalFeesPaid: totalFees,
      compoundedROI,
      finalCapital,
      startingCapital
    }
  }
}

// Pre-defined strategy templates
export const STRATEGY_TEMPLATES: StrategyConfig[] = [
  {
    id: 'conservative-long',
    name: 'Conservative Long',
    description: 'Low leverage longs on strong confluence',
    leverage: 10,
    riskPerTrade: 2,
    takeProfitPercent: 3,
    stopLossPercent: 1.5,
    minConfluence: 5,
    requiredFactors: ['RSI<30'],
    preferredSide: 'long',
    maxOpenPositions: 1,
    compoundProfits: true
  },
  {
    id: 'aggressive-long',
    name: 'Aggressive Long',
    description: 'Higher leverage longs with tight stops',
    leverage: 50,
    riskPerTrade: 3,
    takeProfitPercent: 5,
    stopLossPercent: 1,
    minConfluence: 4,
    requiredFactors: [],
    preferredSide: 'long',
    maxOpenPositions: 1,
    compoundProfits: true
  },
  {
    id: 'max-leverage-long',
    name: 'Max Leverage Long (88x)',
    description: 'Maximum leverage with strict risk management',
    leverage: 88,
    riskPerTrade: 1,
    takeProfitPercent: 2,
    stopLossPercent: 0.5,
    minConfluence: 6,
    requiredFactors: ['BB_OS', 'Stoch<20'],
    preferredSide: 'long',
    maxOpenPositions: 1,
    compoundProfits: true
  },
  {
    id: 'conservative-short',
    name: 'Conservative Short',
    description: 'Low leverage shorts on overbought',
    leverage: 10,
    riskPerTrade: 2,
    takeProfitPercent: 3,
    stopLossPercent: 1.5,
    minConfluence: 5,
    requiredFactors: ['RSI>70'],
    preferredSide: 'short',
    maxOpenPositions: 1,
    compoundProfits: true
  },
  {
    id: 'aggressive-short',
    name: 'Aggressive Short',
    description: 'Higher leverage shorts',
    leverage: 50,
    riskPerTrade: 3,
    takeProfitPercent: 5,
    stopLossPercent: 1,
    minConfluence: 4,
    requiredFactors: [],
    preferredSide: 'short',
    maxOpenPositions: 1,
    compoundProfits: true
  },
  {
    id: 'max-leverage-short',
    name: 'Max Leverage Short (88x)',
    description: 'Maximum leverage shorts with strict management',
    leverage: 88,
    riskPerTrade: 1,
    takeProfitPercent: 2,
    stopLossPercent: 0.5,
    minConfluence: 6,
    requiredFactors: ['BB_OB', 'Stoch>80'],
    preferredSide: 'short',
    maxOpenPositions: 1,
    compoundProfits: true
  },
  {
    id: 'swing-trader',
    name: 'Swing Trader',
    description: 'Both directions with moderate leverage',
    leverage: 20,
    riskPerTrade: 2.5,
    takeProfitPercent: 4,
    stopLossPercent: 2,
    minConfluence: 4,
    requiredFactors: [],
    preferredSide: 'both',
    maxOpenPositions: 1,
    compoundProfits: true
  },
  {
    id: 'moon-phase-trader',
    name: 'Moon Phase Trader',
    description: 'Trades based on lunar cycles',
    leverage: 15,
    riskPerTrade: 2,
    takeProfitPercent: 3,
    stopLossPercent: 1.5,
    minConfluence: 3,
    requiredFactors: ['FullMoon'],
    preferredSide: 'both',
    maxOpenPositions: 1,
    compoundProfits: true
  },
  {
    id: 'snap-day-trader',
    name: 'SNAP Day Trader',
    description: 'Trades around government payment days',
    leverage: 25,
    riskPerTrade: 2,
    takeProfitPercent: 3,
    stopLossPercent: 1.5,
    minConfluence: 3,
    requiredFactors: ['SNAP'],
    preferredSide: 'long',
    maxOpenPositions: 1,
    compoundProfits: true
  },
  {
    id: 'opex-momentum',
    name: 'OpEx Momentum',
    description: 'Trades options expiration volatility',
    leverage: 30,
    riskPerTrade: 2,
    takeProfitPercent: 4,
    stopLossPercent: 1.5,
    minConfluence: 4,
    requiredFactors: ['OpEx'],
    preferredSide: 'both',
    maxOpenPositions: 1,
    compoundProfits: true
  },
  {
    id: 'london-session',
    name: 'London Session',
    description: 'Trades during London market hours',
    leverage: 20,
    riskPerTrade: 2,
    takeProfitPercent: 3,
    stopLossPercent: 1.5,
    minConfluence: 4,
    requiredFactors: ['London'],
    preferredSide: 'both',
    maxOpenPositions: 1,
    compoundProfits: true
  },
  {
    id: 'nyse-momentum',
    name: 'NYSE Momentum',
    description: 'Trades during NYSE hours',
    leverage: 25,
    riskPerTrade: 2,
    takeProfitPercent: 3.5,
    stopLossPercent: 1.5,
    minConfluence: 4,
    requiredFactors: ['NYSE'],
    preferredSide: 'both',
    maxOpenPositions: 1,
    compoundProfits: true
  }
]

// Run all strategy templates and return sorted by ROI
export function runAllStrategies(swings: SwingEvent[], startingCapital: number = 10000): StrategyResult[] {
  const results: StrategyResult[] = []
  
  for (const template of STRATEGY_TEMPLATES) {
    const result = backtestStrategy(swings, template, startingCapital)
    results.push(result)
  }
  
  // Sort by compounded ROI descending
  return results.sort((a, b) => b.stats.compoundedROI - a.stats.compoundedROI)
}

// Generate additional dynamic strategies based on top confluence factors
export function generateDynamicStrategies(
  swings: SwingEvent[],
  topFactors: { factor: string; impact: number }[]
): StrategyConfig[] {
  const dynamicStrategies: StrategyConfig[] = []
  
  // Create strategies for each top factor
  for (let i = 0; i < Math.min(5, topFactors.length); i++) {
    const factor = topFactors[i]
    
    dynamicStrategies.push({
      id: `dynamic-${factor.factor.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      name: `${factor.factor} Strategy`,
      description: `Auto-generated strategy targeting ${factor.factor} factor`,
      leverage: 30,
      riskPerTrade: 2,
      takeProfitPercent: 3,
      stopLossPercent: 1.5,
      minConfluence: 3,
      requiredFactors: [factor.factor],
      preferredSide: 'both',
      maxOpenPositions: 1,
      compoundProfits: true
    })
  }
  
  return dynamicStrategies
}
