import type { CandleSeries } from './candleSeries'
import type { SwingType } from './types'

export function detectSwingAt(
  series: CandleSeries,
  pivotLen: number,
  index: number
): { swingType: SwingType; price: number } | null {
  if (index < pivotLen) return null
  if (index + pivotLen >= series.length) return null

  const pivot = series.at(index).candle

  let isHigh = true
  let isLow = true

  for (let i = index - pivotLen; i <= index + pivotLen; i++) {
    if (i === index) continue

    const c = series.at(i).candle

    if (c.high >= pivot.high) isHigh = false
    if (c.low <= pivot.low) isLow = false

    if (!isHigh && !isLow) break
  }

  if (isHigh === isLow) return null
  if (isHigh) return { swingType: 'high', price: pivot.high }
  return { swingType: 'low', price: pivot.low }
}
