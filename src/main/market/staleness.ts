import type { Market, Quote } from '../../shared/types'

/** Max age of the last successful fetch while the market is in session. */
export const STALE_AFTER_MS: Readonly<Record<Market, number>> = {
  crypto: 15_000,
  vn: 30_000,
  us: 60_000
}

/**
 * `receivedAt` is the local time of the last successful fetch carrying the
 * symbol (not the provider timestamp: VN ticks do not change between trades).
 */
export function isStale(market: Market, receivedAt: number, now: number, inSession: boolean): boolean {
  return inSession && now - receivedAt > STALE_AFTER_MS[market]
}

/** Returns the quote with `state: 'stale'` when it is too old; out of session it is never stale. */
export function markStale(quote: Quote, market: Market, receivedAt: number, now: number, inSession: boolean): Quote {
  return isStale(market, receivedAt, now, inSession) ? { ...quote, state: 'stale' } : quote
}
