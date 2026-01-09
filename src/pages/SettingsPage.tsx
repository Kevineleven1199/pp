import { useEffect, useState } from 'react'

type ApiSettings = {
  openRouterApiKey: string
  openRouterModel: string
  binanceApiKey: string
  binanceApiSecret: string
  asterDexApiKey: string
  asterDexApiSecret: string
  asterDexTestnet: boolean
  pyramidAutoTrade: boolean
  pyramidMaxPositionUsd: number
  telegramBotToken: string
  telegramChatId: string
  telegramEnabled: boolean
  telegramNotifyTrades: boolean
  telegramNotifyAttempts: boolean
  telegramNotifyExits: boolean
  telegramNotifyPnL: boolean
}

const DEFAULT_SETTINGS: ApiSettings = {
  openRouterApiKey: '',
  openRouterModel: 'anthropic/claude-3.5-sonnet',
  binanceApiKey: '',
  binanceApiSecret: '',
  asterDexApiKey: '',
  asterDexApiSecret: '',
  asterDexTestnet: true,
  pyramidAutoTrade: false,
  pyramidMaxPositionUsd: 100,
  telegramBotToken: '',
  telegramChatId: '',
  telegramEnabled: false,
  telegramNotifyTrades: true,
  telegramNotifyAttempts: false,
  telegramNotifyExits: true,
  telegramNotifyPnL: true
}

const OPENROUTER_MODELS = [
  { id: 'openrouter/auto', name: '🔄 Auto (Use Your OpenRouter Default)' },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (Latest)' },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
  { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku (Fast)' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini (Fast)' },
  { id: 'openai/o1', name: 'OpenAI o1 (Reasoning)' },
  { id: 'openai/o1-mini', name: 'OpenAI o1 Mini' },
  { id: 'google/gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash' },
  { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5' },
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3 (Cheap & Good)' },
  { id: 'mistralai/mistral-large-2411', name: 'Mistral Large 2411' },
  { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B' },
]

export default function SettingsPage() {
  const [settings, setSettings] = useState<ApiSettings>(DEFAULT_SETTINGS)
  const [saved, setSaved] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testMessage, setTestMessage] = useState('')
  const [telegramTestStatus, setTelegramTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [telegramTestMessage, setTelegramTestMessage] = useState('')

  useEffect(() => {
    // Load settings from localStorage on mount
    const stored = localStorage.getItem('pricePerfect_apiSettings')
    if (stored) {
      try {
        setSettings(JSON.parse(stored))
      } catch (e) {
        console.error('Failed to parse stored settings')
      }
    }
  }, [])

  const handleSave = () => {
    localStorage.setItem('pricePerfect_apiSettings', JSON.stringify(settings))
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const testOpenRouterConnection = async () => {
    if (!settings.openRouterApiKey) {
      setTestStatus('error')
      setTestMessage('Please enter an API key first')
      return
    }

    setTestStatus('testing')
    setTestMessage('Testing connection...')

    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${settings.openRouterApiKey}`,
        }
      })

      if (response.ok) {
        setTestStatus('success')
        setTestMessage('✓ Connection successful! API key is valid.')
      } else {
        const error = await response.json()
        setTestStatus('error')
        setTestMessage(`✗ Error: ${error.error?.message || 'Invalid API key'}`)
      }
    } catch (e) {
      setTestStatus('error')
      setTestMessage(`✗ Network error: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
  }

  const testTelegramConnection = async () => {
    if (!settings.telegramBotToken || !settings.telegramChatId) {
      setTelegramTestStatus('error')
      setTelegramTestMessage('Please enter both Bot Token and Chat ID')
      return
    }

    setTelegramTestStatus('testing')
    setTelegramTestMessage('Sending test message...')

    try {
      const response = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.telegramChatId,
          text: '✅ *Price Perfect Connected!*\n\nTelegram notifications are now active.\n\n📊 You will receive alerts for:\n• Trade executions\n• Position exits\n• P&L updates',
          parse_mode: 'Markdown'
        })
      })

      const data = await response.json()
      if (data.ok) {
        setTelegramTestStatus('success')
        setTelegramTestMessage('✓ Test message sent! Check your Telegram.')
        // Save telegram settings to backend
        await (window as any).pricePerfect.trader?.saveTelegramSettings({
          botToken: settings.telegramBotToken,
          chatId: settings.telegramChatId,
          enabled: settings.telegramEnabled,
          notifyTrades: settings.telegramNotifyTrades,
          notifyAttempts: settings.telegramNotifyAttempts,
          notifyExits: settings.telegramNotifyExits,
          notifyPnL: settings.telegramNotifyPnL
        })
      } else {
        setTelegramTestStatus('error')
        setTelegramTestMessage(`✗ Error: ${data.description || 'Invalid token or chat ID'}`)
      }
    } catch (e) {
      setTelegramTestStatus('error')
      setTelegramTestMessage(`✗ Network error: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', background: '#0a0e14', padding: 24 }}>
      <div style={{ maxWidth: 600 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Settings</h1>
        <p style={{ fontSize: 14, color: '#9aa4b2', marginBottom: 24 }}>
          Configure API keys for AI models and exchange connections.
        </p>

        {/* OpenRouter API Section */}
        <div style={{ 
          background: '#0d1219', 
          borderRadius: 12, 
          padding: 20, 
          border: '1px solid #1e2636',
          marginBottom: 20
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 20 }}>🤖</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>OpenRouter API</div>
              <div style={{ fontSize: 12, color: '#6b7785' }}>Access 100+ AI models through one API</div>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#9aa4b2', marginBottom: 6 }}>
              API Key
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="password"
                value={settings.openRouterApiKey}
                onChange={(e) => setSettings(s => ({ ...s, openRouterApiKey: e.target.value }))}
                placeholder="sk-or-v1-..."
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid #1e2636',
                  background: '#111820',
                  color: '#e6eaf2',
                  fontSize: 14
                }}
              />
              <button
                onClick={testOpenRouterConnection}
                disabled={testStatus === 'testing'}
                style={{
                  padding: '10px 16px',
                  borderRadius: 8,
                  border: '1px solid #3b82f6',
                  background: testStatus === 'testing' ? '#1e2636' : '#1e3a8a',
                  color: '#60a5fa',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: testStatus === 'testing' ? 'not-allowed' : 'pointer'
                }}
              >
                {testStatus === 'testing' ? 'Testing...' : 'Test'}
              </button>
            </div>
            {testMessage && (
              <div style={{ 
                fontSize: 12, 
                marginTop: 8, 
                color: testStatus === 'success' ? '#4ade80' : testStatus === 'error' ? '#f87171' : '#9aa4b2'
              }}>
                {testMessage}
              </div>
            )}
            <div style={{ fontSize: 11, color: '#6b7785', marginTop: 8 }}>
              Get your API key from <a href="https://openrouter.ai/keys" target="_blank" rel="noopener" style={{ color: '#60a5fa' }}>openrouter.ai/keys</a>
            </div>
          </div>

          <div style={{ marginBottom: 0 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#9aa4b2', marginBottom: 6 }}>
              Default Model
            </label>
            <select
              value={settings.openRouterModel}
              onChange={(e) => setSettings(s => ({ ...s, openRouterModel: e.target.value }))}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #1e2636',
                background: '#111820',
                color: '#e6eaf2',
                fontSize: 14
              }}
            >
              {OPENROUTER_MODELS.map(model => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* AsterDEX API Section - Direct Entry with Auto-Save */}
        <div style={{ 
          background: '#0d1219', 
          borderRadius: 12, 
          padding: 20, 
          border: '2px solid #22c55e',
          marginBottom: 20
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 20 }}>🔺</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: '#22c55e' }}>AsterDEX API — 24/7 Auto-Trading</div>
              <div style={{ fontSize: 12, color: '#6b7785' }}>ETHUSDT Perpetuals • 88x Leverage • Trading starts automatically on app launch</div>
            </div>
          </div>

          <div style={{ 
            padding: 12, 
            background: '#14532d', 
            borderRadius: 8,
            border: '1px solid #22c55e',
            marginBottom: 16
          }}>
            <div style={{ fontSize: 12, color: '#4ade80', fontWeight: 600 }}>
              ✅ Auto-Start Enabled: Trading begins automatically when app launches if keys are saved
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#9aa4b2', marginBottom: 6 }}>
              AsterDEX API Key
            </label>
            <input
              type="password"
              value={settings.asterDexApiKey}
              onChange={(e) => setSettings(s => ({ ...s, asterDexApiKey: e.target.value }))}
              placeholder="Your AsterDEX API Key"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #1e2636',
                background: '#111820',
                color: '#e6eaf2',
                fontSize: 14
              }}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#9aa4b2', marginBottom: 6 }}>
              AsterDEX API Secret
            </label>
            <input
              type="password"
              value={settings.asterDexApiSecret}
              onChange={(e) => setSettings(s => ({ ...s, asterDexApiSecret: e.target.value }))}
              placeholder="Your AsterDEX API Secret"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #1e2636',
                background: '#111820',
                color: '#e6eaf2',
                fontSize: 14
              }}
            />
          </div>

          <button
            onClick={async () => {
              if (settings.asterDexApiKey && settings.asterDexApiSecret) {
                // Save to disk for persistence across sessions
                await (window as any).pricePerfect.trader?.saveApiKeys(settings.asterDexApiKey, settings.asterDexApiSecret)
                // Also save to localStorage
                localStorage.setItem('pricePerfect_apiSettings', JSON.stringify(settings))
                // Start trader immediately
                await (window as any).pricePerfect.trader?.start({
                  apiKey: settings.asterDexApiKey,
                  apiSecret: settings.asterDexApiSecret,
                  testnet: false,
                  enableAutoTrading: true,
                  initialMarginPercent: 8,
                  maxMarginPercent: 80
                })
                alert('✅ API Keys Saved & Trading Started!\n\nTrading will now auto-start every time you open the app.')
              } else {
                alert('Please enter both API Key and Secret')
              }
            }}
            style={{
              width: '100%',
              padding: '14px 20px',
              borderRadius: 10,
              border: 'none',
              background: 'linear-gradient(135deg, #22c55e, #16a34a)',
              color: '#fff',
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer'
            }}
          >
            💾 Save Keys & Start 24/7 Trading
          </button>

          <div style={{ fontSize: 11, color: '#6b7785', marginTop: 12, textAlign: 'center' }}>
            Get your API keys from <a href="https://asterdex.com" target="_blank" rel="noopener" style={{ color: '#60a5fa' }}>asterdex.com</a> → Account → API Management
          </div>
        </div>

        {/* Binance API Section */}
        <div style={{ 
          background: '#0d1219', 
          borderRadius: 12, 
          padding: 20, 
          border: '1px solid #1e2636',
          marginBottom: 20
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 20 }}>📈</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Binance API (Optional)</div>
              <div style={{ fontSize: 12, color: '#6b7785' }}>For live trading (not required for data)</div>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#9aa4b2', marginBottom: 6 }}>
              API Key
            </label>
            <input
              type="password"
              value={settings.binanceApiKey}
              onChange={(e) => setSettings(s => ({ ...s, binanceApiKey: e.target.value }))}
              placeholder="Your Binance API Key"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #1e2636',
                background: '#111820',
                color: '#e6eaf2',
                fontSize: 14
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#9aa4b2', marginBottom: 6 }}>
              API Secret
            </label>
            <input
              type="password"
              value={settings.binanceApiSecret}
              onChange={(e) => setSettings(s => ({ ...s, binanceApiSecret: e.target.value }))}
              placeholder="Your Binance API Secret"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #1e2636',
                background: '#111820',
                color: '#e6eaf2',
                fontSize: 14
              }}
            />
          </div>
        </div>

        {/* Telegram Notifications Section */}
        <div style={{ 
          background: '#0d1219', 
          borderRadius: 12, 
          padding: 20, 
          border: settings.telegramEnabled ? '2px solid #0ea5e9' : '1px solid #1e2636',
          marginBottom: 20
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 20 }}>📱</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Telegram Notifications</div>
              <div style={{ fontSize: 12, color: '#6b7785' }}>Get real-time trade alerts on your phone</div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.telegramEnabled}
                onChange={(e) => setSettings(s => ({ ...s, telegramEnabled: e.target.checked }))}
                style={{ width: 18, height: 18, accentColor: '#0ea5e9' }}
              />
              <span style={{ fontSize: 12, color: settings.telegramEnabled ? '#0ea5e9' : '#6b7785' }}>
                {settings.telegramEnabled ? 'Enabled' : 'Disabled'}
              </span>
            </label>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#9aa4b2', marginBottom: 6 }}>
              Bot Token
            </label>
            <input
              type="password"
              value={settings.telegramBotToken}
              onChange={(e) => setSettings(s => ({ ...s, telegramBotToken: e.target.value }))}
              placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #1e2636',
                background: '#111820',
                color: '#e6eaf2',
                fontSize: 14
              }}
            />
            <div style={{ fontSize: 11, color: '#6b7785', marginTop: 4 }}>
              Create a bot via <a href="https://t.me/BotFather" target="_blank" rel="noopener" style={{ color: '#60a5fa' }}>@BotFather</a> on Telegram
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#9aa4b2', marginBottom: 6 }}>
              Chat ID
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={settings.telegramChatId}
                onChange={(e) => setSettings(s => ({ ...s, telegramChatId: e.target.value }))}
                placeholder="Your chat ID (e.g., 123456789)"
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid #1e2636',
                  background: '#111820',
                  color: '#e6eaf2',
                  fontSize: 14
                }}
              />
              <button
                onClick={testTelegramConnection}
                disabled={telegramTestStatus === 'testing'}
                style={{
                  padding: '10px 16px',
                  borderRadius: 8,
                  border: '1px solid #0ea5e9',
                  background: telegramTestStatus === 'testing' ? '#1e2636' : '#0c4a6e',
                  color: '#38bdf8',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: telegramTestStatus === 'testing' ? 'not-allowed' : 'pointer'
                }}
              >
                {telegramTestStatus === 'testing' ? 'Sending...' : 'Test'}
              </button>
            </div>
            {telegramTestMessage && (
              <div style={{ 
                fontSize: 12, 
                marginTop: 8, 
                color: telegramTestStatus === 'success' ? '#4ade80' : telegramTestStatus === 'error' ? '#f87171' : '#9aa4b2'
              }}>
                {telegramTestMessage}
              </div>
            )}
            <div style={{ fontSize: 11, color: '#6b7785', marginTop: 4 }}>
              Get your Chat ID from <a href="https://t.me/userinfobot" target="_blank" rel="noopener" style={{ color: '#60a5fa' }}>@userinfobot</a> on Telegram
            </div>
          </div>

          {/* Notification Options */}
          <div style={{ 
            padding: 12, 
            background: '#111820', 
            borderRadius: 8,
            border: '1px solid #1e2636'
          }}>
            <div style={{ fontSize: 12, color: '#9aa4b2', marginBottom: 10, fontWeight: 600 }}>
              Notification Types
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.telegramNotifyTrades}
                  onChange={(e) => setSettings(s => ({ ...s, telegramNotifyTrades: e.target.checked }))}
                  style={{ accentColor: '#0ea5e9' }}
                />
                <span style={{ fontSize: 12, color: '#e6eaf2' }}>Trade Executions</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.telegramNotifyExits}
                  onChange={(e) => setSettings(s => ({ ...s, telegramNotifyExits: e.target.checked }))}
                  style={{ accentColor: '#0ea5e9' }}
                />
                <span style={{ fontSize: 12, color: '#e6eaf2' }}>Position Exits</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.telegramNotifyAttempts}
                  onChange={(e) => setSettings(s => ({ ...s, telegramNotifyAttempts: e.target.checked }))}
                  style={{ accentColor: '#0ea5e9' }}
                />
                <span style={{ fontSize: 12, color: '#e6eaf2' }}>Trade Attempts</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.telegramNotifyPnL}
                  onChange={(e) => setSettings(s => ({ ...s, telegramNotifyPnL: e.target.checked }))}
                  style={{ accentColor: '#0ea5e9' }}
                />
                <span style={{ fontSize: 12, color: '#e6eaf2' }}>P&L Updates</span>
              </label>
            </div>
          </div>
        </div>

        {/* Save Button */}
        <button
          onClick={handleSave}
          style={{
            width: '100%',
            padding: '14px 20px',
            borderRadius: 10,
            border: 'none',
            background: saved ? '#14532d' : 'linear-gradient(135deg, #22c55e, #16a34a)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
        >
          {saved ? '✓ Settings Saved!' : 'Save Settings'}
        </button>

        <div style={{ 
          marginTop: 24, 
          padding: 16, 
          background: '#111820', 
          borderRadius: 10, 
          border: '1px solid #1e2636' 
        }}>
          <div style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600, marginBottom: 8 }}>
            🔒 Security Note
          </div>
          <div style={{ fontSize: 11, color: '#6b7785', lineHeight: 1.5 }}>
            API keys are stored locally on your machine and never sent to any external servers except the official API endpoints. 
            Your keys are only used for direct API calls to OpenRouter and Binance.
          </div>
        </div>
      </div>
    </div>
  )
}
