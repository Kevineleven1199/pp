import { EventEmitter } from 'events'
import Decimal from 'decimal.js'

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN })

// Data refresh intervals
const FEAR_GREED_REFRESH_MS = 60 * 60 * 1000      // 1 hour
const LIQUIDATION_REFRESH_MS = 5 * 60 * 1000      // 5 minutes
const OPEN_INTEREST_REFRESH_MS = 5 * 60 * 1000    // 5 minutes
const LONG_SHORT_REFRESH_MS = 5 * 60 * 1000       // 5 minutes

// API Endpoints
const FEAR_GREED_API = 'https://api.alternative.me/fng/?limit=10'
const COINGLASS_BASE = 'https://open-api.coinglass.com/public/v2'

export interface FearGreedData {
  value: number           // 0-100
  classification: string  // Extreme Fear, Fear, Neutral, Greed, Extreme Greed
  timestamp: number
  previousValue: number
  trend: 'rising' | 'falling' | 'stable'
}

export interface LiquidationData {
  symbol: string
  longLiquidations24h: Decimal
  shortLiquidations24h: Decimal
  totalLiquidations24h: Decimal
  longLiquidations1h: Decimal
  shortLiquidations1h: Decimal
  largestLiquidation: Decimal
  liquidationRatio: number  // long/short ratio of liquidations
  recentLiquidationSurge: boolean
  timestamp: number
}

export interface OpenInterestData {
  symbol: string
  openInterest: Decimal
  openInterestChange24h: number  // % change
  openInterestChange1h: number
  allTimeHigh: Decimal
  percentOfATH: number
  trend: 'increasing' | 'decreasing' | 'stable'
  timestamp: number
}

export interface LongShortRatioData {
  symbol: string
  longRatio: number       // % of longs
  shortRatio: number      // % of shorts
  longShortRatio: number  // long/short ratio
  topTraderLongRatio: number
  topTraderShortRatio: number
  retailVsWhale: 'aligned' | 'divergent'
  extremeLevel: 'extreme_long' | 'extreme_short' | 'neutral'
  timestamp: number
}

export interface FundingRateTrend {
  symbol: string
  currentRate: Decimal
  avgRate8h: Decimal
  avgRate24h: Decimal
  avgRate7d: Decimal
  trend: 'increasingly_positive' | 'increasingly_negative' | 'stable' | 'reversing'
  annualizedRate: number
  extremeLevel: 'extreme_positive' | 'extreme_negative' | 'normal'
  timestamp: number
}

export interface MarketSentiment {
  fearGreed: FearGreedData | null
  liquidations: LiquidationData | null
  openInterest: OpenInterestData | null
  longShortRatio: LongShortRatioData | null
  fundingTrend: FundingRateTrend | null
  overallSentiment: 'extreme_fear' | 'fear' | 'neutral' | 'greed' | 'extreme_greed'
  tradingBias: 'strong_long' | 'long' | 'neutral' | 'short' | 'strong_short'
  lastUpdate: number
}

export interface SentimentFactor {
  name: string
  value: number | string
  direction: 'bullish' | 'bearish' | 'neutral'
  weight: number
  description: string
  source: string
}

export class MarketSentimentFetcher extends EventEmitter {
  private sentiment: MarketSentiment
  private refreshIntervals: NodeJS.Timeout[] = []
  private coinglassApiKey: string = ''  // Optional - works without for basic data

  constructor(coinglassApiKey?: string) {
    super()
    this.coinglassApiKey = coinglassApiKey || ''
    this.sentiment = this.initSentiment()
  }

  private initSentiment(): MarketSentiment {
    return {
      fearGreed: null,
      liquidations: null,
      openInterest: null,
      longShortRatio: null,
      fundingTrend: null,
      overallSentiment: 'neutral',
      tradingBias: 'neutral',
      lastUpdate: 0
    }
  }

  // Fetch Fear & Greed Index from Alternative.me (free API)
  async fetchFearGreedIndex(): Promise<FearGreedData | null> {
    try {
      const response = await fetch(FEAR_GREED_API)
      const data = await response.json() as any
      
      if (!data.data || data.data.length === 0) return null

      const current = data.data[0]
      const previous = data.data.length > 1 ? data.data[1] : current
      
      const value = parseInt(current.value)
      const prevValue = parseInt(previous.value)
      
      let classification = 'Neutral'
      if (value <= 20) classification = 'Extreme Fear'
      else if (value <= 40) classification = 'Fear'
      else if (value <= 60) classification = 'Neutral'
      else if (value <= 80) classification = 'Greed'
      else classification = 'Extreme Greed'

      let trend: 'rising' | 'falling' | 'stable' = 'stable'
      if (value - prevValue > 5) trend = 'rising'
      else if (prevValue - value > 5) trend = 'falling'

      const fearGreed: FearGreedData = {
        value,
        classification,
        timestamp: parseInt(current.timestamp) * 1000,
        previousValue: prevValue,
        trend
      }

      this.sentiment.fearGreed = fearGreed
      console.log(`[Sentiment] Fear & Greed: ${value} (${classification})`)
      return fearGreed
    } catch (err) {
      console.error('[Sentiment] Failed to fetch Fear & Greed:', err)
      return null
    }
  }

  // Fetch liquidation data from AsterDEX or alternative sources
  async fetchLiquidationData(symbol: string = 'ETHUSDT'): Promise<LiquidationData | null> {
    try {
      // Try to fetch from AsterDEX API directly
      const response = await fetch(`https://fapi.asterdex.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=24`)
      
      // If AsterDEX doesn't provide liquidation data, we estimate from price action
      // and use available data to calculate liquidation zones
      
      // For now, return estimated data based on volatility
      const liquidations: LiquidationData = {
        symbol,
        longLiquidations24h: new Decimal(0),
        shortLiquidations24h: new Decimal(0),
        totalLiquidations24h: new Decimal(0),
        longLiquidations1h: new Decimal(0),
        shortLiquidations1h: new Decimal(0),
        largestLiquidation: new Decimal(0),
        liquidationRatio: 1,
        recentLiquidationSurge: false,
        timestamp: Date.now()
      }

      // Try Coinglass if API key provided
      if (this.coinglassApiKey) {
        try {
          const cgResponse = await fetch(`${COINGLASS_BASE}/liquidation/info?symbol=ETH`, {
            headers: { 'coinglassSecret': this.coinglassApiKey }
          })
          const cgData = await cgResponse.json() as any
          
          if (cgData.data) {
            liquidations.longLiquidations24h = new Decimal(cgData.data.longVolUsd || 0)
            liquidations.shortLiquidations24h = new Decimal(cgData.data.shortVolUsd || 0)
            liquidations.totalLiquidations24h = liquidations.longLiquidations24h.plus(liquidations.shortLiquidations24h)
            
            if (!liquidations.shortLiquidations24h.isZero()) {
              liquidations.liquidationRatio = liquidations.longLiquidations24h.div(liquidations.shortLiquidations24h).toNumber()
            }
            
            // Surge if liquidations > $50M in 24h
            liquidations.recentLiquidationSurge = liquidations.totalLiquidations24h.gt(50000000)
          }
        } catch {}
      }

      this.sentiment.liquidations = liquidations
      return liquidations
    } catch (err) {
      console.error('[Sentiment] Failed to fetch liquidation data:', err)
      return null
    }
  }

  // Fetch Open Interest data
  async fetchOpenInterest(symbol: string = 'ETHUSDT'): Promise<OpenInterestData | null> {
    try {
      // Fetch from AsterDEX
      const response = await fetch(`https://fapi.asterdex.com/fapi/v1/openInterest?symbol=${symbol}`)
      const data = await response.json() as any
      
      const currentOI = new Decimal(data.openInterest || 0)
      
      // Get historical for comparison (would need separate endpoint)
      const openInterest: OpenInterestData = {
        symbol,
        openInterest: currentOI,
        openInterestChange24h: 0,
        openInterestChange1h: 0,
        allTimeHigh: currentOI,
        percentOfATH: 100,
        trend: 'stable',
        timestamp: Date.now()
      }

      // Try to get OI statistics if Coinglass key available
      if (this.coinglassApiKey) {
        try {
          const cgResponse = await fetch(`${COINGLASS_BASE}/open_interest?symbol=ETH&interval=0`, {
            headers: { 'coinglassSecret': this.coinglassApiKey }
          })
          const cgData = await cgResponse.json() as any
          
          if (cgData.data && cgData.data.length > 0) {
            const latest = cgData.data[0]
            openInterest.openInterest = new Decimal(latest.openInterest || 0)
            openInterest.openInterestChange24h = latest.h24Change || 0
            
            if (openInterest.openInterestChange24h > 5) {
              openInterest.trend = 'increasing'
            } else if (openInterest.openInterestChange24h < -5) {
              openInterest.trend = 'decreasing'
            }
          }
        } catch {}
      }

      this.sentiment.openInterest = openInterest
      console.log(`[Sentiment] Open Interest: ${openInterest.openInterest.toFixed(0)} (${openInterest.trend})`)
      return openInterest
    } catch (err) {
      console.error('[Sentiment] Failed to fetch open interest:', err)
      return null
    }
  }

  // Fetch Long/Short Ratio data
  async fetchLongShortRatio(symbol: string = 'ETHUSDT'): Promise<LongShortRatioData | null> {
    try {
      // Fetch from AsterDEX
      const [globalResponse, topResponse] = await Promise.all([
        fetch(`https://fapi.asterdex.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`),
        fetch(`https://fapi.asterdex.com/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`)
      ])

      const globalData = await globalResponse.json() as any[]
      const topData = await topResponse.json() as any[]

      let longShortRatio: LongShortRatioData = {
        symbol,
        longRatio: 50,
        shortRatio: 50,
        longShortRatio: 1,
        topTraderLongRatio: 50,
        topTraderShortRatio: 50,
        retailVsWhale: 'aligned',
        extremeLevel: 'neutral',
        timestamp: Date.now()
      }

      if (globalData && globalData.length > 0) {
        const ratio = parseFloat(globalData[0].longShortRatio || 1)
        longShortRatio.longShortRatio = ratio
        longShortRatio.longRatio = (ratio / (1 + ratio)) * 100
        longShortRatio.shortRatio = 100 - longShortRatio.longRatio
        
        // Extreme levels
        if (ratio > 2.5) longShortRatio.extremeLevel = 'extreme_long'
        else if (ratio < 0.4) longShortRatio.extremeLevel = 'extreme_short'
      }

      if (topData && topData.length > 0) {
        const topRatio = parseFloat(topData[0].longShortRatio || 1)
        longShortRatio.topTraderLongRatio = (topRatio / (1 + topRatio)) * 100
        longShortRatio.topTraderShortRatio = 100 - longShortRatio.topTraderLongRatio
        
        // Check if retail and whales diverge
        const retailBias = longShortRatio.longRatio > 55 ? 'long' : longShortRatio.shortRatio > 55 ? 'short' : 'neutral'
        const whaleBias = longShortRatio.topTraderLongRatio > 55 ? 'long' : longShortRatio.topTraderShortRatio > 55 ? 'short' : 'neutral'
        
        longShortRatio.retailVsWhale = (retailBias === whaleBias || retailBias === 'neutral' || whaleBias === 'neutral') 
          ? 'aligned' : 'divergent'
      }

      this.sentiment.longShortRatio = longShortRatio
      console.log(`[Sentiment] L/S Ratio: ${longShortRatio.longShortRatio.toFixed(2)} (${longShortRatio.extremeLevel})`)
      return longShortRatio
    } catch (err) {
      console.error('[Sentiment] Failed to fetch long/short ratio:', err)
      return null
    }
  }

  // Fetch Funding Rate Trend
  async fetchFundingRateTrend(symbol: string = 'ETHUSDT'): Promise<FundingRateTrend | null> {
    try {
      const response = await fetch(`https://fapi.asterdex.com/fapi/v1/fundingRate?symbol=${symbol}&limit=21`)
      const data = await response.json() as any[]
      
      if (!data || data.length === 0) return null

      const rates = data.map(d => parseFloat(d.fundingRate))
      const currentRate = rates[0]
      
      // Calculate averages
      const avg8h = rates.slice(0, 1).reduce((a, b) => a + b, 0)
      const avg24h = rates.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, rates.length)
      const avg7d = rates.reduce((a, b) => a + b, 0) / rates.length

      // Determine trend
      let trend: FundingRateTrend['trend'] = 'stable'
      if (currentRate > avg24h * 1.2 && currentRate > 0) trend = 'increasingly_positive'
      else if (currentRate < avg24h * 0.8 && currentRate < 0) trend = 'increasingly_negative'
      else if ((currentRate > 0 && avg24h < 0) || (currentRate < 0 && avg24h > 0)) trend = 'reversing'

      // Extreme levels
      let extremeLevel: FundingRateTrend['extremeLevel'] = 'normal'
      if (currentRate > 0.001) extremeLevel = 'extreme_positive'  // > 0.1%
      else if (currentRate < -0.001) extremeLevel = 'extreme_negative'

      // Annualized rate (3 fundings per day * 365)
      const annualizedRate = currentRate * 3 * 365 * 100

      const fundingTrend: FundingRateTrend = {
        symbol,
        currentRate: new Decimal(currentRate),
        avgRate8h: new Decimal(avg8h),
        avgRate24h: new Decimal(avg24h),
        avgRate7d: new Decimal(avg7d),
        trend,
        annualizedRate,
        extremeLevel,
        timestamp: Date.now()
      }

      this.sentiment.fundingTrend = fundingTrend
      console.log(`[Sentiment] Funding Rate: ${(currentRate * 100).toFixed(4)}% (${trend}, ${annualizedRate.toFixed(1)}% APR)`)
      return fundingTrend
    } catch (err) {
      console.error('[Sentiment] Failed to fetch funding rate trend:', err)
      return null
    }
  }

  // Calculate overall sentiment from all data
  private calculateOverallSentiment(): void {
    let bullishPoints = 0
    let bearishPoints = 0

    // Fear & Greed contribution
    if (this.sentiment.fearGreed) {
      const fg = this.sentiment.fearGreed.value
      if (fg <= 25) bullishPoints += 2    // Extreme fear = contrarian bullish
      else if (fg <= 40) bullishPoints += 1
      else if (fg >= 75) bearishPoints += 2  // Extreme greed = contrarian bearish
      else if (fg >= 60) bearishPoints += 1
    }

    // Long/Short Ratio contribution (contrarian)
    if (this.sentiment.longShortRatio) {
      const lsr = this.sentiment.longShortRatio
      if (lsr.extremeLevel === 'extreme_long') bearishPoints += 2  // Too many longs = bearish
      else if (lsr.extremeLevel === 'extreme_short') bullishPoints += 2
      
      // Whale divergence
      if (lsr.retailVsWhale === 'divergent') {
        // Follow whales, fade retail
        if (lsr.topTraderLongRatio > 55) bullishPoints += 1
        else if (lsr.topTraderShortRatio > 55) bearishPoints += 1
      }
    }

    // Funding Rate contribution (contrarian)
    if (this.sentiment.fundingTrend) {
      const fr = this.sentiment.fundingTrend
      if (fr.extremeLevel === 'extreme_positive') bearishPoints += 1  // High funding = fade longs
      else if (fr.extremeLevel === 'extreme_negative') bullishPoints += 1
    }

    // Liquidation contribution
    if (this.sentiment.liquidations) {
      const liq = this.sentiment.liquidations
      if (liq.liquidationRatio > 2) bullishPoints += 1  // More longs liquidated = contrarian bullish
      else if (liq.liquidationRatio < 0.5) bearishPoints += 1
    }

    // Open Interest contribution
    if (this.sentiment.openInterest) {
      const oi = this.sentiment.openInterest
      if (oi.trend === 'increasing' && oi.openInterestChange24h > 10) {
        // Rising OI can mean either direction strengthening
      }
    }

    // Determine overall sentiment
    const netScore = bullishPoints - bearishPoints
    if (netScore >= 4) this.sentiment.overallSentiment = 'extreme_fear'  // Contrarian bullish
    else if (netScore >= 2) this.sentiment.overallSentiment = 'fear'
    else if (netScore <= -4) this.sentiment.overallSentiment = 'extreme_greed'  // Contrarian bearish
    else if (netScore <= -2) this.sentiment.overallSentiment = 'greed'
    else this.sentiment.overallSentiment = 'neutral'

    // Trading bias
    if (netScore >= 3) this.sentiment.tradingBias = 'strong_long'
    else if (netScore >= 1) this.sentiment.tradingBias = 'long'
    else if (netScore <= -3) this.sentiment.tradingBias = 'strong_short'
    else if (netScore <= -1) this.sentiment.tradingBias = 'short'
    else this.sentiment.tradingBias = 'neutral'

    this.sentiment.lastUpdate = Date.now()
  }

  // Generate confluence factors from sentiment data
  generateSentimentFactors(): SentimentFactor[] {
    const factors: SentimentFactor[] = []

    // Fear & Greed Index
    if (this.sentiment.fearGreed) {
      const fg = this.sentiment.fearGreed
      
      if (fg.value <= 20) {
        factors.push({
          name: 'Extreme Fear',
          value: fg.value,
          direction: 'bullish',
          weight: 2.5,
          description: `Fear & Greed at ${fg.value} - historically great buying opportunity`,
          source: 'Alternative.me'
        })
      } else if (fg.value <= 35) {
        factors.push({
          name: 'Fear Zone',
          value: fg.value,
          direction: 'bullish',
          weight: 1.5,
          description: `Fear & Greed at ${fg.value} - contrarian bullish`,
          source: 'Alternative.me'
        })
      } else if (fg.value >= 80) {
        factors.push({
          name: 'Extreme Greed',
          value: fg.value,
          direction: 'bearish',
          weight: 2.5,
          description: `Fear & Greed at ${fg.value} - historically time to take profits`,
          source: 'Alternative.me'
        })
      } else if (fg.value >= 65) {
        factors.push({
          name: 'Greed Zone',
          value: fg.value,
          direction: 'bearish',
          weight: 1.5,
          description: `Fear & Greed at ${fg.value} - contrarian bearish`,
          source: 'Alternative.me'
        })
      }

      // Trend factor
      if (fg.trend === 'rising' && fg.value < 50) {
        factors.push({
          name: 'Fear Recovering',
          value: `${fg.previousValue}→${fg.value}`,
          direction: 'bullish',
          weight: 1,
          description: 'Sentiment improving from fear levels',
          source: 'Alternative.me'
        })
      } else if (fg.trend === 'falling' && fg.value > 50) {
        factors.push({
          name: 'Greed Fading',
          value: `${fg.previousValue}→${fg.value}`,
          direction: 'bearish',
          weight: 1,
          description: 'Sentiment declining from greed levels',
          source: 'Alternative.me'
        })
      }
    }

    // Long/Short Ratio (contrarian signals)
    if (this.sentiment.longShortRatio) {
      const lsr = this.sentiment.longShortRatio

      if (lsr.extremeLevel === 'extreme_long') {
        factors.push({
          name: 'Crowded Long',
          value: `${lsr.longRatio.toFixed(0)}% longs`,
          direction: 'bearish',
          weight: 2,
          description: `L/S ratio ${lsr.longShortRatio.toFixed(2)} - too many longs, fade the crowd`,
          source: 'AsterDEX'
        })
      } else if (lsr.extremeLevel === 'extreme_short') {
        factors.push({
          name: 'Crowded Short',
          value: `${lsr.shortRatio.toFixed(0)}% shorts`,
          direction: 'bullish',
          weight: 2,
          description: `L/S ratio ${lsr.longShortRatio.toFixed(2)} - too many shorts, short squeeze potential`,
          source: 'AsterDEX'
        })
      }

      // Whale vs Retail divergence
      if (lsr.retailVsWhale === 'divergent') {
        if (lsr.topTraderLongRatio > 55) {
          factors.push({
            name: 'Whales Long vs Retail',
            value: `${lsr.topTraderLongRatio.toFixed(0)}% top traders long`,
            direction: 'bullish',
            weight: 1.5,
            description: 'Smart money positioning long while retail shorts',
            source: 'AsterDEX'
          })
        } else if (lsr.topTraderShortRatio > 55) {
          factors.push({
            name: 'Whales Short vs Retail',
            value: `${lsr.topTraderShortRatio.toFixed(0)}% top traders short`,
            direction: 'bearish',
            weight: 1.5,
            description: 'Smart money positioning short while retail longs',
            source: 'AsterDEX'
          })
        }
      }
    }

    // Funding Rate
    if (this.sentiment.fundingTrend) {
      const fr = this.sentiment.fundingTrend

      if (fr.extremeLevel === 'extreme_positive') {
        factors.push({
          name: 'Extreme Positive Funding',
          value: `${(fr.currentRate.toNumber() * 100).toFixed(3)}%`,
          direction: 'bearish',
          weight: 2,
          description: `${fr.annualizedRate.toFixed(0)}% APR funding - expensive to hold longs`,
          source: 'AsterDEX'
        })
      } else if (fr.extremeLevel === 'extreme_negative') {
        factors.push({
          name: 'Extreme Negative Funding',
          value: `${(fr.currentRate.toNumber() * 100).toFixed(3)}%`,
          direction: 'bullish',
          weight: 2,
          description: `${fr.annualizedRate.toFixed(0)}% APR funding - paid to hold longs`,
          source: 'AsterDEX'
        })
      }

      // Funding trend
      if (fr.trend === 'increasingly_positive') {
        factors.push({
          name: 'Funding Rising',
          value: 'Trend ↑',
          direction: 'bearish',
          weight: 1,
          description: 'Funding rate trending higher - longs getting expensive',
          source: 'AsterDEX'
        })
      } else if (fr.trend === 'increasingly_negative') {
        factors.push({
          name: 'Funding Falling',
          value: 'Trend ↓',
          direction: 'bullish',
          weight: 1,
          description: 'Funding rate trending lower - shorts getting expensive',
          source: 'AsterDEX'
        })
      } else if (fr.trend === 'reversing') {
        factors.push({
          name: 'Funding Reversal',
          value: 'Flip',
          direction: 'neutral',
          weight: 0.5,
          description: 'Funding rate crossing zero - sentiment shift',
          source: 'AsterDEX'
        })
      }
    }

    // Liquidation data
    if (this.sentiment.liquidations) {
      const liq = this.sentiment.liquidations

      if (liq.recentLiquidationSurge) {
        factors.push({
          name: 'Liquidation Cascade',
          value: `$${(liq.totalLiquidations24h.toNumber() / 1e6).toFixed(0)}M`,
          direction: 'neutral',
          weight: 1.5,
          description: 'High liquidation volume - volatility and potential reversal',
          source: 'Market Data'
        })
      }

      if (liq.liquidationRatio > 2) {
        factors.push({
          name: 'Longs Liquidated',
          value: `${liq.liquidationRatio.toFixed(1)}x more longs`,
          direction: 'bullish',
          weight: 1.5,
          description: 'Long liquidation cascade - contrarian bullish after flush',
          source: 'Market Data'
        })
      } else if (liq.liquidationRatio < 0.5) {
        factors.push({
          name: 'Shorts Liquidated',
          value: `${(1/liq.liquidationRatio).toFixed(1)}x more shorts`,
          direction: 'bearish',
          weight: 1.5,
          description: 'Short squeeze occurred - contrarian bearish after pump',
          source: 'Market Data'
        })
      }
    }

    // Open Interest
    if (this.sentiment.openInterest) {
      const oi = this.sentiment.openInterest

      if (oi.openInterestChange24h > 15) {
        factors.push({
          name: 'OI Surge',
          value: `+${oi.openInterestChange24h.toFixed(0)}%`,
          direction: 'neutral',
          weight: 1,
          description: 'Rapid open interest increase - new positions entering',
          source: 'AsterDEX'
        })
      } else if (oi.openInterestChange24h < -15) {
        factors.push({
          name: 'OI Flush',
          value: `${oi.openInterestChange24h.toFixed(0)}%`,
          direction: 'neutral',
          weight: 1,
          description: 'Open interest declining - positions closing, potential bottom',
          source: 'AsterDEX'
        })
      }
    }

    // Overall sentiment
    if (this.sentiment.tradingBias !== 'neutral') {
      const biasName = this.sentiment.tradingBias.replace('_', ' ').toUpperCase()
      factors.push({
        name: 'Sentiment Consensus',
        value: biasName,
        direction: this.sentiment.tradingBias.includes('long') ? 'bullish' : 'bearish',
        weight: this.sentiment.tradingBias.includes('strong') ? 2 : 1,
        description: `Multiple sentiment indicators align ${biasName}`,
        source: 'Aggregate'
      })
    }

    return factors
  }

  // Refresh all data
  async refreshAll(): Promise<void> {
    console.log('[Sentiment] Refreshing all sentiment data...')
    
    await Promise.all([
      this.fetchFearGreedIndex(),
      this.fetchLiquidationData(),
      this.fetchOpenInterest(),
      this.fetchLongShortRatio(),
      this.fetchFundingRateTrend()
    ])

    this.calculateOverallSentiment()
    this.emit('update', this.sentiment)
    
    console.log(`[Sentiment] Overall: ${this.sentiment.overallSentiment}, Bias: ${this.sentiment.tradingBias}`)
  }

  // Start auto-refresh
  startAutoRefresh(): void {
    this.stopAutoRefresh()

    // Initial fetch
    this.refreshAll()

    // Set up intervals
    this.refreshIntervals.push(
      setInterval(() => this.fetchFearGreedIndex(), FEAR_GREED_REFRESH_MS),
      setInterval(() => this.fetchLiquidationData(), LIQUIDATION_REFRESH_MS),
      setInterval(() => this.fetchOpenInterest(), OPEN_INTEREST_REFRESH_MS),
      setInterval(() => this.fetchLongShortRatio(), LONG_SHORT_REFRESH_MS),
      setInterval(() => this.fetchFundingRateTrend(), LONG_SHORT_REFRESH_MS),
      setInterval(() => this.calculateOverallSentiment(), 60000)
    )

    console.log('[Sentiment] Auto-refresh started')
  }

  stopAutoRefresh(): void {
    for (const interval of this.refreshIntervals) {
      clearInterval(interval)
    }
    this.refreshIntervals = []
  }

  getSentiment(): MarketSentiment {
    return this.sentiment
  }

  getFearGreed(): FearGreedData | null {
    return this.sentiment.fearGreed
  }

  getTradingBias(): MarketSentiment['tradingBias'] {
    return this.sentiment.tradingBias
  }
}

// Export singleton instance
let sentimentFetcher: MarketSentimentFetcher | null = null

export function getMarketSentiment(coinglassApiKey?: string): MarketSentimentFetcher {
  if (!sentimentFetcher) {
    sentimentFetcher = new MarketSentimentFetcher(coinglassApiKey)
  }
  return sentimentFetcher
}
