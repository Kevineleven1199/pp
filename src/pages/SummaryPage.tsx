import { useState, useEffect, useMemo } from 'react'

type SwingEvent = {
  id: string
  swingType: 'high' | 'low'
  openTime: number
  price: number
  features: Record<string, number | string | boolean | null>
}

type PatternResult = {
  name: string
  factor: string
  category: string
  highRate: number
  lowRate: number
  separation: number
  totalOccurrences: number
  winRate: number
  confidence: number
  description: string
  botRecommendation: 'LONG' | 'SHORT' | 'BOTH' | 'AVOID'
}

type ConfluenceCombo = {
  factors: string[]
  occurrences: number
  highCount: number
  lowCount: number
  winRate: number
  edge: number
}

const PATTERN_CATEGORIES: Record<string, string[]> = {
  'Technical': ['rsi14', 'ema6_gt_ema50', 'macd_bullish', 'stoch_oversold', 'stoch_overbought', 'bb_oversold', 'bb_overbought', 'strong_trend', 'adx14'],
  'Time': ['utc_hour', 'utc_weekday', 'is_monday', 'is_friday', 'is_tuesday', 'is_turnaround_tuesday', 'is_power_hour', 'is_opening_range'],
  'Session': ['tokyo_open', 'london_open', 'nyse_open', 'overlap_london_nyse', 'is_asian_liquidity', 'is_us_liquidity'],
  'Economic': ['is_nfp_day', 'is_cpi_day', 'is_fomc_day', 'is_earnings_season', 'is_opex_week', 'is_jobless_claims_day'],
  'Government': ['is_snap_day', 'is_payroll_day', 'is_tax_refund_season'],
  'Candle': ['is_doji', 'is_hammer', 'is_rejection_candle', 'candle_direction', 'body_to_range'],
  'Price Level': ['price_round_100', 'price_round_1000', 'is_volatile_candle'],
  'Astro': ['is_full_moon', 'is_new_moon', 'lunar_gravitational_peak', 'is_equinox', 'is_solstice'],
}

function analyzePatterns(swings: SwingEvent[]): PatternResult[] {
  const highs = swings.filter(s => s.swingType === 'high')
  const lows = swings.filter(s => s.swingType === 'low')
  const results: PatternResult[] = []

  const allFactors = new Set<string>()
  swings.forEach(s => Object.keys(s.features || {}).forEach(k => allFactors.add(k)))

  for (const factor of allFactors) {
    const highsWithFactor = highs.filter(s => {
      const v = s.features?.[factor]
      return v === true || (typeof v === 'number' && v > 0.5)
    })
    const lowsWithFactor = lows.filter(s => {
      const v = s.features?.[factor]
      return v === true || (typeof v === 'number' && v > 0.5)
    })

    const highRate = highs.length > 0 ? (highsWithFactor.length / highs.length) * 100 : 0
    const lowRate = lows.length > 0 ? (lowsWithFactor.length / lows.length) * 100 : 0
    const separation = Math.abs(highRate - lowRate)
    const totalOccurrences = highsWithFactor.length + lowsWithFactor.length

    if (totalOccurrences < 10) continue

    const winRate = totalOccurrences > 0 
      ? (highRate > lowRate ? highsWithFactor.length : lowsWithFactor.length) / totalOccurrences * 100 
      : 50

    const confidence = Math.min(100, separation * 2 + Math.log10(totalOccurrences + 1) * 10)

    let category = 'Other'
    for (const [cat, factors] of Object.entries(PATTERN_CATEGORIES)) {
      if (factors.some(f => factor.includes(f) || f.includes(factor))) {
        category = cat
        break
      }
    }

    let botRecommendation: 'LONG' | 'SHORT' | 'BOTH' | 'AVOID' = 'AVOID'
    if (separation >= 5) {
      botRecommendation = highRate > lowRate ? 'SHORT' : 'LONG'
    } else if (separation >= 2) {
      botRecommendation = 'BOTH'
    }

    results.push({
      name: factor.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      factor,
      category,
      highRate,
      lowRate,
      separation,
      totalOccurrences,
      winRate,
      confidence,
      description: `${factor} occurs ${highRate.toFixed(1)}% on highs, ${lowRate.toFixed(1)}% on lows`,
      botRecommendation
    })
  }

  return results.sort((a, b) => b.separation - a.separation)
}

function findBestConfluence(swings: SwingEvent[], topFactors: string[]): ConfluenceCombo[] {
  const combos: ConfluenceCombo[] = []
  const highs = swings.filter(s => s.swingType === 'high')
  const lows = swings.filter(s => s.swingType === 'low')

  // Test 2-factor combinations
  for (let i = 0; i < Math.min(10, topFactors.length); i++) {
    for (let j = i + 1; j < Math.min(10, topFactors.length); j++) {
      const f1 = topFactors[i]
      const f2 = topFactors[j]

      const matchHigh = highs.filter(s => {
        const v1 = s.features?.[f1]
        const v2 = s.features?.[f2]
        return (v1 === true || (typeof v1 === 'number' && v1 > 0.5)) &&
               (v2 === true || (typeof v2 === 'number' && v2 > 0.5))
      }).length

      const matchLow = lows.filter(s => {
        const v1 = s.features?.[f1]
        const v2 = s.features?.[f2]
        return (v1 === true || (typeof v1 === 'number' && v1 > 0.5)) &&
               (v2 === true || (typeof v2 === 'number' && v2 > 0.5))
      }).length

      const total = matchHigh + matchLow
      if (total < 5) continue

      combos.push({
        factors: [f1, f2],
        occurrences: total,
        highCount: matchHigh,
        lowCount: matchLow,
        winRate: total > 0 ? Math.max(matchHigh, matchLow) / total * 100 : 50,
        edge: total > 0 ? Math.abs(matchHigh - matchLow) / total * 100 : 0
      })
    }
  }

  return combos.sort((a, b) => b.edge - a.edge).slice(0, 20)
}

export default function SummaryPage() {
  const [swings, setSwings] = useState<SwingEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)
  const [selectedCategory, setSelectedCategory] = useState<string>('All')

  useEffect(() => {
    setLoading(true)
    Promise.all([
      window.pricePerfect.engine.getSwings('btcusdt'),
      window.pricePerfect.engine.getSwings('ethusdt')
    ]).then(([btcResp, ethResp]) => {
      const all = [...(btcResp.data || []), ...(ethResp.data || [])]
      setSwings(all)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const patterns = useMemo(() => analyzePatterns(swings), [swings])
  const topPatterns = patterns.slice(0, 50)
  const topFactors = topPatterns.map(p => p.factor)
  const confluenceCombos = useMemo(() => findBestConfluence(swings, topFactors), [swings, topFactors])

  const filteredPatterns = selectedCategory === 'All' 
    ? topPatterns 
    : topPatterns.filter(p => p.category === selectedCategory)

  const longPatterns = patterns.filter(p => p.botRecommendation === 'LONG').slice(0, 10)
  const shortPatterns = patterns.filter(p => p.botRecommendation === 'SHORT').slice(0, 10)

  const copyBotConfig = () => {
    const config = {
      generatedAt: new Date().toISOString(),
      dataPoints: swings.length,
      topLongSignals: longPatterns.map(p => ({
        factor: p.factor,
        separation: p.separation,
        winRate: p.winRate,
        occurrences: p.totalOccurrences
      })),
      topShortSignals: shortPatterns.map(p => ({
        factor: p.factor,
        separation: p.separation,
        winRate: p.winRate,
        occurrences: p.totalOccurrences
      })),
      bestConfluence: confluenceCombos.slice(0, 10).map(c => ({
        factors: c.factors,
        edge: c.edge,
        winRate: c.winRate,
        occurrences: c.occurrences
      })),
      recommendedRules: {
        longEntry: longPatterns.slice(0, 3).map(p => p.factor),
        shortEntry: shortPatterns.slice(0, 3).map(p => p.factor),
        minConfluence: 2,
        minSeparation: 5
      }
    }
    navigator.clipboard.writeText(JSON.stringify(config, null, 2))
    setCopied('bot')
    setTimeout(() => setCopied(null), 2000)
  }

  const categories = ['All', ...Object.keys(PATTERN_CATEGORIES)]

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #1e2636', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>🤖 Trading Bot Pattern Summary</div>
          <div style={{ fontSize: 12, color: '#9aa4b2', marginTop: 4 }}>
            {swings.length.toLocaleString()} swings analyzed • Top patterns ranked by edge
          </div>
        </div>
        <button
          onClick={copyBotConfig}
          style={{
            padding: '10px 20px',
            borderRadius: 6,
            border: copied === 'bot' ? '2px solid #22c55e' : '2px solid #3b82f6',
            background: copied === 'bot' ? '#14532d' : '#1e3a5f',
            color: copied === 'bot' ? '#4ade80' : '#60a5fa',
            cursor: 'pointer',
            fontWeight: 700,
            fontSize: 13
          }}
        >
          {copied === 'bot' ? '✓ Copied Bot Config!' : '📋 Copy Bot Config JSON'}
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 20, color: '#9aa4b2' }}>Analyzing patterns...</div>
      ) : swings.length === 0 ? (
        <div style={{ padding: 20, color: '#f0b429' }}>⚠️ No swing data available. Run backfill first.</div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {/* Quick Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            <div style={{ background: '#14532d', borderRadius: 8, padding: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#4ade80' }}>{longPatterns.length}</div>
              <div style={{ fontSize: 11, color: '#86efac' }}>LONG Signals</div>
            </div>
            <div style={{ background: '#7f1d1d', borderRadius: 8, padding: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#f87171' }}>{shortPatterns.length}</div>
              <div style={{ fontSize: 11, color: '#fca5a5' }}>SHORT Signals</div>
            </div>
            <div style={{ background: '#1e3a5f', borderRadius: 8, padding: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#60a5fa' }}>{confluenceCombos.length}</div>
              <div style={{ fontSize: 11, color: '#93c5fd' }}>Confluence Combos</div>
            </div>
            <div style={{ background: '#3f3f46', borderRadius: 8, padding: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#fbbf24' }}>{patterns.length}</div>
              <div style={{ fontSize: 11, color: '#fcd34d' }}>Total Patterns</div>
            </div>
          </div>

          {/* Top Long Signals */}
          <div style={{ background: '#111820', borderRadius: 8, border: '1px solid #14532d', padding: 16, marginBottom: 16 }}>
            <div style={{ fontWeight: 700, color: '#4ade80', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>📈</span> TOP 10 LONG SIGNALS
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {longPatterns.map((p, i) => (
                <div key={p.factor} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: '#0a0e14', borderRadius: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ background: '#22c55e', color: '#000', padding: '2px 8px', borderRadius: 4, fontWeight: 700, fontSize: 11 }}>#{i + 1}</span>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    <span style={{ fontSize: 10, color: '#6b7785', background: '#1e2636', padding: '2px 6px', borderRadius: 3 }}>{p.category}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
                    <span style={{ color: '#4ade80' }}>Edge: {p.separation.toFixed(1)}%</span>
                    <span style={{ color: '#9aa4b2' }}>{p.totalOccurrences} occurrences</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Top Short Signals */}
          <div style={{ background: '#111820', borderRadius: 8, border: '1px solid #7f1d1d', padding: 16, marginBottom: 16 }}>
            <div style={{ fontWeight: 700, color: '#f87171', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>📉</span> TOP 10 SHORT SIGNALS
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {shortPatterns.map((p, i) => (
                <div key={p.factor} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: '#0a0e14', borderRadius: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ background: '#ef4444', color: '#fff', padding: '2px 8px', borderRadius: 4, fontWeight: 700, fontSize: 11 }}>#{i + 1}</span>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    <span style={{ fontSize: 10, color: '#6b7785', background: '#1e2636', padding: '2px 6px', borderRadius: 3 }}>{p.category}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
                    <span style={{ color: '#f87171' }}>Edge: {p.separation.toFixed(1)}%</span>
                    <span style={{ color: '#9aa4b2' }}>{p.totalOccurrences} occurrences</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Best Confluence Combinations */}
          <div style={{ background: '#111820', borderRadius: 8, border: '1px solid #1e3a5f', padding: 16, marginBottom: 16 }}>
            <div style={{ fontWeight: 700, color: '#60a5fa', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>🔗</span> BEST CONFLUENCE COMBINATIONS
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {confluenceCombos.slice(0, 10).map((c, i) => (
                <div key={c.factors.join('+')} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: '#0a0e14', borderRadius: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ background: '#3b82f6', color: '#fff', padding: '2px 8px', borderRadius: 4, fontWeight: 700, fontSize: 11 }}>#{i + 1}</span>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{c.factors.map(f => f.replace(/_/g, ' ')).join(' + ')}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
                    <span style={{ color: '#60a5fa' }}>Edge: {c.edge.toFixed(1)}%</span>
                    <span style={{ color: c.highCount > c.lowCount ? '#4ade80' : '#f87171' }}>
                      {c.highCount > c.lowCount ? 'SHORT' : 'LONG'}
                    </span>
                    <span style={{ color: '#9aa4b2' }}>{c.occurrences} matches</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* All Patterns by Category */}
          <div style={{ background: '#111820', borderRadius: 8, border: '1px solid #1e2636', padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18 }}>📊</span> ALL PATTERNS BY CATEGORY
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 4,
                      border: 'none',
                      background: selectedCategory === cat ? '#3b82f6' : '#1e2636',
                      color: selectedCategory === cat ? '#fff' : '#9aa4b2',
                      cursor: 'pointer',
                      fontSize: 11,
                      fontWeight: 500
                    }}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #1e2636' }}>
                    <th style={{ textAlign: 'left', padding: 8, color: '#6b7785' }}>Pattern</th>
                    <th style={{ textAlign: 'center', padding: 8, color: '#6b7785' }}>Category</th>
                    <th style={{ textAlign: 'center', padding: 8, color: '#6b7785' }}>High %</th>
                    <th style={{ textAlign: 'center', padding: 8, color: '#6b7785' }}>Low %</th>
                    <th style={{ textAlign: 'center', padding: 8, color: '#6b7785' }}>Edge</th>
                    <th style={{ textAlign: 'center', padding: 8, color: '#6b7785' }}>Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPatterns.map(p => (
                    <tr key={p.factor} style={{ borderBottom: '1px solid #0a0e14' }}>
                      <td style={{ padding: 8, fontWeight: 500 }}>{p.name}</td>
                      <td style={{ padding: 8, textAlign: 'center' }}>
                        <span style={{ background: '#1e2636', padding: '2px 6px', borderRadius: 3, fontSize: 10 }}>{p.category}</span>
                      </td>
                      <td style={{ padding: 8, textAlign: 'center', color: '#f87171' }}>{p.highRate.toFixed(1)}%</td>
                      <td style={{ padding: 8, textAlign: 'center', color: '#4ade80' }}>{p.lowRate.toFixed(1)}%</td>
                      <td style={{ padding: 8, textAlign: 'center', color: '#fbbf24', fontWeight: 600 }}>{p.separation.toFixed(1)}%</td>
                      <td style={{ padding: 8, textAlign: 'center' }}>
                        <span style={{
                          background: p.botRecommendation === 'LONG' ? '#14532d' : p.botRecommendation === 'SHORT' ? '#7f1d1d' : '#3f3f46',
                          color: p.botRecommendation === 'LONG' ? '#4ade80' : p.botRecommendation === 'SHORT' ? '#f87171' : '#9aa4b2',
                          padding: '2px 8px',
                          borderRadius: 4,
                          fontSize: 10,
                          fontWeight: 600
                        }}>
                          {p.botRecommendation}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
