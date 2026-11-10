import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchResult } from '../../../src/main/http'
import {
  createSsiProvider,
  parseSsiChart,
  parseSsiIndices,
  parseSsiStocks,
  SSI_URLS
} from '../../../src/main/market/providers/ssi'
import type { Quote, Series } from '../../../src/shared/types'
import { fail, fakeFetch, fixture, ict, ok, timerDeps } from '../helpers'

// Fixtures were captured on Monday 2026-11-09 around 14:30 ICT, in session.
const IN_SESSION = ict(2026, 11, 9, 10, 0)
const AFTER_CLOSE = ict(2026, 11, 9, 16, 0)
const stocks = fixture('ssi/stock-multiple.json') as { code: string; data: Record<string, unknown>[] }

describe('parseSsiStocks', () => {
  it('reads VND prices with ceiling and floor; updatedAt is the fetch time', () => {
    const quotes = parseSsiStocks(stocks, IN_SESSION)!
    expect(quotes.map((q) => q.id)).toEqual(['vn:ACV', 'vn:E1VFVN30', 'vn:FPT', 'vn:SHS', 'vn:VNM'])
    expect(quotes.find((q) => q.id === 'vn:FPT')).toMatchObject({
      price: 50_900,
      refPrice: 50_800,
      change: 100,
      ceiling: 54_300,
      floor: 47_250,
      state: 'live',
      source: 'ssi',
      updatedAt: IN_SESSION
    })
    expect(quotes.find((q) => q.id === 'vn:E1VFVN30')).toMatchObject({ price: 33_150, refPrice: 33_470 })
    expect(parseSsiStocks(stocks, AFTER_CLOSE)![0]!.state).toBe('closed')
  })

  it('returns no quote for unknown symbols', () => {
    expect(parseSsiStocks(fixture('ssi/stock-unknown.json'), IN_SESSION)).toEqual([])
  })

  it('applies the pre-open rule when matchedPrice is 0 or missing', () => {
    const rows = stocks.data.map((r) => (r.stockSymbol === 'FPT' ? { ...r, matchedPrice: 0 } : r))
    const fpt = parseSsiStocks({ ...stocks, data: rows }, IN_SESSION)!.find((q) => q.id === 'vn:FPT')
    expect(fpt).toMatchObject({ price: 50_800, refPrice: 50_800, change: 0, state: 'preopen' })
    const none = stocks.data.map((r) => (r.stockSymbol === 'FPT' ? { ...r, matchedPrice: null } : r))
    expect(parseSsiStocks({ ...stocks, data: none }, IN_SESSION)!.find((q) => q.id === 'vn:FPT')!.state).toBe('preopen')
  })

  it('rejects an invalid envelope and skips invalid rows only', () => {
    expect(parseSsiStocks({ ...stocks, code: 'FAILED' }, IN_SESSION)).toBeNull()
    expect(parseSsiStocks({ code: 'SUCCESS' }, IN_SESSION)).toBeNull()
    expect(parseSsiStocks([], IN_SESSION)).toBeNull()
    const rows = stocks.data.map((r) => (r.stockSymbol === 'VNM' ? { ...r, refPrice: 'x' } : r))
    expect(parseSsiStocks({ ...stocks, data: rows }, IN_SESSION)!.map((q) => q.id)).not.toContain('vn:VNM')
  })
})

describe('parseSsiIndices', () => {
  it('uses prevIndexValue as reference and keeps the internal ids', () => {
    const quotes = parseSsiIndices(fixture('ssi/index-multiple.json'), IN_SESSION)!
    expect(quotes.map((q) => q.id).sort()).toEqual(['vn:HNX30', 'vn:HNXIndex', 'vn:HNXUpcomIndex', 'vn:VN30', 'vn:VNINDEX'])
    expect(quotes.find((q) => q.id === 'vn:VNINDEX')).toMatchObject({
      price: 1715.41,
      refPrice: 1725.36,
      source: 'ssi',
      updatedAt: 1_794_209_445_080
    })
    expect(quotes.find((q) => q.id === 'vn:HNXIndex')).toMatchObject({ price: 254.39, refPrice: 256.73 })
    expect(parseSsiIndices({ code: 'ERROR', data: [] }, IN_SESSION)).toBeNull()
  })
})

describe('parseSsiChart', () => {
  it('stock closes x1000, latest ICT day only, in time order', () => {
    const c = parseSsiChart(fixture('ssi/chart-FPT.json'), 1000)!
    expect(c.points).toHaveLength(225) // 2026-11-09 09:15–14:29 1-minute bars
    expect(c.points[0]).toBe(51_200)
    expect(c.points.at(-1)).toBe(50_900)
    expect(c.lastTime).toBe(1_794_209_340_000)
  })

  it('index closes are not scaled', () => {
    expect(parseSsiChart(fixture('ssi/chart-VNINDEX.json'), 1)!.points.at(-1)).toBe(1712.15)
    expect(parseSsiChart(fixture('ssi/chart-HNXINDEX.json'), 1)!.points.at(-1)).toBe(255.03)
    expect(parseSsiChart(fixture('ssi/chart-HNXUPCOMINDEX.json'), 1)!.points.at(-1)).toBe(121.22)
  })

  it('the mixed-case HNXIndex chart is divided by 1000 (why the provider asks for HNXINDEX)', () => {
    const c = parseSsiChart(fixture('ssi/chart-HNXIndex-thousandths.json'), 1)!
    expect(Math.max(...c.points)).toBeLessThan(1)
  })

  it('rejects invalid payloads', () => {
    expect(parseSsiChart({ code: 'SUCCESS', data: { t: [], c: [] } }, 1)).toBeNull()
    expect(parseSsiChart({ code: 'SUCCESS', data: { t: [1, 2], c: [1] } }, 1)).toBeNull()
    expect(parseSsiChart({ code: 'FAILED', data: { t: [1], c: [1] } }, 1)).toBeNull()
    expect(parseSsiChart({}, 1)).toBeNull()
  })
})

describe('SsiProvider', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(route?: (url: string) => FetchResult | undefined) {
    const net = fakeFetch((url) => {
      const custom = route?.(url)
      if (custom) return custom
      if (url === SSI_URLS.stocks) return ok(stocks)
      if (url === SSI_URLS.indices) return ok(fixture('ssi/index-multiple.json'))
      if (url.includes('symbol=FPT&')) return ok(fixture('ssi/chart-FPT.json'))
      if (url.includes('symbol=VNINDEX&')) return ok(fixture('ssi/chart-VNINDEX.json'))
      if (url.includes('symbol=HNXINDEX&')) return ok(fixture('ssi/chart-HNXINDEX.json'))
      return fail('http', 404)
    })
    const p = createSsiProvider(timerDeps(net.fetchJson))
    const quotes: Quote[] = []
    const series: Series[] = []
    const health: boolean[] = []
    p.on('quote', (q) => quotes.push(q))
    p.on('series', (s) => series.push(s))
    p.on('health', (h) => health.push(h.ok))
    return { p, net, quotes, series, health }
  }

  it('posts stocks and indices in one call each, tagged ssi, and emits the subscribed ids only', async () => {
    vi.setSystemTime(IN_SESSION)
    const { p, net, quotes, health } = setup()
    p.setSubscriptions(['vn:FPT', 'vn:VNINDEX', 'vn:HNXIndex', 'vn:ZZZZ', 'us:AAPL'])
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    const posts = net.calls.filter((c) => c.options.method === 'POST')
    expect(posts.map((c) => [c.url, c.options.body])).toEqual([
      [SSI_URLS.stocks, { stocks: ['FPT', 'ZZZZ'] }],
      [SSI_URLS.indices, { indexIds: ['VNINDEX', 'HNXIndex'] }]
    ])
    expect(net.calls.every((c) => c.options.provider === 'ssi')).toBe(true)
    expect(quotes.map((q) => q.id).sort()).toEqual(['vn:FPT', 'vn:HNXIndex', 'vn:VNINDEX'])
    expect(health).toEqual([true]) // the unknown symbol does not fail the cycle
    p.stop()
  })

  it.each([
    ['HTTP 403', fail('http', 403)],
    ['HTTP 429', fail('http', 429)],
    ['timeout', fail('timeout')],
    ['schema-invalid data', ok({ code: 'FAILED', message: 'x' })]
  ])('%s fails the cycle', async (_name, result) => {
    vi.setSystemTime(IN_SESSION)
    const { p, health } = setup((url) => (url === SSI_URLS.stocks ? result : undefined))
    p.setSubscriptions(['vn:FPT', 'vn:VNINDEX'])
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(health).toEqual([false])
    p.stop()
  })

  it('polls every 5 s in session and every 60 s outside', async () => {
    vi.setSystemTime(IN_SESSION)
    const a = setup()
    a.p.setSubscriptions(['vn:FPT'])
    a.p.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(a.health).toHaveLength(2)
    a.p.stop()
    vi.setSystemTime(AFTER_CLOSE)
    const b = setup()
    b.p.setSubscriptions(['vn:FPT'])
    b.p.start()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(b.health).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(b.health).toHaveLength(2)
    b.p.stop()
  })

  it('fetches 1-minute charts for stocks (x1000) and indices (upper-case HNX names)', async () => {
    vi.setSystemTime(IN_SESSION)
    const { p, net, series } = setup()
    p.setSubscriptions(['vn:FPT', 'vn:HNXIndex'])
    p.start()
    await vi.advanceTimersByTimeAsync(1000)
    const charts = net.calls.filter((c) => c.url.startsWith(SSI_URLS.chart))
    const to = Math.floor(IN_SESSION / 1000)
    expect(charts.map((c) => c.url)).toEqual([
      `${SSI_URLS.chart}?resolution=1&symbol=FPT&from=${to - 4 * 86_400}&to=${to}`,
      `${SSI_URLS.chart}?resolution=1&symbol=HNXINDEX&from=${to - 4 * 86_400}&to=${to}`
    ])
    const fpt = series.filter((s) => s.id === 'vn:FPT').at(-1)!
    expect(fpt.points.at(-1)).toBe(50_900)
    expect(Math.min(...fpt.points)).toBeGreaterThan(40_000)
    const hnx = series.filter((s) => s.id === 'vn:HNXIndex').at(-1)!
    expect(Math.min(...hnx.points)).toBeGreaterThan(200)
    // Charts refresh every 60 s in session.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(net.calls.filter((c) => c.url.startsWith(SSI_URLS.chart))).toHaveLength(4)
    p.stop()
  })
})
