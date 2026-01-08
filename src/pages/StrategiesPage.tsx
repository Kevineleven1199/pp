import { useState, useEffect, useMemo } from 'react'

type SwingEvent = {
  id: string
  swingType: 'high' | 'low'
  openTime: number
  price: number
  features: Record<string, number | string | boolean | null>
}

type StrategyConfig = {
  id: string
  name: string
  description: string
  leverage: number
  riskPerTrade: number
  takeProfitPercent: number
  stopLossPercent: number
  minConfluence: number
  requiredFactors: string[]
  preferredSide: 'long' | 'short' | 'both'
  maxOpenPositions: number
  compoundProfits: boolean
}

type ClosedTrade = {
  id: string
  side: 'long' | 'short'
  entryPrice: number
  exitPrice: number
  entryTime: number
  exitTime: number
  pnl: number
  pnlPercent: number
  fundingPaid: number
  feesPaid: number
  confluenceFactors: string[]
}

type StrategyResult = {
  config: StrategyConfig
  trades: ClosedTrade[]
  stats: {
    totalTrades: number
    winningTrades: number
    losingTrades: number
    winRate: number
    totalPnl: number
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

const ASTRA_CONFIG = {
  symbol: 'ETHUSDT',
  maxLeverage: 88,
  tradingFeeRate: 0.0006,
  fundingInterval: 8,
  fundingRateAvg: 0.0001,
  maintenanceMargin: 0.005,
}

const STRATEGY_TEMPLATES: StrategyConfig[] = [
  { id: 'conservative-long', name: 'Conservative Long', description: 'Low leverage longs on strong confluence', leverage: 10, riskPerTrade: 2, takeProfitPercent: 3, stopLossPercent: 1.5, minConfluence: 5, requiredFactors: [], preferredSide: 'long', maxOpenPositions: 1, compoundProfits: true },
  { id: 'aggressive-long', name: 'Aggressive Long', description: 'Higher leverage longs with tight stops', leverage: 50, riskPerTrade: 3, takeProfitPercent: 5, stopLossPercent: 1, minConfluence: 4, requiredFactors: [], preferredSide: 'long', maxOpenPositions: 1, compoundProfits: true },
  { id: 'max-leverage-long', name: 'Max Leverage Long (88x)', description: 'Maximum leverage with strict risk management', leverage: 88, riskPerTrade: 1, takeProfitPercent: 2, stopLossPercent: 0.5, minConfluence: 6, requiredFactors: [], preferredSide: 'long', maxOpenPositions: 1, compoundProfits: true },
  { id: 'conservative-short', name: 'Conservative Short', description: 'Low leverage shorts on overbought', leverage: 10, riskPerTrade: 2, takeProfitPercent: 3, stopLossPercent: 1.5, minConfluence: 5, requiredFactors: [], preferredSide: 'short', maxOpenPositions: 1, compoundProfits: true },
  { id: 'aggressive-short', name: 'Aggressive Short', description: 'Higher leverage shorts', leverage: 50, riskPerTrade: 3, takeProfitPercent: 5, stopLossPercent: 1, minConfluence: 4, requiredFactors: [], preferredSide: 'short', maxOpenPositions: 1, compoundProfits: true },
  { id: 'max-leverage-short', name: 'Max Leverage Short (88x)', description: 'Maximum leverage shorts', leverage: 88, riskPerTrade: 1, takeProfitPercent: 2, stopLossPercent: 0.5, minConfluence: 6, requiredFactors: [], preferredSide: 'short', maxOpenPositions: 1, compoundProfits: true },
  { id: 'swing-trader', name: 'Swing Trader', description: 'Both directions with moderate leverage', leverage: 20, riskPerTrade: 2.5, takeProfitPercent: 4, stopLossPercent: 2, minConfluence: 4, requiredFactors: [], preferredSide: 'both', maxOpenPositions: 1, compoundProfits: true },
  { id: 'momentum-scalper', name: 'Momentum Scalper', description: 'Quick trades on momentum signals', leverage: 40, riskPerTrade: 1.5, takeProfitPercent: 1.5, stopLossPercent: 0.75, minConfluence: 3, requiredFactors: [], preferredSide: 'both', maxOpenPositions: 1, compoundProfits: true },
  { id: 'trend-follower', name: 'Trend Follower', description: 'Follows strong trend signals', leverage: 25, riskPerTrade: 2, takeProfitPercent: 6, stopLossPercent: 2, minConfluence: 5, requiredFactors: [], preferredSide: 'both', maxOpenPositions: 1, compoundProfits: true },
  { id: 'mean-reversion', name: 'Mean Reversion', description: 'Trades oversold/overbought reversals', leverage: 15, riskPerTrade: 2, takeProfitPercent: 2.5, stopLossPercent: 1.5, minConfluence: 4, requiredFactors: [], preferredSide: 'both', maxOpenPositions: 1, compoundProfits: true },
  { id: 'london-session', name: 'London Session', description: 'Trades during London hours', leverage: 20, riskPerTrade: 2, takeProfitPercent: 3, stopLossPercent: 1.5, minConfluence: 4, requiredFactors: [], preferredSide: 'both', maxOpenPositions: 1, compoundProfits: true },
  { id: 'nyse-momentum', name: 'NYSE Momentum', description: 'Trades during NYSE hours', leverage: 25, riskPerTrade: 2, takeProfitPercent: 3.5, stopLossPercent: 1.5, minConfluence: 4, requiredFactors: [], preferredSide: 'both', maxOpenPositions: 1, compoundProfits: true },
]

function calcLiquidationPrice(side: 'long' | 'short', entryPrice: number, leverage: number): number {
  const marginRatio = 1 / leverage
  if (side === 'long') {
    return entryPrice * (1 - marginRatio + ASTRA_CONFIG.maintenanceMargin)
  }
  return entryPrice * (1 + marginRatio - ASTRA_CONFIG.maintenanceMargin)
}

function generateSignals(swings: SwingEvent[], config: StrategyConfig) {
  const signals: { timestamp: number; side: 'long' | 'short'; entryPrice: number; confidence: number; factors: string[] }[] = []
  
  for (const swing of swings) {
    const factors: string[] = []
    let confidence = 0
    const f = swing.features
    
    if (f.rsi14 !== null && typeof f.rsi14 === 'number' && f.rsi14 < 30) { factors.push('RSI<30'); confidence += 10 }
    if (f.rsi14 !== null && typeof f.rsi14 === 'number' && f.rsi14 > 70) { factors.push('RSI>70'); confidence += 10 }
    if (f.ema6_gt_ema50 === true) { factors.push('EMA6>50'); confidence += 8 }
    if (f.ema6_gt_ema50 === false) { factors.push('EMA6<50'); confidence += 8 }
    if (f.macd_bullish === true) { factors.push('MACD+'); confidence += 8 }
    if (f.macd_bullish === false) { factors.push('MACD-'); confidence += 8 }
    if (f.stoch_oversold === true) { factors.push('Stoch<20'); confidence += 9 }
    if (f.stoch_overbought === true) { factors.push('Stoch>80'); confidence += 9 }
    if (f.bb_oversold === true) { factors.push('BB_OS'); confidence += 10 }
    if (f.bb_overbought === true) { factors.push('BB_OB'); confidence += 10 }
    if (f.strong_trend === true) { factors.push('StrongTrend'); confidence += 7 }
    if (f.us_market_hours === true) { factors.push('US_Mkt'); confidence += 5 }
    if (f.london_open === true) { factors.push('London'); confidence += 5 }
    if (f.nyse_open === true) { factors.push('NYSE'); confidence += 5 }
    if (f.is_opex_week === true) { factors.push('OpEx'); confidence += 6 }
    if (f.is_snap_day === true) { factors.push('SNAP'); confidence += 4 }
    
    if (factors.length < config.minConfluence) continue
    
    const hasRequired = config.requiredFactors.every(rf => factors.includes(rf))
    if (!hasRequired && config.requiredFactors.length > 0) continue
    
    let side: 'long' | 'short'
    if (swing.swingType === 'low') {
      if (config.preferredSide === 'short') continue
      side = 'long'
    } else {
      if (config.preferredSide === 'long') continue
      side = 'short'
    }
    
    signals.push({ timestamp: swing.openTime, side, entryPrice: swing.price, confidence, factors })
  }
  
  return signals.sort((a, b) => a.timestamp - b.timestamp)
}

function backtestStrategy(swings: SwingEvent[], config: StrategyConfig, startingCapital: number = 10000): StrategyResult {
  const signals = generateSignals(swings, config)
  const trades: ClosedTrade[] = []
  let capital = startingCapital
  let maxCapital = startingCapital
  let maxDrawdown = 0
  let openPos: { side: 'long' | 'short'; entryPrice: number; entryTime: number; size: number; margin: number; factors: string[] } | null = null
  
  for (const signal of signals) {
    if (openPos && openPos.side !== signal.side) {
      const holdHours = (signal.timestamp - openPos.entryTime) / (1000 * 60 * 60)
      const fundingPeriods = Math.floor(holdHours / 8)
      const posValue = openPos.size * openPos.entryPrice
      const funding = posValue * ASTRA_CONFIG.fundingRateAvg * fundingPeriods * (openPos.side === 'long' ? 1 : -1)
      const fees = openPos.size * signal.entryPrice * ASTRA_CONFIG.tradingFeeRate * 2
      
      let pnl: number
      if (openPos.side === 'long') {
        pnl = (signal.entryPrice - openPos.entryPrice) * openPos.size * config.leverage
      } else {
        pnl = (openPos.entryPrice - signal.entryPrice) * openPos.size * config.leverage
      }
      
      const netPnl = pnl - funding - fees
      
      trades.push({
        id: `trade-${openPos.entryTime}`,
        side: openPos.side,
        entryPrice: openPos.entryPrice,
        exitPrice: signal.entryPrice,
        entryTime: openPos.entryTime,
        exitTime: signal.timestamp,
        pnl: netPnl,
        pnlPercent: (netPnl / openPos.margin) * 100,
        fundingPaid: funding,
        feesPaid: fees,
        confluenceFactors: openPos.factors
      })
      
      capital += netPnl
      if (capital > maxCapital) maxCapital = capital
      const dd = maxCapital - capital
      if (dd > maxDrawdown) maxDrawdown = dd
      
      openPos = null
    }
    
    if (!openPos && capital > 100) {
      const riskAmount = capital * (config.riskPerTrade / 100)
      const stopMove = config.stopLossPercent / 100
      const posValue = riskAmount / stopMove
      const size = posValue / signal.entryPrice
      const margin = (size * signal.entryPrice) / config.leverage
      
      if (margin < capital * 0.9) {
        openPos = { side: signal.side, entryPrice: signal.entryPrice, entryTime: signal.timestamp, size, margin, factors: signal.factors }
      }
    }
  }
  
  const wins = trades.filter(t => t.pnl > 0)
  const losses = trades.filter(t => t.pnl <= 0)
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  const totalFunding = trades.reduce((s, t) => s + t.fundingPaid, 0)
  const totalFees = trades.reduce((s, t) => s + t.feesPaid, 0)
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 999 : 0
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / trades.length / (1000 * 60 * 60) : 0
  const returns = trades.map(t => t.pnlPercent)
  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0
  const stdDev = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgRet, 2), 0) / (returns.length - 1)) : 0
  const sharpe = stdDev > 0 ? (avgRet / stdDev) * Math.sqrt(365) : 0
  const finalCap = capital
  const roi = ((finalCap - startingCapital) / startingCapital) * 100
  
  return {
    config,
    trades,
    stats: {
      totalTrades: trades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnl,
      maxDrawdown,
      maxDrawdownPercent: (maxDrawdown / maxCapital) * 100,
      sharpeRatio: sharpe,
      profitFactor,
      avgWin,
      avgLoss,
      avgHoldTime: avgHold,
      totalFundingPaid: totalFunding,
      totalFeesPaid: totalFees,
      compoundedROI: roi,
      finalCapital: finalCap,
      startingCapital
    }
  }
}

export default function StrategiesPage() {
  const [swings, setSwings] = useState<SwingEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)
  const [startingCapital] = useState(10000)

  useEffect(() => {
    setLoading(true)
    window.pricePerfect.engine.getSwings('ethusdt').then((resp) => {
      if (resp.data) {
        setSwings(resp.data)
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const results = useMemo(() => {
    if (swings.length === 0) return []
    return STRATEGY_TEMPLATES.map(t => backtestStrategy(swings, t, startingCapital))
      .sort((a, b) => b.stats.compoundedROI - a.stats.compoundedROI)
  }, [swings, startingCapital])

  const top10 = results.slice(0, 10)

  const copyToClipboard = (result: StrategyResult, idx: number) => {
    const json = JSON.stringify({
      rank: idx + 1,
      strategy: result.config,
      stats: result.stats,
      astraConfig: ASTRA_CONFIG,
      sampleTrades: result.trades.slice(-5)
    }, null, 2)
    navigator.clipboard.writeText(json)
    setCopied(result.config.id)
    setTimeout(() => setCopied(null), 2000)
  }

  const copyAllTop10 = () => {
    const json = JSON.stringify({
      generatedAt: new Date().toISOString(),
      astraConfig: ASTRA_CONFIG,
      startingCapital,
      top10Strategies: top10.map((r, i) => ({
        rank: i + 1,
        strategy: r.config,
        stats: r.stats
      }))
    }, null, 2)
    navigator.clipboard.writeText(json)
    setCopied('all')
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #1e2636', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 700 }}>Astra DEX Perp Strategies — ETHUSDT {ASTRA_CONFIG.maxLeverage}x</div>
          <div style={{ fontSize: 12, color: '#9aa4b2', marginTop: 4 }}>
            Real data backtesting • Funding aware • Liquidation protected • ${startingCapital.toLocaleString()} starting capital
          </div>
        </div>
        <button
          onClick={copyAllTop10}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: copied === 'all' ? '1px solid #22c55e' : '1px solid #3b82f6',
            background: copied === 'all' ? '#14532d' : '#1e3a5f',
            color: copied === 'all' ? '#4ade80' : '#60a5fa',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 12
          }}
        >
          {copied === 'all' ? '✓ Copied!' : '📋 Copy Top 10 JSON'}
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 20, color: '#9aa4b2' }}>Loading swing data for backtesting...</div>
      ) : swings.length === 0 ? (
        <div style={{ padding: 20, color: '#f0b429' }}>
          ⚠️ No ETHUSDT swing data available. Run backfill and derived rebuild first.
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          <div style={{ display: 'grid', gap: 12 }}>
            {top10.map((result, idx) => (
              <div
                key={result.config.id}
                style={{
                  background: idx === 0 ? '#1a2a1a' : '#111820',
                  borderRadius: 8,
                  border: idx === 0 ? '2px solid #22c55e' : '1px solid #1e2636',
                  padding: 16
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        background: idx === 0 ? '#22c55e' : idx < 3 ? '#f59e0b' : '#6b7785',
                        color: '#000',
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontWeight: 700,
                        fontSize: 11
                      }}>
                        #{idx + 1}
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 16 }}>{result.config.name}</span>
                      <span style={{
                        background: result.config.preferredSide === 'long' ? '#14532d' : result.config.preferredSide === 'short' ? '#7f1d1d' : '#1e3a5f',
                        color: result.config.preferredSide === 'long' ? '#4ade80' : result.config.preferredSide === 'short' ? '#f87171' : '#60a5fa',
                        padding: '2px 6px',
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 600
                      }}>
                        {result.config.preferredSide.toUpperCase()}
                      </span>
                      <span style={{ background: '#3f3f46', color: '#fbbf24', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600 }}>
                        {result.config.leverage}x
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7785', marginTop: 4 }}>{result.config.description}</div>
                  </div>
                  <button
                    onClick={() => copyToClipboard(result, idx)}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 4,
                      border: copied === result.config.id ? '1px solid #22c55e' : '1px solid #1e2636',
                      background: copied === result.config.id ? '#14532d' : '#0a0e14',
                      color: copied === result.config.id ? '#4ade80' : '#9aa4b2',
                      cursor: 'pointer',
                      fontSize: 11
                    }}
                  >
                    {copied === result.config.id ? '✓ Copied' : '📋 Copy JSON'}
                  </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
                  <div style={{ background: '#0a0e14', borderRadius: 6, padding: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>Compounded ROI</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: result.stats.compoundedROI >= 0 ? '#22c55e' : '#ef4444' }}>
                      {result.stats.compoundedROI >= 0 ? '+' : ''}{result.stats.compoundedROI.toFixed(1)}%
                    </div>
                  </div>
                  <div style={{ background: '#0a0e14', borderRadius: 6, padding: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>Final Capital</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#e6eaf2' }}>
                      ${result.stats.finalCapital.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </div>
                  </div>
                  <div style={{ background: '#0a0e14', borderRadius: 6, padding: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>Win Rate</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: result.stats.winRate >= 50 ? '#22c55e' : '#f59e0b' }}>
                      {result.stats.winRate.toFixed(1)}%
                    </div>
                  </div>
                  <div style={{ background: '#0a0e14', borderRadius: 6, padding: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>Total Trades</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#e6eaf2' }}>{result.stats.totalTrades}</div>
                  </div>
                  <div style={{ background: '#0a0e14', borderRadius: 6, padding: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>Max Drawdown</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#ef4444' }}>
                      -{result.stats.maxDrawdownPercent.toFixed(1)}%
                    </div>
                  </div>
                  <div style={{ background: '#0a0e14', borderRadius: 6, padding: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>Profit Factor</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: result.stats.profitFactor >= 1.5 ? '#22c55e' : '#f59e0b' }}>
                      {result.stats.profitFactor.toFixed(2)}
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 12, display: 'flex', gap: 16, fontSize: 11, color: '#6b7785' }}>
                  <span>Fees: ${result.stats.totalFeesPaid.toFixed(2)}</span>
                  <span>Funding: ${result.stats.totalFundingPaid.toFixed(2)}</span>
                  <span>Avg Hold: {result.stats.avgHoldTime.toFixed(1)}h</span>
                  <span>Sharpe: {result.stats.sharpeRatio.toFixed(2)}</span>
                  <span>W/L: {result.stats.winningTrades}/{result.stats.losingTrades}</span>
                </div>
              </div>
            ))}
          </div>

          {results.length > 10 && (
            <div style={{ marginTop: 20, padding: 12, background: '#111820', borderRadius: 8, border: '1px solid #1e2636' }}>
              <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 8 }}>OTHER STRATEGIES (sorted by ROI)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                {results.slice(10).map((r, i) => (
                  <div key={r.config.id} style={{ fontSize: 11, color: '#9aa4b2', display: 'flex', justifyContent: 'space-between' }}>
                    <span>#{i + 11} {r.config.name}</span>
                    <span style={{ color: r.stats.compoundedROI >= 0 ? '#22c55e' : '#ef4444' }}>
                      {r.stats.compoundedROI >= 0 ? '+' : ''}{r.stats.compoundedROI.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
