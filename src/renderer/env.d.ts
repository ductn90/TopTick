import type { TickerApi } from '../shared/types'

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts. */
    ticker: TickerApi
  }
}

export {}
