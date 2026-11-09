import fs from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCafefBoard } from '../../src/main/market/providers/cafef'
import { parseVietcapQuotes } from '../../src/main/market/providers/vietcap'
import { itemTone, type PriceTone } from '../../src/shared/priceTone'
import type { Market, Quote } from '../../src/shared/types'
import { fixture, ict } from './helpers'

const BAR = join(__dirname, '../../src/renderer/bar')

/** Top-level `.class { color: X; }` rules of a CSS module (rules inside @media are indented). */
function colorRules(file: string): Record<string, string> {
  const css = fs.readFileSync(join(BAR, file), 'utf8')
  const rules: Record<string, string> = {}
  for (const m of css.matchAll(/^\.(\w+)\s*\{\s*color:\s*([^;]+);/gm)) rules[m[1]!] ??= m[2]!.trim()
  return rules
}

const SPARK = colorRules('Sparkline.module.css')
const ITEM = colorRules('TickerItem.module.css') // glyph and % change
const PRICE = colorRules('PriceText.module.css')

const TOKEN: Record<PriceTone, string> = {
  up: 'var(--up)',
  down: 'var(--down)',
  flat: 'var(--flat)',
  ref: 'var(--ref)',
  ceiling: 'var(--ceiling)',
  floor: 'var(--floor)'
}

// FPT on 2026-11-06: reference 52,900, ceiling 56,600, floor 49,200.
const quote = (price: number, extra: Partial<Quote> = {}): Quote => ({
  id: 'vn:FPT',
  price,
  refPrice: 52_900,
  change: price - (extra.refPrice ?? 52_900),
  changePct: 0,
  state: 'live',
  source: 'fake',
  updatedAt: 0,
  ceiling: 56_600,
  floor: 49_200,
  ...extra
})

const CASES: [string, Quote | undefined, Market, PriceTone][] = [
  ['VN stock at the reference', quote(52_900), 'vn', 'ref'],
  ['VN stock at the ceiling', quote(56_600), 'vn', 'ceiling'],
  ['VN stock at the floor', quote(49_200), 'vn', 'floor'],
  ['VN stock up', quote(53_000), 'vn', 'up'],
  ['VN stock down', quote(52_800), 'vn', 'down'],
  ['VN stock without ceiling, at the old ceiling', quote(56_600, { ceiling: undefined, floor: undefined }), 'vn', 'up'],
  ['VN stock without floor, at the old floor', quote(49_200, { ceiling: undefined, floor: undefined }), 'vn', 'down'],
  ['VN index unchanged', quote(1740, { id: 'vn:VNINDEX', refPrice: 1740, ceiling: undefined, floor: undefined }), 'vn', 'ref'],
  ['US stock unchanged', quote(100, { id: 'us:AAPL', refPrice: 100 }), 'us', 'flat'],
  ['crypto up', quote(101, { id: 'crypto:BTCUSDT', refPrice: 100 }), 'crypto', 'up'],
  ['crypto down', quote(99, { id: 'crypto:BTCUSDT', refPrice: 100 }), 'crypto', 'down'],
  ['loading', quote(56_600, { state: 'loading' }), 'vn', 'flat'],
  ['error', quote(56_600, { state: 'error' }), 'vn', 'flat'],
  ['no quote yet', undefined, 'vn', 'flat']
]

describe('sparkline color = price tone', () => {
  it.each(CASES)('%s', (_name, q, market, expected) => {
    const tone = itemTone(q, market)
    expect(tone).toBe(expected)
    expect(SPARK[tone]).toBe(TOKEN[tone])
    // Same color as the glyph and % change of the item...
    expect(SPARK[tone]).toBe(ITEM[tone])
    // ...and as the price number itself, in every tone.
    expect(SPARK[tone]).toBe(PRICE[tone])
  })

  it('the dashed reference line stays neutral', () => {
    const css = fs.readFileSync(join(BAR, 'Sparkline.module.css'), 'utf8')
    expect(/\.refLine\s*\{[^}]*stroke:\s*var\(--text-3\)/.exec(css)).not.toBeNull()
  })

  it('has no color transition or animation (a tone change is an instant switch)', () => {
    const css = fs.readFileSync(join(BAR, 'Sparkline.module.css'), 'utf8')
    expect(css).not.toMatch(/transition|animation|@keyframes/)
  })
})

// REAL DATA: Vietcap getList and the CafeF HOSE board recorded 2026-11-09 10:30 ICT. SMA was at
// its ceiling (9,800), CMV at its floor (7,890), VCI (19,950 / 20,000) and VNG (5,060) down.
describe('real provider payloads: one tone for price and sparkline', () => {
  const now = ict(2026, 11, 9, 10, 30)
  const expected: Record<string, PriceTone> = { 'vn:SMA': 'ceiling', 'vn:CMV': 'floor', 'vn:VCI': 'down', 'vn:VNG': 'down' }
  const sources: [string, Quote[]][] = [
    ['Vietcap', parseVietcapQuotes(fixture('vietcap/getList-limits.json'), now)!],
    ['CafeF', parseCafefBoard(fixture('cafef/board-center1-limits.json'), new Set(['SMA', 'CMV', 'VCI', 'VNG']), now)!]
  ]
  it.each(sources)('%s', (_source, quotes) => {
    expect(quotes.map((q) => q.id).sort()).toEqual(Object.keys(expected).sort())
    for (const q of quotes) {
      const tone = itemTone(q, 'vn')
      expect(tone, q.id).toBe(expected[q.id])
      expect(SPARK[tone], q.id).toBe(TOKEN[tone])
      expect(PRICE[tone], q.id).toBe(SPARK[tone])
      expect(ITEM[tone], q.id).toBe(SPARK[tone])
    }
  })
})
