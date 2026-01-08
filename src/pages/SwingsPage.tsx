import { useEffect, useMemo, useState } from 'react'

type SwingEvent = {
  id: string
  exchange: string
  symbol: string
  baseInterval: string
  pivotLen: number
  swingType: 'high' | 'low'
  openTime: number
  closeTime: number
  price: number
  features: Record<string, any>
}

type Stats = {
  total: number
  highs: number
  lows: number
  avgPrice: number
  avgRsi: number
  avgRsiHigh: number
  avgRsiLow: number
  pctUsMarket: number
  pctEma6GtEma50: number
  pctCloseGtSma200: number
  minPrice: number
  maxPrice: number
  avgRange: number
  avgBody: number
}

type RankedVariable = {
  rank: number
  name: string
  description: string
  highValue: number
  lowValue: number
  separation: number
  impactScore: number
  unit: string
  winRate: number
  dominantType: 'high' | 'low' | 'neutral'
}

function calcStats(swings: SwingEvent[]): Stats {
  const highs = swings.filter(s => s.swingType === 'high')
  const lows = swings.filter(s => s.swingType === 'low')
  
  const prices = swings.map(s => s.price).filter(p => Number.isFinite(p))
  const rsis = swings.map(s => s.features?.rsi14).filter(r => typeof r === 'number' && Number.isFinite(r))
  const rsiHighs = highs.map(s => s.features?.rsi14).filter(r => typeof r === 'number' && Number.isFinite(r))
  const rsiLows = lows.map(s => s.features?.rsi14).filter(r => typeof r === 'number' && Number.isFinite(r))
  const usMarket = swings.filter(s => s.features?.us_market_hours === true)
  const ema6GtEma50 = swings.filter(s => s.features?.ema6_gt_ema50 === true)
  const closeGtSma200 = swings.filter(s => s.features?.close_gt_sma200 === true)
  const ranges = swings.map(s => s.features?.range_pct).filter(r => typeof r === 'number' && Number.isFinite(r))
  const bodies = swings.map(s => s.features?.body_pct).filter(r => typeof r === 'number' && Number.isFinite(r))

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

  return {
    total: swings.length,
    highs: highs.length,
    lows: lows.length,
    avgPrice: avg(prices),
    avgRsi: avg(rsis),
    avgRsiHigh: avg(rsiHighs),
    avgRsiLow: avg(rsiLows),
    pctUsMarket: swings.length ? (usMarket.length / swings.length) * 100 : 0,
    pctEma6GtEma50: swings.length ? (ema6GtEma50.length / swings.length) * 100 : 0,
    pctCloseGtSma200: swings.length ? (closeGtSma200.length / swings.length) * 100 : 0,
    minPrice: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    avgRange: avg(ranges) * 100,
    avgBody: avg(bodies) * 100,
  }
}

function calcRankedVariables(swings: SwingEvent[]): RankedVariable[] {
  const highs = swings.filter(s => s.swingType === 'high')
  const lows = swings.filter(s => s.swingType === 'low')
  
  if (highs.length === 0 || lows.length === 0) return []

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  const std = (arr: number[]) => {
    if (arr.length < 2) return 0
    const m = avg(arr)
    return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length)
  }
  const pct = (arr: SwingEvent[], fn: (s: SwingEvent) => boolean) => 
    arr.length ? (arr.filter(fn).length / arr.length) * 100 : 0

  const getNum = (s: SwingEvent, key: string) => {
    const v = s.features?.[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }

  const variables: Omit<RankedVariable, 'rank' | 'impactScore' | 'winRate' | 'dominantType'>[] = [
    {
      name: 'RSI14',
      description: 'Relative Strength Index - momentum oscillator',
      highValue: avg(highs.map(s => getNum(s, 'rsi14')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'rsi14')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
    {
      name: 'EMA6 > EMA50',
      description: 'Short-term trend direction (bullish when true)',
      highValue: pct(highs, s => s.features?.ema6_gt_ema50 === true),
      lowValue: pct(lows, s => s.features?.ema6_gt_ema50 === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Close > SMA200',
      description: 'Price above long-term average (bullish bias)',
      highValue: pct(highs, s => s.features?.close_gt_sma200 === true),
      lowValue: pct(lows, s => s.features?.close_gt_sma200 === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'US Market Hours',
      description: 'During NYSE/NASDAQ trading hours',
      highValue: pct(highs, s => s.features?.us_market_hours === true),
      lowValue: pct(lows, s => s.features?.us_market_hours === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Close-SMA200 Distance',
      description: 'Price distance from 200 SMA (%)',
      highValue: avg(highs.map(s => getNum(s, 'close_sma200_pct')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'close_sma200_pct')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Candle Range %',
      description: 'High-Low range as % of price (volatility)',
      highValue: avg(highs.map(s => getNum(s, 'range_pct')).filter(v => v !== null) as number[]) * 100,
      lowValue: avg(lows.map(s => getNum(s, 'range_pct')).filter(v => v !== null) as number[]) * 100,
      separation: 0,
      unit: '%'
    },
    {
      name: 'Candle Body %',
      description: 'Open-Close as % of range (momentum strength)',
      highValue: avg(highs.map(s => getNum(s, 'body_pct')).filter(v => v !== null) as number[]) * 100,
      lowValue: avg(lows.map(s => getNum(s, 'body_pct')).filter(v => v !== null) as number[]) * 100,
      separation: 0,
      unit: '%'
    },
    {
      name: 'Hour of Day (UTC)',
      description: 'Average UTC hour when swing occurs',
      highValue: avg(highs.map(s => getNum(s, 'utc_hour')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'utc_hour')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: 'hr'
    },
    {
      name: 'Day of Week',
      description: 'Average weekday (1=Mon, 7=Sun)',
      highValue: avg(highs.map(s => getNum(s, 'utc_weekday')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'utc_weekday')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
    {
      name: 'RSI Overbought (>70)',
      description: '% of swings with RSI above 70',
      highValue: pct(highs, s => (getNum(s, 'rsi14') ?? 0) > 70),
      lowValue: pct(lows, s => (getNum(s, 'rsi14') ?? 0) > 70),
      separation: 0,
      unit: '%'
    },
    {
      name: 'RSI Oversold (<30)',
      description: '% of swings with RSI below 30',
      highValue: pct(highs, s => (getNum(s, 'rsi14') ?? 100) < 30),
      lowValue: pct(lows, s => (getNum(s, 'rsi14') ?? 100) < 30),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Month of Year',
      description: 'Average month (1-12)',
      highValue: avg(highs.map(s => getNum(s, 'utc_month')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'utc_month')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
    {
      name: 'Moon Phase',
      description: 'Lunar cycle position (0=new, 0.5=full)',
      highValue: avg(highs.map(s => getNum(s, 'moon_phase')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'moon_phase')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
    {
      name: 'Full Moon',
      description: '% of swings during full moon',
      highValue: pct(highs, s => s.features?.is_full_moon === true),
      lowValue: pct(lows, s => s.features?.is_full_moon === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'New Moon',
      description: '% of swings during new moon',
      highValue: pct(highs, s => s.features?.is_new_moon === true),
      lowValue: pct(lows, s => s.features?.is_new_moon === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Moon Illumination',
      description: 'Average moon brightness (%)',
      highValue: avg(highs.map(s => getNum(s, 'moon_illumination')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'moon_illumination')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Tokyo Session',
      description: '% during Tokyo market hours',
      highValue: pct(highs, s => s.features?.tokyo_open === true),
      lowValue: pct(lows, s => s.features?.tokyo_open === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'London Session',
      description: '% during London market hours',
      highValue: pct(highs, s => s.features?.london_open === true),
      lowValue: pct(lows, s => s.features?.london_open === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'NYSE Session',
      description: '% during NYSE market hours',
      highValue: pct(highs, s => s.features?.nyse_open === true),
      lowValue: pct(lows, s => s.features?.nyse_open === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Sydney Session',
      description: '% during Sydney market hours',
      highValue: pct(highs, s => s.features?.sydney_open === true),
      lowValue: pct(lows, s => s.features?.sydney_open === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Frankfurt Session',
      description: '% during Frankfurt market hours',
      highValue: pct(highs, s => s.features?.frankfurt_open === true),
      lowValue: pct(lows, s => s.features?.frankfurt_open === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'London-NYSE Overlap',
      description: '% during London/NYSE overlap (high liquidity)',
      highValue: pct(highs, s => s.features?.overlap_london_nyse === true),
      lowValue: pct(lows, s => s.features?.overlap_london_nyse === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Tokyo-London Overlap',
      description: '% during Tokyo/London overlap',
      highValue: pct(highs, s => s.features?.overlap_tokyo_london === true),
      lowValue: pct(lows, s => s.features?.overlap_tokyo_london === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Markets Open Count',
      description: 'Avg number of major markets open',
      highValue: avg(highs.map(s => getNum(s, 'markets_open_count')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'markets_open_count')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
    {
      name: 'Weekend',
      description: '% of swings on weekends',
      highValue: pct(highs, s => s.features?.is_weekend === true),
      lowValue: pct(lows, s => s.features?.is_weekend === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Monday',
      description: '% of swings on Mondays',
      highValue: pct(highs, s => s.features?.is_monday === true),
      lowValue: pct(lows, s => s.features?.is_monday === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Friday',
      description: '% of swings on Fridays',
      highValue: pct(highs, s => s.features?.is_friday === true),
      lowValue: pct(lows, s => s.features?.is_friday === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Quarter',
      description: 'Average quarter (1-4)',
      highValue: avg(highs.map(s => getNum(s, 'quarter')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'quarter')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
    {
      name: 'Month Start',
      description: '% of swings in first 3 days of month',
      highValue: pct(highs, s => s.features?.is_month_start === true),
      lowValue: pct(lows, s => s.features?.is_month_start === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Month End',
      description: '% of swings in last 3 days of month',
      highValue: pct(highs, s => s.features?.is_month_end === true),
      lowValue: pct(lows, s => s.features?.is_month_end === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Hour Bucket',
      description: 'Avg 4-hour bucket (0-5)',
      highValue: avg(highs.map(s => getNum(s, 'hour_bucket')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'hour_bucket')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
    // 15 MORE HUMAN-INTUITIVE FACTORS
    {
      name: 'Tuesday',
      description: '% of swings on Tuesdays',
      highValue: pct(highs, s => s.features?.is_tuesday === true),
      lowValue: pct(lows, s => s.features?.is_tuesday === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Wednesday',
      description: '% of swings on Wednesdays',
      highValue: pct(highs, s => s.features?.is_wednesday === true),
      lowValue: pct(lows, s => s.features?.is_wednesday === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Thursday',
      description: '% of swings on Thursdays',
      highValue: pct(highs, s => s.features?.is_thursday === true),
      lowValue: pct(lows, s => s.features?.is_thursday === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'First Week',
      description: '% in first 7 days of month',
      highValue: pct(highs, s => s.features?.is_first_week === true),
      lowValue: pct(lows, s => s.features?.is_first_week === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Last Week',
      description: '% in last week of month (22+)',
      highValue: pct(highs, s => s.features?.is_last_week === true),
      lowValue: pct(lows, s => s.features?.is_last_week === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Mid-Month',
      description: '% in middle of month (10-20)',
      highValue: pct(highs, s => s.features?.is_mid_month === true),
      lowValue: pct(lows, s => s.features?.is_mid_month === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Q1 (Jan-Mar)',
      description: '% in first quarter',
      highValue: pct(highs, s => s.features?.is_q1 === true),
      lowValue: pct(lows, s => s.features?.is_q1 === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Q4 (Oct-Dec)',
      description: '% in fourth quarter',
      highValue: pct(highs, s => s.features?.is_q4 === true),
      lowValue: pct(lows, s => s.features?.is_q4 === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Summer (Jun-Aug)',
      description: '% during summer months',
      highValue: pct(highs, s => s.features?.is_summer === true),
      lowValue: pct(lows, s => s.features?.is_summer === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'December',
      description: '% in December (tax/year-end)',
      highValue: pct(highs, s => s.features?.is_december === true),
      lowValue: pct(lows, s => s.features?.is_december === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'January',
      description: '% in January (new year effect)',
      highValue: pct(highs, s => s.features?.is_january === true),
      lowValue: pct(lows, s => s.features?.is_january === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Minute of Hour',
      description: 'Avg minute (0-59)',
      highValue: avg(highs.map(s => getNum(s, 'minute_of_hour')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'minute_of_hour')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
    {
      name: 'Hour Start',
      description: '% in first 5 mins of hour',
      highValue: pct(highs, s => s.features?.is_hour_start === true),
      lowValue: pct(lows, s => s.features?.is_hour_start === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Hour End',
      description: '% in last 5 mins of hour',
      highValue: pct(highs, s => s.features?.is_hour_end === true),
      lowValue: pct(lows, s => s.features?.is_hour_end === true),
      separation: 0,
      unit: '%'
    },
    {
      name: 'Half Hour',
      description: '% around :30 mark (25-35)',
      highValue: pct(highs, s => s.features?.is_half_hour === true),
      lowValue: pct(lows, s => s.features?.is_half_hour === true),
      separation: 0,
      unit: '%'
    },
    // 10 AI-DISCOVERED UNEXPECTED FACTORS
    {
      name: '🤖 Golden Ratio Hour',
      description: 'Near 14:48 UTC (φ × 24)',
      highValue: pct(highs, s => s.features?.golden_ratio_hour === true),
      lowValue: pct(lows, s => s.features?.golden_ratio_hour === true),
      separation: 0,
      unit: '%'
    },
    {
      name: '🤖 Fibonacci Day',
      description: 'Day of month is Fibonacci (1,2,3,5,8,13,21)',
      highValue: pct(highs, s => s.features?.fibonacci_day === true),
      lowValue: pct(lows, s => s.features?.fibonacci_day === true),
      separation: 0,
      unit: '%'
    },
    {
      name: '🤖 Prime Hour',
      description: 'Hour is prime number',
      highValue: pct(highs, s => s.features?.prime_hour === true),
      lowValue: pct(lows, s => s.features?.prime_hour === true),
      separation: 0,
      unit: '%'
    },
    {
      name: '🤖 Digit Sum Day',
      description: 'Sum of day digits (e.g. 15→6)',
      highValue: avg(highs.map(s => getNum(s, 'digit_sum_day')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'digit_sum_day')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
    {
      name: '🤖 Lunar Gravity Peak',
      description: '% near full moon (45-55% phase)',
      highValue: pct(highs, s => s.features?.lunar_gravitational_peak === true),
      lowValue: pct(lows, s => s.features?.lunar_gravitational_peak === true),
      separation: 0,
      unit: '%'
    },
    {
      name: '🤖 Triple Witching',
      description: '% during triple witching week',
      highValue: pct(highs, s => s.features?.triple_witching_week === true),
      lowValue: pct(lows, s => s.features?.triple_witching_week === true),
      separation: 0,
      unit: '%'
    },
    {
      name: '🤖 Mercury Retrograde',
      description: 'Proxy based on 88-day cycle',
      highValue: pct(highs, s => s.features?.mercury_retrograde_proxy === true),
      lowValue: pct(lows, s => s.features?.mercury_retrograde_proxy === true),
      separation: 0,
      unit: '%'
    },
    {
      name: '🤖 Solar Cycle Phase',
      description: '11-year solar activity cycle',
      highValue: avg(highs.map(s => getNum(s, 'solar_cycle_phase')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'solar_cycle_phase')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
    {
      name: '🤖 Minute Entropy',
      description: 'Pseudo-random time hash (0-59)',
      highValue: avg(highs.map(s => getNum(s, 'minute_entropy')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'minute_entropy')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
    {
      name: '🤖 Temporal Harmonic',
      description: 'Hour/weekday wave interference',
      highValue: avg(highs.map(s => getNum(s, 'temporal_harmonic')).filter(v => v !== null) as number[]),
      lowValue: avg(lows.map(s => getNum(s, 'temporal_harmonic')).filter(v => v !== null) as number[]),
      separation: 0,
      unit: ''
    },
  ]

  // Calculate separation (absolute difference) for each variable
  for (const v of variables) {
    v.separation = Math.abs(v.highValue - v.lowValue)
  }

  // Calculate impact score: normalize separation relative to the values
  // Higher separation = more predictive power for distinguishing highs from lows
  const maxSep = Math.max(...variables.map(v => v.separation), 0.001)
  
  const ranked: RankedVariable[] = variables
    .map(v => {
      // Win rate: how biased is this variable toward one swing type?
      const total = Math.abs(v.highValue) + Math.abs(v.lowValue)
      const dominantValue = Math.max(Math.abs(v.highValue), Math.abs(v.lowValue))
      const winRate = total > 0 ? (dominantValue / total) * 100 : 50
      const dominantType: 'high' | 'low' | 'neutral' = 
        Math.abs(v.highValue) > Math.abs(v.lowValue) ? 'high' : 
        Math.abs(v.lowValue) > Math.abs(v.highValue) ? 'low' : 'neutral'
      
      return {
        ...v,
        impactScore: (v.separation / maxSep) * 100,
        winRate,
        dominantType
      }
    })
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, 40)
    .map((v, i) => ({ ...v, rank: i + 1 }))

  return ranked
}

type ConfluenceResult = {
  rank: number
  factors: string[]
  description: string
  highPct: number
  lowPct: number
  separation: number
  impactScore: number
  winRate: number
  dominantType: 'high' | 'low' | 'neutral'
  sampleSize: number
}

function calcConfluence(swings: SwingEvent[], numFactors: number): ConfluenceResult[] {
  const highs = swings.filter(s => s.swingType === 'high')
  const lows = swings.filter(s => s.swingType === 'low')
  
  if (highs.length === 0 || lows.length === 0) return []

  const boolFactors: { key: string; name: string; check: (f: any) => boolean }[] = [
    { key: 'ema6_gt_ema50', name: 'EMA6>50', check: f => f?.ema6_gt_ema50 === true },
    { key: 'close_gt_sma200', name: 'Cls>SMA200', check: f => f?.close_gt_sma200 === true },
    { key: 'us_market_hours', name: 'US Mkt', check: f => f?.us_market_hours === true },
    { key: 'rsi_high', name: 'RSI>70', check: f => (f?.rsi14 ?? 0) > 70 },
    { key: 'rsi_low', name: 'RSI<30', check: f => (f?.rsi14 ?? 100) < 30 },
    { key: 'tokyo_open', name: 'Tokyo', check: f => f?.tokyo_open === true },
    { key: 'london_open', name: 'London', check: f => f?.london_open === true },
    { key: 'nyse_open', name: 'NYSE', check: f => f?.nyse_open === true },
    { key: 'overlap_london_nyse', name: 'Ldn-NYSE', check: f => f?.overlap_london_nyse === true },
    { key: 'is_monday', name: 'Monday', check: f => f?.is_monday === true },
    { key: 'is_friday', name: 'Friday', check: f => f?.is_friday === true },
    { key: 'is_month_start', name: 'MoStart', check: f => f?.is_month_start === true },
    { key: 'is_month_end', name: 'MoEnd', check: f => f?.is_month_end === true },
    { key: 'is_q1', name: 'Q1', check: f => f?.is_q1 === true },
    { key: 'is_q4', name: 'Q4', check: f => f?.is_q4 === true },
    { key: 'is_full_moon', name: 'FullMoon', check: f => f?.is_full_moon === true },
    { key: 'is_new_moon', name: 'NewMoon', check: f => f?.is_new_moon === true },
    { key: 'golden_ratio_hour', name: '🤖Golden', check: f => f?.golden_ratio_hour === true },
    { key: 'fibonacci_day', name: '🤖Fib', check: f => f?.fibonacci_day === true },
    { key: 'prime_hour', name: '🤖Prime', check: f => f?.prime_hour === true },
    { key: 'lunar_gravitational_peak', name: '🤖LunarPeak', check: f => f?.lunar_gravitational_peak === true },
    { key: 'is_hour_start', name: 'HrStart', check: f => f?.is_hour_start === true },
    { key: 'is_half_hour', name: 'Half:30', check: f => f?.is_half_hour === true },
    { key: 'is_tuesday', name: 'Tuesday', check: f => f?.is_tuesday === true },
    { key: 'is_wednesday', name: 'Wednesday', check: f => f?.is_wednesday === true },
  ]

  function* combinations<T>(arr: T[], k: number): Generator<T[]> {
    if (k === 0) { yield []; return }
    if (arr.length < k) return
    const [first, ...rest] = arr
    for (const combo of combinations(rest, k - 1)) yield [first, ...combo]
    yield* combinations(rest, k)
  }

  const results: ConfluenceResult[] = []
  const maxCombos = numFactors <= 3 ? 5000 : numFactors <= 5 ? 2000 : 500

  let count = 0
  for (const combo of combinations(boolFactors, numFactors)) {
    if (count++ > maxCombos) break
    
    const checkAll = (f: any) => combo.every(c => c.check(f))
    const highMatches = highs.filter(s => checkAll(s.features)).length
    const lowMatches = lows.filter(s => checkAll(s.features)).length
    const highPct = (highMatches / highs.length) * 100
    const lowPct = (lowMatches / lows.length) * 100
    const separation = Math.abs(highPct - lowPct)
    
    if (highMatches + lowMatches > 0) {
      const totalMatches = highMatches + lowMatches
      const dominantCount = Math.max(highMatches, lowMatches)
      const winRate = totalMatches > 0 ? (dominantCount / totalMatches) * 100 : 50
      const dominantType = highMatches > lowMatches ? 'high' : highMatches < lowMatches ? 'low' : 'neutral'
      
      results.push({
        rank: 0,
        factors: combo.map(c => c.name),
        description: combo.map(c => c.name).join(' + '),
        highPct,
        lowPct,
        separation,
        impactScore: 0,
        winRate,
        dominantType,
        sampleSize: totalMatches
      })
    }
  }

  const maxSep = Math.max(...results.map(r => r.separation), 0.001)
  return results
    .map(r => ({ ...r, impactScore: (r.separation / maxSep) * 100 }))
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, 30)
    .map((r, i) => ({ ...r, rank: i + 1 }))
}

type CrossSymbolAnalysis = {
  btcLeadsEth: { rank: number; pattern: string; btcSignal: string; ethFollows: string; occurrences: number; successRate: number; avgLagMinutes: number; impactScore: number }[]
  ethLeadsBtc: { rank: number; pattern: string; ethSignal: string; btcFollows: string; occurrences: number; successRate: number; avgLagMinutes: number; impactScore: number }[]
  correlation: number
  btcHighsBeforeEthHighs: number
  btcLowsBeforeEthLows: number
}

function calcCrossSymbolAnalysis(btcSwings: SwingEvent[], ethSwings: SwingEvent[]): CrossSymbolAnalysis {
  const btcHighs = btcSwings.filter(s => s.swingType === 'high').sort((a, b) => a.openTime - b.openTime)
  const btcLows = btcSwings.filter(s => s.swingType === 'low').sort((a, b) => a.openTime - b.openTime)
  const ethHighs = ethSwings.filter(s => s.swingType === 'high').sort((a, b) => a.openTime - b.openTime)
  const ethLows = ethSwings.filter(s => s.swingType === 'low').sort((a, b) => a.openTime - b.openTime)

  const windowMs = 60 * 60 * 1000 // 1 hour window
  
  // Count BTC highs that precede ETH highs within window
  let btcHighsBeforeEthHighs = 0
  let btcHighsBeforeEthHighsLag = 0
  for (const ethH of ethHighs) {
    const btcBefore = btcHighs.find(b => b.openTime < ethH.openTime && ethH.openTime - b.openTime <= windowMs)
    if (btcBefore) {
      btcHighsBeforeEthHighs++
      btcHighsBeforeEthHighsLag += (ethH.openTime - btcBefore.openTime) / 60000
    }
  }

  // Count BTC lows that precede ETH lows within window
  let btcLowsBeforeEthLows = 0
  let btcLowsBeforeEthLowsLag = 0
  for (const ethL of ethLows) {
    const btcBefore = btcLows.find(b => b.openTime < ethL.openTime && ethL.openTime - b.openTime <= windowMs)
    if (btcBefore) {
      btcLowsBeforeEthLows++
      btcLowsBeforeEthLowsLag += (ethL.openTime - btcBefore.openTime) / 60000
    }
  }

  // Calculate correlation
  const btcPctLeadsHighs = ethHighs.length > 0 ? (btcHighsBeforeEthHighs / ethHighs.length) * 100 : 0
  const btcPctLeadsLows = ethLows.length > 0 ? (btcLowsBeforeEthLows / ethLows.length) * 100 : 0
  const correlation = (btcPctLeadsHighs + btcPctLeadsLows) / 2

  // Build BTC leads ETH patterns
  const btcLeadsEth: CrossSymbolAnalysis['btcLeadsEth'] = [
    {
      rank: 1,
      pattern: 'BTC High → ETH High',
      btcSignal: 'Swing High',
      ethFollows: 'Swing High within 1hr',
      occurrences: btcHighsBeforeEthHighs,
      successRate: btcPctLeadsHighs,
      avgLagMinutes: btcHighsBeforeEthHighs > 0 ? Math.round(btcHighsBeforeEthHighsLag / btcHighsBeforeEthHighs) : 0,
      impactScore: btcPctLeadsHighs
    },
    {
      rank: 2,
      pattern: 'BTC Low → ETH Low',
      btcSignal: 'Swing Low',
      ethFollows: 'Swing Low within 1hr',
      occurrences: btcLowsBeforeEthLows,
      successRate: btcPctLeadsLows,
      avgLagMinutes: btcLowsBeforeEthLows > 0 ? Math.round(btcLowsBeforeEthLowsLag / btcLowsBeforeEthLows) : 0,
      impactScore: btcPctLeadsLows
    }
  ]

  // ETH leads BTC (reverse analysis)
  let ethHighsBeforeBtcHighs = 0
  let ethHighsBeforeBtcHighsLag = 0
  for (const btcH of btcHighs) {
    const ethBefore = ethHighs.find(e => e.openTime < btcH.openTime && btcH.openTime - e.openTime <= windowMs)
    if (ethBefore) {
      ethHighsBeforeBtcHighs++
      ethHighsBeforeBtcHighsLag += (btcH.openTime - ethBefore.openTime) / 60000
    }
  }

  let ethLowsBeforeBtcLows = 0
  let ethLowsBeforeBtcLowsLag = 0
  for (const btcL of btcLows) {
    const ethBefore = ethLows.find(e => e.openTime < btcL.openTime && btcL.openTime - e.openTime <= windowMs)
    if (ethBefore) {
      ethLowsBeforeBtcLows++
      ethLowsBeforeBtcLowsLag += (btcL.openTime - ethBefore.openTime) / 60000
    }
  }

  const ethPctLeadsHighs = btcHighs.length > 0 ? (ethHighsBeforeBtcHighs / btcHighs.length) * 100 : 0
  const ethPctLeadsLows = btcLows.length > 0 ? (ethLowsBeforeBtcLows / btcLows.length) * 100 : 0

  const ethLeadsBtc: CrossSymbolAnalysis['ethLeadsBtc'] = [
    {
      rank: 1,
      pattern: 'ETH High → BTC High',
      ethSignal: 'Swing High',
      btcFollows: 'Swing High within 1hr',
      occurrences: ethHighsBeforeBtcHighs,
      successRate: ethPctLeadsHighs,
      avgLagMinutes: ethHighsBeforeBtcHighs > 0 ? Math.round(ethHighsBeforeBtcHighsLag / ethHighsBeforeBtcHighs) : 0,
      impactScore: ethPctLeadsHighs
    },
    {
      rank: 2,
      pattern: 'ETH Low → BTC Low',
      ethSignal: 'Swing Low',
      btcFollows: 'Swing Low within 1hr',
      occurrences: ethLowsBeforeBtcLows,
      successRate: ethPctLeadsLows,
      avgLagMinutes: ethLowsBeforeBtcLows > 0 ? Math.round(ethLowsBeforeBtcLowsLag / ethLowsBeforeBtcLows) : 0,
      impactScore: ethPctLeadsLows
    }
  ]

  return {
    btcLeadsEth: btcLeadsEth.sort((a, b) => b.impactScore - a.impactScore),
    ethLeadsBtc: ethLeadsBtc.sort((a, b) => b.impactScore - a.impactScore),
    correlation,
    btcHighsBeforeEthHighs: btcPctLeadsHighs,
    btcLowsBeforeEthLows: btcPctLeadsLows
  }
}

const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w']

// Factor correlation calculation
type FactorCorrelation = {
  factor1: string
  factor2: string
  correlation: number
  sampleSize: number
}

function calcFactorCorrelations(swings: SwingEvent[]): FactorCorrelation[] {
  if (swings.length < 10) return []
  
  const numericFactors = [
    { key: 'rsi14', name: 'RSI14' },
    { key: 'ema6', name: 'EMA6' },
    { key: 'ema50', name: 'EMA50' },
    { key: 'sma200', name: 'SMA200' },
    { key: 'range_pct', name: 'Range%' },
    { key: 'body_pct', name: 'Body%' },
    { key: 'close_sma200_pct', name: 'Cls-SMA%' },
    { key: 'utc_hour', name: 'Hour' },
    { key: 'utc_weekday', name: 'Weekday' },
    { key: 'moon_phase', name: 'MoonPhase' },
    { key: 'moon_illumination', name: 'MoonIll' },
    { key: 'markets_open_count', name: 'MktsOpen' },
  ]
  
  // Extract values
  const getVals = (key: string) => swings.map(s => s.features?.[key]).filter(v => typeof v === 'number' && isFinite(v)) as number[]
  
  // Pearson correlation
  const pearson = (x: number[], y: number[]): number => {
    if (x.length !== y.length || x.length < 3) return 0
    const n = x.length
    const sumX = x.reduce((a, b) => a + b, 0)
    const sumY = y.reduce((a, b) => a + b, 0)
    const sumXY = x.reduce((a, v, i) => a + v * y[i], 0)
    const sumX2 = x.reduce((a, v) => a + v * v, 0)
    const sumY2 = y.reduce((a, v) => a + v * v, 0)
    const num = n * sumXY - sumX * sumY
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY))
    return den === 0 ? 0 : num / den
  }
  
  const correlations: FactorCorrelation[] = []
  
  for (let i = 0; i < numericFactors.length; i++) {
    for (let j = i + 1; j < numericFactors.length; j++) {
      const vals1 = getVals(numericFactors[i].key)
      const vals2 = getVals(numericFactors[j].key)
      
      // Match by index (same swing)
      const paired: { v1: number; v2: number }[] = []
      swings.forEach(s => {
        const v1 = s.features?.[numericFactors[i].key]
        const v2 = s.features?.[numericFactors[j].key]
        if (typeof v1 === 'number' && typeof v2 === 'number' && isFinite(v1) && isFinite(v2)) {
          paired.push({ v1, v2 })
        }
      })
      
      if (paired.length >= 10) {
        const corr = pearson(paired.map(p => p.v1), paired.map(p => p.v2))
        correlations.push({
          factor1: numericFactors[i].name,
          factor2: numericFactors[j].name,
          correlation: corr,
          sampleSize: paired.length
        })
      }
    }
  }
  
  return correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
}

// Multi-factor confluence analysis - best combinations of factors
type MultiFactorConfluence = {
  factors: string[]
  highWinRate: number  // % of highs when all factors present
  lowWinRate: number   // % of lows when all factors present
  totalOccurrences: number
  avgWinRate: number
  separation: number  // How different from baseline
}

function calcMultiFactorConfluence(swings: SwingEvent[]): MultiFactorConfluence[] {
  if (swings.length < 50) return []
  
  const highs = swings.filter(s => s.swingType === 'high')
  const lows = swings.filter(s => s.swingType === 'low')
  const baselineHighPct = (highs.length / swings.length) * 100
  
  // Boolean factor conditions to combine
  const conditions: { name: string; test: (s: SwingEvent) => boolean }[] = [
    { name: 'RSI<30', test: s => (s.features?.rsi14 ?? 50) < 30 },
    { name: 'RSI>70', test: s => (s.features?.rsi14 ?? 50) > 70 },
    { name: 'EMA6>EMA50', test: s => s.features?.ema6_gt_ema50 === true },
    { name: 'EMA6<EMA50', test: s => s.features?.ema6_gt_ema50 === false },
    { name: 'Above200', test: s => s.features?.close_gt_sma200 === true },
    { name: 'Below200', test: s => s.features?.close_gt_sma200 === false },
    { name: 'USMarket', test: s => s.features?.us_market_hours === true },
    { name: 'LondonOpen', test: s => s.features?.london_open === true },
    { name: 'TokyoOpen', test: s => s.features?.tokyo_open === true },
    { name: 'NYSEOpen', test: s => s.features?.nyse_open === true },
    { name: 'Monday', test: s => s.features?.is_monday === true },
    { name: 'Friday', test: s => s.features?.is_friday === true },
    { name: 'NewMoon', test: s => s.features?.moon_phase === 0 || s.features?.moon_phase === 'new' },
    { name: 'FullMoon', test: s => s.features?.moon_phase === 0.5 || s.features?.moon_phase === 'full' },
    { name: 'Q1', test: s => s.features?.quarter === 1 },
    { name: 'Q4', test: s => s.features?.quarter === 4 },
  ]
  
  const results: MultiFactorConfluence[] = []
  
  // Generate 2-factor and 3-factor combinations
  for (let i = 0; i < conditions.length; i++) {
    for (let j = i + 1; j < conditions.length; j++) {
      // 2-factor combination
      const matching2 = swings.filter(s => conditions[i].test(s) && conditions[j].test(s))
      if (matching2.length >= 10) {
        const matchHighs = matching2.filter(s => s.swingType === 'high').length
        const matchLows = matching2.filter(s => s.swingType === 'low').length
        const highPct = (matchHighs / matching2.length) * 100
        const lowPct = (matchLows / matching2.length) * 100
        results.push({
          factors: [conditions[i].name, conditions[j].name],
          highWinRate: highPct,
          lowWinRate: lowPct,
          totalOccurrences: matching2.length,
          avgWinRate: Math.max(highPct, lowPct),
          separation: Math.abs(highPct - baselineHighPct)
        })
      }
      
      // 3-factor combinations
      for (let k = j + 1; k < conditions.length; k++) {
        const matching3 = swings.filter(s => conditions[i].test(s) && conditions[j].test(s) && conditions[k].test(s))
        if (matching3.length >= 5) {
          const matchHighs = matching3.filter(s => s.swingType === 'high').length
          const matchLows = matching3.filter(s => s.swingType === 'low').length
          const highPct = (matchHighs / matching3.length) * 100
          const lowPct = (matchLows / matching3.length) * 100
          results.push({
            factors: [conditions[i].name, conditions[j].name, conditions[k].name],
            highWinRate: highPct,
            lowWinRate: lowPct,
            totalOccurrences: matching3.length,
            avgWinRate: Math.max(highPct, lowPct),
            separation: Math.abs(highPct - baselineHighPct)
          })
        }
      }
    }
  }
  
  // Sort by best win rate and filter to top combinations
  return results
    .filter(r => r.avgWinRate >= 60) // Only show strong signals
    .sort((a, b) => b.avgWinRate - a.avgWinRate)
    .slice(0, 20)
}

// ETHUSDT Leading Indicator Analysis - Ranked by Trading Edge
type EthLeaderRanking = {
  rank: number
  symbol: string
  symbolName: string
  category: 'crypto' | 'index' | 'commodity'
  edge: 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE'
  direction: 'LONG' | 'SHORT' | 'BOTH'
  signal: string  // Human readable signal
  action: string  // What to do when signal fires
  leadsBy: number // Average minutes before ETH moves
  hitRate: number // % of times this signal preceded ETH move
  occurrences: number
  tradingAdvice: string
}

function calcEthLeaderRankings(allSwings: Map<string, SwingEvent[]>): EthLeaderRanking[] {
  const ethSwings = allSwings.get('ethusdt') || []
  if (ethSwings.length === 0) return []
  
  const ethHighs = ethSwings.filter(s => s.swingType === 'high')
  const ethLows = ethSwings.filter(s => s.swingType === 'low')
  const windowMs = 60 * 60 * 1000 // 1 hour
  
  const symbolInfo: Record<string, { name: string; category: 'crypto' | 'index' | 'commodity' }> = {
    'btcusdt': { name: 'Bitcoin', category: 'crypto' },
    'solusdt': { name: 'Solana', category: 'crypto' },
    'dogeusdt': { name: 'Dogecoin', category: 'crypto' },
    'xrpusdt': { name: 'XRP', category: 'crypto' },
    'spy': { name: 'S&P 500', category: 'index' },
    'nq': { name: 'Nasdaq 100', category: 'index' },
    'gc': { name: 'Gold', category: 'commodity' },
    'cl': { name: 'Crude Oil', category: 'commodity' },
  }
  
  const results: EthLeaderRanking[] = []
  let rankCounter = 0
  
  for (const [symbol, swings] of allSwings.entries()) {
    if (symbol === 'ethusdt') continue
    
    const info = symbolInfo[symbol] || { name: symbol.toUpperCase(), category: 'crypto' as const }
    const otherHighs = swings.filter(s => s.swingType === 'high')
    const otherLows = swings.filter(s => s.swingType === 'low')
    
    // Analyze: When OTHER tops, does ETH top soon after? (SHORT signal)
    let highLeadsHigh = 0, lagHH = 0
    for (const ethH of ethHighs) {
      const leader = otherHighs.find(o => o.openTime < ethH.openTime && ethH.openTime - o.openTime <= windowMs)
      if (leader) { highLeadsHigh++; lagHH += (ethH.openTime - leader.openTime) / 60000 }
    }
    
    // Analyze: When OTHER bottoms, does ETH bottom soon after? (LONG signal)
    let lowLeadsLow = 0, lagLL = 0
    for (const ethL of ethLows) {
      const leader = otherLows.find(o => o.openTime < ethL.openTime && ethL.openTime - o.openTime <= windowMs)
      if (leader) { lowLeadsLow++; lagLL += (ethL.openTime - leader.openTime) / 60000 }
    }
    
    const sym = symbol.toUpperCase().replace('USDT', '')
    const shortHitRate = ethHighs.length > 0 ? (highLeadsHigh / ethHighs.length) * 100 : 0
    const longHitRate = ethLows.length > 0 ? (lowLeadsLow / ethLows.length) * 100 : 0
    const avgShortLag = highLeadsHigh > 0 ? Math.round(lagHH / highLeadsHigh) : 0
    const avgLongLag = lowLeadsLow > 0 ? Math.round(lagLL / lowLeadsLow) : 0
    
    // Determine edge strength
    const getEdge = (rate: number): 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE' => {
      if (rate >= 80) return 'STRONG'
      if (rate >= 60) return 'MODERATE'
      if (rate >= 40) return 'WEAK'
      return 'NONE'
    }
    
    // Add SHORT signal entry
    if (highLeadsHigh > 0) {
      const edge = getEdge(shortHitRate)
      results.push({
        rank: 0,
        symbol: sym,
        symbolName: info.name,
        category: info.category,
        edge,
        direction: 'SHORT',
        signal: `${sym} makes a HIGH`,
        action: `SHORT ETH within ~${avgShortLag}m`,
        leadsBy: avgShortLag,
        hitRate: shortHitRate,
        occurrences: highLeadsHigh,
        tradingAdvice: edge === 'STRONG' 
          ? `🔥 HIGH EDGE: When ${sym} tops, ETH tops ${shortHitRate.toFixed(0)}% of the time ~${avgShortLag}m later. Consider shorting ETH.`
          : edge === 'MODERATE'
          ? `⚡ USEFUL: ${sym} high often precedes ETH high. Watch for confirmation.`
          : `📊 WEAK: Some correlation but not reliable alone.`
      })
    }
    
    // Add LONG signal entry
    if (lowLeadsLow > 0) {
      const edge = getEdge(longHitRate)
      results.push({
        rank: 0,
        symbol: sym,
        symbolName: info.name,
        category: info.category,
        edge,
        direction: 'LONG',
        signal: `${sym} makes a LOW`,
        action: `LONG ETH within ~${avgLongLag}m`,
        leadsBy: avgLongLag,
        hitRate: longHitRate,
        occurrences: lowLeadsLow,
        tradingAdvice: edge === 'STRONG'
          ? `🔥 HIGH EDGE: When ${sym} bottoms, ETH bottoms ${longHitRate.toFixed(0)}% of the time ~${avgLongLag}m later. Consider longing ETH.`
          : edge === 'MODERATE'
          ? `⚡ USEFUL: ${sym} low often precedes ETH low. Watch for confirmation.`
          : `📊 WEAK: Some correlation but not reliable alone.`
      })
    }
  }
  
  // Sort by hit rate and assign ranks
  results.sort((a, b) => b.hitRate - a.hitRate)
  results.forEach((r, i) => r.rank = i + 1)
  
  return results
}

// Multi-symbol correlation matrix
type SymbolCorrelation = {
  symbol1: string
  symbol2: string
  highCorr: number  // % of highs that occur within 1hr
  lowCorr: number   // % of lows that occur within 1hr
  overall: number
  leadLag: number   // positive = symbol1 leads, negative = symbol2 leads
}

function calcMultiSymbolCorrelation(
  allSwings: Map<string, SwingEvent[]>
): SymbolCorrelation[] {
  const symbols = Array.from(allSwings.keys())
  const results: SymbolCorrelation[] = []
  const windowMs = 60 * 60 * 1000 // 1 hour
  
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const s1 = symbols[i]
      const s2 = symbols[j]
      const swings1 = allSwings.get(s1) || []
      const swings2 = allSwings.get(s2) || []
      
      const highs1 = swings1.filter(s => s.swingType === 'high')
      const highs2 = swings2.filter(s => s.swingType === 'high')
      const lows1 = swings1.filter(s => s.swingType === 'low')
      const lows2 = swings2.filter(s => s.swingType === 'low')
      
      // Count correlated highs
      let corrHighs = 0, s1LeadsHighs = 0
      for (const h1 of highs1) {
        const match = highs2.find(h2 => Math.abs(h1.openTime - h2.openTime) <= windowMs)
        if (match) {
          corrHighs++
          if (h1.openTime < match.openTime) s1LeadsHighs++
        }
      }
      
      // Count correlated lows
      let corrLows = 0, s1LeadsLows = 0
      for (const l1 of lows1) {
        const match = lows2.find(l2 => Math.abs(l1.openTime - l2.openTime) <= windowMs)
        if (match) {
          corrLows++
          if (l1.openTime < match.openTime) s1LeadsLows++
        }
      }
      
      const highCorr = highs1.length > 0 ? (corrHighs / highs1.length) * 100 : 0
      const lowCorr = lows1.length > 0 ? (corrLows / lows1.length) * 100 : 0
      const totalCorr = corrHighs + corrLows
      const s1Leads = s1LeadsHighs + s1LeadsLows
      const leadLag = totalCorr > 0 ? ((s1Leads / totalCorr) - 0.5) * 200 : 0 // -100 to +100
      
      results.push({
        symbol1: s1.toUpperCase(),
        symbol2: s2.toUpperCase(),
        highCorr,
        lowCorr,
        overall: (highCorr + lowCorr) / 2,
        leadLag
      })
    }
  }
  
  return results.sort((a, b) => b.overall - a.overall)
}

export default function SwingsPage() {
  const [swings, setSwings] = useState<SwingEvent[]>([])
  const [btcSwings, setBtcSwings] = useState<SwingEvent[]>([])
  const [ethSwings, setEthSwings] = useState<SwingEvent[]>([])
  const [totalInDb, setTotalInDb] = useState(0)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)
  const [confluenceMode, setConfluenceMode] = useState(1)
  const [selectedSymbol, setSelectedSymbol] = useState('btcusdt')
  const [selectedTimeframe, setSelectedTimeframe] = useState('1m')
  const [multiTfMode, setMultiTfMode] = useState(0) // 0=off, 2-10=number of TFs
  const [matrixSelection, setMatrixSelection] = useState<{vars: number, tfs: number} | null>(null)
  const [availableSymbols] = useState<string[]>([
    // Single assets
    'btcusdt', 'ethusdt', 'solusdt', 'dogeusdt', 'xrpusdt',
    'spy', 'nq', 'gc', 'cl',
    // Crypto combos
    'btc+eth', 'btc+sol', 'btc+doge', 'eth+sol',
    // Cross-market combos
    'btc+spy', 'btc+nq', 'eth+spy', 'btc+gc',
    // Multi-asset
    'crypto-all', 'tradfi-all', 'all'
  ])

  const [allSymbolSwings, setAllSymbolSwings] = useState<Map<string, SwingEvent[]>>(new Map())
  const [showCorrelation, setShowCorrelation] = useState(true) // Auto-load correlation data by default

  // Strategy Filter State
  const [strategyFilters, setStrategyFilters] = useState<{
    daysOfWeek: number[]
    hoursOfDay: number[]
    months: number[]
    quarters: number[]
    moonPhases: string[]
    sessions: string[]
    rsiRange: [number, number]
    trendDirection: 'any' | 'bullish' | 'bearish'
  }>({
    daysOfWeek: [],
    hoursOfDay: [],
    months: [],
    quarters: [],
    moonPhases: [],
    sessions: [],
    rsiRange: [0, 100],
    trendDirection: 'any'
  })

  // Apply strategy filters to swings
  const filteredSwings = useMemo(() => {
    let result = swings
    
    // Filter by day of week (0=Sunday, 6=Saturday)
    if (strategyFilters.daysOfWeek.length > 0) {
      result = result.filter(s => {
        const day = new Date(s.openTime).getUTCDay()
        return strategyFilters.daysOfWeek.includes(day)
      })
    }
    
    // Filter by hour of day (UTC)
    if (strategyFilters.hoursOfDay.length > 0) {
      result = result.filter(s => {
        const hour = new Date(s.openTime).getUTCHours()
        return strategyFilters.hoursOfDay.includes(hour)
      })
    }
    
    // Filter by month (1-12)
    if (strategyFilters.months.length > 0) {
      result = result.filter(s => {
        const month = new Date(s.openTime).getUTCMonth() + 1
        return strategyFilters.months.includes(month)
      })
    }
    
    // Filter by quarter (1-4)
    if (strategyFilters.quarters.length > 0) {
      result = result.filter(s => {
        const month = new Date(s.openTime).getUTCMonth() + 1
        const quarter = Math.ceil(month / 3)
        return strategyFilters.quarters.includes(quarter)
      })
    }
    
    // Filter by moon phase
    if (strategyFilters.moonPhases.length > 0) {
      result = result.filter(s => {
        const phase = s.features?.moon_phase
        return phase && strategyFilters.moonPhases.includes(String(phase).toLowerCase())
      })
    }
    
    // Filter by trading session
    if (strategyFilters.sessions.length > 0) {
      result = result.filter(s => {
        const f = s.features
        return strategyFilters.sessions.some(session => {
          if (session === 'tokyo') return f?.tokyo_open === true
          if (session === 'london') return f?.london_open === true
          if (session === 'nyse') return f?.nyse_open === true || f?.us_market_hours === true
          if (session === 'sydney') return f?.sydney_open === true
          if (session === 'frankfurt') return f?.frankfurt_open === true
          return false
        })
      })
    }
    
    // Filter by trend direction (EMA6 vs EMA50)
    if (strategyFilters.trendDirection !== 'any') {
      result = result.filter(s => {
        const bullish = s.features?.ema6_gt_ema50 === true
        if (strategyFilters.trendDirection === 'bullish') return bullish
        if (strategyFilters.trendDirection === 'bearish') return bullish === false
        return true
      })
    }
    
    return result
  }, [swings, strategyFilters])

  const stats = useMemo(() => calcStats(filteredSwings), [filteredSwings])
  const rankedVars = useMemo(() => calcRankedVariables(filteredSwings), [filteredSwings])
  const factorCorrelations = useMemo(() => calcFactorCorrelations(filteredSwings), [filteredSwings])
  const symbolCorrelations = useMemo(() => 
    allSymbolSwings.size > 1 ? calcMultiSymbolCorrelation(allSymbolSwings) : [],
    [allSymbolSwings]
  )
  const confluenceResults = useMemo(() => 
    confluenceMode > 1 ? calcConfluence(filteredSwings, confluenceMode) : [], 
    [filteredSwings, confluenceMode]
  )
  const crossAnalysis = useMemo(() => 
    selectedSymbol === 'btc+eth' ? calcCrossSymbolAnalysis(btcSwings, ethSwings) : null,
    [selectedSymbol, btcSwings, ethSwings]
  )
  
  // Multi-factor confluence analysis
  const multiFactorConfluence = useMemo(() => calcMultiFactorConfluence(filteredSwings), [filteredSwings])
  
  // ETHUSDT leader analysis - all symbols impact on ETH (ranked by trading edge)
  const ethLeaderRankings = useMemo(() => 
    allSymbolSwings.size > 1 ? calcEthLeaderRankings(allSymbolSwings) : [],
    [allSymbolSwings]
  )

  // Calculate feature completeness - % of swings that have each feature populated
  const featureCompleteness = useMemo(() => {
    if (filteredSwings.length === 0) return { overall: 0, features: [] as { name: string; pct: number; count: number }[] }
    
    const featureNames = [
      'rsi14', 'ema6', 'ema50', 'sma200', 'atr14', 'bb_pct_b', 'macd_histogram', 'stoch_k', 'adx14', 'roc10',
      'ema6_gt_ema50', 'close_gt_sma200', 'us_market_hours', 'utc_hour', 'utc_weekday', 'utc_month',
      'moon_phase', 'moon_illumination', 'tokyo_open', 'london_open', 'nyse_open', 'sydney_open', 'frankfurt_open',
      'range_pct', 'body_pct', 'close_sma200_pct', 'is_monday', 'is_friday', 'is_weekend',
      'quarter', 'is_month_start', 'is_month_end', 'is_first_week', 'is_last_week', 'is_mid_month',
      'hour_bucket', 'is_hour_start', 'is_hour_end', 'is_half_hour'
    ]
    
    const features = featureNames.map(name => {
      const count = filteredSwings.filter(s => {
        const val = s.features?.[name]
        return val !== null && val !== undefined
      }).length
      return { name, pct: (count / filteredSwings.length) * 100, count }
    })
    
    const totalPopulated = features.reduce((sum, f) => sum + f.count, 0)
    const totalPossible = features.length * filteredSwings.length
    const overall = totalPossible > 0 ? (totalPopulated / totalPossible) * 100 : 0
    
    return { overall, features }
  }, [filteredSwings])

  useEffect(() => {
    let mounted = true
    setLoading(true)

    // Helper to filter by timeframe
    const filterByTimeframe = (data: SwingEvent[]) => {
      if (!selectedTimeframe || selectedTimeframe === 'all') return data
      return data.filter(s => s.baseInterval === selectedTimeframe)
    }

    if (selectedSymbol === 'btc+eth') {
      // Load both BTC and ETH swings
      Promise.all([
        window.pricePerfect.engine.getSwings('btcusdt'),
        window.pricePerfect.engine.getSwings('ethusdt')
      ]).then(([btcResp, ethResp]) => {
        if (!mounted) return
        const btcData = filterByTimeframe(btcResp?.data || [])
        const ethData = filterByTimeframe(ethResp?.data || [])
        setBtcSwings(btcData)
        setEthSwings(ethData)
        setSwings([...btcData, ...ethData].sort((a, b) => b.openTime - a.openTime))
        setTotalInDb((btcResp?.total || 0) + (ethResp?.total || 0))
        setLoading(false)
      }).catch(() => {
        if (!mounted) return
        setLoading(false)
      })
    } else if (selectedSymbol === 'crypto-all') {
      // Load all crypto symbols
      Promise.all([
        window.pricePerfect.engine.getSwings('btcusdt'),
        window.pricePerfect.engine.getSwings('ethusdt'),
        window.pricePerfect.engine.getSwings('solusdt'),
        window.pricePerfect.engine.getSwings('dogeusdt'),
        window.pricePerfect.engine.getSwings('xrpusdt')
      ]).then((responses) => {
        if (!mounted) return
        const allData = responses.flatMap(r => filterByTimeframe(r?.data || []))
        setSwings(allData.sort((a, b) => b.openTime - a.openTime))
        setTotalInDb(responses.reduce((sum, r) => sum + (r?.total || 0), 0))
        setLoading(false)
      }).catch(() => {
        if (!mounted) return
        setLoading(false)
      })
    } else if (selectedSymbol === 'all') {
      // Load all symbols including tradfi
      Promise.all([
        window.pricePerfect.engine.getSwings('btcusdt'),
        window.pricePerfect.engine.getSwings('ethusdt'),
        window.pricePerfect.engine.getSwings('solusdt'),
        window.pricePerfect.engine.getSwings('dogeusdt'),
        window.pricePerfect.engine.getSwings('xrpusdt'),
        window.pricePerfect.engine.getSwings('spy'),
        window.pricePerfect.engine.getSwings('nq'),
        window.pricePerfect.engine.getSwings('gc'),
        window.pricePerfect.engine.getSwings('cl')
      ]).then((responses) => {
        if (!mounted) return
        const allData = responses.flatMap(r => filterByTimeframe(r?.data || []))
        setSwings(allData.sort((a, b) => b.openTime - a.openTime))
        setTotalInDb(responses.reduce((sum, r) => sum + (r?.total || 0), 0))
        setLoading(false)
      }).catch(() => {
        if (!mounted) return
        setLoading(false)
      })
    } else {
      window.pricePerfect.engine.getSwings(selectedSymbol).then((resp: any) => {
        if (!mounted) return
        const data = filterByTimeframe(resp?.data || [])
        setSwings(data)
        setTotalInDb(resp?.total || data.length)
        setLoading(false)
      }).catch(() => {
        if (!mounted) return
        setLoading(false)
      })
    }

    const off = window.pricePerfect.engine.on('swing', (evt: SwingEvent) => {
      // Filter by timeframe for live events
      if (selectedTimeframe && selectedTimeframe !== 'all' && evt.baseInterval !== selectedTimeframe) return
      
      if (selectedSymbol === 'btc+eth') {
        if (evt.symbol?.toLowerCase() === 'btcusdt') {
          setBtcSwings(prev => [evt, ...prev].slice(0, 10000))
        } else if (evt.symbol?.toLowerCase() === 'ethusdt') {
          setEthSwings(prev => [evt, ...prev].slice(0, 10000))
        }
        setSwings(prev => [evt, ...prev].slice(0, 10000))
      } else if (selectedSymbol === 'crypto-all' || selectedSymbol === 'all') {
        setSwings(prev => [evt, ...prev].slice(0, 10000))
      } else {
        if (evt.symbol?.toLowerCase() !== selectedSymbol.toLowerCase()) return
        setSwings((prev) => {
          const exists = prev.some((s) => s.id === evt.id)
          if (exists) return prev
          return [evt, ...prev].slice(0, 10000)
        })
      }
      setTotalInDb(prev => prev + 1)
    })

    return () => {
      mounted = false
      off()
    }
  }, [selectedSymbol, selectedTimeframe])

  // Load all symbols for correlation analysis
  useEffect(() => {
    if (!showCorrelation) return
    const symbols = ['btcusdt', 'ethusdt', 'solusdt', 'dogeusdt', 'xrpusdt', 'spy', 'nq', 'gc', 'cl']
    Promise.all(symbols.map(s => window.pricePerfect.engine.getSwings(s)))
      .then(responses => {
        const map = new Map<string, SwingEvent[]>()
        responses.forEach((r, i) => {
          if (r?.data?.length > 0) map.set(symbols[i], r.data)
        })
        setAllSymbolSwings(map)
      })
  }, [showCorrelation])

  const csv = useMemo(() => {
    if (swings.length === 0) return ''

    const featureKeys = ['rsi14', 'ema6', 'ema50', 'sma200', 'ema6_gt_ema50', 'close_gt_sma200', 'us_market_hours']
    const headers = ['openTime', 'time', 'type', 'price', ...featureKeys]

    const rows = swings.map((s) => {
      const time = new Date(s.openTime).toISOString()
      const base = [String(s.openTime), time, s.swingType, String(s.price)]
      const feats = featureKeys.map((k) => {
        const v = s.features?.[k]
        if (v === null || v === undefined) return ''
        if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(6) : ''
        return String(v)
      })
      return [...base, ...feats]
    })

    return [headers.join(','), ...rows.map((r) => r.map(escapeCsv).join(','))].join('\n')
  }, [swings])

  async function copyCsv() {
    if (!csv) return
    try {
      await navigator.clipboard.writeText(csv)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #1e2636' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 700 }}>Swings Dataset</div>
              <div style={{ fontSize: 12, color: '#9aa4b2', marginTop: 6 }}>
                Live swing highs/lows (pivot-based) with feature snapshots.
              </div>
            </div>
            
            {/* Symbol Selector */}
            <select
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid #1e2636',
                background: '#111820',
                color: '#e6eaf2',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                textTransform: 'uppercase'
              }}
            >
              {availableSymbols.map(sym => (
                <option key={sym} value={sym}>{sym.toUpperCase()}</option>
              ))}
            </select>

            {/* Timeframe Selector */}
            <select
              value={selectedTimeframe}
              onChange={(e) => setSelectedTimeframe(e.target.value)}
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid #1e2636',
                background: '#111820',
                color: '#3b82f6',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {TIMEFRAMES.map(tf => (
                <option key={tf} value={tf}>{tf}</option>
              ))}
            </select>
          </div>

          <button
            onClick={copyCsv}
            disabled={!csv}
            style={{
              border: '1px solid #1e2636',
              background: csv ? '#0f1421' : '#0b0f17',
              color: csv ? '#e6eaf2' : '#5f6b7a',
              padding: '8px 10px',
              borderRadius: 10,
              cursor: csv ? 'pointer' : 'not-allowed'
            }}
          >
            {copied ? 'Copied' : 'Copy CSV'}
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 16, color: '#9aa4b2' }}>Loading historical swings…</div>
      ) : (
        <>
          {/* Database Stats Panel */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0d1219' }}>
            <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
              Database Statistics ({filteredSwings.length.toLocaleString()} {filteredSwings.length !== swings.length ? `filtered of ${swings.length.toLocaleString()}` : 'total'} swings{selectedSymbol === 'btc+eth' ? ` — BTC: ${btcSwings.length.toLocaleString()}, ETH: ${ethSwings.length.toLocaleString()}` : ''})
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
              <StatCard label="Swing Highs" value={stats.highs.toLocaleString()} color="#ff5c77" />
              <StatCard label="Swing Lows" value={stats.lows.toLocaleString()} color="#29d48b" />
              <StatCard label="Avg RSI (All)" value={stats.avgRsi.toFixed(1)} />
              <StatCard label="Avg RSI (Highs)" value={stats.avgRsiHigh.toFixed(1)} color="#ff5c77" />
              <StatCard label="Avg RSI (Lows)" value={stats.avgRsiLow.toFixed(1)} color="#29d48b" />
              <StatCard label="% US Market Hrs" value={`${stats.pctUsMarket.toFixed(1)}%`} />
              <StatCard label="% EMA6 > EMA50" value={`${stats.pctEma6GtEma50.toFixed(1)}%`} />
              <StatCard label="% Close > SMA200" value={`${stats.pctCloseGtSma200.toFixed(1)}%`} />
              <StatCard label="Avg Range %" value={`${stats.avgRange.toFixed(3)}%`} />
              <StatCard label="Avg Body %" value={`${stats.avgBody.toFixed(3)}%`} />
              <StatCard label="Price Range" value={`$${stats.minPrice.toFixed(0)} - $${stats.maxPrice.toFixed(0)}`} />
            </div>
          </div>

          {/* Real Data Auditor Panel */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0d1219' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: '#6b7785', textTransform: 'uppercase', letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>🔍 Real Data Auditor</span>
                <span style={{ 
                  color: featureCompleteness.overall >= 95 ? '#22c55e' : featureCompleteness.overall >= 80 ? '#f59e0b' : '#ef4444',
                  fontWeight: 700,
                  fontSize: 12
                }}>
                  {featureCompleteness.overall.toFixed(1)}% Complete
                </span>
              </div>
              <div style={{ fontSize: 10, color: '#6b7785' }}>
                {featureCompleteness.features.filter(f => f.pct >= 99).length}/{featureCompleteness.features.length} features at 100%
              </div>
            </div>
            
            {/* Main Progress Bar */}
            <div style={{ height: 12, background: '#1e2636', borderRadius: 6, overflow: 'hidden', marginBottom: 8, position: 'relative' }}>
              <div style={{ 
                height: '100%', 
                width: `${featureCompleteness.overall}%`, 
                background: featureCompleteness.overall >= 95 ? 'linear-gradient(90deg, #22c55e, #4ade80)' : 
                           featureCompleteness.overall >= 80 ? 'linear-gradient(90deg, #f59e0b, #fbbf24)' : 
                           'linear-gradient(90deg, #ef4444, #f87171)',
                borderRadius: 6,
                transition: 'width 0.3s ease'
              }} />
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
                {featureCompleteness.overall >= 100 ? '✓ ALL REAL DATA VERIFIED' : `${featureCompleteness.overall.toFixed(1)}% — ${(100 - featureCompleteness.overall).toFixed(1)}% MISSING`}
              </div>
            </div>

            {/* Feature Grid */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {featureCompleteness.features.map(f => (
                <div 
                  key={f.name}
                  style={{ 
                    padding: '3px 6px', 
                    borderRadius: 4, 
                    fontSize: 9,
                    background: f.pct >= 99 ? '#14532d' : f.pct >= 50 ? '#78350f' : '#7f1d1d',
                    color: f.pct >= 99 ? '#4ade80' : f.pct >= 50 ? '#fbbf24' : '#fca5a5',
                    border: `1px solid ${f.pct >= 99 ? '#22c55e33' : f.pct >= 50 ? '#f59e0b33' : '#ef444433'}`
                  }}
                  title={`${f.count.toLocaleString()} of ${filteredSwings.length.toLocaleString()} swings have real data`}
                >
                  {f.pct >= 99 ? '✓' : f.pct >= 50 ? '◐' : '✗'} {f.name}: {f.pct.toFixed(0)}%
                </div>
              ))}
            </div>
            
            {featureCompleteness.overall < 100 && (
              <div style={{ marginTop: 8, fontSize: 10, color: '#f59e0b', background: '#78350f22', padding: '6px 10px', borderRadius: 4, border: '1px solid #78350f44' }}>
                ⚠️ Missing data points are marked in red/yellow. Regenerate swings to fill gaps. All data is real — no synthetic values.
              </div>
            )}
          </div>

          {/* Cross-Symbol Analysis Panel (BTC+ETH mode only) */}
          {selectedSymbol === 'btc+eth' && crossAnalysis && (
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0a1219' }}>
              <div style={{ fontSize: 11, color: '#f0b429', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
                🔗 Cross-Symbol Leading Indicator Analysis (BTC ↔ ETH)
              </div>
              
              {/* Summary Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
                <div style={{ background: '#111820', borderRadius: 8, padding: '12px', border: '1px solid #1e2636' }}>
                  <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>BTC Leads ETH (Correlation)</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: crossAnalysis.correlation > 50 ? '#29d48b' : '#ff5c77' }}>
                    {crossAnalysis.correlation.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 10, color: '#6b7785', marginTop: 4 }}>
                    {crossAnalysis.correlation > 50 ? '✓ BTC appears to lead ETH' : '✗ Weak leading signal'}
                  </div>
                </div>
                <div style={{ background: '#111820', borderRadius: 8, padding: '12px', border: '1px solid #1e2636' }}>
                  <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>BTC High → ETH High</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#ff5c77' }}>
                    {crossAnalysis.btcHighsBeforeEthHighs.toFixed(1)}%
                  </div>
                </div>
                <div style={{ background: '#111820', borderRadius: 8, padding: '12px', border: '1px solid #1e2636' }}>
                  <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>BTC Low → ETH Low</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#29d48b' }}>
                    {crossAnalysis.btcLowsBeforeEthLows.toFixed(1)}%
                  </div>
                </div>
              </div>

              {/* BTC Leads ETH Table */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, color: '#f59e0b', marginBottom: 8, fontWeight: 600 }}>
                  📈 BTC Leading Signals → ETH Follows (within 1 hour)
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid #1e2636', color: '#6b7785' }}>
                      <th style={{ padding: '8px 6px' }}>Pattern</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Occurrences</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Success Rate</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Avg Lag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {crossAnalysis.btcLeadsEth.map((p) => (
                      <tr key={p.pattern} style={{ borderBottom: '1px solid #121a2a' }}>
                        <td style={{ padding: '8px 6px', fontWeight: 600 }}>{p.pattern}</td>
                        <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{p.occurrences.toLocaleString()}</td>
                        <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: p.successRate > 50 ? '#29d48b' : '#9aa4b2' }}>
                          {p.successRate.toFixed(1)}%
                        </td>
                        <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{p.avgLagMinutes} min</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ETH Leads BTC Table */}
              <div>
                <div style={{ fontSize: 10, color: '#8b5cf6', marginBottom: 8, fontWeight: 600 }}>
                  📉 ETH Leading Signals → BTC Follows (reverse check)
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid #1e2636', color: '#6b7785' }}>
                      <th style={{ padding: '8px 6px' }}>Pattern</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Occurrences</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Success Rate</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Avg Lag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {crossAnalysis.ethLeadsBtc.map((p) => (
                      <tr key={p.pattern} style={{ borderBottom: '1px solid #121a2a' }}>
                        <td style={{ padding: '8px 6px', fontWeight: 600 }}>{p.pattern}</td>
                        <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{p.occurrences.toLocaleString()}</td>
                        <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: p.successRate > 50 ? '#29d48b' : '#9aa4b2' }}>
                          {p.successRate.toFixed(1)}%
                        </td>
                        <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{p.avgLagMinutes} min</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Theory Verdict */}
              <div style={{ marginTop: 16, padding: 12, background: '#111820', borderRadius: 8, border: '1px solid #1e2636' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#e6eaf2', marginBottom: 6 }}>
                  📊 Theory Analysis: "BTC is a leading indicator for ETH"
                </div>
                <div style={{ fontSize: 12, color: crossAnalysis.correlation > 50 ? '#29d48b' : '#ff5c77' }}>
                  {crossAnalysis.correlation > 60 
                    ? `✓ SUPPORTED — BTC swings precede ETH swings ${crossAnalysis.correlation.toFixed(0)}% of the time. Consider trading ETH on BTC signals.`
                    : crossAnalysis.correlation > 40
                    ? `⚠ INCONCLUSIVE — ${crossAnalysis.correlation.toFixed(0)}% correlation is not strong enough to confirm the theory.`
                    : `✗ NOT SUPPORTED — Only ${crossAnalysis.correlation.toFixed(0)}% of ETH swings follow BTC. The theory does not hold with this data.`
                  }
                </div>
              </div>
            </div>
          )}

          {/* Correlation Analysis Section */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0a1219' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 1 }}>
                🔗 Correlation Analysis — Factors & Symbols
              </div>
              <button
                onClick={() => setShowCorrelation(!showCorrelation)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: '1px solid #1e2636',
                  background: showCorrelation ? '#581c87' : '#111820',
                  color: showCorrelation ? '#e9d5ff' : '#9aa4b2',
                  fontSize: 11,
                  cursor: 'pointer'
                }}
              >
                {showCorrelation ? '✓ Analysis Active' : 'Load Correlation Data'}
              </button>
            </div>
            
            {showCorrelation && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Multi-Factor Confluence - Best Combinations */}
                <div style={{ background: '#111820', borderRadius: 8, padding: 12, border: '1px solid #1e2636' }}>
                  <div style={{ fontSize: 10, color: '#22c55e', marginBottom: 10, fontWeight: 600 }}>
                    🎯 Best Multi-Factor Combinations (2-3 factors)
                  </div>
                  {multiFactorConfluence.length === 0 ? (
                    <div style={{ fontSize: 11, color: '#6b7785' }}>Need 50+ swings for analysis...</div>
                  ) : (
                    <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                      {multiFactorConfluence.slice(0, 15).map((mf, i) => (
                        <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid #1a2332' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <span style={{ 
                              fontSize: 11, 
                              fontWeight: 700, 
                              color: mf.avgWinRate >= 70 ? '#22c55e' : mf.avgWinRate >= 60 ? '#fbbf24' : '#f87171'
                            }}>
                              {mf.avgWinRate.toFixed(0)}%
                            </span>
                            <span style={{ fontSize: 9, color: mf.highWinRate > mf.lowWinRate ? '#ff5c77' : '#29d48b' }}>
                              {mf.highWinRate > mf.lowWinRate ? '▲ Highs' : '▼ Lows'}
                            </span>
                            <span style={{ fontSize: 9, color: '#6b7785', marginLeft: 'auto' }}>
                              n={mf.totalOccurrences}
                            </span>
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {mf.factors.map((f, fi) => (
                              <span key={fi} style={{ 
                                padding: '2px 6px', 
                                borderRadius: 4, 
                                fontSize: 9, 
                                background: '#1e2636', 
                                color: '#a78bfa',
                                border: '1px solid #581c87'
                              }}>
                                {f}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ETHUSDT Leading Indicators - Ranked by Trading Edge */}
                <div style={{ background: '#111820', borderRadius: 8, padding: 12, border: '1px solid #1e2636' }}>
                  <div style={{ fontSize: 10, color: '#f59e0b', marginBottom: 6, fontWeight: 600 }}>
                    🏆 PROVEN WINNING SIGNALS FOR ETH
                  </div>
                  <div style={{ fontSize: 9, color: '#6b7785', marginBottom: 10 }}>
                    Historical win rates if you had taken these trades
                  </div>
                  {ethLeaderRankings.length === 0 ? (
                    <div style={{ fontSize: 11, color: '#6b7785' }}>Loading all symbols...</div>
                  ) : (
                    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                      {ethLeaderRankings.slice(0, 12).map((lr: EthLeaderRanking) => (
                        <div key={`${lr.symbol}-${lr.direction}`} style={{ 
                          padding: '10px', 
                          marginBottom: 8, 
                          borderRadius: 8, 
                          background: lr.hitRate >= 80 ? '#052e16' : lr.hitRate >= 60 ? '#422006' : '#1e2636',
                          border: `2px solid ${lr.hitRate >= 80 ? '#22c55e' : lr.hitRate >= 60 ? '#f59e0b' : '#2d3748'}`
                        }}>
                          {/* Main winning trade callout */}
                          <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: 10, 
                            marginBottom: 8,
                            padding: '8px 10px',
                            borderRadius: 6,
                            background: lr.direction === 'LONG' ? '#14532d' : '#7f1d1d'
                          }}>
                            <span style={{ fontSize: 18 }}>{lr.direction === 'LONG' ? '📈' : '📉'}</span>
                            <div style={{ flex: 1 }}>
                              <div style={{ 
                                fontSize: 13, 
                                fontWeight: 700, 
                                color: lr.direction === 'LONG' ? '#4ade80' : '#fca5a5'
                              }}>
                                {lr.direction} ETH = {lr.hitRate.toFixed(0)}% WIN RATE
                              </div>
                              <div style={{ fontSize: 10, color: '#9aa4b2' }}>
                                {lr.occurrences} trades would have won
                              </div>
                            </div>
                            <span style={{ 
                              fontSize: 11, 
                              fontWeight: 700, 
                              color: '#fff',
                              background: lr.hitRate >= 80 ? '#16a34a' : lr.hitRate >= 60 ? '#d97706' : '#6b7785',
                              padding: '4px 8px',
                              borderRadius: 6
                            }}>
                              #{lr.rank}
                            </span>
                          </div>
                          
                          {/* Trigger explanation */}
                          <div style={{ fontSize: 11, color: '#e6eaf2', marginBottom: 6 }}>
                            <strong>When to enter:</strong> {lr.symbolName} ({lr.symbol}) makes a {lr.direction === 'LONG' ? 'LOW' : 'HIGH'}
                          </div>
                          <div style={{ fontSize: 11, color: lr.direction === 'LONG' ? '#4ade80' : '#f87171', marginBottom: 6 }}>
                            <strong>Trade:</strong> {lr.direction} ETH within ~{lr.leadsBy} minutes
                          </div>
                          <div style={{ 
                            fontSize: 10, 
                            color: '#22c55e', 
                            background: '#0a1a0f',
                            padding: '6px 8px',
                            borderRadius: 4,
                            border: '1px solid #14532d'
                          }}>
                            ✅ <strong>Result:</strong> If you {lr.direction === 'LONG' ? 'longed' : 'shorted'} ETH on this signal, you would have won <strong>{lr.hitRate.toFixed(0)}%</strong> of the time ({lr.occurrences} winning trades)
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Correlation Insights Summary */}
            {showCorrelation && symbolCorrelations.length > 0 && (
              <div style={{ marginTop: 12, padding: 10, background: '#0d1117', borderRadius: 6, border: '1px solid #1e2636' }}>
                <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>💡 KEY INSIGHTS</div>
                <div style={{ fontSize: 11, color: '#e6eaf2', lineHeight: 1.5 }}>
                  {symbolCorrelations[0] && (
                    <div>• <strong style={{ color: '#60a5fa' }}>{symbolCorrelations[0].symbol1}-{symbolCorrelations[0].symbol2}</strong> highest correlation ({symbolCorrelations[0].overall.toFixed(0)}%) — swings often occur within 1hr</div>
                  )}
                  {factorCorrelations[0] && (
                    <div>• <strong style={{ color: '#a78bfa' }}>{factorCorrelations[0].factor1}</strong> and <strong style={{ color: '#a78bfa' }}>{factorCorrelations[0].factor2}</strong> strongly correlated ({(factorCorrelations[0].correlation * 100).toFixed(0)}%)</div>
                  )}
                  {symbolCorrelations.find(s => Math.abs(s.leadLag) > 20) && (
                    <div>• <strong style={{ color: '#f59e0b' }}>Leading indicator found:</strong> {
                      (() => {
                        const lead = symbolCorrelations.find(s => Math.abs(s.leadLag) > 20)!
                        return lead.leadLag > 0 ? `${lead.symbol1} tends to lead ${lead.symbol2}` : `${lead.symbol2} tends to lead ${lead.symbol1}`
                      })()
                    }</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Confluence Matrix + Strategy Filter Panel */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #1e2636' }}>
            {/* LEFT: Confluence Matrix - 10 rows */}
            <div style={{ flex: 1, padding: '12px 16px', background: '#0a0e14', borderRight: '1px solid #1e2636' }}>
              <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
                📊 Confluence Matrix — Variables × Timeframes
              </div>
              
              {/* Header row */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 8, paddingLeft: 90 }}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => (
                  <div key={v} style={{ width: 44, textAlign: 'center', fontSize: 9, color: '#6b7785' }}>
                    {v} Var{v > 1 ? 's' : ''}
                  </div>
                ))}
              </div>

              {/* Matrix rows - 1 TF through 10 TFs */}
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(tfCount => (
                <div key={tfCount} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                  <div style={{ width: 86, fontSize: 10, color: tfCount === 1 ? '#3b82f6' : '#f0b429', fontWeight: 500 }}>
                    {tfCount === 1 ? '1 Timeframe' : `${tfCount} TFs`}
                  </div>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(varCount => {
                    const isSelected = matrixSelection?.vars === varCount && matrixSelection?.tfs === tfCount
                    const isSimple = tfCount === 1 && varCount === 1
                    return (
                      <button
                        key={varCount}
                        onClick={() => {
                          if (isSelected) {
                            setMatrixSelection(null)
                            setConfluenceMode(1)
                            setMultiTfMode(0)
                          } else {
                            setMatrixSelection({ vars: varCount, tfs: tfCount })
                            setConfluenceMode(varCount)
                            setMultiTfMode(tfCount > 1 ? tfCount : 0)
                          }
                        }}
                        style={{
                          width: 44,
                          height: 28,
                          borderRadius: 4,
                          border: isSelected ? '2px solid #22c55e' : '1px solid #1e2636',
                          background: isSelected ? '#14532d' : isSimple ? '#1e3a5f' : `rgba(251, 191, 36, ${0.1 + (tfCount * 0.08)})`,
                          color: isSelected ? '#4ade80' : isSimple ? '#60a5fa' : '#fbbf24',
                          cursor: 'pointer',
                          fontSize: 10,
                          fontWeight: isSelected ? 700 : 500
                        }}
                      >
                        {varCount}×{tfCount}
                      </button>
                    )
                  })}
                </div>
              ))}

              {/* Legend */}
              <div style={{ marginTop: 12, display: 'flex', gap: 16, fontSize: 10, color: '#6b7785' }}>
                <span>💡 Click cell to analyze: <strong style={{ color: '#e6eaf2' }}>[Variables] × [Timeframes]</strong></span>
                <span style={{ color: '#4ade80' }}>■ Selected</span>
                <span style={{ color: '#60a5fa' }}>■ Single TF</span>
                <span style={{ color: '#fbbf24' }}>■ Multi-TF</span>
              </div>
            </div>

            {/* RIGHT: Strategy Filter Panel */}
            <div style={{ width: 320, padding: '12px 16px', background: '#0d1117', overflow: 'auto', maxHeight: 420 }}>
              <div style={{ fontSize: 11, color: '#a78bfa', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
                🤖 Strategy Filters — Bot Config
              </div>

              {/* Day of Week */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>Day of Week</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => {
                    const isActive = strategyFilters.daysOfWeek.includes(i)
                    return (
                      <button
                        key={day}
                        onClick={() => setStrategyFilters(f => ({
                          ...f,
                          daysOfWeek: isActive 
                            ? f.daysOfWeek.filter(d => d !== i)
                            : [...f.daysOfWeek, i]
                        }))}
                        style={{
                          padding: '4px 8px',
                          fontSize: 10,
                          borderRadius: 4,
                          border: '1px solid #1e2636',
                          background: isActive ? '#3b82f6' : '#111820',
                          color: isActive ? '#fff' : '#9aa4b2',
                          cursor: 'pointer'
                        }}
                      >
                        {day}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Time of Day (Hours) */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>Hours (UTC)</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                  {Array.from({ length: 24 }, (_, i) => {
                    const isActive = strategyFilters.hoursOfDay.includes(i)
                    return (
                      <button
                        key={i}
                        onClick={() => setStrategyFilters(f => ({
                          ...f,
                          hoursOfDay: isActive 
                            ? f.hoursOfDay.filter(h => h !== i)
                            : [...f.hoursOfDay, i]
                        }))}
                        style={{
                          width: 28,
                          height: 22,
                          fontSize: 9,
                          borderRadius: 3,
                          border: '1px solid #1e2636',
                          background: isActive ? '#22c55e' : '#111820',
                          color: isActive ? '#fff' : '#6b7785',
                          cursor: 'pointer'
                        }}
                      >
                        {i}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Month */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>Month</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => {
                    const isActive = strategyFilters.months.includes(i + 1)
                    return (
                      <button
                        key={m}
                        onClick={() => setStrategyFilters(f => ({
                          ...f,
                          months: isActive 
                            ? f.months.filter(x => x !== i + 1)
                            : [...f.months, i + 1]
                        }))}
                        style={{
                          padding: '4px 6px',
                          fontSize: 9,
                          borderRadius: 4,
                          border: '1px solid #1e2636',
                          background: isActive ? '#f0b429' : '#111820',
                          color: isActive ? '#000' : '#9aa4b2',
                          cursor: 'pointer'
                        }}
                      >
                        {m}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Quarter */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>Quarter</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[1, 2, 3, 4].map(q => {
                    const isActive = strategyFilters.quarters.includes(q)
                    return (
                      <button
                        key={q}
                        onClick={() => setStrategyFilters(f => ({
                          ...f,
                          quarters: isActive 
                            ? f.quarters.filter(x => x !== q)
                            : [...f.quarters, q]
                        }))}
                        style={{
                          padding: '4px 12px',
                          fontSize: 10,
                          borderRadius: 4,
                          border: '1px solid #1e2636',
                          background: isActive ? '#a78bfa' : '#111820',
                          color: isActive ? '#fff' : '#9aa4b2',
                          cursor: 'pointer'
                        }}
                      >
                        Q{q}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Moon Phase */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>Moon Phase</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {['New', 'Waxing', 'Full', 'Waning'].map(phase => {
                    const isActive = strategyFilters.moonPhases.includes(phase.toLowerCase())
                    return (
                      <button
                        key={phase}
                        onClick={() => setStrategyFilters(f => ({
                          ...f,
                          moonPhases: isActive 
                            ? f.moonPhases.filter(x => x !== phase.toLowerCase())
                            : [...f.moonPhases, phase.toLowerCase()]
                        }))}
                        style={{
                          padding: '4px 8px',
                          fontSize: 10,
                          borderRadius: 4,
                          border: '1px solid #1e2636',
                          background: isActive ? '#fbbf24' : '#111820',
                          color: isActive ? '#000' : '#9aa4b2',
                          cursor: 'pointer'
                        }}
                      >
                        {phase === 'New' ? '🌑' : phase === 'Waxing' ? '🌓' : phase === 'Full' ? '🌕' : '🌗'} {phase}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Trading Sessions */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>Trading Sessions</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {['Tokyo', 'London', 'NYSE', 'Sydney', 'Frankfurt'].map(session => {
                    const isActive = strategyFilters.sessions.includes(session.toLowerCase())
                    return (
                      <button
                        key={session}
                        onClick={() => setStrategyFilters(f => ({
                          ...f,
                          sessions: isActive 
                            ? f.sessions.filter(x => x !== session.toLowerCase())
                            : [...f.sessions, session.toLowerCase()]
                        }))}
                        style={{
                          padding: '4px 8px',
                          fontSize: 10,
                          borderRadius: 4,
                          border: '1px solid #1e2636',
                          background: isActive ? '#06b6d4' : '#111820',
                          color: isActive ? '#fff' : '#9aa4b2',
                          cursor: 'pointer'
                        }}
                      >
                        {session}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Trend Direction */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 6 }}>Trend Bias (EMA6 vs EMA50)</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[
                    { key: 'any', label: 'Any', color: '#6b7785' },
                    { key: 'bullish', label: '▲ Bullish', color: '#22c55e' },
                    { key: 'bearish', label: '▼ Bearish', color: '#ef4444' }
                  ].map(({ key, label, color }) => (
                    <button
                      key={key}
                      onClick={() => setStrategyFilters(f => ({ ...f, trendDirection: key as any }))}
                      style={{
                        padding: '4px 10px',
                        fontSize: 10,
                        borderRadius: 4,
                        border: '1px solid #1e2636',
                        background: strategyFilters.trendDirection === key ? color : '#111820',
                        color: strategyFilters.trendDirection === key ? '#fff' : '#9aa4b2',
                        cursor: 'pointer'
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Export for Bot */}
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #1e2636' }}>
                <button
                  onClick={() => {
                    const config = {
                      symbol: selectedSymbol,
                      timeframe: selectedTimeframe,
                      filters: strategyFilters,
                      exportedAt: new Date().toISOString(),
                      confluenceMatrix: matrixSelection
                    }
                    navigator.clipboard.writeText(JSON.stringify(config, null, 2))
                  }}
                  style={{
                    width: '100%',
                    padding: '10px',
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 6,
                    border: '1px solid #22c55e',
                    background: 'linear-gradient(135deg, #14532d 0%, #166534 100%)',
                    color: '#4ade80',
                    cursor: 'pointer'
                  }}
                >
                  📋 Copy Bot Config (JSON)
                </button>
                <div style={{ fontSize: 9, color: '#6b7785', marginTop: 6, textAlign: 'center' }}>
                  {strategyFilters.daysOfWeek.length + strategyFilters.hoursOfDay.length + strategyFilters.months.length + strategyFilters.quarters.length + strategyFilters.moonPhases.length + strategyFilters.sessions.length} filters active
                </div>
              </div>
            </div>
          </div>

          {/* Matrix Selection Results */}
          {matrixSelection && (
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0d1a0d' }}>
              <div style={{ fontSize: 11, color: '#4ade80', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
                🎯 Selected: {matrixSelection.vars} Variable{matrixSelection.vars > 1 ? 's' : ''} × {matrixSelection.tfs} Timeframe{matrixSelection.tfs > 1 ? 's' : ''}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <div style={{ background: '#111820', borderRadius: 8, padding: 12, border: '1px solid #1e2636' }}>
                  <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>Variables in Confluence</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#3b82f6' }}>{matrixSelection.vars}</div>
                  <div style={{ fontSize: 10, color: '#6b7785', marginTop: 4 }}>Trading factors combined</div>
                </div>
                <div style={{ background: '#111820', borderRadius: 8, padding: 12, border: '1px solid #1e2636' }}>
                  <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>Timeframes Aligned</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#f0b429' }}>{matrixSelection.tfs}</div>
                  <div style={{ fontSize: 10, color: '#6b7785', marginTop: 4 }}>Multi-TF confirmation</div>
                </div>
                <div style={{ background: '#111820', borderRadius: 8, padding: 12, border: '1px solid #1e2636' }}>
                  <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>Confluence Strength</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#22c55e' }}>
                    {Math.min(100, (matrixSelection.vars * matrixSelection.tfs * 10))}%
                  </div>
                  <div style={{ fontSize: 10, color: '#6b7785', marginTop: 4 }}>Higher = stronger signal</div>
                </div>
              </div>
              <div style={{ marginTop: 12, padding: 12, background: '#111820', borderRadius: 8, border: '1px solid #1e2636' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#e6eaf2', marginBottom: 6 }}>
                  📈 Strategy: {matrixSelection.vars}V × {matrixSelection.tfs}TF Confluence
                </div>
                <div style={{ fontSize: 12, color: '#9aa4b2' }}>
                  {matrixSelection.tfs === 1 
                    ? `Looking for ${matrixSelection.vars} trading variable${matrixSelection.vars > 1 ? 's' : ''} to align on the ${selectedTimeframe} timeframe.`
                    : `Looking for ${matrixSelection.vars} trading variable${matrixSelection.vars > 1 ? 's' : ''} to align across ${matrixSelection.tfs} different timeframes (${TIMEFRAMES.slice(0, matrixSelection.tfs).join(', ')}).`
                  }
                  {matrixSelection.vars * matrixSelection.tfs >= 6 && ' This is a high-confluence setup with strong signal confirmation.'}
                </div>
              </div>
            </div>
          )}

          {/* Confluence Results (when mode > 1) */}
          {confluenceMode > 1 && (
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0d1219' }}>
              <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
                Top {confluenceMode}-Factor Confluences (Ranked by Impact)
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid #1e2636', color: '#6b7785' }}>
                      <th style={{ padding: '8px 6px', width: 40 }}>Rank</th>
                      <th style={{ padding: '8px 6px' }}>Factor Combination</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>High %</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Low %</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Win Rate</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Separation</th>
                      <th style={{ padding: '8px 6px', width: 120 }}>Impact Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {confluenceResults.map((r) => (
                      <tr key={r.description} style={{ borderBottom: '1px solid #121a2a' }}>
                        <td style={{ padding: '8px 6px', fontWeight: 700, color: r.rank <= 3 ? '#f0b429' : '#9aa4b2' }}>
                          #{r.rank}
                        </td>
                        <td style={{ padding: '8px 6px' }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {r.factors.map((f, i) => (
                              <span key={i} style={{ 
                                background: '#1e2636', 
                                padding: '2px 6px', 
                                borderRadius: 4,
                                fontSize: 10,
                                color: f.startsWith('🤖') ? '#a78bfa' : '#e6eaf2'
                              }}>
                                {f}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td style={{ padding: '8px 6px', textAlign: 'right', color: '#ff5c77', fontFamily: 'monospace' }}>
                          {r.highPct.toFixed(2)}%
                        </td>
                        <td style={{ padding: '8px 6px', textAlign: 'right', color: '#29d48b', fontFamily: 'monospace' }}>
                          {r.lowPct.toFixed(2)}%
                        </td>
                        <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                            <span style={{ 
                              fontSize: 9, 
                              padding: '1px 4px', 
                              borderRadius: 3,
                              background: r.dominantType === 'high' ? '#3f1219' : r.dominantType === 'low' ? '#0a3622' : '#1e2636',
                              color: r.dominantType === 'high' ? '#ff5c77' : r.dominantType === 'low' ? '#29d48b' : '#6b7785'
                            }}>
                              {r.dominantType === 'high' ? '▼' : r.dominantType === 'low' ? '▲' : '–'}
                            </span>
                            <span style={{ 
                              fontFamily: 'monospace', 
                              fontWeight: 600,
                              color: r.winRate >= 70 ? '#22c55e' : r.winRate >= 60 ? '#f0b429' : '#9aa4b2'
                            }}>
                              {r.winRate.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: '#9aa4b2' }}>
                          {r.separation.toFixed(2)}
                        </td>
                        <td style={{ padding: '8px 6px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ flex: 1, height: 8, background: '#1e2636', borderRadius: 4, overflow: 'hidden' }}>
                              <div style={{ 
                                width: `${r.impactScore}%`, 
                                height: '100%', 
                                background: r.rank === 1 ? '#f0b429' : r.rank <= 3 ? '#ff9f1c' : '#3b82f6',
                                borderRadius: 4
                              }} />
                            </div>
                            <span style={{ fontSize: 10, color: '#9aa4b2', minWidth: 32 }}>
                              {r.impactScore.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {confluenceResults.length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ padding: 16, textAlign: 'center', color: '#6b7785' }}>
                          No confluence data - run Derived Rebuild to populate features
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Top 40 Ranked Trading Variables (Single Factor) */}
          {confluenceMode === 1 && (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2636', background: '#0a0e14' }}>
            <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
              Top 40 Single-Factor Variables (Ranked by Impact Score) — 🤖 = AI-Discovered
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #1e2636', color: '#6b7785' }}>
                    <th style={{ padding: '8px 6px', width: 40 }}>Rank</th>
                    <th style={{ padding: '8px 6px' }}>Variable</th>
                    <th style={{ padding: '8px 6px', textAlign: 'right' }}>High Avg</th>
                    <th style={{ padding: '8px 6px', textAlign: 'right' }}>Low Avg</th>
                    <th style={{ padding: '8px 6px', textAlign: 'right' }}>Win Rate</th>
                    <th style={{ padding: '8px 6px', textAlign: 'right' }}>Separation</th>
                    <th style={{ padding: '8px 6px', width: 120 }}>Impact Score</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedVars.map((v) => (
                    <tr key={v.name} style={{ borderBottom: '1px solid #121a2a' }}>
                      <td style={{ padding: '8px 6px', fontWeight: 700, color: v.rank <= 3 ? '#f0b429' : '#9aa4b2' }}>
                        #{v.rank}
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        <div style={{ fontWeight: 600, color: '#e6eaf2' }}>{v.name}</div>
                        <div style={{ fontSize: 10, color: '#6b7785', marginTop: 2 }}>{v.description}</div>
                      </td>
                      <td style={{ padding: '8px 6px', textAlign: 'right', color: '#ff5c77', fontFamily: 'monospace' }}>
                        {v.highValue.toFixed(2)}{v.unit}
                      </td>
                      <td style={{ padding: '8px 6px', textAlign: 'right', color: '#29d48b', fontFamily: 'monospace' }}>
                        {v.lowValue.toFixed(2)}{v.unit}
                      </td>
                      <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                          <span style={{ 
                            fontSize: 9, 
                            padding: '1px 4px', 
                            borderRadius: 3,
                            background: v.dominantType === 'high' ? '#3f1219' : v.dominantType === 'low' ? '#0a3622' : '#1e2636',
                            color: v.dominantType === 'high' ? '#ff5c77' : v.dominantType === 'low' ? '#29d48b' : '#6b7785'
                          }}>
                            {v.dominantType === 'high' ? '▼' : v.dominantType === 'low' ? '▲' : '–'}
                          </span>
                          <span style={{ 
                            fontFamily: 'monospace', 
                            fontWeight: 600,
                            color: v.winRate >= 70 ? '#22c55e' : v.winRate >= 60 ? '#f0b429' : '#9aa4b2'
                          }}>
                            {v.winRate.toFixed(0)}%
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: '#9aa4b2' }}>
                        {v.separation.toFixed(2)}
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ 
                            flex: 1, 
                            height: 8, 
                            background: '#1e2636', 
                            borderRadius: 4, 
                            overflow: 'hidden' 
                          }}>
                            <div style={{ 
                              width: `${v.impactScore}%`, 
                              height: '100%', 
                              background: v.rank === 1 ? '#f0b429' : v.rank <= 3 ? '#ff9f1c' : '#3b82f6',
                              borderRadius: 4
                            }} />
                          </div>
                          <span style={{ fontSize: 10, color: '#9aa4b2', minWidth: 32 }}>
                            {v.impactScore.toFixed(0)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          )}

          {/* Recent Swings Table - ALL FEATURES */}
          <div style={{ padding: '12px 16px', color: '#6b7785', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
            Recent Swings - All Features (scroll right →) — showing 10 of {filteredSwings.length.toLocaleString()}
          </div>
          <div style={{ overflowX: 'auto', padding: '0 16px 16px' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 10, whiteSpace: 'nowrap' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #1e2636', color: '#9aa4b2' }}>
                  <th style={{ padding: '8px 6px', position: 'sticky', left: 0, background: '#0b0f17', zIndex: 1 }}>Time</th>
                  <th style={{ padding: '8px 6px' }}>Type</th>
                  <th style={{ padding: '8px 6px' }}>Price</th>
                  <th style={{ padding: '8px 6px' }}>RSI14</th>
                  <th style={{ padding: '8px 6px' }}>EMA6</th>
                  <th style={{ padding: '8px 6px' }}>EMA50</th>
                  <th style={{ padding: '8px 6px' }}>SMA200</th>
                  <th style={{ padding: '8px 6px' }}>EMA6&gt;50</th>
                  <th style={{ padding: '8px 6px' }}>Cls&gt;200</th>
                  <th style={{ padding: '8px 6px' }}>Cls-SMA%</th>
                  <th style={{ padding: '8px 6px' }}>Range%</th>
                  <th style={{ padding: '8px 6px' }}>Body%</th>
                  <th style={{ padding: '8px 6px' }}>Weekday</th>
                  <th style={{ padding: '8px 6px' }}>Hour</th>
                  <th style={{ padding: '8px 6px' }}>Minute</th>
                  <th style={{ padding: '8px 6px' }}>Month</th>
                  <th style={{ padding: '8px 6px' }}>US Mkt</th>
                  <th style={{ padding: '8px 6px' }}>Moon</th>
                  <th style={{ padding: '8px 6px' }}>MoonIll%</th>
                  <th style={{ padding: '8px 6px' }}>Tokyo</th>
                  <th style={{ padding: '8px 6px' }}>London</th>
                  <th style={{ padding: '8px 6px' }}>NYSE</th>
                  <th style={{ padding: '8px 6px' }}>Sydney</th>
                  <th style={{ padding: '8px 6px' }}>Frnkfrt</th>
                  <th style={{ padding: '8px 6px' }}>Ldn-NYSE</th>
                  <th style={{ padding: '8px 6px' }}>Tky-Ldn</th>
                  <th style={{ padding: '8px 6px' }}>MktsOpen</th>
                  <th style={{ padding: '8px 6px' }}>Weekend</th>
                  <th style={{ padding: '8px 6px' }}>Mon</th>
                  <th style={{ padding: '8px 6px' }}>Fri</th>
                  <th style={{ padding: '8px 6px' }}>Quarter</th>
                  <th style={{ padding: '8px 6px' }}>MoStart</th>
                  <th style={{ padding: '8px 6px' }}>MoEnd</th>
                  <th style={{ padding: '8px 6px' }}>HrBucket</th>
                  <th style={{ padding: '8px 6px' }}>Session</th>
                  <th style={{ padding: '8px 6px' }}>Tue</th>
                  <th style={{ padding: '8px 6px' }}>Wed</th>
                  <th style={{ padding: '8px 6px' }}>Thu</th>
                  <th style={{ padding: '8px 6px' }}>1stWk</th>
                  <th style={{ padding: '8px 6px' }}>LastWk</th>
                  <th style={{ padding: '8px 6px' }}>MidMo</th>
                  <th style={{ padding: '8px 6px' }}>Q1</th>
                  <th style={{ padding: '8px 6px' }}>Q4</th>
                  <th style={{ padding: '8px 6px' }}>Summer</th>
                  <th style={{ padding: '8px 6px' }}>Dec</th>
                  <th style={{ padding: '8px 6px' }}>Jan</th>
                  <th style={{ padding: '8px 6px' }}>HrStart</th>
                  <th style={{ padding: '8px 6px' }}>HrEnd</th>
                  <th style={{ padding: '8px 6px' }}>Half:30</th>
                  <th style={{ padding: '8px 6px' }}>🤖Gold</th>
                  <th style={{ padding: '8px 6px' }}>🤖Fib</th>
                  <th style={{ padding: '8px 6px' }}>🤖Prime</th>
                  <th style={{ padding: '8px 6px' }}>🤖DigSum</th>
                  <th style={{ padding: '8px 6px' }}>🤖Lunar</th>
                  <th style={{ padding: '8px 6px' }}>🤖TriWit</th>
                  <th style={{ padding: '8px 6px' }}>🤖Merc</th>
                  <th style={{ padding: '8px 6px' }}>🤖Solar</th>
                  <th style={{ padding: '8px 6px' }}>🤖Entrpy</th>
                  <th style={{ padding: '8px 6px' }}>🤖Harmon</th>
                </tr>
              </thead>
              <tbody>
                {filteredSwings.slice(-10).reverse().map((s) => {
                  const f = s.features || {}
                  const isHigh = s.swingType === 'high'
                  const fmt = (v: any, dec = 2) => typeof v === 'number' ? v.toFixed(dec) : '-'
                  const bool = (v: any) => v === true ? 'Y' : v === false ? 'N' : '-'

                  return (
                    <tr key={s.id} style={{ borderBottom: '1px solid #121a2a' }}>
                      <td style={{ padding: '8px 6px', position: 'sticky', left: 0, background: '#0b0f17' }}>{new Date(s.openTime).toLocaleString()}</td>
                      <td style={{ padding: '8px 6px', color: isHigh ? '#ff5c77' : '#29d48b' }}>{s.swingType}</td>
                      <td style={{ padding: '8px 6px' }}>{fmt(s.price)}</td>
                      <td style={{ padding: '8px 6px' }}>{fmt(f.rsi14)}</td>
                      <td style={{ padding: '8px 6px' }}>{fmt(f.ema6)}</td>
                      <td style={{ padding: '8px 6px' }}>{fmt(f.ema50)}</td>
                      <td style={{ padding: '8px 6px' }}>{fmt(f.sma200)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.ema6_gt_ema50)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.close_gt_sma200)}</td>
                      <td style={{ padding: '8px 6px' }}>{fmt(f.close_sma200_pct, 3)}</td>
                      <td style={{ padding: '8px 6px' }}>{fmt(f.range_pct, 4)}</td>
                      <td style={{ padding: '8px 6px' }}>{fmt(f.body_pct, 4)}</td>
                      <td style={{ padding: '8px 6px' }}>{f.utc_weekday ?? '-'}</td>
                      <td style={{ padding: '8px 6px' }}>{f.utc_hour ?? '-'}</td>
                      <td style={{ padding: '8px 6px' }}>{f.utc_minute ?? '-'}</td>
                      <td style={{ padding: '8px 6px' }}>{f.utc_month ?? '-'}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.us_market_hours)}</td>
                      <td style={{ padding: '8px 6px' }}>{f.moon_phase_name ?? fmt(f.moon_phase)}</td>
                      <td style={{ padding: '8px 6px' }}>{fmt(f.moon_illumination, 1)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.tokyo_open)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.london_open)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.nyse_open)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.sydney_open)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.frankfurt_open)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.overlap_london_nyse)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.overlap_tokyo_london)}</td>
                      <td style={{ padding: '8px 6px' }}>{f.markets_open_count ?? '-'}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_weekend)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_monday)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_friday)}</td>
                      <td style={{ padding: '8px 6px' }}>{f.quarter ?? '-'}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_month_start)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_month_end)}</td>
                      <td style={{ padding: '8px 6px' }}>{f.hour_bucket ?? '-'}</td>
                      <td style={{ padding: '8px 6px' }}>{f.session ?? '-'}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_tuesday)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_wednesday)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_thursday)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_first_week)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_last_week)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_mid_month)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_q1)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_q4)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_summer)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_december)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_january)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_hour_start)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_hour_end)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.is_half_hour)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.golden_ratio_hour)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.fibonacci_day)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.prime_hour)}</td>
                      <td style={{ padding: '8px 6px' }}>{f.digit_sum_day ?? '-'}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.lunar_gravitational_peak)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.triple_witching_week)}</td>
                      <td style={{ padding: '8px 6px' }}>{bool(f.mercury_retrograde_proxy)}</td>
                      <td style={{ padding: '8px 6px' }}>{fmt(f.solar_cycle_phase, 3)}</td>
                      <td style={{ padding: '8px 6px' }}>{f.minute_entropy ?? '-'}</td>
                      <td style={{ padding: '8px 6px' }}>{fmt(f.temporal_harmonic, 3)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: '#111820', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 10, color: '#6b7785', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: color || '#e6eaf2' }}>{value}</div>
    </div>
  )
}

function escapeCsv(v: string) {
  if (v.includes('"')) v = v.replace(/"/g, '""')
  if (v.includes(',') || v.includes('\n') || v.includes('"')) return `"${v}"`
  return v
}
