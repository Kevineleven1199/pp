import * as fs from 'fs'
import * as path from 'path'
import { EventEmitter } from 'events'
import Decimal from 'decimal.js'
import { getMarketSentiment, MarketSentimentFetcher, SentimentFactor } from './marketSentiment'

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN })

const DATA_DIR = path.join(process.env.HOME || '', '.price-perfect')
const SWINGS_DIR = path.join(DATA_DIR, 'swings', 'crypto')

// Trading Constants
const SYMBOL = 'ETHUSDT'
const MAX_LEVERAGE = 88
const TRADING_FEE_RATE = new Decimal('0.0006')  // 0.06% per trade
const FUNDING_INTERVAL_HOURS = 8

// Position Sizing (% of margin balance)
const INITIAL_MARGIN_PERCENT = new Decimal('0.08')   // 8% initial entry
const MIN_PYRAMID_ADD_PERCENT = new Decimal('0.04')  // 4% minimum add
const MAX_PYRAMID_ADD_PERCENT = new Decimal('0.08')  // 8% maximum add
const MAX_TOTAL_MARGIN_PERCENT = new Decimal('0.80') // 80% max exposure
const HEDGE_SIZE_PERCENT = new Decimal('0.25')       // 25-50% of primary for hedge

// ANTI-LIQUIDATION SAFEGUARDS - NEVER GET LIQUIDATED
const MAINTENANCE_MARGIN_RATE = new Decimal('0.005')   // 0.5% maintenance margin
const LIQUIDATION_BUFFER_PERCENT = new Decimal('0.25') // 25% buffer from liquidation price
const MAX_LOSS_PER_TRADE_PERCENT = new Decimal('0.02') // Max 2% loss per trade (of margin balance)
const EMERGENCY_CLOSE_MARGIN_RATIO = new Decimal('0.15') // Close all if margin ratio drops to 15%
const STOP_LOSS_DISTANCE_FROM_LIQ = new Decimal('0.30')  // Stop must be 30% away from liquidation

// Profit Protection Requirements (unrealized profit buffer needed)
const PROFIT_BUFFER_PER_LEVEL = [
  new Decimal('0'),      // Level 1: no buffer needed
  new Decimal('0.02'),   // Level 2: 2% buffer
  new Decimal('0.04'),   // Level 3: 4% buffer
  new Decimal('0.06'),   // Level 4: 6% buffer
  new Decimal('0.08'),   // Level 5: 8% buffer
  new Decimal('0.10'),   // Level 6+: 10% buffer
]

// Trailing Stop Progression (% from entry/high)
const STOP_LOSS_PER_LEVEL = [
  new Decimal('-0.008'),  // Level 1: -0.8% (tight)
  new Decimal('0'),       // Level 2: breakeven
  new Decimal('0.003'),   // Level 3: +0.3% profit locked
  new Decimal('0.005'),   // Level 4: +0.5% profit locked
  new Decimal('0.007'),   // Level 5: +0.7% profit locked
]

const TRAILING_CALLBACK_PER_LEVEL = [
  new Decimal('0.008'),   // Level 1: 0.8% callback
  new Decimal('0.006'),   // Level 2: 0.6% callback
  new Decimal('0.005'),   // Level 3: 0.5% callback
  new Decimal('0.004'),   // Level 4: 0.4% callback
  new Decimal('0.003'),   // Level 5+: 0.3% callback (tightest)
]

export interface SwingPattern {
  swingType: 'high' | 'low'
  openTime: number
  price: number
  features: Record<string, number | string | boolean | null>
  outcome?: {
    nextSwingPrice: number
    pnlPercent: number
    holdingMinutes: number
  }
}

export interface PatternMatch {
  pattern: SwingPattern
  similarity: number
  expectedMove: number
  winRate: number
  avgReturn: number
  sampleSize: number
}

export interface ConfluenceSignal {
  direction: 'long' | 'short' | 'neutral'
  score: number           // 0-10 confluence score
  confidence: number      // 0-1 confidence level
  factors: ConfluenceFactor[]
  patternMatches: PatternMatch[]
  expectedReturn: Decimal
  winProbability: number
  fundingBias: 'long' | 'short' | 'neutral'
}

export interface ConfluenceFactor {
  name: string
  value: number | string
  direction: 'bullish' | 'bearish' | 'neutral'
  weight: number
  description: string
}

export interface PyramidLevel {
  level: number
  entryPrice: Decimal
  quantity: Decimal
  marginUsed: Decimal
  notionalValue: Decimal
  timestamp: number
  confluenceScore: number
  stopLoss: Decimal
  trailingCallback: Decimal
  unrealizedPnl: Decimal
}

export interface PyramidPosition {
  id: string
  side: 'long' | 'short'
  levels: PyramidLevel[]
  avgEntryPrice: Decimal
  totalQuantity: Decimal
  totalMarginUsed: Decimal
  totalNotionalValue: Decimal
  currentStopLoss: Decimal
  trailingStopPrice: Decimal
  highWaterMark: Decimal       // Highest profit reached
  unrealizedPnl: Decimal
  unrealizedPnlPercent: Decimal
  openTime: number
  lastUpdateTime: number
}

export interface HedgeState {
  primaryPosition: PyramidPosition | null
  hedgePosition: PyramidPosition | null
  netExposure: Decimal          // Long - Short notional
  totalMarginUsed: Decimal
  totalUnrealizedPnl: Decimal
}

export interface AccountState {
  marginBalance: Decimal        // Actual USDT balance
  availableMargin: Decimal      // Unused margin
  totalEquity: Decimal          // Balance + unrealized PnL
  usedMarginPercent: Decimal    // % of balance in positions
  currentFundingRate: Decimal
  nextFundingTime: number
}

export interface StrategyConfig {
  maxPyramidLevels: number
  minConfluenceToEnter: number
  minConfluenceToAdd: number
  enableHedgeMode: boolean
  enableDCA: boolean
  takeProfitMultiplier: number  // x risk for take profit
  riskRewardMinimum: number     // Minimum R:R to enter
  maxConsecutiveLosses: number
  cooldownMinutes: number       // Minutes between trades
}

const DEFAULT_CONFIG: StrategyConfig = {
  maxPyramidLevels: 5,
  minConfluenceToEnter: 4,
  minConfluenceToAdd: 5,
  enableHedgeMode: true,
  enableDCA: true,
  takeProfitMultiplier: 2.5,
  riskRewardMinimum: 2.0,
  maxConsecutiveLosses: 3,
  cooldownMinutes: 5
}

export class PyramidStrategyEngine extends EventEmitter {
  private config: StrategyConfig
  private patternDatabase: Map<string, SwingPattern[]> = new Map()
  private hedgeState: HedgeState
  private accountState: AccountState
  private lastTradeTime: number = 0
  private consecutiveLosses: number = 0
  private sessionStats = {
    totalTrades: 0,
    winningTrades: 0,
    totalPnl: new Decimal(0),
    largestWin: new Decimal(0),
    largestLoss: new Decimal(0),
    avgWin: new Decimal(0),
    avgLoss: new Decimal(0)
  }
  
  // Market sentiment fetcher for Fear & Greed, liquidations, L/S ratio, etc.
  private sentimentFetcher: MarketSentimentFetcher

  constructor(config: Partial<StrategyConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.hedgeState = this.initHedgeState()
    this.accountState = this.initAccountState()
    this.loadPatternDatabase()
    
    // Initialize sentiment fetcher and start auto-refresh
    this.sentimentFetcher = getMarketSentiment()
    this.sentimentFetcher.startAutoRefresh()
    
    // Listen for sentiment updates
    this.sentimentFetcher.on('update', (sentiment) => {
      this.emit('sentimentUpdate', sentiment)
    })
  }

  private initHedgeState(): HedgeState {
    return {
      primaryPosition: null,
      hedgePosition: null,
      netExposure: new Decimal(0),
      totalMarginUsed: new Decimal(0),
      totalUnrealizedPnl: new Decimal(0)
    }
  }

  private initAccountState(): AccountState {
    return {
      marginBalance: new Decimal(0),
      availableMargin: new Decimal(0),
      totalEquity: new Decimal(0),
      usedMarginPercent: new Decimal(0),
      currentFundingRate: new Decimal(0),
      nextFundingTime: 0
    }
  }

  // Load historical swing patterns from database
  private loadPatternDatabase(): void {
    try {
      const ethDir = path.join(SWINGS_DIR, 'ethusdt')
      if (!fs.existsSync(ethDir)) {
        console.log('[PyramidStrategy] No pattern database found, will build from live data')
        return
      }

      // MEMORY OPTIMIZATION: Only load last 3 days of patterns to prevent 88GB memory usage
      const MAX_PATTERNS_PER_TF = 5000
      const MAX_FILES_TO_LOAD = 3 // Only load last 3 days
      
      const timeframes = ['1m', '5m', '15m', '1h', '4h']
      for (const tf of timeframes) {
        const tfDir = path.join(ethDir, tf)
        if (!fs.existsSync(tfDir)) continue

        const patterns: SwingPattern[] = []
        const files = fs.readdirSync(tfDir).filter(f => f.endsWith('.jsonl')).sort()
        
        // Only load the most recent files to save memory
        const recentFiles = files.slice(-MAX_FILES_TO_LOAD)
        
        for (const file of recentFiles) {
          if (patterns.length >= MAX_PATTERNS_PER_TF) break
          
          const content = fs.readFileSync(path.join(tfDir, file), 'utf-8')
          const lines = content.trim().split('\n').filter(l => l)
          
          for (const line of lines) {
            if (patterns.length >= MAX_PATTERNS_PER_TF) break
            try {
              const swing = JSON.parse(line) as SwingPattern
              if (swing.features && Object.keys(swing.features).length > 10) {
                patterns.push(swing)
              }
            } catch {}
          }
        }

        if (patterns.length > 0) {
          this.patternDatabase.set(tf, patterns)
          console.log(`[PyramidStrategy] Loaded ${patterns.length} patterns for ${tf} (limited to save memory)`)
        }
      }

      this.calculatePatternOutcomes()
      this.calculateTemporalStats()
      
      // Force garbage collection hint
      if (global.gc) global.gc()
    } catch (err) {
      console.error('[PyramidStrategy] Error loading pattern database:', err)
    }
  }

  // Calculate outcomes for each pattern (what happened after)
  private calculatePatternOutcomes(): void {
    for (const [tf, patterns] of this.patternDatabase) {
      for (let i = 0; i < patterns.length - 1; i++) {
        const current = patterns[i]
        const next = patterns[i + 1]
        
        if (current.swingType === 'low') {
          // After a swing low, we'd go long - measure to next swing high
          if (next.swingType === 'high') {
            current.outcome = {
              nextSwingPrice: next.price,
              pnlPercent: ((next.price - current.price) / current.price) * 100,
              holdingMinutes: (next.openTime - current.openTime) / 60000
            }
          }
        } else {
          // After a swing high, we'd go short - measure to next swing low
          if (next.swingType === 'low') {
            current.outcome = {
              nextSwingPrice: next.price,
              pnlPercent: ((current.price - next.price) / current.price) * 100,
              holdingMinutes: (next.openTime - current.openTime) / 60000
            }
          }
        }
      }
    }
  }

  // Update account state from exchange data
  updateAccountState(
    marginBalance: Decimal,
    availableMargin: Decimal,
    fundingRate: Decimal,
    nextFundingTime: number
  ): void {
    this.accountState.marginBalance = marginBalance
    this.accountState.availableMargin = availableMargin
    this.accountState.currentFundingRate = fundingRate
    this.accountState.nextFundingTime = nextFundingTime
    
    // Calculate total equity and used margin %
    this.accountState.totalEquity = marginBalance.plus(this.hedgeState.totalUnrealizedPnl)
    this.accountState.usedMarginPercent = this.hedgeState.totalMarginUsed
      .div(marginBalance)
      .mul(100)

    this.emit('accountUpdate', this.accountState)
  }

  // Find similar historical patterns to current market state
  findPatternMatches(currentFeatures: Record<string, number | null>, timeframe: string = '5m'): PatternMatch[] {
    const patterns = this.patternDatabase.get(timeframe)
    if (!patterns || patterns.length < 50) return []

    const matches: PatternMatch[] = []
    const featureKeys = Object.keys(currentFeatures).filter(k => currentFeatures[k] !== null)

    for (const pattern of patterns) {
      if (!pattern.outcome) continue

      let similarity = 0
      let matchedFeatures = 0

      for (const key of featureKeys) {
        const current = currentFeatures[key]
        const historical = pattern.features[key]
        
        if (current === null || historical === null) continue
        if (typeof current !== 'number' || typeof historical !== 'number') continue

        matchedFeatures++
        
        // Calculate similarity based on relative difference
        const diff = Math.abs(current - historical)
        const maxVal = Math.max(Math.abs(current), Math.abs(historical), 1)
        const featureSimilarity = 1 - Math.min(diff / maxVal, 1)
        
        // Weight certain features more heavily
        const weight = this.getFeatureWeight(key)
        similarity += featureSimilarity * weight
      }

      if (matchedFeatures > 5) {
        similarity = similarity / matchedFeatures
        
        if (similarity > 0.7) {  // 70% similarity threshold
          matches.push({
            pattern,
            similarity,
            expectedMove: pattern.outcome.pnlPercent,
            winRate: 0,  // Calculated below
            avgReturn: 0,
            sampleSize: 1
          })
        }
      }
    }

    // Group similar matches and calculate aggregate stats
    return this.aggregatePatternMatches(matches)
  }

  private getFeatureWeight(key: string): number {
    const highWeight = ['rsi14', 'macd_hist', 'bb_position', 'ema_cross', 'volume_ratio']
    const medWeight = ['atr14', 'adx', 'cci', 'mfi', 'obv_slope']
    
    if (highWeight.some(k => key.includes(k))) return 1.5
    if (medWeight.some(k => key.includes(k))) return 1.2
    return 1.0
  }

  private aggregatePatternMatches(matches: PatternMatch[]): PatternMatch[] {
    if (matches.length === 0) return []

    // Sort by similarity
    matches.sort((a, b) => b.similarity - a.similarity)
    
    // Take top 20 matches
    const topMatches = matches.slice(0, 20)
    
    // Calculate aggregate statistics
    const winningMatches = topMatches.filter(m => m.expectedMove > 0)
    const winRate = winningMatches.length / topMatches.length
    
    const avgReturn = topMatches.reduce((sum, m) => sum + m.expectedMove, 0) / topMatches.length
    const avgWin = winningMatches.length > 0 
      ? winningMatches.reduce((sum, m) => sum + m.expectedMove, 0) / winningMatches.length 
      : 0
    const losingMatches = topMatches.filter(m => m.expectedMove <= 0)
    const avgLoss = losingMatches.length > 0
      ? Math.abs(losingMatches.reduce((sum, m) => sum + m.expectedMove, 0) / losingMatches.length)
      : 0

    // Update stats on matches
    for (const match of topMatches) {
      match.winRate = winRate
      match.avgReturn = avgReturn
      match.sampleSize = topMatches.length
    }

    console.log(`[PyramidStrategy] Pattern analysis: ${topMatches.length} matches, ` +
      `${(winRate * 100).toFixed(1)}% win rate, avg return ${avgReturn.toFixed(2)}%`)

    return topMatches
  }

  // Historical win rates by temporal factors (calculated from pattern database)
  private temporalStats: {
    dayOfWeek: Map<number, { longs: number; longWins: number; shorts: number; shortWins: number }>
    hourOfDay: Map<number, { longs: number; longWins: number; shorts: number; shortWins: number }>
    monthOfYear: Map<number, { longs: number; longWins: number; shorts: number; shortWins: number }>
    quarter: Map<number, { longs: number; longWins: number; shorts: number; shortWins: number }>
    session: Map<string, { longs: number; longWins: number; shorts: number; shortWins: number }>
  } = {
    dayOfWeek: new Map(),
    hourOfDay: new Map(),
    monthOfYear: new Map(),
    quarter: new Map(),
    session: new Map()
  }

  // Calculate temporal statistics from pattern database
  private calculateTemporalStats(): void {
    for (const [tf, patterns] of this.patternDatabase) {
      for (const pattern of patterns) {
        if (!pattern.outcome) continue
        
        const date = new Date(pattern.openTime)
        const dayOfWeek = date.getUTCDay()
        const hour = date.getUTCHours()
        const month = date.getUTCMonth()
        const quarter = Math.floor(month / 3)
        const session = this.getSession(hour)
        
        const isLong = pattern.swingType === 'low'  // Buy at swing low
        const isWin = pattern.outcome.pnlPercent > 0
        
        // Update day of week stats
        const dayStats = this.temporalStats.dayOfWeek.get(dayOfWeek) || { longs: 0, longWins: 0, shorts: 0, shortWins: 0 }
        if (isLong) {
          dayStats.longs++
          if (isWin) dayStats.longWins++
        } else {
          dayStats.shorts++
          if (isWin) dayStats.shortWins++
        }
        this.temporalStats.dayOfWeek.set(dayOfWeek, dayStats)
        
        // Update hour stats
        const hourStats = this.temporalStats.hourOfDay.get(hour) || { longs: 0, longWins: 0, shorts: 0, shortWins: 0 }
        if (isLong) {
          hourStats.longs++
          if (isWin) hourStats.longWins++
        } else {
          hourStats.shorts++
          if (isWin) hourStats.shortWins++
        }
        this.temporalStats.hourOfDay.set(hour, hourStats)
        
        // Update month stats
        const monthStats = this.temporalStats.monthOfYear.get(month) || { longs: 0, longWins: 0, shorts: 0, shortWins: 0 }
        if (isLong) {
          monthStats.longs++
          if (isWin) monthStats.longWins++
        } else {
          monthStats.shorts++
          if (isWin) monthStats.shortWins++
        }
        this.temporalStats.monthOfYear.set(month, monthStats)
        
        // Update quarter stats
        const qStats = this.temporalStats.quarter.get(quarter) || { longs: 0, longWins: 0, shorts: 0, shortWins: 0 }
        if (isLong) {
          qStats.longs++
          if (isWin) qStats.longWins++
        } else {
          qStats.shorts++
          if (isWin) qStats.shortWins++
        }
        this.temporalStats.quarter.set(quarter, qStats)
        
        // Update session stats
        const sessStats = this.temporalStats.session.get(session) || { longs: 0, longWins: 0, shorts: 0, shortWins: 0 }
        if (isLong) {
          sessStats.longs++
          if (isWin) sessStats.longWins++
        } else {
          sessStats.shorts++
          if (isWin) sessStats.shortWins++
        }
        this.temporalStats.session.set(session, sessStats)
      }
    }
    
    console.log('[PyramidStrategy] Temporal stats calculated from pattern database')
  }

  private getSession(hour: number): string {
    if (hour >= 0 && hour < 8) return 'asia'
    if (hour >= 8 && hour < 13) return 'london'
    if (hour >= 13 && hour < 21) return 'newyork'
    return 'asia'
  }

  private getDayName(day: number): string {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]
  }

  private getMonthName(month: number): string {
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month]
  }

  // Generate confluence signal from current market data
  generateConfluenceSignal(
    currentPrice: Decimal,
    features: Record<string, number | null>,
    recentCandles: Array<{ open: number; high: number; low: number; close: number; volume: number }>
  ): ConfluenceSignal {
    const factors: ConfluenceFactor[] = []
    let bullishScore = 0
    let bearishScore = 0
    
    const now = new Date()
    const dayOfWeek = now.getUTCDay()
    const hour = now.getUTCHours()
    const month = now.getUTCMonth()
    const quarter = Math.floor(month / 3)
    const session = this.getSession(hour)

    // ═══════════════════════════════════════════════════════════════
    // TEMPORAL FACTORS - Superhuman awareness of time-based patterns
    // ═══════════════════════════════════════════════════════════════

    // 1. Day of Week Analysis
    const dayStats = this.temporalStats.dayOfWeek.get(dayOfWeek)
    if (dayStats && (dayStats.longs + dayStats.shorts) > 50) {
      const longWinRate = dayStats.longs > 0 ? dayStats.longWins / dayStats.longs : 0
      const shortWinRate = dayStats.shorts > 0 ? dayStats.shortWins / dayStats.shorts : 0
      
      if (longWinRate > 0.58) {
        factors.push({ 
          name: `${this.getDayName(dayOfWeek)} Favors Longs`, 
          value: `${(longWinRate * 100).toFixed(0)}%`, 
          direction: 'bullish', 
          weight: 1.5, 
          description: `Historical ${(longWinRate * 100).toFixed(0)}% long win rate on ${this.getDayName(dayOfWeek)}s (${dayStats.longs} trades)` 
        })
        bullishScore += 1.5
      } else if (shortWinRate > 0.58) {
        factors.push({ 
          name: `${this.getDayName(dayOfWeek)} Favors Shorts`, 
          value: `${(shortWinRate * 100).toFixed(0)}%`, 
          direction: 'bearish', 
          weight: 1.5, 
          description: `Historical ${(shortWinRate * 100).toFixed(0)}% short win rate on ${this.getDayName(dayOfWeek)}s (${dayStats.shorts} trades)` 
        })
        bearishScore += 1.5
      }
      
      // Avoid bad days
      if (longWinRate < 0.42 && shortWinRate < 0.42) {
        factors.push({ 
          name: `${this.getDayName(dayOfWeek)} Low Win Rate`, 
          value: 'Caution', 
          direction: 'neutral', 
          weight: -1, 
          description: `Both directions historically weak on ${this.getDayName(dayOfWeek)}s` 
        })
        bullishScore -= 0.5
        bearishScore -= 0.5
      }
    }

    // 2. Hour of Day Analysis
    const hourStats = this.temporalStats.hourOfDay.get(hour)
    if (hourStats && (hourStats.longs + hourStats.shorts) > 30) {
      const longWinRate = hourStats.longs > 0 ? hourStats.longWins / hourStats.longs : 0
      const shortWinRate = hourStats.shorts > 0 ? hourStats.shortWins / hourStats.shorts : 0
      
      if (longWinRate > 0.60) {
        factors.push({ 
          name: `${hour}:00 UTC Bullish Hour`, 
          value: `${(longWinRate * 100).toFixed(0)}%`, 
          direction: 'bullish', 
          weight: 1, 
          description: `${(longWinRate * 100).toFixed(0)}% long win rate at this hour` 
        })
        bullishScore += 1
      } else if (shortWinRate > 0.60) {
        factors.push({ 
          name: `${hour}:00 UTC Bearish Hour`, 
          value: `${(shortWinRate * 100).toFixed(0)}%`, 
          direction: 'bearish', 
          weight: 1, 
          description: `${(shortWinRate * 100).toFixed(0)}% short win rate at this hour` 
        })
        bearishScore += 1
      }
    }

    // 3. Session Analysis (Asia/London/NY)
    const sessStats = this.temporalStats.session.get(session)
    if (sessStats && (sessStats.longs + sessStats.shorts) > 100) {
      const longWinRate = sessStats.longs > 0 ? sessStats.longWins / sessStats.longs : 0
      const shortWinRate = sessStats.shorts > 0 ? sessStats.shortWins / sessStats.shorts : 0
      
      const sessionName = session.charAt(0).toUpperCase() + session.slice(1)
      if (longWinRate > shortWinRate + 0.05) {
        factors.push({ 
          name: `${sessionName} Session Bullish`, 
          value: `${(longWinRate * 100).toFixed(0)}%`, 
          direction: 'bullish', 
          weight: 1, 
          description: `${sessionName} session historically favors longs` 
        })
        bullishScore += 1
      } else if (shortWinRate > longWinRate + 0.05) {
        factors.push({ 
          name: `${sessionName} Session Bearish`, 
          value: `${(shortWinRate * 100).toFixed(0)}%`, 
          direction: 'bearish', 
          weight: 1, 
          description: `${sessionName} session historically favors shorts` 
        })
        bearishScore += 1
      }
    }

    // 4. Month of Year Analysis
    const monthStats = this.temporalStats.monthOfYear.get(month)
    if (monthStats && (monthStats.longs + monthStats.shorts) > 50) {
      const longWinRate = monthStats.longs > 0 ? monthStats.longWins / monthStats.longs : 0
      const shortWinRate = monthStats.shorts > 0 ? monthStats.shortWins / monthStats.shorts : 0
      
      if (longWinRate > 0.58) {
        factors.push({ 
          name: `${this.getMonthName(month)} Bullish Month`, 
          value: `${(longWinRate * 100).toFixed(0)}%`, 
          direction: 'bullish', 
          weight: 1, 
          description: `${this.getMonthName(month)} historically bullish` 
        })
        bullishScore += 1
      } else if (shortWinRate > 0.58) {
        factors.push({ 
          name: `${this.getMonthName(month)} Bearish Month`, 
          value: `${(shortWinRate * 100).toFixed(0)}%`, 
          direction: 'bearish', 
          weight: 1, 
          description: `${this.getMonthName(month)} historically bearish` 
        })
        bearishScore += 1
      }
    }

    // 5. Quarter Analysis
    const qStats = this.temporalStats.quarter.get(quarter)
    if (qStats && (qStats.longs + qStats.shorts) > 100) {
      const longWinRate = qStats.longs > 0 ? qStats.longWins / qStats.longs : 0
      const shortWinRate = qStats.shorts > 0 ? qStats.shortWins / qStats.shorts : 0
      
      if (longWinRate > shortWinRate + 0.08) {
        factors.push({ 
          name: `Q${quarter + 1} Bullish Quarter`, 
          value: `${(longWinRate * 100).toFixed(0)}%`, 
          direction: 'bullish', 
          weight: 0.5, 
          description: `Q${quarter + 1} historically favors longs` 
        })
        bullishScore += 0.5
      } else if (shortWinRate > longWinRate + 0.08) {
        factors.push({ 
          name: `Q${quarter + 1} Bearish Quarter`, 
          value: `${(shortWinRate * 100).toFixed(0)}%`, 
          direction: 'bearish', 
          weight: 0.5, 
          description: `Q${quarter + 1} historically favors shorts` 
        })
        bearishScore += 0.5
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // TECHNICAL INDICATORS - Standard TA factors
    // ═══════════════════════════════════════════════════════════════

    // 1. RSI Analysis
    const rsi = features.rsi14
    if (rsi !== null) {
      if (rsi < 30) {
        factors.push({ name: 'RSI Oversold', value: rsi, direction: 'bullish', weight: 2, description: `RSI ${rsi.toFixed(1)} < 30` })
        bullishScore += 2
      } else if (rsi > 70) {
        factors.push({ name: 'RSI Overbought', value: rsi, direction: 'bearish', weight: 2, description: `RSI ${rsi.toFixed(1)} > 70` })
        bearishScore += 2
      } else if (rsi < 45) {
        factors.push({ name: 'RSI Low', value: rsi, direction: 'bullish', weight: 1, description: `RSI ${rsi.toFixed(1)} trending up` })
        bullishScore += 1
      } else if (rsi > 55) {
        factors.push({ name: 'RSI High', value: rsi, direction: 'bearish', weight: 1, description: `RSI ${rsi.toFixed(1)} trending down` })
        bearishScore += 1
      }
    }

    // 2. MACD Analysis
    const macdHist = features.macd_hist
    const macdSignal = features.macd_signal
    if (macdHist !== null) {
      if (macdHist > 0 && (features.macd_hist_prev ?? 0) < 0) {
        factors.push({ name: 'MACD Bullish Cross', value: macdHist, direction: 'bullish', weight: 2, description: 'MACD crossed above signal' })
        bullishScore += 2
      } else if (macdHist < 0 && (features.macd_hist_prev ?? 0) > 0) {
        factors.push({ name: 'MACD Bearish Cross', value: macdHist, direction: 'bearish', weight: 2, description: 'MACD crossed below signal' })
        bearishScore += 2
      } else if (macdHist > 0) {
        bullishScore += 0.5
      } else {
        bearishScore += 0.5
      }
    }

    // 3. Bollinger Band Position
    const bbPos = features.bb_position
    if (bbPos !== null) {
      if (bbPos < 0.1) {
        factors.push({ name: 'BB Lower Touch', value: bbPos, direction: 'bullish', weight: 1.5, description: 'Price at lower Bollinger Band' })
        bullishScore += 1.5
      } else if (bbPos > 0.9) {
        factors.push({ name: 'BB Upper Touch', value: bbPos, direction: 'bearish', weight: 1.5, description: 'Price at upper Bollinger Band' })
        bearishScore += 1.5
      }
    }

    // 4. EMA Trend
    const ema6 = features.ema6
    const ema50 = features.ema50
    if (ema6 !== null && ema50 !== null) {
      if (ema6 > ema50) {
        factors.push({ name: 'EMA Bullish', value: ema6, direction: 'bullish', weight: 1, description: 'EMA6 > EMA50' })
        bullishScore += 1
      } else {
        factors.push({ name: 'EMA Bearish', value: ema6, direction: 'bearish', weight: 1, description: 'EMA6 < EMA50' })
        bearishScore += 1
      }
    }

    // 5. Volume Analysis
    const volRatio = features.volume_ratio
    if (volRatio !== null && volRatio > 1.5) {
      const priceChange = recentCandles.length > 1 
        ? recentCandles[recentCandles.length - 1].close - recentCandles[recentCandles.length - 2].close
        : 0
      if (priceChange > 0) {
        factors.push({ name: 'Volume Surge Up', value: volRatio, direction: 'bullish', weight: 1.5, description: `Volume ${volRatio.toFixed(1)}x avg with price up` })
        bullishScore += 1.5
      } else {
        factors.push({ name: 'Volume Surge Down', value: volRatio, direction: 'bearish', weight: 1.5, description: `Volume ${volRatio.toFixed(1)}x avg with price down` })
        bearishScore += 1.5
      }
    }

    // 6. ADX Trend Strength
    const adx = features.adx
    if (adx !== null && adx > 25) {
      factors.push({ name: 'Strong Trend', value: adx, direction: 'neutral', weight: 0.5, description: `ADX ${adx.toFixed(1)} indicates strong trend` })
    }

    // 7. Pattern Database Analysis
    const patternMatches = this.findPatternMatches(features)
    if (patternMatches.length > 0) {
      const avgExpectedMove = patternMatches.reduce((sum, m) => sum + m.expectedMove, 0) / patternMatches.length
      const avgWinRate = patternMatches.reduce((sum, m) => sum + m.winRate, 0) / patternMatches.length
      
      if (avgExpectedMove > 0.5 && avgWinRate > 0.55) {
        factors.push({ 
          name: 'Pattern Match Bullish', 
          value: `${avgWinRate * 100}%`, 
          direction: 'bullish', 
          weight: 2, 
          description: `${patternMatches.length} similar patterns, ${(avgWinRate * 100).toFixed(0)}% win rate, +${avgExpectedMove.toFixed(2)}% avg` 
        })
        bullishScore += 2
      } else if (avgExpectedMove < -0.5 && avgWinRate > 0.55) {
        factors.push({ 
          name: 'Pattern Match Bearish', 
          value: `${avgWinRate * 100}%`, 
          direction: 'bearish', 
          weight: 2, 
          description: `${patternMatches.length} similar patterns favor short` 
        })
        bearishScore += 2
      }
    }

    // 8. Funding Rate Bias
    let fundingBias: 'long' | 'short' | 'neutral' = 'neutral'
    if (this.accountState.currentFundingRate.gt(0.0005)) {
      fundingBias = 'short'  // Longs paying shorts, favor short
      factors.push({ name: 'Funding Favors Short', value: this.accountState.currentFundingRate.mul(100).toNumber(), direction: 'bearish', weight: 0.5, description: 'High positive funding rate' })
      bearishScore += 0.5
    } else if (this.accountState.currentFundingRate.lt(-0.0005)) {
      fundingBias = 'long'   // Shorts paying longs, favor long
      factors.push({ name: 'Funding Favors Long', value: this.accountState.currentFundingRate.mul(100).toNumber(), direction: 'bullish', weight: 0.5, description: 'Negative funding rate' })
      bullishScore += 0.5
    }

    // ═══════════════════════════════════════════════════════════════
    // ADVANCED INDICATORS - Superhuman multi-factor awareness
    // ═══════════════════════════════════════════════════════════════

    // 9. Stochastic RSI
    const stochRsi = features.stoch_rsi_k
    const stochRsiD = features.stoch_rsi_d
    if (stochRsi !== null) {
      if (stochRsi < 20 && (stochRsiD === null || stochRsi > stochRsiD)) {
        factors.push({ name: 'Stoch RSI Oversold Reversal', value: stochRsi, direction: 'bullish', weight: 1.5, description: `Stoch RSI ${stochRsi.toFixed(0)} crossing up from oversold` })
        bullishScore += 1.5
      } else if (stochRsi > 80 && (stochRsiD === null || stochRsi < stochRsiD)) {
        factors.push({ name: 'Stoch RSI Overbought Reversal', value: stochRsi, direction: 'bearish', weight: 1.5, description: `Stoch RSI ${stochRsi.toFixed(0)} crossing down from overbought` })
        bearishScore += 1.5
      }
    }

    // 10. CCI (Commodity Channel Index)
    const cci = features.cci
    if (cci !== null) {
      if (cci < -100) {
        factors.push({ name: 'CCI Oversold', value: cci, direction: 'bullish', weight: 1, description: `CCI ${cci.toFixed(0)} deeply oversold` })
        bullishScore += 1
      } else if (cci > 100) {
        factors.push({ name: 'CCI Overbought', value: cci, direction: 'bearish', weight: 1, description: `CCI ${cci.toFixed(0)} deeply overbought` })
        bearishScore += 1
      }
    }

    // 11. MFI (Money Flow Index) - Volume-weighted RSI
    const mfi = features.mfi
    if (mfi !== null) {
      if (mfi < 20) {
        factors.push({ name: 'MFI Oversold', value: mfi, direction: 'bullish', weight: 1.5, description: `Money Flow ${mfi.toFixed(0)} indicating buying pressure` })
        bullishScore += 1.5
      } else if (mfi > 80) {
        factors.push({ name: 'MFI Overbought', value: mfi, direction: 'bearish', weight: 1.5, description: `Money Flow ${mfi.toFixed(0)} indicating selling pressure` })
        bearishScore += 1.5
      }
    }

    // 12. OBV Slope (On-Balance Volume trend)
    const obvSlope = features.obv_slope
    if (obvSlope !== null) {
      if (obvSlope > 0.5) {
        factors.push({ name: 'OBV Rising', value: obvSlope, direction: 'bullish', weight: 1, description: 'Volume accumulation detected' })
        bullishScore += 1
      } else if (obvSlope < -0.5) {
        factors.push({ name: 'OBV Falling', value: obvSlope, direction: 'bearish', weight: 1, description: 'Volume distribution detected' })
        bearishScore += 1
      }
    }

    // 13. ATR Volatility Assessment
    const atr = features.atr14
    const atrPercent = features.atr_percent
    if (atrPercent !== null) {
      if (atrPercent > 3) {
        factors.push({ name: 'High Volatility', value: `${atrPercent.toFixed(1)}%`, direction: 'neutral', weight: 0.5, description: `ATR ${atrPercent.toFixed(1)}% - widen stops, reduce size` })
      } else if (atrPercent < 1) {
        factors.push({ name: 'Low Volatility', value: `${atrPercent.toFixed(1)}%`, direction: 'neutral', weight: 0.5, description: `ATR ${atrPercent.toFixed(1)}% - tight range, breakout possible` })
      }
    }

    // 14. Price Distance from Key EMAs
    const priceVsEma200 = features.price_vs_ema200
    if (priceVsEma200 !== null) {
      if (priceVsEma200 > 5) {
        factors.push({ name: 'Extended Above EMA200', value: `${priceVsEma200.toFixed(1)}%`, direction: 'bearish', weight: 0.5, description: 'Price extended above long-term average' })
        bearishScore += 0.5
      } else if (priceVsEma200 < -5) {
        factors.push({ name: 'Extended Below EMA200', value: `${priceVsEma200.toFixed(1)}%`, direction: 'bullish', weight: 0.5, description: 'Price extended below long-term average' })
        bullishScore += 0.5
      }
    }

    // 15. Multi-Timeframe Pattern Confluence
    const mtfPatterns = this.checkMultiTimeframePatterns(features)
    if (mtfPatterns.aligned && mtfPatterns.direction !== 'neutral') {
      factors.push({ 
        name: 'MTF Confluence', 
        value: `${mtfPatterns.timeframes} TFs`, 
        direction: mtfPatterns.direction === 'long' ? 'bullish' : 'bearish', 
        weight: 2.5, 
        description: `${mtfPatterns.timeframes} timeframes aligned ${mtfPatterns.direction}` 
      })
      if (mtfPatterns.direction === 'long') {
        bullishScore += 2.5
      } else {
        bearishScore += 2.5
      }
    }

    // 16. Swing Structure Analysis
    const recentSwings = this.analyzeRecentSwings(recentCandles)
    if (recentSwings.trend === 'uptrend' && recentSwings.strength > 0.6) {
      factors.push({ name: 'Uptrend Structure', value: `${(recentSwings.strength * 100).toFixed(0)}%`, direction: 'bullish', weight: 1.5, description: 'Higher highs and higher lows' })
      bullishScore += 1.5
    } else if (recentSwings.trend === 'downtrend' && recentSwings.strength > 0.6) {
      factors.push({ name: 'Downtrend Structure', value: `${(recentSwings.strength * 100).toFixed(0)}%`, direction: 'bearish', weight: 1.5, description: 'Lower highs and lower lows' })
      bearishScore += 1.5
    }

    // ═══════════════════════════════════════════════════════════════
    // SENTIMENT FACTORS - Fear & Greed, Liquidations, L/S Ratio, etc.
    // ═══════════════════════════════════════════════════════════════

    const sentimentFactors = this.sentimentFetcher.generateSentimentFactors()
    for (const sf of sentimentFactors) {
      factors.push({
        name: sf.name,
        value: sf.value,
        direction: sf.direction,
        weight: sf.weight,
        description: `${sf.description} [${sf.source}]`
      })
      
      if (sf.direction === 'bullish') {
        bullishScore += sf.weight
      } else if (sf.direction === 'bearish') {
        bearishScore += sf.weight
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // CONFLUENCE STRENGTH MULTIPLIER
    // ═══════════════════════════════════════════════════════════════
    
    // Boost score when multiple factor categories align
    const temporalFactors = factors.filter(f => f.name.includes('UTC') || f.name.includes('Session') || f.name.includes('Month') || f.name.includes('Day') || f.name.includes('Quarter')).length
    const technicalFactors = factors.filter(f => f.name.includes('RSI') || f.name.includes('MACD') || f.name.includes('BB') || f.name.includes('EMA')).length
    const patternFactors = factors.filter(f => f.name.includes('Pattern') || f.name.includes('MTF')).length
    const sentimentCount = sentimentFactors.length
    
    // Enhanced confluence bonus when multiple categories align (including sentiment)
    const categoriesAligned = [
      temporalFactors >= 2,
      technicalFactors >= 2,
      patternFactors >= 1,
      sentimentCount >= 2
    ].filter(Boolean).length

    if (categoriesAligned >= 3) {
      const confluenceBonus = categoriesAligned >= 4 ? 2.5 : 1.5
      factors.push({ 
        name: 'Multi-Category Confluence', 
        value: `${temporalFactors}T/${technicalFactors}TA/${patternFactors}P/${sentimentCount}S`, 
        direction: bullishScore > bearishScore ? 'bullish' : 'bearish', 
        weight: confluenceBonus, 
        description: `${categoriesAligned}/4 categories aligned: ${temporalFactors} temporal + ${technicalFactors} technical + ${patternFactors} pattern + ${sentimentCount} sentiment` 
      })
      if (bullishScore > bearishScore) {
        bullishScore += confluenceBonus
      } else {
        bearishScore += confluenceBonus
      }
    }

    // Calculate final signal
    const totalScore = bullishScore + bearishScore
    const netScore = bullishScore - bearishScore
    let direction: 'long' | 'short' | 'neutral' = 'neutral'
    let score = 0
    let confidence = 0

    if (Math.abs(netScore) >= 2) {
      direction = netScore > 0 ? 'long' : 'short'
      score = Math.min(Math.abs(netScore), 10)
      confidence = Math.min(score / 10, 0.9)
    }

    // Calculate expected return based on pattern matches
    let expectedReturn = new Decimal(0)
    let winProbability = 0.5
    if (patternMatches.length > 0) {
      const avgReturn = patternMatches.reduce((sum, m) => sum + m.expectedMove, 0) / patternMatches.length
      expectedReturn = new Decimal(avgReturn).div(100)
      winProbability = patternMatches.reduce((sum, m) => sum + m.winRate, 0) / patternMatches.length
    }

    return {
      direction,
      score,
      confidence,
      factors,
      patternMatches,
      expectedReturn,
      winProbability,
      fundingBias
    }
  }

  // Check multiple timeframes for pattern alignment
  private checkMultiTimeframePatterns(features: Record<string, number | null>): { aligned: boolean; direction: 'long' | 'short' | 'neutral'; timeframes: number } {
    const timeframes = ['1m', '5m', '15m', '1h', '4h']
    let longCount = 0
    let shortCount = 0
    let totalChecked = 0

    for (const tf of timeframes) {
      const patterns = this.patternDatabase.get(tf)
      if (!patterns || patterns.length < 20) continue
      
      // Get most recent patterns and check their outcomes
      const recentPatterns = patterns.slice(-50).filter(p => p.outcome)
      if (recentPatterns.length < 10) continue
      
      totalChecked++
      const bullishPatterns = recentPatterns.filter(p => p.swingType === 'low' && p.outcome!.pnlPercent > 0).length
      const bearishPatterns = recentPatterns.filter(p => p.swingType === 'high' && p.outcome!.pnlPercent > 0).length
      
      const bullishRate = bullishPatterns / recentPatterns.length
      const bearishRate = bearishPatterns / recentPatterns.length
      
      if (bullishRate > 0.55) longCount++
      if (bearishRate > 0.55) shortCount++
    }

    if (totalChecked < 2) return { aligned: false, direction: 'neutral', timeframes: 0 }

    // Check for alignment (majority of timeframes agree)
    const threshold = Math.ceil(totalChecked * 0.6)
    if (longCount >= threshold) {
      return { aligned: true, direction: 'long', timeframes: longCount }
    } else if (shortCount >= threshold) {
      return { aligned: true, direction: 'short', timeframes: shortCount }
    }

    return { aligned: false, direction: 'neutral', timeframes: 0 }
  }

  // Analyze recent candles for swing structure (higher highs/lows or lower highs/lows)
  private analyzeRecentSwings(candles: Array<{ open: number; high: number; low: number; close: number; volume: number }>): { trend: 'uptrend' | 'downtrend' | 'ranging'; strength: number } {
    if (candles.length < 10) return { trend: 'ranging', strength: 0 }

    // Find swing highs and lows in recent candles
    const swingHighs: number[] = []
    const swingLows: number[] = []
    
    for (let i = 2; i < candles.length - 2; i++) {
      const c = candles[i]
      const prev1 = candles[i - 1]
      const prev2 = candles[i - 2]
      const next1 = candles[i + 1]
      const next2 = candles[i + 2]
      
      // Swing high: higher than neighbors
      if (c.high > prev1.high && c.high > prev2.high && c.high > next1.high && c.high > next2.high) {
        swingHighs.push(c.high)
      }
      
      // Swing low: lower than neighbors
      if (c.low < prev1.low && c.low < prev2.low && c.low < next1.low && c.low < next2.low) {
        swingLows.push(c.low)
      }
    }

    if (swingHighs.length < 2 || swingLows.length < 2) return { trend: 'ranging', strength: 0 }

    // Check for higher highs and higher lows (uptrend)
    let higherHighs = 0
    let higherLows = 0
    let lowerHighs = 0
    let lowerLows = 0

    for (let i = 1; i < swingHighs.length; i++) {
      if (swingHighs[i] > swingHighs[i - 1]) higherHighs++
      else lowerHighs++
    }

    for (let i = 1; i < swingLows.length; i++) {
      if (swingLows[i] > swingLows[i - 1]) higherLows++
      else lowerLows++
    }

    const totalSwings = swingHighs.length + swingLows.length - 2
    if (totalSwings <= 0) return { trend: 'ranging', strength: 0 }

    const uptrendScore = (higherHighs + higherLows) / totalSwings
    const downtrendScore = (lowerHighs + lowerLows) / totalSwings

    if (uptrendScore > 0.6) {
      return { trend: 'uptrend', strength: uptrendScore }
    } else if (downtrendScore > 0.6) {
      return { trend: 'downtrend', strength: downtrendScore }
    }

    return { trend: 'ranging', strength: Math.max(uptrendScore, downtrendScore) }
  }

  // Calculate position size based on margin balance and pyramid level
  calculatePositionSize(
    level: number,
    marginBalance: Decimal,
    unrealizedPnl: Decimal,
    currentPrice: Decimal
  ): { marginToUse: Decimal; quantity: Decimal; notionalValue: Decimal } | null {
    
    // Check if we can add more exposure
    const currentMarginUsed = this.hedgeState.totalMarginUsed
    const maxMarginAllowed = marginBalance.mul(MAX_TOTAL_MARGIN_PERCENT)
    
    if (currentMarginUsed.gte(maxMarginAllowed)) {
      console.log('[PyramidStrategy] Max margin exposure reached')
      return null
    }

    // Calculate required profit buffer for this level
    const bufferIndex = Math.min(level - 1, PROFIT_BUFFER_PER_LEVEL.length - 1)
    const requiredBuffer = marginBalance.mul(PROFIT_BUFFER_PER_LEVEL[bufferIndex])
    
    if (level > 1 && unrealizedPnl.lt(requiredBuffer)) {
      console.log(`[PyramidStrategy] Insufficient profit buffer for level ${level}. Need ${requiredBuffer.toFixed(2)}, have ${unrealizedPnl.toFixed(2)}`)
      return null
    }

    // Calculate margin to use
    let marginPercent: Decimal
    if (level === 1) {
      marginPercent = INITIAL_MARGIN_PERCENT
    } else {
      // Scale margin with level, but cap at max
      const scaleFactor = new Decimal(1).plus(new Decimal(level - 1).mul('0.02'))
      marginPercent = MIN_PYRAMID_ADD_PERCENT.mul(scaleFactor)
      if (marginPercent.gt(MAX_PYRAMID_ADD_PERCENT)) {
        marginPercent = MAX_PYRAMID_ADD_PERCENT
      }
    }

    // For levels > 1, also limit to 75% of unrealized profit
    let marginToUse = marginBalance.mul(marginPercent)
    if (level > 1) {
      const maxFromProfit = unrealizedPnl.mul('0.75')
      if (marginToUse.gt(maxFromProfit)) {
        marginToUse = maxFromProfit
      }
    }

    // Ensure we don't exceed available margin
    const availableMargin = maxMarginAllowed.minus(currentMarginUsed)
    if (marginToUse.gt(availableMargin)) {
      marginToUse = availableMargin
    }

    // Minimum margin check ($5)
    if (marginToUse.lt(5)) {
      console.log('[PyramidStrategy] Margin too small')
      return null
    }

    // Calculate notional and quantity
    const notionalValue = marginToUse.mul(MAX_LEVERAGE)
    const quantity = notionalValue.div(currentPrice)

    console.log(`[PyramidStrategy] Level ${level}: Margin $${marginToUse.toFixed(2)} → ` +
      `Notional $${notionalValue.toFixed(2)} → ${quantity.toFixed(4)} ETH`)

    return { marginToUse, quantity, notionalValue }
  }

  // ANTI-LIQUIDATION: Calculate liquidation price for a position
  calculateLiquidationPrice(
    side: 'long' | 'short',
    entryPrice: Decimal,
    marginUsed: Decimal,
    positionSize: Decimal
  ): Decimal {
    // Liquidation occurs when: unrealizedLoss >= margin * (1 - maintenanceMarginRate)
    // For longs: liqPrice = entryPrice * (1 - (margin / notional) * (1 - mmr))
    // For shorts: liqPrice = entryPrice * (1 + (margin / notional) * (1 - mmr))
    
    const notional = positionSize.mul(entryPrice)
    const marginRatio = marginUsed.div(notional)
    const buffer = marginRatio.mul(new Decimal(1).minus(MAINTENANCE_MARGIN_RATE))
    
    if (side === 'long') {
      return entryPrice.mul(new Decimal(1).minus(buffer))
    } else {
      return entryPrice.mul(new Decimal(1).plus(buffer))
    }
  }

  // ANTI-LIQUIDATION: Check if stop loss is safe distance from liquidation
  isStopSafeFromLiquidation(
    side: 'long' | 'short',
    stopPrice: Decimal,
    liquidationPrice: Decimal,
    currentPrice: Decimal
  ): boolean {
    if (side === 'long') {
      // For longs, stop must be ABOVE liquidation price by buffer
      const safeStopMin = liquidationPrice.mul(new Decimal(1).plus(STOP_LOSS_DISTANCE_FROM_LIQ))
      return stopPrice.gte(safeStopMin)
    } else {
      // For shorts, stop must be BELOW liquidation price by buffer
      const safeStopMax = liquidationPrice.mul(new Decimal(1).minus(STOP_LOSS_DISTANCE_FROM_LIQ))
      return stopPrice.lte(safeStopMax)
    }
  }

  // ANTI-LIQUIDATION: Adjust stop to safe distance from liquidation
  adjustStopForLiquidationSafety(
    side: 'long' | 'short',
    proposedStop: Decimal,
    liquidationPrice: Decimal
  ): Decimal {
    if (side === 'long') {
      const safeStopMin = liquidationPrice.mul(new Decimal(1).plus(STOP_LOSS_DISTANCE_FROM_LIQ))
      if (proposedStop.lt(safeStopMin)) {
        console.log(`[AntiLiq] Adjusting stop from ${proposedStop.toFixed(2)} to ${safeStopMin.toFixed(2)} (30% above liq ${liquidationPrice.toFixed(2)})`)
        return safeStopMin
      }
    } else {
      const safeStopMax = liquidationPrice.mul(new Decimal(1).minus(STOP_LOSS_DISTANCE_FROM_LIQ))
      if (proposedStop.gt(safeStopMax)) {
        console.log(`[AntiLiq] Adjusting stop from ${proposedStop.toFixed(2)} to ${safeStopMax.toFixed(2)} (30% below liq ${liquidationPrice.toFixed(2)})`)
        return safeStopMax
      }
    }
    return proposedStop
  }

  // ANTI-LIQUIDATION: Check if margin ratio is dangerously low
  checkMarginRatioSafety(
    marginBalance: Decimal,
    totalUnrealizedPnl: Decimal,
    totalPositionMargin: Decimal
  ): { safe: boolean; marginRatio: Decimal; action: 'none' | 'reduce' | 'close_all' } {
    const equity = marginBalance.plus(totalUnrealizedPnl)
    const marginRatio = totalPositionMargin.gt(0) ? equity.div(totalPositionMargin) : new Decimal(100)
    
    if (marginRatio.lt(EMERGENCY_CLOSE_MARGIN_RATIO)) {
      console.error(`[AntiLiq] 🚨 CRITICAL: Margin ratio ${marginRatio.toFixed(2)} below ${EMERGENCY_CLOSE_MARGIN_RATIO}! CLOSE ALL POSITIONS!`)
      return { safe: false, marginRatio, action: 'close_all' }
    }
    
    if (marginRatio.lt(LIQUIDATION_BUFFER_PERCENT)) {
      console.warn(`[AntiLiq] ⚠️ Warning: Margin ratio ${marginRatio.toFixed(2)} approaching danger zone. Reduce exposure.`)
      return { safe: false, marginRatio, action: 'reduce' }
    }
    
    return { safe: true, marginRatio, action: 'none' }
  }

  // Calculate stop loss for current pyramid level (with anti-liquidation)
  calculateStopLoss(
    side: 'long' | 'short',
    entryPrice: Decimal,
    level: number,
    highWaterMark: Decimal,
    marginUsed?: Decimal,
    positionSize?: Decimal
  ): { stopPrice: Decimal; trailingCallback: Decimal; liquidationPrice?: Decimal } {
    const stopIndex = Math.min(level - 1, STOP_LOSS_PER_LEVEL.length - 1)
    const callbackIndex = Math.min(level - 1, TRAILING_CALLBACK_PER_LEVEL.length - 1)
    
    const stopOffset = STOP_LOSS_PER_LEVEL[stopIndex]
    const trailingCallback = TRAILING_CALLBACK_PER_LEVEL[callbackIndex]

    let stopPrice: Decimal
    if (side === 'long') {
      // For longs: stop below entry/high water mark
      const basePrice = highWaterMark.gt(entryPrice) ? highWaterMark : entryPrice
      stopPrice = basePrice.mul(new Decimal(1).plus(stopOffset))
      
      // If we have profit locked, use trailing from high
      if (stopOffset.gt(0)) {
        const trailingStop = highWaterMark.mul(new Decimal(1).minus(trailingCallback))
        if (trailingStop.gt(stopPrice)) {
          stopPrice = trailingStop
        }
      }
    } else {
      // For shorts: stop above entry/low water mark
      const basePrice = highWaterMark.lt(entryPrice) ? highWaterMark : entryPrice
      stopPrice = basePrice.mul(new Decimal(1).minus(stopOffset))
      
      if (stopOffset.gt(0)) {
        const trailingStop = highWaterMark.mul(new Decimal(1).plus(trailingCallback))
        if (trailingStop.lt(stopPrice)) {
          stopPrice = trailingStop
        }
      }
    }

    // ANTI-LIQUIDATION: Ensure stop is safe distance from liquidation
    let liquidationPrice: Decimal | undefined
    if (marginUsed && positionSize && marginUsed.gt(0) && positionSize.gt(0)) {
      liquidationPrice = this.calculateLiquidationPrice(side, entryPrice, marginUsed, positionSize)
      stopPrice = this.adjustStopForLiquidationSafety(side, stopPrice, liquidationPrice)
    }

    return { stopPrice, trailingCallback, liquidationPrice }
  }

  // Check if we should open a hedge position
  shouldOpenHedge(signal: ConfluenceSignal): boolean {
    if (!this.config.enableHedgeMode) return false
    if (!this.hedgeState.primaryPosition) return false
    if (this.hedgeState.hedgePosition) return false  // Already have hedge

    const primary = this.hedgeState.primaryPosition
    
    // Only hedge when primary is in profit > 3%
    if (primary.unrealizedPnlPercent.lt(3)) return false

    // Hedge when signal direction opposes primary
    if (primary.side === 'long' && signal.direction === 'short' && signal.score >= 3) {
      return true
    }
    if (primary.side === 'short' && signal.direction === 'long' && signal.score >= 3) {
      return true
    }

    // Also hedge when funding strongly favors opposite
    if (primary.side === 'long' && signal.fundingBias === 'short') {
      return true
    }
    if (primary.side === 'short' && signal.fundingBias === 'long') {
      return true
    }

    return false
  }

  // Calculate hedge position size (25-50% of primary)
  calculateHedgeSize(currentPrice: Decimal): { marginToUse: Decimal; quantity: Decimal } | null {
    if (!this.hedgeState.primaryPosition) return null

    const primary = this.hedgeState.primaryPosition
    
    // Hedge size is 25-50% of primary notional, scaled by profit
    const profitMultiplier = Decimal.min(primary.unrealizedPnlPercent.div(10), new Decimal(1))
    const hedgePercent = HEDGE_SIZE_PERCENT.plus(profitMultiplier.mul('0.25'))
    
    const hedgeNotional = primary.totalNotionalValue.mul(hedgePercent)
    const marginToUse = hedgeNotional.div(MAX_LEVERAGE)
    const quantity = hedgeNotional.div(currentPrice)

    // Check margin available
    if (marginToUse.gt(this.accountState.availableMargin)) {
      return null
    }

    return { marginToUse, quantity }
  }

  // Main decision function - called on each new candle/tick
  evaluateMarket(
    currentPrice: Decimal,
    features: Record<string, number | null>,
    recentCandles: Array<{ open: number; high: number; low: number; close: number; volume: number }>
  ): {
    action: 'open_long' | 'open_short' | 'add_long' | 'add_short' | 'close_long' | 'close_short' | 
            'hedge_long' | 'hedge_short' | 'update_stops' | 'take_profit' | 'none'
    signal: ConfluenceSignal
    positionSize?: { marginToUse: Decimal; quantity: Decimal; notionalValue: Decimal }
    stopLoss?: Decimal
    takeProfit?: Decimal
    reason: string
  } {
    // Generate confluence signal
    const signal = this.generateConfluenceSignal(currentPrice, features, recentCandles)
    
    // Check cooldown
    const now = Date.now()
    if (now - this.lastTradeTime < this.config.cooldownMinutes * 60 * 1000) {
      return { action: 'none', signal, reason: 'Cooldown active' }
    }

    // Check consecutive losses circuit breaker
    if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      return { action: 'none', signal, reason: `Circuit breaker: ${this.consecutiveLosses} consecutive losses` }
    }

    // Update positions with current price
    this.updatePositionPnL(currentPrice)

    // Check if we should take profit on existing positions
    const takeProfitAction = this.checkTakeProfit(currentPrice, signal)
    if (takeProfitAction) return takeProfitAction

    // Check if stops should be updated
    const stopUpdateAction = this.checkStopUpdates(currentPrice)
    if (stopUpdateAction) return stopUpdateAction

    // Check if we should hedge
    if (this.shouldOpenHedge(signal)) {
      const hedgeSize = this.calculateHedgeSize(currentPrice)
      if (hedgeSize) {
        const hedgeSide = this.hedgeState.primaryPosition!.side === 'long' ? 'short' : 'long'
        return {
          action: hedgeSide === 'long' ? 'hedge_long' : 'hedge_short',
          signal,
          positionSize: { ...hedgeSize, notionalValue: hedgeSize.marginToUse.mul(MAX_LEVERAGE) },
          reason: `Opening hedge ${hedgeSide} while primary in profit`
        }
      }
    }

    // Check if we should add to existing position (pyramid)
    if (this.hedgeState.primaryPosition) {
      const primary = this.hedgeState.primaryPosition
      const pyramidAction = this.checkPyramidAdd(currentPrice, signal, primary)
      if (pyramidAction) return pyramidAction
    }

    // Check if we should open new position
    if (!this.hedgeState.primaryPosition && signal.score >= this.config.minConfluenceToEnter) {
      const posSize = this.calculatePositionSize(
        1, 
        this.accountState.marginBalance, 
        new Decimal(0), 
        currentPrice
      )
      
      if (posSize && signal.winProbability >= 0.5) {
        const { stopPrice } = this.calculateStopLoss(signal.direction as 'long' | 'short', currentPrice, 1, currentPrice)
        const riskPercent = signal.direction === 'long' 
          ? currentPrice.minus(stopPrice).div(currentPrice)
          : stopPrice.minus(currentPrice).div(currentPrice)
        
        const takeProfit = signal.direction === 'long'
          ? currentPrice.mul(new Decimal(1).plus(riskPercent.mul(this.config.takeProfitMultiplier)))
          : currentPrice.mul(new Decimal(1).minus(riskPercent.mul(this.config.takeProfitMultiplier)))

        return {
          action: signal.direction === 'long' ? 'open_long' : 'open_short',
          signal,
          positionSize: posSize,
          stopLoss: stopPrice,
          takeProfit,
          reason: `Confluence score ${signal.score}, ${(signal.winProbability * 100).toFixed(0)}% win probability`
        }
      }
    }

    return { action: 'none', signal, reason: 'No actionable signal' }
  }

  private updatePositionPnL(currentPrice: Decimal): void {
    if (this.hedgeState.primaryPosition) {
      const pos = this.hedgeState.primaryPosition
      if (pos.side === 'long') {
        pos.unrealizedPnl = currentPrice.minus(pos.avgEntryPrice).mul(pos.totalQuantity)
        pos.unrealizedPnlPercent = currentPrice.minus(pos.avgEntryPrice).div(pos.avgEntryPrice).mul(100)
        if (currentPrice.gt(pos.highWaterMark)) {
          pos.highWaterMark = currentPrice
        }
      } else {
        pos.unrealizedPnl = pos.avgEntryPrice.minus(currentPrice).mul(pos.totalQuantity)
        pos.unrealizedPnlPercent = pos.avgEntryPrice.minus(currentPrice).div(pos.avgEntryPrice).mul(100)
        if (currentPrice.lt(pos.highWaterMark)) {
          pos.highWaterMark = currentPrice
        }
      }
    }

    // Update hedge position similarly
    if (this.hedgeState.hedgePosition) {
      const pos = this.hedgeState.hedgePosition
      if (pos.side === 'long') {
        pos.unrealizedPnl = currentPrice.minus(pos.avgEntryPrice).mul(pos.totalQuantity)
        pos.unrealizedPnlPercent = currentPrice.minus(pos.avgEntryPrice).div(pos.avgEntryPrice).mul(100)
      } else {
        pos.unrealizedPnl = pos.avgEntryPrice.minus(currentPrice).mul(pos.totalQuantity)
        pos.unrealizedPnlPercent = pos.avgEntryPrice.minus(currentPrice).div(pos.avgEntryPrice).mul(100)
      }
    }

    // Update totals
    this.hedgeState.totalUnrealizedPnl = (this.hedgeState.primaryPosition?.unrealizedPnl || new Decimal(0))
      .plus(this.hedgeState.hedgePosition?.unrealizedPnl || new Decimal(0))
  }

  private checkTakeProfit(currentPrice: Decimal, signal: ConfluenceSignal): ReturnType<typeof this.evaluateMarket> | null {
    if (!this.hedgeState.primaryPosition) return null
    
    const pos = this.hedgeState.primaryPosition
    
    // Take profit more aggressively as pyramid grows
    const profitThreshold = new Decimal(2).plus(new Decimal(pos.levels.length).mul('0.5'))
    
    if (pos.unrealizedPnlPercent.gt(profitThreshold)) {
      // Check if signal is reversing
      if ((pos.side === 'long' && signal.direction === 'short') ||
          (pos.side === 'short' && signal.direction === 'long')) {
        return {
          action: pos.side === 'long' ? 'close_long' : 'close_short',
          signal,
          reason: `Taking profit at ${pos.unrealizedPnlPercent.toFixed(2)}% with reversal signal`
        }
      }
    }

    // Aggressive take profit on large pyramids
    if (pos.levels.length >= 4 && pos.unrealizedPnlPercent.gt(5)) {
      return {
        action: pos.side === 'long' ? 'close_long' : 'close_short',
        signal,
        reason: `Taking profit on ${pos.levels.length}-level pyramid at ${pos.unrealizedPnlPercent.toFixed(2)}%`
      }
    }

    return null
  }

  private checkStopUpdates(currentPrice: Decimal): ReturnType<typeof this.evaluateMarket> | null {
    if (!this.hedgeState.primaryPosition) return null
    
    const pos = this.hedgeState.primaryPosition
    const { stopPrice } = this.calculateStopLoss(pos.side, pos.avgEntryPrice, pos.levels.length, pos.highWaterMark)
    
    // Only emit update if stop moved significantly
    if (stopPrice.minus(pos.currentStopLoss).abs().div(pos.currentStopLoss).gt(0.001)) {
      return {
        action: 'update_stops',
        signal: this.generateConfluenceSignal(currentPrice, {}, []),
        stopLoss: stopPrice,
        reason: `Trailing stop updated to ${stopPrice.toFixed(2)}`
      }
    }

    return null
  }

  private checkPyramidAdd(
    currentPrice: Decimal, 
    signal: ConfluenceSignal, 
    pos: PyramidPosition
  ): ReturnType<typeof this.evaluateMarket> | null {
    // Check if signal matches position direction
    if (pos.side !== signal.direction) return null
    
    // Check confluence threshold for adding
    if (signal.score < this.config.minConfluenceToAdd) return null
    
    // Check max levels
    if (pos.levels.length >= this.config.maxPyramidLevels) return null
    
    // Calculate new position size
    const nextLevel = pos.levels.length + 1
    const posSize = this.calculatePositionSize(
      nextLevel,
      this.accountState.marginBalance,
      pos.unrealizedPnl,
      currentPrice
    )
    
    if (!posSize) return null

    const { stopPrice } = this.calculateStopLoss(pos.side, currentPrice, nextLevel, pos.highWaterMark)

    return {
      action: pos.side === 'long' ? 'add_long' : 'add_short',
      signal,
      positionSize: posSize,
      stopLoss: stopPrice,
      reason: `Pyramid level ${nextLevel}: confluence ${signal.score}, profit buffer OK`
    }
  }

  // Record trade result for statistics
  recordTradeResult(pnl: Decimal, isWin: boolean): void {
    this.sessionStats.totalTrades++
    this.sessionStats.totalPnl = this.sessionStats.totalPnl.plus(pnl)
    
    if (isWin) {
      this.sessionStats.winningTrades++
      this.consecutiveLosses = 0
      if (pnl.gt(this.sessionStats.largestWin)) {
        this.sessionStats.largestWin = pnl
      }
    } else {
      this.consecutiveLosses++
      if (pnl.lt(this.sessionStats.largestLoss)) {
        this.sessionStats.largestLoss = pnl
      }
    }

    this.lastTradeTime = Date.now()
    this.emit('tradeResult', { pnl, isWin, stats: this.sessionStats })
  }

  // Get current state
  getState() {
    return {
      hedgeState: this.hedgeState,
      accountState: this.accountState,
      sessionStats: this.sessionStats,
      consecutiveLosses: this.consecutiveLosses,
      patternDbSize: Array.from(this.patternDatabase.values()).reduce((sum, p) => sum + p.length, 0)
    }
  }

  // Reset circuit breaker
  resetCircuitBreaker(): void {
    this.consecutiveLosses = 0
    this.emit('circuitBreakerReset')
  }
}
