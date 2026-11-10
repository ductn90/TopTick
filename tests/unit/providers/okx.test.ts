import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchResult } from '../../../src/main/http'
import {
  createOkxProvider,
  OKX_REST,
  OKX_WS,
  okxInstId,
  parseOkxCandles,
  parseOkxTickerMessage,
  parseOkxTickers,
  symbolFromInstId
} from '../../../src/main/market/providers/okx'
import type { Quote, Series } from '../../../src/shared/types'
import { fail, FakeSendingWebSocket, fakeFetch, fixture, flushPromises, ok, timerDeps } from '../helpers'

describe('symbol mapping', () => {
  it('maps internal USDT pairs to OKX instIds and back', () => {
    expect(okxInstId('BTCUSDT')).toBe('BTC-USDT')
    expect(okxInstId('1INCHUSDT')).toBe('1INCH-USDT')
    expect(okxInstId('USDT')).toBeNull()
    expect(okxInstId('BTCEUR')).toBeNull()
    expect(symbolFromInstId('BTC-USDT')).toBe('BTCUSDT')
    expect(symbolFromInstId('BOME-USDC')).toBeNull()
  })
})

describe('parsers', () => {
  it('parseOkxTickerMessage maps last -> price, open24h -> reference, ts -> updatedAt', () => {
    const [q] = parseOkxTickerMessage(fixture('okx/ticker-ws.json'))
    expect(q).toMatchObject({
      id: 'crypto:BTCUSDT',
      price: 74051.3,
      refPrice: 75874.6,
      state: 'live',
      source: 'okx',
      updatedAt: 1_794_209_619_974
    })
    expect(q!.changePct).toBeCloseTo(((74051.3 - 75874.6) / 75874.6) * 100, 6)
  })

  it('parseOkxTickerMessage ignores events and malformed rows', () => {
    expect(parseOkxTickerMessage(fixture('okx/ws-subscribe-error.json'))).toEqual([])
    expect(parseOkxTickerMessage(fixture('okx/ws-subscribe-ok.json'))).toEqual([])
    const msg = fixture('okx/ticker-ws.json') as { arg: unknown; data: Record<string, unknown>[] }
    expect(parseOkxTickerMessage({ ...msg, data: [{ ...msg.data[0], last: '0' }] })).toEqual([])
    expect(parseOkxTickerMessage({ ...msg, data: [{ ...msg.data[0], last: 'abc' }] })).toEqual([])
  })

  it('parseOkxTickers keeps the wanted USDT pairs only', () => {
    const quotes = parseOkxTickers(fixture('okx/tickers-spot.json'), new Set(['BTCUSDT', 'ETHUSDT', 'DOGEUSDT']))!
    expect(quotes.map((q) => q.id)).toEqual(['crypto:BTCUSDT', 'crypto:ETHUSDT'])
    expect(quotes[0]).toMatchObject({ price: 73960.8, refPrice: 75844.4, source: 'okx' })
    expect(parseOkxTickers({ code: '51001', data: [], msg: 'x' }, new Set(['BTCUSDT']))).toBeNull()
    expect(parseOkxTickers({}, new Set(['BTCUSDT']))).toBeNull()
  })

  it('parseOkxCandles sorts newest-first rows into time order', () => {
    const k = parseOkxCandles(fixture('okx/candles-BTC.json'))!
    expect(k.closes).toHaveLength(96)
    expect(k.closes.at(-1)).toBe(73963.9)
    expect(k.closes[0]).toBe(75988.7)
    expect(k.firstOpen).toBe(75925.7)
    expect(k.lastTime).toBe(1_794_209_400_000)
    expect(parseOkxCandles(fixture('okx/candles-unknown.json'))).toBeNull()
    expect(parseOkxCandles({ code: '0', data: [] })).toBeNull()
  })
})

describe('OkxProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSendingWebSocket.instances = []
  })
  afterEach(() => vi.useRealTimers())

  function setup(rest: () => FetchResult = () => ok(fixture('okx/tickers-spot.json'))) {
    const net = fakeFetch((url) => {
      if (url.includes('/market/candles?instId=BTC-USDT')) return ok(fixture('okx/candles-BTC.json'))
      if (url.includes('/market/candles')) return ok(fixture('okx/candles-unknown.json'))
      if (url === `${OKX_REST}/market/tickers?instType=SPOT`) return rest()
      return fail('http', 404)
    })
    const p = createOkxProvider({ ...timerDeps(net.fetchJson), WebSocket: FakeSendingWebSocket, random: () => 0.5 })
    const quotes: Quote[] = []
    const series: Series[] = []
    const health: boolean[] = []
    p.on('quote', (q) => quotes.push(q))
    p.on('series', (s) => series.push(s))
    p.on('health', (h) => health.push(h.ok))
    return { p, net, quotes, series, health }
  }

  it('subscribes to tickers for every mapped pair on open and emits quotes', () => {
    const { p, quotes, health } = setup()
    p.setSubscriptions(['crypto:BTCUSDT', 'crypto:ETHUSDT', 'vn:FPT'])
    p.start()
    const ws = FakeSendingWebSocket.last()
    expect(ws.url).toBe(OKX_WS)
    ws.open()
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      op: 'subscribe',
      args: [
        { channel: 'tickers', instId: 'BTC-USDT' },
        { channel: 'tickers', instId: 'ETH-USDT' }
      ]
    })
    expect(health).toEqual([true])
    ws.message(fixture('okx/ws-subscribe-ok.json'))
    ws.message(fixture('okx/ticker-ws.json'))
    expect(quotes.map((q) => [q.id, q.price, q.source])).toEqual([['crypto:BTCUSDT', 74051.3, 'okx']])
    p.stop()
  })

  it('keeps the socket after a subscribe error for an unlisted pair', () => {
    const { p, quotes } = setup()
    p.setSubscriptions(['crypto:BTCUSDT', 'crypto:ZZZUSDT'])
    p.start()
    const ws = FakeSendingWebSocket.last()
    ws.open()
    ws.message(fixture('okx/ws-subscribe-error.json'))
    ws.message('pong')
    ws.message(fixture('okx/ticker-ws.json'))
    expect(ws.closed).toBe(false)
    expect(FakeSendingWebSocket.instances).toHaveLength(1)
    expect(quotes.map((q) => q.id)).toEqual(['crypto:BTCUSDT'])
    p.stop()
  })

  it('sends a text ping every 25 s while open', () => {
    const { p } = setup()
    p.setSubscriptions(['crypto:BTCUSDT'])
    p.start()
    const ws = FakeSendingWebSocket.last()
    ws.open()
    vi.advanceTimersByTime(24_999)
    expect(ws.sent.filter((m) => m === 'ping')).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(ws.sent.filter((m) => m === 'ping')).toHaveLength(1)
    vi.advanceTimersByTime(25_000)
    expect(ws.sent.filter((m) => m === 'ping')).toHaveLength(2)
    p.stop()
  })

  it('polls REST tickers 10 s after a drop and reports health from those cycles', async () => {
    const { p, net, quotes, health } = setup()
    p.setSubscriptions(['crypto:BTCUSDT'])
    p.start()
    const keepFailing = setInterval(() => {
      const ws = FakeSendingWebSocket.last()
      if (!ws.closed) ws.drop()
    }, 100)
    FakeSendingWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(health).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(health).toEqual([true])
    expect(net.calls.filter((c) => c.url.includes('/market/tickers')).every((c) => c.options.provider === 'okx')).toBe(true)
    expect(quotes.at(-1)).toMatchObject({ id: 'crypto:BTCUSDT', price: 73960.8, source: 'okx' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(health).toEqual([true, true])
    clearInterval(keepFailing)
    p.stop()
  })

  it.each([
    ['HTTP 401', fail('http', 401)],
    ['HTTP 403', fail('http', 403)],
    ['HTTP 429', fail('http', 429)],
    ['timeout', fail('timeout')],
    ['code != 0', ok({ code: '50011', data: [], msg: 'Too Many Requests' })]
  ])('a REST cycle with %s reports health false', async (_name, result) => {
    const { p, health } = setup(() => result)
    p.setSubscriptions(['crypto:BTCUSDT'])
    p.start()
    FakeSendingWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(health).toEqual([false])
    p.stop()
  })

  it('fetches 15m x 96 candles on start; the live price replaces the last point', async () => {
    const { p, net, series } = setup()
    p.setSubscriptions(['crypto:BTCUSDT', 'crypto:ZZZUSDT'])
    p.start()
    await flushPromises()
    const candles = () => net.calls.filter((c) => c.url.includes('/market/candles'))
    expect(candles().map((c) => c.url)).toEqual([
      `${OKX_REST}/market/candles?instId=BTC-USDT&bar=15m&limit=96`,
      `${OKX_REST}/market/candles?instId=ZZZ-USDT&bar=15m&limit=96`
    ])
    expect(series.map((s) => s.id)).toEqual(['crypto:BTCUSDT']) // unknown pair: no series
    expect(series[0]!.points).toHaveLength(96)
    FakeSendingWebSocket.last().open()
    FakeSendingWebSocket.last().message(fixture('okx/ticker-ws.json'))
    const updated = series.at(-1)!
    expect(updated.points).toHaveLength(96)
    expect(updated.points[95]).toBe(74051.3)
    expect(updated.refPrice).toBe(75874.6)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(candles()).toHaveLength(4)
    p.stop()
  })

  it('stop closes the socket and cancels every timer', async () => {
    const { p, net } = setup()
    p.setSubscriptions(['crypto:BTCUSDT'])
    p.start()
    const ws = FakeSendingWebSocket.last()
    ws.open()
    p.stop()
    expect(ws.closed).toBe(true)
    const calls = net.calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(FakeSendingWebSocket.instances).toHaveLength(1)
    expect(ws.sent.filter((m) => m === 'ping')).toHaveLength(0)
    expect(net.calls).toHaveLength(calls)
  })
})
