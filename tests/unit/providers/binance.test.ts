import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backoffDelay,
  createBinanceProvider,
  parseExchangeInfo,
  parseKlines,
  parseMiniTicker,
  parseTicker24hr,
  streamUrl,
  type WebSocketLike
} from '../../../src/main/market/providers/binance'
import type { Quote, Series } from '../../../src/shared/types'
import { fail, fakeFetch, fixture, flushPromises, ok, timerDeps } from '../helpers'

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.onopen?.({})
  }
  message(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  drop(): void {
    this.onclose?.({})
  }
  static last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
  }
}

describe('parsers', () => {
  it('parseMiniTicker maps c -> price and o -> 24h open', () => {
    const q = parseMiniTicker(fixture('binance/miniTicker.json'))!
    expect(q).toMatchObject({
      id: 'crypto:BTCUSDT',
      price: 76069.01,
      refPrice: 80384,
      state: 'live',
      source: 'binance',
      updatedAt: 1793928605018
    })
    expect(q.change).toBeCloseTo(76069.01 - 80384, 6)
    expect(q.changePct).toBeCloseTo(((76069.01 - 80384) / 80384) * 100, 6)
  })

  it('parseMiniTicker rejects malformed, zero, negative and non-numeric prices', () => {
    const base = fixture('binance/miniTicker.json') as { stream: string; data: Record<string, unknown> }
    const withData = (patch: Record<string, unknown>) => ({ ...base, data: { ...base.data, ...patch } })
    expect(parseMiniTicker({ foo: 1 })).toBeNull()
    expect(parseMiniTicker(withData({ c: undefined }))).toBeNull()
    expect(parseMiniTicker(withData({ c: 'abc' }))).toBeNull()
    expect(parseMiniTicker(withData({ c: '0' }))).toBeNull()
    expect(parseMiniTicker(withData({ c: '-1' }))).toBeNull()
    expect(parseMiniTicker(withData({ o: '0' }))).toBeNull()
    expect(parseMiniTicker(withData({ c: 'Infinity' }))).toBeNull()
  })

  it('parseTicker24hr returns one quote per symbol', () => {
    const quotes = parseTicker24hr(fixture('binance/ticker24hr.json'))!
    expect(quotes.map((q) => q.id)).toEqual(['crypto:BTCUSDT', 'crypto:ETHUSDT'])
    expect(quotes[0]).toMatchObject({ price: 76061.04, refPrice: 80386.57, updatedAt: 1793928591002 })
    expect(quotes[0]!.changePct).toBeCloseTo(-5.381, 2) // matches Binance's priceChangePercent
    expect(parseTicker24hr({})).toBeNull()
  })

  it('parseKlines returns 96 closes in time order', () => {
    const k = parseKlines(fixture('binance/klines-BTCUSDT.json'))!
    expect(k.closes).toHaveLength(96)
    expect(k.closes[0]).toBe(80739.99)
    expect(k.firstOpen).toBe(80387.86)
    expect(parseKlines([])).toBeNull()
    expect(parseKlines([[1, 'x', '1', '1', 'nope']])).toBeNull()
  })

  it('parseExchangeInfo keeps TRADING USDT pairs only', () => {
    const list = parseExchangeInfo(fixture('binance/exchangeInfo.json'))!
    expect(list).toHaveLength(20)
    expect(list.every((s) => s.symbol.endsWith('USDT'))).toBe(true)
    expect(list.map((s) => s.symbol)).not.toContain('BCCUSDT') // status BREAK
    expect(list.find((s) => s.symbol === 'BTCUSDT')).toEqual({ symbol: 'BTCUSDT', base: 'BTC' })
  })

  it('streamUrl builds a combined miniTicker stream', () => {
    expect(streamUrl(['BTCUSDT', 'ETHUSDT'])).toBe(
      'wss://stream.binance.com:9443/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker'
    )
  })

  it('backoffDelay follows 1-2-4-8-16-30 s with ±20 % jitter', () => {
    const mid = () => 0.5
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((a) => backoffDelay(a, mid))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000
    ])
    expect(backoffDelay(0, () => 0)).toBe(800)
    expect(backoffDelay(5, () => 1)).toBe(36_000)
  })
})

describe('BinanceProvider', () => {
  const tickerFixture = fixture('binance/ticker24hr.json')
  const klinesFixture = fixture('binance/klines-BTCUSDT.json')

  function setup() {
    const net = fakeFetch((url) => {
      if (url.includes('/klines')) return ok(klinesFixture)
      if (url.includes('/ticker/24hr')) return ok(tickerFixture)
      return fail('http', 404)
    })
    const p = createBinanceProvider({ ...timerDeps(net.fetchJson), WebSocket: FakeWebSocket, random: () => 0.5 })
    const quotes: Quote[] = []
    const series: Series[] = []
    const health: boolean[] = []
    p.on('quote', (q) => quotes.push(q))
    p.on('series', (s) => series.push(s))
    p.on('health', (h) => health.push(h.ok))
    return { p, net, quotes, series, health }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
  })
  afterEach(() => vi.useRealTimers())

  it('opens one combined stream and emits quotes from messages', () => {
    const { p, quotes, health } = setup()
    p.setSubscriptions(['crypto:BTCUSDT', 'crypto:ETHUSDT', 'vn:FPT'])
    p.start()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.last().url).toBe(streamUrl(['BTCUSDT', 'ETHUSDT']))
    FakeWebSocket.last().open()
    expect(p.connected).toBe(true)
    expect(health).toEqual([true])
    FakeWebSocket.last().message(fixture('binance/miniTicker.json'))
    expect(quotes).toHaveLength(1)
    expect(quotes[0]!.price).toBe(76069.01)
  })

  it('reconnects with backoff 1, 2, 4 s after repeated drops and resets after a successful open', () => {
    const { p } = setup()
    p.setSubscriptions(['crypto:BTCUSDT'])
    p.start()
    FakeWebSocket.last().drop()
    vi.advanceTimersByTime(999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    FakeWebSocket.last().drop()
    vi.advanceTimersByTime(1999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(3)
    FakeWebSocket.last().drop()
    vi.advanceTimersByTime(4000)
    expect(FakeWebSocket.instances).toHaveLength(4)
    FakeWebSocket.last().open()
    FakeWebSocket.last().drop()
    vi.advanceTimersByTime(1000)
    expect(FakeWebSocket.instances).toHaveLength(5)
  })

  it('polls REST 24hr every 5 s once the socket has been down for 10 s, and stops when it is back', async () => {
    const { p, net, quotes } = setup()
    p.setSubscriptions(['crypto:BTCUSDT', 'crypto:ETHUSDT'])
    p.start()
    const restCalls = () => net.calls.filter((c) => c.url.includes('/ticker/24hr')).length
    // Keep every reconnect attempt failing.
    const keepFailing = setInterval(() => {
      const ws = FakeWebSocket.last()
      if (!ws.closed) ws.drop()
    }, 100)
    FakeWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(restCalls()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(restCalls()).toBe(1)
    expect(quotes.map((q) => q.id)).toEqual(['crypto:BTCUSDT', 'crypto:ETHUSDT'])
    expect(decodeURIComponent(net.calls.find((c) => c.url.includes('/ticker/24hr'))!.url)).toContain(
      'symbols=["BTCUSDT","ETHUSDT"]'
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(restCalls()).toBe(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(restCalls()).toBe(3)
    clearInterval(keepFailing)
    // Next reconnect attempt succeeds.
    await vi.advanceTimersByTimeAsync(30_000 * 1.2)
    FakeWebSocket.last().open()
    const after = restCalls()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(restCalls()).toBe(after)
    p.stop()
  })

  it('a drop is not a failed cycle; REST cycles report health while the socket is down', async () => {
    let restDown = true
    const net = fakeFetch((url) => {
      if (url.includes('/ticker/24hr')) return restDown ? fail('http', 403) : ok(fixture('binance/ticker24hr.json'))
      return fail('http', 404)
    })
    const p = createBinanceProvider({ ...timerDeps(net.fetchJson), WebSocket: FakeWebSocket, random: () => 0.5 })
    const health: boolean[] = []
    p.on('health', (h) => health.push(h.ok))
    p.setSubscriptions(['crypto:BTCUSDT'])
    p.start()
    const keepFailing = setInterval(() => {
      const ws = FakeWebSocket.last()
      if (!ws.closed) ws.drop()
    }, 100)
    FakeWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(health).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(health).toEqual([false])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(health).toEqual([false, false, false])
    restDown = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(health).toEqual([false, false, false, true])
    clearInterval(keepFailing)
    p.stop()
  })

  it('debounces subscription changes by 500 ms into one reconnect', () => {
    const { p } = setup()
    p.setSubscriptions(['crypto:BTCUSDT'])
    p.start()
    FakeWebSocket.last().open()
    p.setSubscriptions(['crypto:BTCUSDT', 'crypto:ETHUSDT'])
    vi.advanceTimersByTime(300)
    p.setSubscriptions(['crypto:BTCUSDT', 'crypto:ETHUSDT', 'crypto:SOLUSDT'])
    vi.advanceTimersByTime(499)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[0]!.closed).toBe(true)
    expect(FakeWebSocket.last().url).toBe(streamUrl(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']))
    // Same members in another order: no reconnect.
    p.setSubscriptions(['crypto:SOLUSDT', 'crypto:BTCUSDT', 'crypto:ETHUSDT'])
    vi.advanceTimersByTime(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('reconnects proactively after 23 h', () => {
    const { p } = setup()
    p.setSubscriptions(['crypto:BTCUSDT'])
    p.start()
    FakeWebSocket.last().open()
    vi.advanceTimersByTime(23 * 3600_000 - 1)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[0]!.closed).toBe(true)
  })

  it('fetches 15m x 96 klines on start and every 5 min; the live price replaces the last point', async () => {
    const { p, net, series } = setup()
    p.setSubscriptions(['crypto:BTCUSDT'])
    p.start()
    await flushPromises()
    const klines = () => net.calls.filter((c) => c.url.includes('/klines'))
    expect(klines()).toHaveLength(1)
    expect(klines()[0]!.url).toContain('symbol=BTCUSDT&interval=15m&limit=96')
    expect(series).toHaveLength(1)
    expect(series[0]!.points).toHaveLength(96)
    expect(series[0]!.refPrice).toBe(80387.86) // first candle open until a quote is known

    FakeWebSocket.last().open()
    FakeWebSocket.last().message(fixture('binance/miniTicker.json'))
    const updated = series[series.length - 1]!
    expect(updated.points).toHaveLength(96)
    expect(updated.points[95]).toBe(76069.01)
    expect(updated.refPrice).toBe(80384)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(klines()).toHaveLength(2)
    p.stop()
  })

  it('stop closes the socket and cancels timers', () => {
    const { p } = setup()
    p.setSubscriptions(['crypto:BTCUSDT'])
    p.start()
    FakeWebSocket.last().drop()
    p.stop()
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
