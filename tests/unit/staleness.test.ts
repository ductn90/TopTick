import { describe, expect, it } from 'vitest'
import { isStale, markStale, STALE_AFTER_MS } from '../../src/main/market/staleness'
import type { Quote } from '../../src/shared/types'

const quote: Quote = {
  id: 'crypto:BTCUSDT',
  price: 1,
  refPrice: 1,
  change: 0,
  changePct: 0,
  state: 'live',
  source: 'binance',
  updatedAt: 0
}

describe('staleness', () => {
  it('uses 15 s / 30 s / 60 s thresholds for crypto / VN / US', () => {
    expect(STALE_AFTER_MS).toEqual({ crypto: 15_000, vn: 30_000, us: 60_000 })
    for (const [market, ms] of Object.entries(STALE_AFTER_MS) as [keyof typeof STALE_AFTER_MS, number][]) {
      expect(isStale(market, 0, ms, true)).toBe(false)
      expect(isStale(market, 0, ms + 1, true)).toBe(true)
    }
  })

  it('is never stale out of session', () => {
    expect(isStale('vn', 0, 10 * 60_000, false)).toBe(false)
    expect(markStale({ ...quote, state: 'closed' }, 'vn', 0, 10 * 60_000, false).state).toBe('closed')
  })

  it('markStale keeps values and only changes the state', () => {
    const fresh = markStale(quote, 'crypto', 1000, 2000, true)
    expect(fresh).toBe(quote)
    const old = markStale(quote, 'crypto', 0, 15_001, true)
    expect(old).toEqual({ ...quote, state: 'stale' })
  })
})
