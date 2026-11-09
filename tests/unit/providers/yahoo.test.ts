import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createYahooProvider,
  parseYahooChart,
  parseYahooSearch,
  YAHOO_CHART_URL
} from '../../../src/main/market/providers/yahoo'
import type { FetchResult } from '../../../src/main/http'
import type { Quote } from '../../../src/shared/types'
import { fail, fakeFetch, fixture, ok, timerDeps } from '../helpers'

type Chart = {
  chart: {
    result: {
      meta: { currentTradingPeriod: { regular: { start: number; end: number } } } & Record<string, unknown>
      indicators: { quote: { close: (number | null)[] }[] }
    }[]
  }
}

const aapl = fixture('yahoo/chart-AAPL.json') as Chart
const regular = aapl.chart.result[0]!.meta.currentTradingPeriod.regular
const IN_SESSION = (regular.start + 3600) * 1000
const OUT_OF_SESSION = (regular.end + 3600) * 1000

describe('parseYahooChart', () => {
  it('maps meta prices, previous close and the regular period', () => {
    const c = parseYahooChart(aapl, OUT_OF_SESSION)!
    expect(c.quote).toMatchObject({
      id: 'us:AAPL',
      price: 344.17,
      refPrice: 349.51,
      state: 'closed',
      source: 'yahoo',
      updatedAt: 1793912401 * 1000
    })
    expect(c.quote.changePct).toBeCloseTo(-1.528, 2)
    expect(c.period).toEqual({ start: regular.start, end: regular.end })
    expect(c.series).toMatchObject({ id: 'us:AAPL', refPrice: 349.51 })
    expect(c.series.points).toHaveLength(79)
    expect(parseYahooChart(aapl, IN_SESSION)!.quote.state).toBe('live')
  })

  it('parses an index (^GSPC)', () => {
    const c = parseYahooChart(fixture('yahoo/chart-GSPC.json'), OUT_OF_SESSION)!
    expect(c.quote).toMatchObject({ id: 'us:^GSPC', price: 7353.73, refPrice: 7688.62 })
  })

  it('drops null closes', () => {
    const copy = structuredClone(aapl)
    const close = copy.chart.result[0]!.indicators.quote[0]!.close
    close[3] = null
    close[10] = null
    expect(parseYahooChart(copy, OUT_OF_SESSION)!.series.points).toHaveLength(77)
  })

  it('rejects error payloads and invalid prices', () => {
    expect(parseYahooChart({ chart: { result: null, error: { code: 'Not Found' } } }, 0)).toBeNull()
    const bad = structuredClone(aapl)
    bad.chart.result[0]!.meta.regularMarketPrice = 0
    expect(parseYahooChart(bad, 0)).toBeNull()
    bad.chart.result[0]!.meta.regularMarketPrice = -3
    expect(parseYahooChart(bad, 0)).toBeNull()
  })
})

describe('parseYahooSearch', () => {
  it('keeps US EQUITY/ETF/INDEX results', () => {
    const list = parseYahooSearch(fixture('yahoo/search-NVDA.json'))!
    const symbols = list.map((i) => i.symbol)
    expect(symbols[0]).toBe('NVDA')
    expect(symbols).not.toContain('NVDA.TO') // Toronto
    expect(list[0]).toEqual({
      id: 'us:NVDA',
      market: 'us',
      kind: 'stock',
      symbol: 'NVDA',
      displaySymbol: 'NVDA',
      nameEn: 'NVIDIA Corporation',
      nameVi: 'NVIDIA Corporation'
    })
    expect(list.find((i) => i.symbol === 'NVDL')!.kind).toBe('etf')
  })

  it('maps indices and display names', () => {
    const list = parseYahooSearch({
      quotes: [
        { symbol: '^GSPC', quoteType: 'INDEX', exchange: 'SNP', shortname: 'S&P 500' },
        { symbol: 'BTC-USD', quoteType: 'CRYPTOCURRENCY', exchange: 'CCC' }
      ]
    })!
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'us:^GSPC', kind: 'index', displaySymbol: 'S&P 500' })
  })
})

describe('YahooProvider', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(route: (url: string) => FetchResult) {
    const net = fakeFetch(route)
    const p = createYahooProvider(timerDeps(net.fetchJson))
    const quotes: Quote[] = []
    p.on('quote', (q) => quotes.push(q))
    return { p, net, quotes }
  }

  const gspc = fixture('yahoo/chart-GSPC.json')
  const route = (url: string): FetchResult =>
    url.startsWith(`${YAHOO_CHART_URL}/AAPL?`) ? ok(aapl) : url.startsWith(`${YAHOO_CHART_URL}/%5EGSPC?`) ? ok(gspc) : fail('http', 404)

  it('requests range=1d interval=5m per symbol, staggered', async () => {
    vi.setSystemTime(IN_SESSION)
    const { p, net, quotes } = setup(route)
    p.setSubscriptions(['us:AAPL', 'us:^GSPC', 'vn:FPT'])
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(net.calls.map((c) => c.url)).toEqual([`${YAHOO_CHART_URL}/AAPL?range=1d&interval=5m`])
    await vi.advanceTimersByTimeAsync(500)
    expect(net.calls.map((c) => c.url)[1]).toBe(`${YAHOO_CHART_URL}/%5EGSPC?range=1d&interval=5m`)
    expect(quotes.map((q) => q.id)).toEqual(['us:AAPL', 'us:^GSPC'])
    p.stop()
  })

  it('polls every 10 s in session and every 5 min outside', async () => {
    vi.setSystemTime(IN_SESSION)
    const a = setup(route)
    a.p.setSubscriptions(['us:AAPL'])
    a.p.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(a.net.calls).toHaveLength(4) // 0, 10, 20, 30 s
    a.p.stop()

    vi.setSystemTime(OUT_OF_SESSION)
    const b = setup(route)
    b.p.setSubscriptions(['us:AAPL'])
    b.p.start()
    await vi.advanceTimersByTimeAsync(299_000)
    expect(b.net.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(b.net.calls).toHaveLength(2)
    b.p.stop()
  })

  it('backs off x2 per 429 up to 120 s, then resets on success', async () => {
    vi.setSystemTime(IN_SESSION)
    let status = 429
    const { p, net } = setup((url) => (status === 200 ? route(url) : fail('http', status)))
    p.setSubscriptions(['us:AAPL'])
    p.start()
    const times: number[] = []
    const t0 = Date.now()
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersToNextTimerAsync()
      times.push(Date.now() - t0)
    }
    // Attempt at 0, then delays 20, 40, 80, 120, 120 s.
    expect(net.calls).toHaveLength(6)
    expect(times.slice(1).map((t, i) => t - times[i]!)).toEqual([20_000, 40_000, 80_000, 120_000, 120_000])
    expect(p.backoffMs).toBe(120_000)
    status = 200
    await vi.advanceTimersToNextTimerAsync()
    expect(p.backoffMs).toBe(0)
    const before = net.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(net.calls.length).toBe(before + 1)
    p.stop()
  })

  it('treats 401 and 403 like 429 but retries other failures at the normal cadence', async () => {
    vi.setSystemTime(IN_SESSION)
    for (const status of [401, 403]) {
      const { p } = setup(() => fail('http', status))
      p.setSubscriptions(['us:AAPL'])
      p.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(p.backoffMs).toBe(20_000)
      p.stop()
    }
    const { p, net } = setup(() => fail('http', 500))
    p.setSubscriptions(['us:AAPL'])
    p.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(p.backoffMs).toBe(0)
    expect(net.calls).toHaveLength(3)
    p.stop()
  })

  it('inSession uses the period of the last response', async () => {
    vi.setSystemTime(IN_SESSION)
    const { p } = setup(route)
    expect(p.inSession!('us:AAPL', IN_SESSION)).toBe(false) // unknown yet
    p.setSubscriptions(['us:AAPL'])
    await p.pollOnce()
    expect(p.inSession!('us:AAPL', IN_SESSION)).toBe(true)
    expect(p.inSession!('us:AAPL', OUT_OF_SESSION)).toBe(false)
  })
})
