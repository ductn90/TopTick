import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CAFEF_BOARD_URL,
  CAFEF_CHART_URL,
  createCafefProvider,
  parseCafefBoard,
  parseCafefChart,
  parseCafefIndices,
  parseCafefTime
} from '../../../src/main/market/providers/cafef'
import type { Quote, Series } from '../../../src/shared/types'
import { fail, fakeFetch, fixture, ict, ok, timerDeps } from '../helpers'

const IN_SESSION = ict(2026, 11, 6, 10, 0)
const AFTER_CLOSE = ict(2026, 11, 6, 16, 0)
const board = fixture('cafef/board-center1.json') as { a: string; b: number; l: number; k: number; Time: string }[]

describe('parseCafefTime', () => {
  it('parses "HH:mm dd/MM/yyyy" as ICT', () => {
    expect(parseCafefTime('14:45 05/11/2026')).toBe(ict(2026, 11, 5, 14, 45))
    expect(parseCafefTime('07:00 01/01/0001')).toBeNull()
    expect(parseCafefTime('garbage')).toBeNull()
    expect(parseCafefTime(undefined)).toBeNull()
  })
})

describe('parseCafefBoard', () => {
  it('normalizes thousand-VND values (x1000) for the wanted symbols only', () => {
    const quotes = parseCafefBoard(board, new Set(['FPT', 'VNM']), IN_SESSION)!
    expect(quotes.map((q) => q.id)).toEqual(['vn:FPT', 'vn:VNM'])
    // FPT row: b 53.9, l 52.9, k -1, Time "14:45 05/11/2026"
    expect(quotes[0]).toMatchObject({
      price: 52_900,
      refPrice: 53_900,
      change: -1000,
      state: 'live',
      source: 'cafef',
      updatedAt: ict(2026, 11, 5, 14, 45)
    })
    expect(quotes[0]!.changePct).toBeCloseTo((-1000 / 53_900) * 100, 6)
    expect(quotes[1]).toMatchObject({ price: 57_500, refPrice: 57_400, change: 100 })
  })

  it('reads ceiling (c) and floor (d) in thousand VND; leaves them out when missing', () => {
    const [q] = parseCafefBoard(board, new Set(['FPT']), IN_SESSION)!
    expect(q).toMatchObject({ refPrice: 53_900, ceiling: 57_600, floor: 50_200 })
    const rows = board.map((r) => (r.a === 'FPT' ? { a: r.a, b: r.b, l: r.l, k: r.k, Time: r.Time } : r))
    const [none] = parseCafefBoard(rows, new Set(['FPT']), IN_SESSION)!
    expect(none).not.toHaveProperty('ceiling')
    expect(none).not.toHaveProperty('floor')
  })

  it('applies the pre-open rule when l is 0', () => {
    const rows = board.map((r) => (r.a === 'FPT' ? { ...r, l: 0, k: 0 } : r))
    const [q] = parseCafefBoard(rows, new Set(['FPT']), IN_SESSION)!
    expect(q).toMatchObject({ price: 53_900, refPrice: 53_900, change: 0, changePct: 0, state: 'preopen' })
  })

  it('falls back to now for placeholder times and skips invalid rows only', () => {
    const quotes = parseCafefBoard(board, new Set(['AAT']), IN_SESSION)!
    expect(quotes[0]!.updatedAt).toBe(IN_SESSION) // "07:00 01/01/0001"
    const rows = [...board, { a: 'BAD', b: 'x' }, { a: 'NEG', b: 10, l: -5, k: 0, Time: '' }]
    expect(parseCafefBoard(rows, new Set(['BAD', 'NEG', 'FPT']), IN_SESSION)!.map((q) => q.id)).toEqual(['vn:FPT'])
    expect(parseCafefBoard({ rows: [] }, new Set(['FPT']), IN_SESSION)).toBeNull()
  })
})

describe('parseCafefIndices', () => {
  it('parses comma strings and derives refPrice = index - change', () => {
    const quotes = parseCafefIndices(fixture('cafef/index.json'), IN_SESSION)!
    expect(quotes.map((q) => q.id).sort()).toEqual(
      ['vn:HNX30', 'vn:HNXIndex', 'vn:HNXUpcomIndex', 'vn:VN30', 'vn:VNINDEX'].sort()
    )
    const vni = quotes.find((q) => q.id === 'vn:VNINDEX')!
    // {"change":"7.71","index":"1,740.73","percent":"0.44"}
    expect(vni.price).toBe(1740.73)
    expect(vni.refPrice).toBe(1733.02)
    expect(vni.change).toBeCloseTo(7.71, 6)
    expect(vni.changePct).toBeCloseTo(0.44, 2)
    expect(vni.source).toBe('cafef')
  })

  it('rejects malformed payloads and skips unknown names', () => {
    expect(parseCafefIndices({}, IN_SESSION)).toBeNull()
    expect(parseCafefIndices([{ name: 'VNINDEX', index: 1, change: '0', percent: '0' }], IN_SESSION)).toBeNull()
    expect(parseCafefIndices([{ name: 'OTHER', index: '1', change: '0', percent: '0' }], IN_SESSION)).toEqual([])
    expect(parseCafefIndices([{ name: 'VN30', index: 'n/a', change: '0', percent: '0' }], IN_SESSION)).toEqual([])
  })
})

describe('parseCafefChart', () => {
  it('keeps the latest day in time order, x1000', () => {
    const c = parseCafefChart(fixture('cafef/tradingview-FPT.json'))!
    // 16 bars on 2026-11-05, 09:29 -> 14:45; the fixture also holds 2026-04-14.
    expect(c.points).toHaveLength(16)
    expect(c.points[0]).toBe(53_800)
    expect(c.points[15]).toBe(52_900)
    expect(c.lastTime).toBe(ict(2026, 11, 5, 14, 45))
    expect(parseCafefChart({ succeeded: false, data: { value: null } })).toBeNull()
    expect(parseCafefChart({})).toBeNull()
  })
})

describe('CafefProvider', () => {
  const index = fixture('cafef/index.json')
  const chart = fixture('cafef/tradingview-FPT.json')

  function setup(boardOf?: (s: string) => 1 | 2 | 9 | undefined) {
    const net = fakeFetch((url) => {
      if (url.startsWith(`${CAFEF_BOARD_URL}?center=`)) return ok(board)
      if (url === `${CAFEF_BOARD_URL}?index=true`) return ok(index)
      if (url.startsWith(CAFEF_CHART_URL)) return ok(chart)
      return fail('http', 404)
    })
    const p = createCafefProvider({ ...timerDeps(net.fetchJson), boardOf })
    const quotes: Quote[] = []
    const series: Series[] = []
    p.on('quote', (q) => quotes.push(q))
    p.on('series', (s) => series.push(s))
    return { p, net, quotes, series }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fetches only the boards of subscribed stocks, plus index=true for indices', async () => {
    vi.setSystemTime(IN_SESSION)
    const { p, net, quotes } = setup((s) => (s === 'FPT' ? 1 : s === 'SHS' ? 2 : undefined))
    p.setSubscriptions(['vn:FPT', 'vn:VNINDEX'])
    await expect(p.pollOnce()).resolves.toBe(true)
    expect(net.calls.map((c) => c.url)).toEqual([`${CAFEF_BOARD_URL}?center=1`, `${CAFEF_BOARD_URL}?index=true`])
    expect(net.calls.every((c) => c.options.provider === 'cafef')).toBe(true)
    expect(quotes.map((q) => q.id).sort()).toEqual(['vn:FPT', 'vn:VNINDEX'])
  })

  it('tries all three boards when a board is unknown', async () => {
    const { p, net } = setup(() => undefined)
    p.setSubscriptions(['vn:FPT'])
    await p.pollOnce()
    expect(net.calls.map((c) => c.url)).toEqual([1, 2, 9].map((n) => `${CAFEF_BOARD_URL}?center=${n}`))
  })

  it('polls every 10 s in session and 60 s outside', async () => {
    vi.setSystemTime(IN_SESSION)
    const a = setup(() => 1)
    a.p.setSubscriptions(['vn:FPT'])
    a.p.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(a.net.calls.filter((c) => c.url.includes('center='))).toHaveLength(3)
    a.p.stop()

    vi.setSystemTime(AFTER_CLOSE)
    const b = setup(() => 1)
    b.p.setSubscriptions(['vn:FPT'])
    b.p.start()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(b.net.calls.filter((c) => c.url.includes('center='))).toHaveLength(1)
    b.p.stop()
  })

  it('fetches TradingViewsData for stocks only (no index series on CafeF)', async () => {
    vi.setSystemTime(AFTER_CLOSE)
    const { p, net, series } = setup(() => 1)
    p.setSubscriptions(['vn:FPT', 'vn:VNINDEX'])
    p.start()
    await vi.advanceTimersByTimeAsync(1000)
    const charts = net.calls.filter((c) => c.url.startsWith(CAFEF_CHART_URL))
    expect(charts.map((c) => c.url)).toEqual([`${CAFEF_CHART_URL}?symbol=FPT&type=1`])
    expect([...new Set(series.map((s) => s.id))]).toEqual(['vn:FPT'])
    p.stop()
  })
})
