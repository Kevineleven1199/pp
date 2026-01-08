import { useEffect, useState } from 'react'

const CRYPTO_SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'dogeusdt', 'xrpusdt']
const TRADFI_SYMBOLS = ['spy', 'nq', 'gc', 'cl'] // SPY, NQ Futures, Gold, Crude Oil
const ALL_SYMBOLS = [...CRYPTO_SYMBOLS, ...TRADFI_SYMBOLS]
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']

const DATA_SOURCES = [
  { name: 'Binance Global', url: 'wss://stream.binance.com:9443/ws', priority: 1 },
  { name: 'Binance US', url: 'wss://stream.binance.us:9443/ws', priority: 2 },
  { name: 'Binance Vision', url: 'wss://data-stream.binance.vision/ws', priority: 3 },
  { name: 'Bybit', url: 'wss://stream.bybit.com/v5/public/spot', priority: 4 },
  { name: 'OKX', url: 'wss://ws.okx.com:8443/ws/v5/public', priority: 5 },
]

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
  insufficientData?: boolean
}

type Status = {
  connected: boolean
  lastPrice?: number
  symbol?: string
  exchange?: string
  dataDir?: string
  candlesWritten?: number
  swingsFound?: number
  pivotLen?: number
  dataStatuses?: DataStatus[]
  databaseSizeBytes?: number
  databaseSizeMB?: number
  backfill?: {
    state: string
    message?: string
    monthsProcessed?: number
    candlesIngested?: number
    lastError?: string
  }
  derivedRebuild?: {
    state: string
    message?: string
    currentFile?: string
    daysProcessed?: number
    swingEventsWritten?: number
    lastError?: string
  }
}

export default function StatusPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [errorLog, setErrorLog] = useState<string[]>([])

  useEffect(() => {
    let mounted = true
    window.pricePerfect.engine.getStatus().then((s: Status) => {
      console.log('[StatusPage] Initial status:', s?.dataStatuses?.length || 0, 'statuses, connected:', s?.connected)
      if (mounted) setStatus(s)
    })
    const off = window.pricePerfect.engine.on('status', (s: Status) => {
      console.log('[StatusPage] Status update:', s?.dataStatuses?.length || 0, 'statuses, db:', s?.databaseSizeMB, 'MB')
      setStatus(s)
      if (s.backfill?.lastError) {
        setErrorLog(prev => [`[Backfill] ${s.backfill?.lastError}`, ...prev].slice(0, 50))
      }
      if (s.derivedRebuild?.lastError) {
        setErrorLog(prev => [`[Rebuild] ${s.derivedRebuild?.lastError}`, ...prev].slice(0, 50))
      }
    })
    return () => { mounted = false; off() }
  }, [])

  const b = status?.backfill
  const d = status?.derivedRebuild
  const dataStatuses = status?.dataStatuses || []
  const totalJobs = ALL_SYMBOLS.length * TIMEFRAMES.length
  // Count as complete if has swings OR has insufficient data to generate swings (data limitation)
  const completedJobs = dataStatuses.filter(ds => ds.swingFiles > 0 || ds.insufficientData).length
  const insufficientDataJobs = dataStatuses.filter(ds => ds.insufficientData).length
  const progressPct = totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0
  const dbSizeMB = status?.databaseSizeMB ?? 0

  return (
    <div style={{ height: '100%', overflow: 'auto', background: '#0a0e14' }}>
      <div style={{ padding: '16px', borderBottom: '1px solid #1e2636', background: '#0d1219' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>Engine Status</div>
          <div style={{ padding: '6px 12px', borderRadius: 20, background: status?.connected ? '#14532d' : '#7f1d1d', color: status?.connected ? '#4ade80' : '#fca5a5', fontSize: 12, fontWeight: 600 }}>
            {status?.connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#9aa4b2', marginTop: 8 }}>Auto-running 24/7 - Real data only - No manual intervention required</div>
      </div>

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ padding: 16, background: '#0d1219', borderRadius: 10, border: '1px solid #1e2636' }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Data Sources (Fallback Order)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {DATA_SOURCES.map((src, i) => (
              <div key={src.name} style={{ padding: '8px 12px', borderRadius: 8, background: i === 0 && status?.connected ? '#14532d' : '#1e2636', border: '1px solid ' + (i === 0 && status?.connected ? '#22c55e' : '#2d3748'), fontSize: 11 }}>
                <div style={{ fontWeight: 600, color: i === 0 && status?.connected ? '#4ade80' : '#9aa4b2' }}>#{src.priority} {src.name}</div>
                <div style={{ fontSize: 10, color: '#6b7785', marginTop: 2 }}>{src.url.replace('wss://', '')}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: 16, background: '#0d1219', borderRadius: 10, border: '1px solid #1e2636' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontWeight: 700 }}>Pipeline Progress</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#4ade80' }}>{progressPct}% Complete</div>
          </div>
          <div style={{ height: 16, background: '#1e2636', borderRadius: 8, overflow: 'hidden', marginBottom: 12 }}>
            <div style={{ height: '100%', width: progressPct + '%', background: 'linear-gradient(90deg, #22c55e, #4ade80)', borderRadius: 8 }} />
          </div>
          <div style={{ fontSize: 11, color: '#6b7785' }}>
            {completedJobs}/{totalJobs} symbol/timeframe combinations with swing data
            {insufficientDataJobs > 0 && <span style={{ color: '#f59e0b' }}> ({insufficientDataJobs} have insufficient source data)</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <div style={{ flex: 1, padding: '10px 14px', background: '#111820', borderRadius: 8, fontSize: 12, color: '#e6eaf2', fontFamily: 'monospace' }}>
              {d?.state === 'running' ? '🔄 ' : b?.state === 'running' ? '⬇️ ' : '✅ '}
              {d?.state === 'running' ? d.message || 'Processing swings...' : b?.state === 'running' ? b.message || 'Downloading...' : 'Pipeline running 24/7'}
            </div>
            <button
              onClick={() => window.pricePerfect.engine.startDerivedRebuild()}
              disabled={d?.state === 'running'}
              style={{
                padding: '10px 16px',
                borderRadius: 8,
                border: '1px solid #22c55e',
                background: d?.state === 'running' ? '#1e2636' : '#14532d',
                color: d?.state === 'running' ? '#6b7785' : '#4ade80',
                fontSize: 12,
                fontWeight: 600,
                cursor: d?.state === 'running' ? 'not-allowed' : 'pointer'
              }}
            >
              {d?.state === 'running' ? 'Rebuilding...' : '🔄 Rebuild All Swings'}
            </button>
          </div>
        </div>

        <div style={{ padding: 16, background: '#0d1219', borderRadius: 10, border: '1px solid #1e2636' }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Data Coverage Matrix</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto repeat(12, 1fr)', gap: 3, fontSize: 10 }}>
            <div style={{ padding: 6 }}></div>
            {TIMEFRAMES.map(tf => <div key={tf} style={{ padding: 6, textAlign: 'center', color: '#9aa4b2', fontWeight: 700 }}>{tf}</div>)}
            {CRYPTO_SYMBOLS.map(sym => (
              <>
                <div key={sym} style={{ padding: 6, color: '#f0b429', fontWeight: 700 }}>{sym.replace('usdt', '').toUpperCase()}</div>
                {TIMEFRAMES.map(tf => {
                  const ds = dataStatuses.find(s => s.symbol === sym && s.timeframe === tf)
                  const hasSwings = ds && ds.swingFiles > 0
                  const hasCandles = ds && ds.candleFiles > 0
                  return (
                    <div key={sym + tf} title={`${ds?.candleFiles || 0} candles, ${ds?.swingFiles || 0} swings`} style={{ padding: 6, textAlign: 'center', borderRadius: 4, background: hasSwings ? '#14532d' : hasCandles ? '#422006' : '#1e2636', color: hasSwings ? '#4ade80' : hasCandles ? '#fbbf24' : '#6b7785', fontWeight: 600, cursor: 'help' }}>
                      {hasSwings ? '✓' : hasCandles ? '◐' : '·'}
                    </div>
                  )
                })}
              </>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 10, color: '#6b7785' }}>
            <span>✓ = Swings ready</span><span>◐ = Candles only</span><span>· = Pending</span>
          </div>
        </div>

        <div style={{ padding: 16, background: '#0d1219', borderRadius: 10, border: '1px solid #1e2636' }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Swing Progress Matrix</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto repeat(12, 1fr)', gap: 3, fontSize: 10 }}>
            <div style={{ padding: 6 }}></div>
            {TIMEFRAMES.map(tf => <div key={tf} style={{ padding: 6, textAlign: 'center', color: '#9aa4b2', fontWeight: 700 }}>{tf}</div>)}
            {CRYPTO_SYMBOLS.map(sym => (
              <>
                <div key={sym + '-swing'} style={{ padding: 6, color: '#f0b429', fontWeight: 700 }}>{sym.replace('usdt', '').toUpperCase()}</div>
                {TIMEFRAMES.map(tf => {
                  const ds = dataStatuses.find(s => s.symbol === sym && s.timeframe === tf)
                  const swingCount = ds?.totalSwings || 0
                  const hasFeatures = ds?.featuresComplete
                  const hasSwings = ds && ds.swingFiles > 0
                  const displayVal = swingCount > 0 ? (swingCount >= 1000 ? Math.round(swingCount / 1000) + 'k' : swingCount.toString()) : '-'
                  return (
                    <div 
                      key={sym + tf + '-swing'} 
                      title={`${swingCount.toLocaleString()} swings, ${ds?.swingFiles || 0} files${hasFeatures ? ', features complete' : ''}`} 
                      style={{ 
                        padding: 6, 
                        textAlign: 'center', 
                        borderRadius: 4, 
                        background: hasFeatures ? '#1e3a5f' : hasSwings ? '#14532d' : '#1e2636', 
                        color: hasFeatures ? '#60a5fa' : hasSwings ? '#4ade80' : '#6b7785', 
                        fontWeight: 600, 
                        cursor: 'help',
                        fontSize: 9
                      }}
                    >
                      {displayVal}
                    </div>
                  )
                })}
              </>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 10, color: '#6b7785' }}>
            <span style={{ color: '#60a5fa' }}>Blue = Features complete</span>
            <span style={{ color: '#4ade80' }}>Green = Swings detected</span>
            <span>- = No swings yet</span>
          </div>
        </div>

        <div style={{ padding: 16, background: '#0d1219', borderRadius: 10, border: '1px solid #1e2636' }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>TradFi Coverage Matrix (Yahoo Finance)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto repeat(12, 1fr)', gap: 3, fontSize: 10 }}>
            <div style={{ padding: 6 }}></div>
            {TIMEFRAMES.map(tf => <div key={tf} style={{ padding: 6, textAlign: 'center', color: '#9aa4b2', fontWeight: 700 }}>{tf}</div>)}
            {TRADFI_SYMBOLS.map(sym => (
              <>
                <div key={sym + '-tradfi'} style={{ padding: 6, color: '#60a5fa', fontWeight: 700 }}>{sym.toUpperCase()}</div>
                {TIMEFRAMES.map(tf => {
                  const ds = dataStatuses.find(s => s.symbol === sym && s.timeframe === tf)
                  const hasSwings = ds && ds.swingFiles > 0
                  const hasCandles = ds && ds.candleFiles > 0
                  return (
                    <div key={sym + tf + '-tradfi'} title={`${ds?.candleFiles || 0} candle files, ${ds?.swingFiles || 0} swing files`} style={{ padding: 6, textAlign: 'center', borderRadius: 4, background: hasSwings ? '#14532d' : hasCandles ? '#422006' : '#1e2636', color: hasSwings ? '#4ade80' : hasCandles ? '#fbbf24' : '#6b7785', fontWeight: 600, cursor: 'help' }}>
                      {hasSwings ? '✓' : hasCandles ? '◐' : '·'}
                    </div>
                  )
                })}
              </>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 10, color: '#6b7785' }}>
            <span>SPY = S&P 500 ETF</span><span>NQ = Nasdaq Futures</span><span>GC = Gold</span><span>CL = Crude Oil</span>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <div style={{ padding: 16, background: '#0d1219', borderRadius: 10, border: '1px solid #1e2636' }}>
            <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 4 }}>Database Size</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#a78bfa' }}>{dbSizeMB > 1000 ? (dbSizeMB / 1000).toFixed(1) + ' GB' : dbSizeMB + ' MB'}</div>
          </div>
          <div style={{ padding: 16, background: '#0d1219', borderRadius: 10, border: '1px solid #1e2636' }}>
            <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 4 }}>Backfill</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: b?.state === 'running' ? '#60a5fa' : '#4ade80' }}>{b?.state === 'running' ? 'Downloading...' : 'Idle'}</div>
            {b?.candlesIngested ? <div style={{ fontSize: 11, color: '#9aa4b2' }}>{b.candlesIngested.toLocaleString()} candles</div> : null}
          </div>
          <div style={{ padding: 16, background: '#0d1219', borderRadius: 10, border: '1px solid #1e2636' }}>
            <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 4 }}>Swing Detection</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: d?.state === 'running' ? '#60a5fa' : '#4ade80' }}>{d?.state === 'running' ? 'Processing...' : 'Idle'}</div>
            {d?.swingEventsWritten ? <div style={{ fontSize: 11, color: '#9aa4b2' }}>{d.swingEventsWritten.toLocaleString()} swings</div> : null}
          </div>
          <div style={{ padding: 16, background: '#0d1219', borderRadius: 10, border: '1px solid #1e2636' }}>
            <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 4 }}>Live Price</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#f0b429' }}>{status?.lastPrice ? '$' + status.lastPrice.toLocaleString() : '-'}</div>
          </div>
          <div style={{ padding: 16, background: '#0d1219', borderRadius: 10, border: '1px solid #1e2636' }}>
            <div style={{ fontSize: 11, color: '#6b7785', marginBottom: 4 }}>Total Swings</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#4ade80' }}>{status?.swingsFound?.toLocaleString() || '-'}</div>
          </div>
        </div>

        <div style={{ padding: 16, background: '#0d1219', borderRadius: 10, border: '1px solid #1e2636' }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Activity Log</div>
          <div style={{ maxHeight: 150, overflow: 'auto', background: '#111820', borderRadius: 8, padding: 12, fontFamily: 'monospace', fontSize: 11 }}>
            {!d?.message && !b?.message && errorLog.length === 0 && <div style={{ color: '#4ade80' }}>No errors. Pipeline running smoothly.</div>}
            {d?.message && <div style={{ color: '#60a5fa', marginBottom: 4 }}>[Current] {d.message}</div>}
            {b?.message && <div style={{ color: '#60a5fa', marginBottom: 4 }}>[Backfill] {b.message}</div>}
            {errorLog.map((log, i) => <div key={i} style={{ color: '#fca5a5', marginBottom: 4 }}>{log}</div>)}
          </div>
        </div>
      </div>
    </div>
  )
}
