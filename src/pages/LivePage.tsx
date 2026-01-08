import { createChart, type UTCTimestamp } from 'lightweight-charts'
import { useEffect, useMemo, useRef, useState } from 'react'

type Kline = {
  exchange: string
  symbol: string
  interval: string
  openTime: number
  open: number
  high: number
  low: number
  close: number
  isFinal: boolean
}

export default function LivePage() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [last, setLast] = useState<Kline | null>(null)
  const [connected, setConnected] = useState(false)

  const title = useMemo(() => {
    if (!last) return 'Live'
    return `${last.exchange.toUpperCase()} ${last.symbol} (${last.interval})`
  }, [last])

  useEffect(() => {
    const off = window.pricePerfect.engine.on('status', (s: any) => {
      setConnected(Boolean(s?.connected))
    })
    return () => off()
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#0b0f17' },
        textColor: '#e6eaf2'
      },
      grid: {
        vertLines: { color: '#121a2a' },
        horzLines: { color: '#121a2a' }
      },
      timeScale: {
        borderColor: '#1e2636'
      },
      rightPriceScale: {
        borderColor: '#1e2636'
      },
      crosshair: {
        vertLine: { color: '#2a3550' },
        horzLine: { color: '#2a3550' }
      },
      height: containerRef.current.clientHeight
    })

    const series = chart.addCandlestickSeries({
      upColor: '#29d48b',
      downColor: '#ff5c77',
      wickUpColor: '#29d48b',
      wickDownColor: '#ff5c77',
      borderVisible: false
    })

    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return
      chart.applyOptions({ height: containerRef.current.clientHeight, width: containerRef.current.clientWidth })
    })
    ro.observe(containerRef.current)

    const off = window.pricePerfect.engine.on('kline', (k: Kline) => {
      setLast(k)
      const time = Math.floor(k.openTime / 1000) as UTCTimestamp
      series.update({
        time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close
      })
    })

    return () => {
      off()
      ro.disconnect()
      chart.remove()
    }
  }, [])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '14px 16px',
          borderBottom: '1px solid #1e2636',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12
        }}
      >
        <div>
          <div style={{ fontWeight: 700 }}>{title}</div>
          <div style={{ fontSize: 12, color: connected ? '#29d48b' : '#9aa4b2', marginTop: 4 }}>
            {connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 12, color: '#9aa4b2' }}>
            {last ? `Last: ${last.close.toFixed(2)}` : 'No data'}
          </div>
          {connected ? (
            <button
              onClick={() => window.pricePerfect.engine.stopLive()}
              style={{
                border: '1px solid #1e2636',
                background: '#182033',
                color: '#ff5c77',
                padding: '8px 12px',
                borderRadius: 10,
                cursor: 'pointer',
                fontSize: 12
              }}
            >
              Stop Live
            </button>
          ) : (
            <button
              onClick={() => window.pricePerfect.engine.startLive()}
              style={{
                border: '1px solid #1e2636',
                background: '#182033',
                color: '#29d48b',
                padding: '8px 12px',
                borderRadius: 10,
                cursor: 'pointer',
                fontSize: 12
              }}
            >
              Start Live
            </button>
          )}
        </div>
      </div>

      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}
