import { runBackfill } from '../engine/backfill'
import * as path from 'path'

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')

console.log('[ETH Backfill] Starting ETHUSDT backfill...')
console.log('[ETH Backfill] Data dir:', dataDir)

runBackfill({
  dataDir,
  exchange: 'binance',
  symbol: 'ethusdt',
  interval: '1m',
  maxMonths: 120,
  onProgress: (progress) => {
    console.log(`[ETH Backfill] ${progress.state}: ${progress.message || ''} - ${progress.monthsProcessed || 0} months`)
  }
}).then(() => {
  console.log('[ETH Backfill] Complete!')
  process.exit(0)
}).catch((err) => {
  console.error('[ETH Backfill] Error:', err)
  process.exit(1)
})
