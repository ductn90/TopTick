import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchResult } from '../../../src/main/http'
import {
  CNBC_CHART_URL,
  CNBC_QUOTE_URL,
  cnbcQuoteUrl,
  cnbcSymbol,
  createCnbcProvider,
  parseCnbcChart,
  parseCnbcQuotes
} from '../../../src/main/market/providers/cnbc'
import type { Quote, Series } from '../../../src/shared/types'
import { fail, fakeFetch, fixture, ok, timerDeps } from '../helpers'

// Captured Monday 2026-11-09 14:39 ICT (US closed, Friday's data).
const SATURDAY = Date.UTC(2026, 10, 7, 15, 0)
const MONDAY_OPEN = Date.UTC(2026, 10, 9, 15, 0) // 10:00 EST
const MONDAY_NIGHT = Date.UTC(2026, 10, 10, 2, 0) // 21:00 EST, after the close
const bySymbol = new Map([
  ['AAPL', 'us:AAPL'],
  ['NVDA', 'us:NVDA'],
  ['.SPX', 'us:^GSPC'],
  ['.IXIC', 'us:^IXIC'],
  ['BRK.B', 'us:BRK-B'],
  ['ZZZZQ', 'us:ZZZZQ']
])

describe('cnbcSymbol', () => {
  it('maps indices and class shares; unmapped indices -> null', () => {
    expect(cnbcSymbol('AAPL')).toBe('AAPL')
    expect(cnbcSymbol('BRK-B')).toBe('BRK.B')
    expect(cnbcSymbol('^GSPC')).toBe('.SPX')
    expect(cnbcSymbol('^IXIC')).toBe('.IXIC')
    expect(cnbcSymbol('^DJI')).toBe('.DJI')
    expect(cnbcSymbol('^NDX')).toBe('.NDX')
    expect(cnbcSymbol('^RUT')).toBeNull()
  })

  it('joins symbols with %7C', () => {
    expect(cnbcQuoteUrl(['AAPL', '.SPX'])).toMatch(new RegExp(`^${CNBC_QUOTE_URL}\\?symbols=AAPL%7C\\.SPX&requestMethod=itv&`))
  })
})

describe('parseCnbcQuotes', () => {
  it('derives the reference as last − change and keeps the internal ids', () => {
    const quotes = parseCnbcQuotes(fixture('cnbc/quote.json'), bySymbol, SATURDAY)!
    expect(quotes.map((q) => q.id)).toEqual(['us:AAPL', 'us:NVDA', 'us:^GSPC', 'us:^IXIC', 'us:BRK-B'])
    const aapl = quotes[0]!
    expect(aapl).toMatchObject({ price: 342.37, refPrice: 344.17, state: 'closed', source: 'cnbc', updatedAt: SATURDAY })
    expect(aapl.changePct).toBeCloseTo(-0.523, 3)
    expect(quotes.find((q) => q.id === 'us:^GSPC')).toMatchObject({ price: 7376.86, refPrice: 7353.73 })
    expect(quotes.find((q) => q.id === 'us:^IXIC')).toMatchObject({ price: 24_579.425, refPrice: 24_314.997 })
  })

  it('is live inside the scheduled regular session', () => {
    expect(parseCnbcQuotes(fixture('cnbc/quote.json'), bySymbol, MONDAY_OPEN)![0]!.state).toBe('live')
    expect(parseCnbcQuotes(fixture('cnbc/quote.json'), bySymbol, MONDAY_NIGHT)![0]!.state).toBe('closed')
  })

  it('reads UNCH as zero change, skips code 1 rows and rejects an invalid envelope', () => {
    const raw = { FormattedQuoteResult: { FormattedQuote: [{ symbol: 'AAPL', code: 0, last: '342.37', change: 'UNCH' }] } }
    expect(parseCnbcQuotes(raw, bySymbol, SATURDAY)![0]).toMatchObject({ price: 342.37, refPrice: 342.37, change: 0 })
    expect(parseCnbcQuotes({ FormattedQuoteResult: { FormattedQuote: [{ symbol: 'ZZZZQ', code: 1 }] } }, bySymbol, SATURDAY)).toEqual([])
    expect(parseCnbcQuotes({}, bySymbol, SATURDAY)).toBeNull()
    expect(parseCnbcQuotes('<html>', bySymbol, SATURDAY)).toBeNull()
  })
})

describe('parseCnbcChart', () => {
  it('keeps the latest regular session (09:30–16:00 ET), dropping pre/post-market', () => {
    const c = parseCnbcChart(fixture('cnbc/chart5d-AAPL.json'))!
    expect(c.points).toHaveLength(78) // 2026-11-06, 5-minute bars
    expect(c.points.at(-1)).toBe(341.95)
  })

  it('drops the stray Saturday bars on .SPX', () => {
    const c = parseCnbcChart(fixture('cnbc/chart5d-SPX.json'))!
    expect(c.points).toHaveLength(78)
    expect(c.points.at(-1)).toBe(7376.85)
  })

  it('drops the 16:00 bar of start-stamped symbols (post-market)', () => {
    const bar = (t: string, close: string) => ({ close, tradeTime: `20261106${t}`, tradeTimeinMills: 1 })
    const raw = { barData: { priceBars: [bar('092500', '1'), bar('093000', '2'), bar('155500', '3'), bar('160000', '4')] } }
    expect(parseCnbcChart(raw)!.points).toEqual([2, 3])
  })

  it('returns null for an unknown symbol', () => {
    expect(parseCnbcChart(fixture('cnbc/chart5d-unknown.json'))).toBeNull()
    expect(parseCnbcChart({ barData: { priceBars: [] } })).toBeNull()
  })
})

describe('CnbcProvider', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(route?: (url: string) => FetchResult | undefined) {
    const net = fakeFetch((url) => {
      const custom = route?.(url)
      if (custom) return custom
      if (url.startsWith(CNBC_QUOTE_URL)) return ok(fixture('cnbc/quote.json'))
      if (url === `${CNBC_CHART_URL}?symbol=AAPL`) return ok(fixture('cnbc/chart5d-AAPL.json'))
      if (url === `${CNBC_CHART_URL}?symbol=.SPX`) return ok(fixture('cnbc/chart5d-SPX.json'))
      if (url.startsWith(CNBC_CHART_URL)) return ok(fixture('cnbc/chart5d-unknown.json'))
      return fail('http', 404)
    })
    const p = createCnbcProvider(timerDeps(net.fetchJson))
    const quotes: Quote[] = []
    const series: Series[] = []
    const health: boolean[] = []
    p.on('quote', (q) => quotes.push(q))
    p.on('series', (s) => series.push(s))
    p.on('health', (h) => health.push(h.ok))
    return { p, net, quotes, series, health }
  }

  const quoteCalls = (net: ReturnType<typeof setup>['net']) => net.calls.filter((c) => c.url.startsWith(CNBC_QUOTE_URL))

  it('requests mapped symbols in one batch tagged cnbc and emits internal ids', async () => {
    vi.setSystemTime(SATURDAY)
    const { p, net, quotes, health } = setup()
    p.setSubscriptions(['us:AAPL', 'us:^GSPC', 'us:^RUT', 'vn:FPT'])
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(quoteCalls(net).map((c) => c.url)).toEqual([cnbcQuoteUrl(['AAPL', '.SPX'])])
    expect(net.calls.every((c) => c.options.provider === 'cnbc')).toBe(true)
    expect(quotes.map((q) => q.id)).toEqual(['us:AAPL', 'us:^GSPC'])
    expect(health).toEqual([true])
    p.stop()
  })

  it('splits more than 25 symbols into batches', async () => {
    vi.setSystemTime(SATURDAY)
    const { p, net } = setup()
    p.setSubscriptions(Array.from({ length: 30 }, (_, i) => `us:S${i}`))
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(quoteCalls(net)).toHaveLength(2)
    expect(decodeURIComponent(quoteCalls(net)[1]!.url)).toContain('symbols=S25|S26|S27|S28|S29&')
    p.stop()
  })

  it.each([
    ['HTTP 401', fail('http', 401)],
    ['HTTP 403', fail('http', 403)],
    ['HTTP 429', fail('http', 429)],
    ['timeout', fail('timeout')],
    ['an invalid envelope', ok({ error: 'nope' })]
  ])('%s fails the cycle', async (_name, result) => {
    vi.setSystemTime(SATURDAY)
    const { p, health } = setup((url) => (url.startsWith(CNBC_QUOTE_URL) ? result : undefined))
    p.setSubscriptions(['us:AAPL'])
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(health).toEqual([false])
    p.stop()
  })

  it('polls every 10 s in the scheduled session and every 5 min outside', async () => {
    vi.setSystemTime(MONDAY_OPEN)
    const a = setup()
    a.p.setSubscriptions(['us:AAPL'])
    a.p.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(quoteCalls(a.net)).toHaveLength(2)
    a.p.stop()
    vi.setSystemTime(SATURDAY)
    const b = setup()
    b.p.setSubscriptions(['us:AAPL'])
    b.p.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    expect(quoteCalls(b.net)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(quoteCalls(b.net)).toHaveLength(2)
    b.p.stop()
  })

  it('fetches 5-day charts for mapped symbols; the live price replaces the last point', async () => {
    vi.setSystemTime(SATURDAY)
    const { p, net, series } = setup()
    p.setSubscriptions(['us:AAPL', 'us:^GSPC', 'us:^RUT'])
    p.start()
    await vi.advanceTimersByTimeAsync(1000)
    const charts = net.calls.filter((c) => c.url.startsWith(CNBC_CHART_URL)).map((c) => c.url)
    expect(charts).toEqual([`${CNBC_CHART_URL}?symbol=AAPL`, `${CNBC_CHART_URL}?symbol=.SPX`])
    const aapl = series.filter((s) => s.id === 'us:AAPL').at(-1)!
    expect(aapl.points).toHaveLength(78)
    expect(aapl.refPrice).toBe(344.17)
    // Next poll: the quote moves the last point to the quote price.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(series.filter((s) => s.id === 'us:AAPL').at(-1)!.points.at(-1)).toBe(342.37)
    // Out of session: charts are fetched once, not every 5 min.
    expect(net.calls.filter((c) => c.url.startsWith(CNBC_CHART_URL))).toHaveLength(2)
    p.stop()
  })
})
