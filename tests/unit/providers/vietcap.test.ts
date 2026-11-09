import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ictDateKey } from '../../../src/main/market/schedule'
import {
  createVietcapProvider,
  parseGapChart,
  parseVietcapDirectory,
  parseVietcapIndices,
  parseVietcapQuotes,
  VIETCAP_URLS
} from '../../../src/main/market/providers/vietcap'
import type { Quote, Series } from '../../../src/shared/types'
import { fail, fakeFetch, fixture, flushPromises, ict, ok, timerDeps } from '../helpers'

const IN_SESSION = ict(2026, 11, 6, 10, 0)
const PRE_OPEN = ict(2026, 11, 6, 8, 16)
const AFTER_CLOSE = ict(2026, 11, 6, 16, 0)

type LiveRow = { listingInfo: { symbol: string; refPrice: number }; matchPrice: { matchPrice: number } }
type IndexRow = { symbol: string; price: number; refPrice: number; change: number; changePercent: number }

describe('parseVietcapQuotes', () => {
  it('maps matchPrice.matchPrice -> price and listingInfo.refPrice -> refPrice (full VND)', () => {
    const raw = fixture('vietcap/getList-live.json') as LiveRow[]
    const quotes = parseVietcapQuotes(raw, IN_SESSION)!
    expect(quotes).toHaveLength(raw.length)
    raw.forEach((row, i) => {
      const q = quotes[i]!
      expect(q.id).toBe(`vn:${row.listingInfo.symbol}`)
      expect(q.price).toBe(row.matchPrice.matchPrice)
      expect(q.refPrice).toBe(row.listingInfo.refPrice)
      expect(q.change).toBe(row.matchPrice.matchPrice - row.listingInfo.refPrice)
      expect(q.state).toBe('live')
      expect(q.source).toBe('vietcap')
      expect(Number.isInteger(q.price) && q.price > 1000).toBe(true)
    })
    // Captured 2026-11-06 09:16 ICT.
    expect(quotes[0]).toMatchObject({ id: 'vn:FPT', price: 51_400, refPrice: 52_900, change: -1500 })
    expect(quotes[0]!.updatedAt).toBe(Date.parse('2026-11-06T02:16:13.355Z'))
  })

  it('applies the pre-open rule when matchPrice is 0', () => {
    const quotes = parseVietcapQuotes(fixture('vietcap/getList-preopen.json'), PRE_OPEN)!
    expect(quotes.map((q) => q.id)).toEqual(['vn:FPT', 'vn:VCB', 'vn:HPG', 'vn:VNM'])
    expect(quotes[0]).toMatchObject({ price: 52900, refPrice: 52900, change: 0, changePct: 0, state: 'preopen' })
    expect(quotes.every((q) => q.state === 'preopen' && q.change === 0)).toBe(true)
  })

  it('marks quotes closed outside the session', () => {
    const quotes = parseVietcapQuotes(fixture('vietcap/getList-live.json'), AFTER_CLOSE)!
    expect(quotes.every((q) => q.state === 'closed')).toBe(true)
  })

  it('keeps listingInfo ceiling and floor; leaves them out when missing or invalid', () => {
    const [q] = parseVietcapQuotes(fixture('vietcap/getList-live.json'), IN_SESSION)!
    expect(q).toMatchObject({ id: 'vn:FPT', ceiling: 56_600, floor: 49_200 })
    const row = (extra: object) => ({ listingInfo: { symbol: 'FPT', refPrice: 52_900, ...extra }, matchPrice: { matchPrice: 53_000 } })
    const [none] = parseVietcapQuotes([row({})], IN_SESSION)!
    expect(none).not.toHaveProperty('ceiling')
    expect(none).not.toHaveProperty('floor')
    const [bad] = parseVietcapQuotes([row({ ceiling: 0, floor: null })], IN_SESSION)!
    expect(bad).not.toHaveProperty('ceiling')
    expect(bad).not.toHaveProperty('floor')
  })

  it('has no ceiling or floor on indices', () => {
    const quotes = parseVietcapIndices(fixture('vietcap/marketIndex-live.json'), IN_SESSION)!
    expect(quotes.some((q) => 'ceiling' in q || 'floor' in q)).toBe(false)
  })

  it('rejects invalid payloads and invalid prices', () => {
    expect(parseVietcapQuotes({ symbols: [] }, IN_SESSION)).toBeNull()
    expect(parseVietcapQuotes([{ listingInfo: { symbol: 'FPT' } }], IN_SESSION)).toBeNull()
    const row = (matchPrice: number, refPrice = 52900) => ({ listingInfo: { symbol: 'FPT', refPrice }, matchPrice: { matchPrice } })
    expect(parseVietcapQuotes([row(-1)], IN_SESSION)).toEqual([])
    expect(parseVietcapQuotes([row(Number.NaN)], IN_SESSION)).toBeNull() // zod rejects NaN
    expect(parseVietcapQuotes([row(53000, 0)], IN_SESSION)).toEqual([])
    expect(parseVietcapQuotes([row(0, 0)], IN_SESSION)).toEqual([])
  })
})

describe('parseVietcapIndices', () => {
  it('maps price/refPrice for every index, keeping Vietcap codes', () => {
    const raw = fixture('vietcap/marketIndex-live.json') as IndexRow[]
    const quotes = parseVietcapIndices(raw, IN_SESSION)!
    expect(quotes.map((q) => q.id).sort()).toEqual(
      ['vn:HNX30', 'vn:HNXIndex', 'vn:HNXUpcomIndex', 'vn:VN30', 'vn:VNINDEX'].sort()
    )
    for (const q of quotes) {
      const row = raw.find((r) => `vn:${r.symbol}` === q.id)!
      expect(q.price).toBe(row.price)
      expect(q.refPrice).toBe(row.refPrice)
      expect(q.change).toBeCloseTo(row.change, 2)
      expect(q.changePct).toBeCloseTo(row.changePercent, 1)
    }
  })

  it('applies the pre-open rule when price is 0', () => {
    const quotes = parseVietcapIndices(fixture('vietcap/marketIndex-preopen.json'), PRE_OPEN)!
    const vni = quotes.find((q) => q.id === 'vn:VNINDEX')!
    expect(vni).toMatchObject({ price: 1740.73, refPrice: 1740.73, change: 0, changePct: 0, state: 'preopen' })
  })
})

describe('parseGapChart', () => {
  it('keeps only the latest ICT trading day', () => {
    const raw = fixture('vietcap/gap-chart-FPT.json') as { c: number[]; t: string[] }[]
    const parsed = parseGapChart(raw)!
    const lastDay = ictDateKey(Number(raw[0]!.t[raw[0]!.t.length - 1]) * 1000)
    const expected = raw[0]!.t.filter((t) => ictDateKey(Number(t) * 1000) === lastDay).length
    expect(parsed.symbol).toBe('FPT')
    expect(parsed.points).toHaveLength(expected)
    expect(expected).toBeLessThan(raw[0]!.c.length)
    expect(parsed.points[parsed.points.length - 1]).toBe(raw[0]!.c[raw[0]!.c.length - 1])
  })

  it('handles indices and rejects empty or inconsistent rows', () => {
    expect(parseGapChart(fixture('vietcap/gap-chart-VNINDEX.json'))!.points.length).toBeGreaterThan(10)
    expect(parseGapChart([])).toBeNull()
    expect(parseGapChart([{ symbol: 'FPT', c: [1, 2], t: ['1'] }])).toBeNull()
    expect(parseGapChart({})).toBeNull()
  })
})

describe('parseVietcapDirectory', () => {
  it('keeps STOCK/ETF on HSX, HNX and UPCOM with VI and EN names', () => {
    const list = parseVietcapDirectory(fixture('vietcap/getAll.json'))!
    const symbols = list.map((e) => e.symbol)
    expect(symbols).toEqual(expect.arrayContaining(['FPT', 'VCB', 'SHS', 'ACV', 'FUEVFVND']))
    expect(symbols).not.toContain('XDC') // DELISTED
    expect(symbols).not.toContain('CVRE2614') // CW
    expect(symbols).not.toContain('VN30F2512') // FU
    expect(symbols).not.toContain('FUCVREIT') // UNIT_TRUST
    expect(new Set(list.map((e) => e.board))).toEqual(new Set(['HSX', 'HNX', 'UPCOM']))
    expect(list.find((e) => e.symbol === 'FPT')).toEqual({
      symbol: 'FPT',
      kind: 'stock',
      board: 'HSX',
      nameVi: 'FPT Corp',
      nameEn: 'FPT Corporation' // enOrganShortName is null in getAll -> enOrganName
    })
    expect(list.find((e) => e.symbol === 'FUEVFVND')!.kind).toBe('etf')
    // enOrganShortName null -> enOrganName
    expect(list.find((e) => e.symbol === 'YEG')!.nameEn).toBe('Yeah1 Group Corporation')
  })
})

describe('VietcapProvider', () => {
  const live = fixture('vietcap/getList-live.json')
  const indices = fixture('vietcap/marketIndex-live.json')
  const chart = fixture('vietcap/gap-chart-FPT.json')

  function setup(route?: (url: string) => ReturnType<typeof ok>) {
    const net = fakeFetch(
      route ??
        ((url) => {
          if (url === VIETCAP_URLS.quotes) return ok(live)
          if (url === VIETCAP_URLS.indices) return ok(indices)
          if (url === VIETCAP_URLS.chart) return ok(chart)
          return fail('http', 404)
        })
    )
    const p = createVietcapProvider(timerDeps(net.fetchJson))
    const quotes: Quote[] = []
    const series: Series[] = []
    const health: boolean[] = []
    p.on('quote', (q) => quotes.push(q))
    p.on('series', (s) => series.push(s))
    p.on('health', (h) => health.push(h.ok))
    return { p, net, quotes, series, health }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('batches stocks and indices into one POST each', async () => {
    vi.setSystemTime(IN_SESSION)
    const { p, net, quotes } = setup()
    p.setSubscriptions(['vn:FPT', 'vn:VCB', 'vn:VNINDEX', 'crypto:BTCUSDT'])
    await expect(p.pollOnce()).resolves.toBe(true)
    const posts = net.calls.filter((c) => c.url !== VIETCAP_URLS.chart)
    expect(posts.map((c) => [c.url, c.options.method, c.options.body, c.options.provider])).toEqual([
      [VIETCAP_URLS.quotes, 'POST', { symbols: ['FPT', 'VCB'] }, 'vietcap'],
      [VIETCAP_URLS.indices, 'POST', { symbols: ['VNINDEX'] }, 'vietcap']
    ])
    expect(quotes.length).toBeGreaterThan(0)
  })

  it('polls every 3 s in session and every 60 s outside', async () => {
    vi.setSystemTime(IN_SESSION)
    const a = setup()
    a.p.setSubscriptions(['vn:FPT'])
    a.p.start()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(a.net.calls.filter((c) => c.url === VIETCAP_URLS.quotes)).toHaveLength(4) // t=0,3,6,9
    a.p.stop()

    vi.setSystemTime(AFTER_CLOSE)
    const b = setup()
    b.p.setSubscriptions(['vn:FPT'])
    b.p.start()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(b.net.calls.filter((c) => c.url === VIETCAP_URLS.quotes)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(b.net.calls.filter((c) => c.url === VIETCAP_URLS.quotes)).toHaveLength(2)
    b.p.stop()
  })

  it('reports a failed cycle when either request fails or the schema mismatches', async () => {
    vi.setSystemTime(IN_SESSION)
    const { p, health } = setup((url) => (url === VIETCAP_URLS.indices ? ok({ nope: true }) : ok(live)))
    p.setSubscriptions(['vn:FPT', 'vn:VNINDEX'])
    p.start()
    await flushPromises()
    expect(health).toEqual([false])
    p.stop()
  })

  it('fetches gap-chart per symbol, staggered 250 ms, once out of session', async () => {
    vi.setSystemTime(AFTER_CLOSE)
    const { p, net, series } = setup()
    p.setSubscriptions(['vn:FPT', 'vn:VCB', 'vn:VNINDEX'])
    p.start()
    const charts = () => net.calls.filter((c) => c.url === VIETCAP_URLS.chart)
    await vi.advanceTimersByTimeAsync(0)
    expect(charts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(charts()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(250)
    expect(charts()).toHaveLength(3)
    expect(charts().map((c) => (c.options.body as { symbols: string[] }).symbols)).toEqual([['FPT'], ['VCB'], ['VNINDEX']])
    expect(charts()[0]!.options.body).toMatchObject({ timeFrame: 'ONE_MINUTE', countBack: 300 })
    expect(series.length).toBeGreaterThan(0)
    expect(series.every((s) => s.points.length <= 120)).toBe(true)
    // Out of session: no further chart fetches.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(charts()).toHaveLength(3)
    p.stop()
  })

  it('refreshes charts every 60 s in session', async () => {
    vi.setSystemTime(IN_SESSION)
    const { p, net } = setup()
    p.setSubscriptions(['vn:FPT'])
    p.start()
    const charts = () => net.calls.filter((c) => c.url === VIETCAP_URLS.chart)
    await vi.advanceTimersByTimeAsync(0)
    expect(charts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_001)
    expect(charts()).toHaveLength(2)
    p.stop()
  })
})
