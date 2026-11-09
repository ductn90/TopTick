import type { Market, Quote } from './types'

/** Color of an item's glyph, price and % change on the bar. */
export type PriceTone = 'up' | 'down' | 'flat' | 'ref' | 'ceiling' | 'floor'

/**
 * Vietnamese market convention: the price at the ceiling is purple, at the floor cyan and at the
 * reference price yellow (VN indices included, they have no ceiling or floor). A quote without
 * ceiling/floor (a source that does not send them) falls back to up/down. Other markets keep
 * up/down/flat.
 */
export function priceTone(q: Pick<Quote, 'price' | 'refPrice' | 'change' | 'ceiling' | 'floor'>, market: Market): PriceTone {
  if (market === 'vn') {
    if (q.ceiling !== undefined && q.ceiling > 0 && q.price >= q.ceiling) return 'ceiling'
    if (q.floor !== undefined && q.floor > 0 && q.price <= q.floor) return 'floor'
    if (q.price === q.refPrice) return 'ref'
  }
  if (q.change > 0) return 'up'
  if (q.change < 0) return 'down'
  return 'flat'
}

/**
 * Tone of a bar item: `flat` while loading or in error, otherwise `priceTone`. The glyph, the
 * price, the % change and the sparkline all take their color from this one value.
 */
export function itemTone(q: Quote | undefined, market: Market): PriceTone {
  if (!q || q.state === 'loading' || q.state === 'error') return 'flat'
  return priceTone(q, market)
}
