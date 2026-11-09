import type { Kind, Market } from './types'

/** Number formatting always uses en-US separators, in both languages [A12]. */
const LOCALE = 'en-US'

const fixedFormatters = new Map<number, Intl.NumberFormat>()

function fixed(dp: number): Intl.NumberFormat {
  let f = fixedFormatters.get(dp)
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: dp, maximumFractionDigits: dp })
    fixedFormatters.set(dp, f)
  }
  return f
}

const pctFormatter = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero'
})

const MAX_CRYPTO_DP = 8
const CRYPTO_SIG_DIGITS = 4

/** Decimal places for a price (design §Formatting decimals table). */
export function priceDecimals(market: Market, kind: Kind, price: number): number {
  if (kind === 'index') return 2
  if (market === 'vn') return 0
  if (market === 'us') return 2
  const abs = Math.abs(price)
  if (abs >= 10_000) return 0
  if (abs >= 1) return 2
  if (!(abs > 0)) return CRYPTO_SIG_DIGITS
  const dp = CRYPTO_SIG_DIGITS - 1 - Math.floor(Math.log10(abs))
  return Math.min(MAX_CRYPTO_DP, dp)
}

export function formatPrice(price: number, market: Market, kind: Kind): string {
  return fixed(priceDecimals(market, kind, price)).format(price)
}

/** Change percent with 2 dp and an explicit sign: "+0.44%", "-5.37%", "0.00%". */
export function formatPct(pct: number): string {
  return `${pctFormatter.format(pct)}%`
}

export type DirectionGlyph = '▲' | '▼' | '•'

export function directionGlyph(change: number): DirectionGlyph {
  if (change > 0) return '▲'
  if (change < 0) return '▼'
  return '•'
}

/** Local wall-clock time "HH:mm:ss" for tooltips. */
export function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
