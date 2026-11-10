import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFailoverSource, PROBE_INTERVAL_MS } from '../../src/main/market/failover'
import { createMarketHub } from '../../src/main/market/hub'
import { createBinanceProvider } from '../../src/main/market/providers/binance'
import { createCafefProvider } from '../../src/main/market/providers/cafef'
import { CNBC_QUOTE_URL, createCnbcProvider } from '../../src/main/market/providers/cnbc'
import { createOkxProvider, OKX_REST } from '../../src/main/market/providers/okx'
import { Emitter, realTimers, type PollingProvider, type ProviderEvents } from '../../src/main/market/providers/types'
import { createSsiProvider, SSI_URLS } from '../../src/main/market/providers/ssi'
import { createVietcapProvider } from '../../src/main/market/providers/vietcap'
import { ForcedFailWebSocket } from '../../src/main/market/providers/ws'
import { createYahooProvider, YAHOO_CHART_URL } from '../../src/main/market/providers/yahoo'
import type { Quote, QuoteSource } from '../../src/shared/types'
import { fail, FakeSendingWebSocket, fakeFetch, fixture, ict, mockLogger, ok, timerDeps } from './helpers'

function fakeProvider(id: QuoteSource, inSession = true) {
  const events = new Emitter<ProviderEvents>()
  const p = {
    id,
    running: false,
    subs: [] as string[],
    probeResult: false,
    setSubscriptions: vi.fn((ids: string[]) => {
      p.subs = ids
    }),
    start: vi.fn(() => {
      p.running = true
    }),
    stop: vi.fn(() => {
      p.running = false
    }),
    pollOnce: vi.fn(async () => p.probeResult),
    on: events.on.bind(events),
    emit: events.emit.bind(events),
    inSession: vi.fn(() => inSession)
  }
  return p satisfies PollingProvider & Record<string, unknown>
}

const quote = (source: QuoteSource, id = 'vn:FPT'): Quote => ({
  id,
  price: 53_000,
  refPrice: 52_900,
  change: 100,
  changePct: 0.19,
  state: 'live',
  source,
  updatedAt: 1
})

describe('failover, VN chain of two (fake providers)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup() {
    const primary = fakeProvider('vietcap')
    const fallback = fakeProvider('cafef')
    const log = mockLogger()
    const vn = createFailoverSource({ market: 'vn', chain: [primary, fallback], log, timers: realTimers })
    const quotes: Quote[] = []
    vn.on('quote', (q) => quotes.push(q))
    vn.setSubscriptions(['vn:FPT', 'vn:VNINDEX'])
    vn.start()
    return { primary, fallback, log, vn, quotes }
  }

  it('stays on Vietcap after 2 failed cycles and switches to CafeF on the 3rd', () => {
    const { primary, fallback, log, vn } = setup()
    expect(primary.running).toBe(true)
    primary.emit('health', { ok: false })
    primary.emit('health', { ok: false })
    expect(vn.mode).toBe('primary')
    expect(fallback.start).not.toHaveBeenCalled()
    primary.emit('health', { ok: false })
    expect(vn.mode).toBe('fallback')
    expect(primary.running).toBe(false)
    expect(fallback.running).toBe(true)
    expect(fallback.subs).toEqual(['vn:FPT', 'vn:VNINDEX'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('switching to CafeF'))
  })

  it('a successful cycle resets the failure count', () => {
    const { primary, vn } = setup()
    primary.emit('health', { ok: false })
    primary.emit('health', { ok: false })
    primary.emit('health', { ok: true })
    primary.emit('health', { ok: false })
    primary.emit('health', { ok: false })
    expect(vn.mode).toBe('primary')
  })

  it('forwards CafeF quotes with source cafef only while in fallback', () => {
    const { primary, fallback, quotes } = setup()
    fallback.emit('quote', quote('cafef'))
    expect(quotes).toHaveLength(0)
    for (let i = 0; i < 3; i++) primary.emit('health', { ok: false })
    fallback.emit('quote', quote('cafef'))
    expect(quotes.map((q) => q.source)).toEqual(['cafef'])
  })

  it('probes Vietcap every 60 s and returns to primary on success, stopping CafeF', async () => {
    const { primary, fallback, log, vn, quotes } = setup()
    for (let i = 0; i < 3; i++) primary.emit('health', { ok: false })
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS - 1)
    expect(primary.pollOnce).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(primary.pollOnce).toHaveBeenCalledTimes(1)
    expect(vn.mode).toBe('fallback')
    primary.probeResult = true
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
    expect(primary.pollOnce).toHaveBeenCalledTimes(2)
    expect(vn.mode).toBe('primary')
    expect(fallback.running).toBe(false)
    expect(primary.running).toBe(true)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('switching back to Vietcap'))
    // CafeF output is ignored again; no more probes.
    fallback.emit('quote', quote('cafef'))
    expect(quotes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(5 * PROBE_INTERVAL_MS)
    expect(primary.pollOnce).toHaveBeenCalledTimes(2)
  })

  it('stop cancels probes', async () => {
    const { primary, vn } = setup()
    for (let i = 0; i < 3; i++) primary.emit('health', { ok: false })
    vn.stop()
    await vi.advanceTimersByTimeAsync(5 * PROBE_INTERVAL_MS)
    expect(primary.pollOnce).not.toHaveBeenCalled()
  })
})

describe('failover, VN (real providers, forced Vietcap failure)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('switches after 3 failed 3 s cycles in session and emits CafeF quotes', async () => {
    vi.setSystemTime(ict(2026, 11, 6, 10, 0))
    let vietcapDown = true
    const net = fakeFetch((url, opts) => {
      if (opts.provider === 'vietcap') {
        if (vietcapDown) return fail('network')
        return url.includes('marketIndex') ? ok(fixture('vietcap/marketIndex-live.json')) : ok(fixture('vietcap/getList-live.json'))
      }
      if (url.includes('center=')) return ok(fixture('cafef/board-center1.json'))
      if (url.includes('index=true')) return ok(fixture('cafef/index.json'))
      return fail('http', 404)
    })
    const deps = timerDeps(net.fetchJson)
    const vn = createFailoverSource({
      market: 'vn',
      chain: [createVietcapProvider(deps), createCafefProvider({ ...deps, boardOf: () => 1 })],
      log: deps.log,
      timers: realTimers
    })
    const quotes: Quote[] = []
    vn.on('quote', (q) => quotes.push(q))
    vn.setSubscriptions(['vn:FPT'])
    vn.start()
    await vi.advanceTimersByTimeAsync(5_999)
    expect(vn.mode).toBe('primary') // cycles at 0 and 3 s failed
    await vi.advanceTimersByTimeAsync(1)
    expect(vn.mode).toBe('fallback') // 3rd failure at 6 s
    await vi.advanceTimersByTimeAsync(0)
    expect(quotes.at(-1)).toMatchObject({ id: 'vn:FPT', source: 'cafef', price: 52_900 })

    vietcapDown = false
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
    expect(vn.mode).toBe('primary')
    expect(quotes.at(-1)!.source).toBe('vietcap')
    vn.stop()
  })
})

describe('failover, chains of any length (fake providers)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup3() {
    const a = fakeProvider('vietcap')
    const b = fakeProvider('cafef', false)
    const c = fakeProvider('ssi')
    const log = mockLogger()
    const src = createFailoverSource({ market: 'vn', chain: [a, b, c], log, timers: realTimers })
    const quotes: Quote[] = []
    src.on('quote', (q) => quotes.push(q))
    src.setSubscriptions(['vn:FPT'])
    src.start()
    return { a, b, c, log, src, quotes }
  }

  const failN = (p: ReturnType<typeof fakeProvider>, n: number): void => {
    for (let i = 0; i < n; i++) p.emit('health', { ok: false })
  }

  it('walks the chain: 3 failures move 0 -> 1, 3 more move 1 -> 2', () => {
    const { a, b, c, log, src } = setup3()
    failN(a, 3)
    expect(src.active).toBe('cafef')
    expect([a.running, b.running, c.running]).toEqual([false, true, false])
    failN(b, 2)
    expect(src.active).toBe('cafef')
    failN(b, 1)
    expect(src.active).toBe('ssi')
    expect([a.running, b.running, c.running]).toEqual([false, false, true])
    expect(c.subs).toEqual(['vn:FPT'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('vn: switching to SSI iBoard (3 consecutive failed CafeF cycles)'))
  })

  it('stays on the last provider when it fails too, without restarting anything', () => {
    const { a, b, c, src } = setup3()
    failN(a, 3)
    failN(b, 3)
    const starts = [a.start.mock.calls.length, b.start.mock.calls.length, c.start.mock.calls.length]
    failN(c, 10)
    expect(src.active).toBe('ssi')
    expect([a.start.mock.calls.length, b.start.mock.calls.length, c.start.mock.calls.length]).toEqual(starts)
    expect(c.stop).not.toHaveBeenCalled()
  })

  it('probes only the primary from the last provider and returns to it, stopping the backup', async () => {
    const { a, b, c, src, quotes } = setup3()
    failN(a, 3)
    failN(b, 3)
    a.probeResult = true
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
    expect(a.pollOnce).toHaveBeenCalledTimes(1)
    expect(b.pollOnce).not.toHaveBeenCalled()
    expect(c.pollOnce).not.toHaveBeenCalled()
    expect(src.active).toBe('vietcap')
    expect([a.running, b.running, c.running]).toEqual([true, false, false])
    c.emit('quote', quote('ssi'))
    expect(quotes).toHaveLength(0)
  })

  it('ignores health and quotes from inactive backups', () => {
    const { a, b, c, src, quotes } = setup3()
    failN(b, 5)
    failN(c, 5)
    expect(src.active).toBe('vietcap')
    b.emit('quote', quote('cafef'))
    c.emit('quote', quote('ssi'))
    expect(quotes).toHaveLength(0)
    failN(a, 3)
    failN(c, 3) // SSI is not active yet: ignored
    expect(src.active).toBe('cafef')
    b.emit('quote', quote('cafef'))
    c.emit('quote', quote('ssi'))
    expect(quotes.map((q) => q.source)).toEqual(['cafef'])
  })

  it('a healthy primary never starts a backup and is never probed', async () => {
    const { a, b, c } = setup3()
    for (let i = 0; i < 20; i++) a.emit('health', { ok: i % 3 !== 0 })
    await vi.advanceTimersByTimeAsync(10 * PROBE_INTERVAL_MS)
    expect(b.start).not.toHaveBeenCalled()
    expect(c.start).not.toHaveBeenCalled()
    expect(a.pollOnce).not.toHaveBeenCalled()
  })

  it('inSession follows the active provider', () => {
    const { a, src } = setup3()
    expect(src.inSession!('vn:FPT', 0)).toBe(true)
    failN(a, 3) // CafeF reports out of session
    expect(src.inSession!('vn:FPT', 0)).toBe(false)
  })

  it('a single-provider chain never switches', async () => {
    const only = fakeProvider('yahoo')
    const src = createFailoverSource({ market: 'us', chain: [only], log: mockLogger(), timers: realTimers })
    src.setSubscriptions(['us:AAPL'])
    src.start()
    failN(only, 10)
    await vi.advanceTimersByTimeAsync(5 * PROBE_INTERVAL_MS)
    expect(src.mode).toBe('primary')
    expect(only.running).toBe(true)
    expect(only.stop).not.toHaveBeenCalled()
    expect(only.pollOnce).not.toHaveBeenCalled()
  })

  it('the hub marks quotes stale when every source of the chain fails', () => {
    vi.setSystemTime(1_800_000_000_000)
    const a = fakeProvider('binance')
    const b = fakeProvider('okx')
    const crypto = createFailoverSource({ market: 'crypto', chain: [a, b], log: mockLogger(), timers: realTimers })
    const other = fakeProvider('yahoo')
    const hub = createMarketHub({ providers: { crypto, vn: other, us: other }, emit: () => {}, now: () => Date.now(), timers: realTimers })
    hub.setSubscriptions(['crypto:BTCUSDT'])
    hub.start()
    a.emit('quote', { ...quote('binance', 'crypto:BTCUSDT'), updatedAt: Date.now() })
    failN(a, 3)
    failN(b, 3)
    expect(crypto.active).toBe('okx')
    vi.advanceTimersByTime(15_000)
    expect(hub.snapshot().quotes['crypto:BTCUSDT']!.state).toBe('live')
    vi.advanceTimersByTime(1_000)
    expect(hub.snapshot().quotes['crypto:BTCUSDT']).toMatchObject({ state: 'stale', source: 'binance' })
    hub.stop()
  })
})

describe('failover, VN (real providers, Vietcap and CafeF forced down)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reaches SSI after 3 + 3 failed cycles with ceiling and floor, and returns to Vietcap on the probe', async () => {
    vi.setSystemTime(ict(2026, 11, 9, 10, 0))
    let vietcapDown = true
    const net = fakeFetch((url, opts) => {
      if (opts.provider === 'vietcap') {
        if (vietcapDown) return fail('network')
        return url.includes('marketIndex') ? ok(fixture('vietcap/marketIndex-live.json')) : ok(fixture('vietcap/getList-live.json'))
      }
      if (opts.provider === 'cafef') return fail('network')
      if (url === SSI_URLS.stocks) return ok(fixture('ssi/stock-multiple.json'))
      if (url === SSI_URLS.indices) return ok(fixture('ssi/index-multiple.json'))
      return fail('http', 404)
    })
    const deps = timerDeps(net.fetchJson)
    const vn = createFailoverSource({
      market: 'vn',
      chain: [createVietcapProvider(deps), createCafefProvider({ ...deps, boardOf: () => 1 }), createSsiProvider(deps)],
      log: deps.log,
      timers: realTimers
    })
    const quotes: Quote[] = []
    vn.on('quote', (q) => quotes.push(q))
    vn.setSubscriptions(['vn:FPT'])
    vn.start()
    await vi.advanceTimersByTimeAsync(6_000) // Vietcap cycles at 0, 3, 6 s
    expect(vn.active).toBe('cafef')
    await vi.advanceTimersByTimeAsync(19_999) // CafeF cycles at 6, 16 s
    expect(vn.active).toBe('cafef')
    await vi.advanceTimersByTimeAsync(1) // 3rd CafeF failure at 26 s
    expect(vn.active).toBe('ssi')
    await vi.advanceTimersByTimeAsync(0)
    expect(quotes.at(-1)).toMatchObject({ id: 'vn:FPT', source: 'ssi', price: 50_900, ceiling: 54_300, floor: 47_250 })
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('vn: switching to SSI iBoard'))
    vietcapDown = false
    await vi.advanceTimersByTimeAsync(6_000 + PROBE_INTERVAL_MS - 26_001) // first probe 60 s after leaving Vietcap (66 s)
    expect(vn.active).toBe('ssi')
    await vi.advanceTimersByTimeAsync(1)
    expect(vn.active).toBe('vietcap')
    expect(quotes.at(-1)!.source).toBe('vietcap')
    vn.stop()
  })
})

describe('failover, crypto (real Binance forced down, real OKX)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSendingWebSocket.instances = []
  })
  afterEach(() => vi.useRealTimers())

  it('switches to OKX after ~20 s of failed Binance REST cycles and back on the probe', async () => {
    let binanceDown = true
    const net = fakeFetch((url, opts) => {
      if (opts.provider === 'binance') {
        if (binanceDown) return fail('http', 403)
        return url.includes('/ticker/24hr') ? ok(fixture('binance/ticker24hr.json')) : ok(fixture('binance/klines-BTCUSDT.json'))
      }
      if (url.startsWith(`${OKX_REST}/market/candles`)) return ok(fixture('okx/candles-BTC.json'))
      if (url.startsWith(`${OKX_REST}/market/tickers`)) return ok(fixture('okx/tickers-spot.json'))
      return fail('http', 404)
    })
    const deps = timerDeps(net.fetchJson)
    // The forced socket fails until Binance "recovers"; after that a fake socket that never opens.
    const BinanceWs = class {
      constructor(url: string) {
        return binanceDown ? new ForcedFailWebSocket(url) : new FakeSendingWebSocket(url)
      }
    } as unknown as typeof ForcedFailWebSocket
    const crypto = createFailoverSource({
      market: 'crypto',
      chain: [
        createBinanceProvider({ ...deps, WebSocket: BinanceWs, random: () => 0.5 }),
        createOkxProvider({ ...deps, WebSocket: FakeSendingWebSocket, random: () => 0.5 })
      ],
      log: deps.log,
      timers: realTimers
    })
    const quotes: Quote[] = []
    crypto.on('quote', (q) => quotes.push(q))
    crypto.setSubscriptions(['crypto:BTCUSDT'])
    crypto.start()
    await vi.advanceTimersByTimeAsync(19_999) // REST cycles at 10 and 15 s failed
    expect(crypto.active).toBe('binance')
    expect(FakeSendingWebSocket.instances).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1) // 3rd failed REST cycle at 20 s
    expect(crypto.active).toBe('okx')
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('crypto: switching to OKX (3 consecutive failed Binance cycles)'))
    const okxWs = FakeSendingWebSocket.last()
    okxWs.open()
    okxWs.message(fixture('okx/ticker-ws.json'))
    expect(quotes.at(-1)).toMatchObject({ id: 'crypto:BTCUSDT', source: 'okx', price: 74051.3 })
    binanceDown = false
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
    expect(crypto.active).toBe('binance')
    expect(okxWs.closed).toBe(true)
    expect(quotes.at(-1)!.source).toBe('binance')
    crypto.stop()
  })

  it('stays on Binance when only the socket is blocked and REST works', async () => {
    const net = fakeFetch((url) =>
      url.includes('/ticker/24hr') ? ok(fixture('binance/ticker24hr.json')) : ok(fixture('binance/klines-BTCUSDT.json'))
    )
    const deps = timerDeps(net.fetchJson)
    const okx = createOkxProvider({ ...deps, WebSocket: FakeSendingWebSocket })
    const crypto = createFailoverSource({
      market: 'crypto',
      chain: [createBinanceProvider({ ...deps, WebSocket: ForcedFailWebSocket, random: () => 0.5 }), okx],
      log: deps.log,
      timers: realTimers
    })
    const quotes: Quote[] = []
    crypto.on('quote', (q) => quotes.push(q))
    crypto.setSubscriptions(['crypto:BTCUSDT'])
    crypto.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(crypto.active).toBe('binance')
    expect(FakeSendingWebSocket.instances).toHaveLength(0)
    expect(quotes.filter((q) => q.id === 'crypto:BTCUSDT').at(-1)).toMatchObject({ source: 'binance', price: 76061.04 })
    crypto.stop()
  })
})

describe('failover, US (real Yahoo forced down, real CNBC)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(yahooRoute: (url: string) => ReturnType<typeof ok>) {
    const net = fakeFetch((url, opts) => {
      if (opts.provider === 'yahoo') return yahooRoute(url)
      if (url.startsWith(CNBC_QUOTE_URL)) return ok(fixture('cnbc/quote.json'))
      return ok(fixture('cnbc/chart5d-unknown.json'))
    })
    const deps = timerDeps(net.fetchJson)
    const us = createFailoverSource({
      market: 'us',
      chain: [createYahooProvider(deps), createCnbcProvider(deps)],
      log: deps.log,
      timers: realTimers
    })
    const quotes: Quote[] = []
    us.on('quote', (q) => quotes.push(q))
    return { us, quotes, deps }
  }

  it('switches to CNBC after 3 failed Yahoo fetches (HTTP 429) and back on the probe', async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 9, 15, 0)) // Monday 10:00 EST
    let yahooDown = true
    const { us, quotes, deps } = setup((url) =>
      yahooDown ? fail('http', 429) : ok(fixture(url.includes('GSPC') ? 'yahoo/chart-GSPC.json' : 'yahoo/chart-AAPL.json'))
    )
    us.setSubscriptions(['us:AAPL', 'us:^GSPC', 'us:NVDA'])
    us.start()
    await vi.advanceTimersByTimeAsync(1000) // fetches at 0, 0.5 and 1 s
    expect(us.active).toBe('cnbc')
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('us: switching to CNBC (3 consecutive failed Yahoo Finance cycles)'))
    await vi.advanceTimersByTimeAsync(0)
    expect(quotes.find((q) => q.id === 'us:AAPL')).toMatchObject({ source: 'cnbc', price: 342.37, refPrice: 344.17 })
    expect(quotes.find((q) => q.id === 'us:^GSPC')).toMatchObject({ source: 'cnbc', price: 7376.86 })
    yahooDown = false
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
    expect(us.active).toBe('yahoo')
    expect(quotes.at(-1)!.source).toBe('yahoo')
    us.stop()
  })

  it('one failing Yahoo symbol among working ones does not switch', async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 9, 15, 0))
    const { us } = setup((url) =>
      url.startsWith(`${YAHOO_CHART_URL}/NVDA`) ? fail('network') : ok(fixture(url.includes('GSPC') ? 'yahoo/chart-GSPC.json' : 'yahoo/chart-AAPL.json'))
    )
    us.setSubscriptions(['us:AAPL', 'us:NVDA', 'us:^GSPC'])
    us.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(us.active).toBe('yahoo')
    us.stop()
  })

  it('an unknown Yahoo symbol (HTTP 404) is not a failed cycle and does not block the probe', async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 9, 15, 0))
    const { us } = setup((url) => (url.startsWith(`${YAHOO_CHART_URL}/ZZZZQ`) ? fail('http', 404) : ok(fixture('yahoo/chart-AAPL.json'))))
    us.setSubscriptions(['us:ZZZZQ'])
    us.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(us.active).toBe('yahoo')
    us.stop()
  })
})
