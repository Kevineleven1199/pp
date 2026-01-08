/// <reference types="vite/client" />

export {}

declare global {
  interface Window {
    pricePerfect: {
      engine: {
        start: (opts?: { symbol?: string; interval?: string }) => Promise<void>
        stop: () => Promise<void>
        startBackfill: (opts?: { maxMonths?: number; symbol?: string; interval?: string }) => Promise<void>
        stopBackfill: () => Promise<void>
        startReconcile: (opts?: { maxDays?: number; symbol?: string; interval?: string }) => Promise<void>
        stopReconcile: () => Promise<void>
        getStatus: () => Promise<{
          connected: boolean
          lastPrice?: number
          lastKlineOpenTime?: number
          symbol?: string
          exchange?: string
          interval?: string
          dataDir?: string
          candlesWritten?: number
          gapsFound?: number
          swingsFound?: number
          pivotLen?: number
          backfill?: {
            state: 'idle' | 'running' | 'done' | 'error' | 'stopped'
            startedAt?: number
            finishedAt?: number
            message?: string
            currentMonth?: string
            currentUrl?: string
            monthsProcessed?: number
            daysWritten?: number
            candlesIngested?: number
            lastError?: string
          }
          reconcile?: {
            state: 'idle' | 'running' | 'done' | 'error' | 'stopped'
            startedAt?: number
            finishedAt?: number
            message?: string
            currentFile?: string
            daysScanned?: number
            gapsFound?: number
            gapsRepaired?: number
            gapsSkipped?: number
            candlesRepaired?: number
            lastError?: string
          }
          derivedRebuild?: {
            state: 'idle' | 'running' | 'done' | 'error' | 'stopped'
            startedAt?: number
            finishedAt?: number
            message?: string
            currentFile?: string
            daysProcessed?: number
            baseCandlesProcessed?: number
            aggCandlesWritten?: number
            swingEventsWritten?: number
            lastError?: string
          }
        }>
        startDerivedRebuild: (opts?: { maxDays?: number }) => Promise<void>
        stopDerivedRebuild: () => Promise<void>
        exportCsv: () => Promise<{ path: string; error?: string }>
        getSymbols: () => Promise<string[]>
        getSwings: (symbol?: string) => Promise<{ data: any[]; total: number; symbol?: string }>
        startLive: () => Promise<void>
        stopLive: () => Promise<void>
        on: <K extends 'status' | 'kline' | 'swing'>(
          event: K,
          callback: (payload: any) => void
        ) => () => void
      }
    }
  }
}
