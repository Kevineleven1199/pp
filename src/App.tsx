import { useEffect, useMemo, useState } from 'react'
import LivePage from './pages/LivePage'
import StatusPage from './pages/StatusPage'
import SwingsPage from './pages/SwingsPage'
import StrategiesPage from './pages/StrategiesPage'
import SummaryPage from './pages/SummaryPage'
import PyramidPage from './pages/PyramidPage'
import SettingsPage from './pages/SettingsPage'

// Version number - increment by 0.1 each update
export const APP_VERSION = '10.6'

type PageKey = 'live' | 'swings' | 'strategies' | 'pyramid' | 'summary' | 'status' | 'settings'

type NavItem = {
  key: PageKey
  label: string
}

const navItems: NavItem[] = [
  { key: 'live', label: 'Live' },
  { key: 'swings', label: 'Swings' },
  { key: 'strategies', label: 'Strategies' },
  { key: 'pyramid', label: '🔺 Pyramid' },
  { key: 'summary', label: 'Summary' },
  { key: 'status', label: 'Status' },
  { key: 'settings', label: '⚙️ Settings' }
]

export default function App() {
  const [page, setPage] = useState<PageKey>('live')
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const off = window.pricePerfect.engine.on('status', (s) => {
      setConnected(Boolean(s?.connected))
    })
    return () => off()
  }, [])

  const content = useMemo(() => {
    switch (page) {
      case 'live':
        return <LivePage />
      case 'swings':
        return <SwingsPage />
      case 'strategies':
        return <StrategiesPage />
      case 'pyramid':
        return <PyramidPage />
      case 'summary':
        return <SummaryPage />
      case 'status':
        return <StatusPage />
      case 'settings':
        return <SettingsPage />
      default:
        return null
    }
  }, [page])

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      <div
        style={{
          width: 240,
          borderRight: '1px solid #1e2636',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, letterSpacing: 0.3 }}>Price Perfect</span>
            <span style={{ fontSize: 10, color: '#a78bfa', background: '#1e1a3a', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>
              v{APP_VERSION}
            </span>
          </div>
          <div style={{ fontSize: 12, color: connected ? '#29d48b' : '#ff5c77' }}>
            {connected ? 'Engine: Connected' : 'Engine: Disconnected'}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => setPage(item.key)}
              style={{
                border: '1px solid #1e2636',
                background: page === item.key ? '#182033' : '#0f1421',
                color: '#e6eaf2',
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: 10,
                cursor: 'pointer'
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>{content}</div>
    </div>
  )
}
