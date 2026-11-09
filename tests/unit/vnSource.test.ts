import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCafefProvider } from '../../src/main/market/providers/cafef'
import { Emitter, realTimers, type PollingProvider, type ProviderEvents } from '../../src/main/market/providers/types'
import { createVietcapProvider } from '../../src/main/market/providers/vietcap'
import { createVnSource, PROBE_INTERVAL_MS } from '../../src/main/market/vnSource'
import type { Quote, QuoteSource } from '../../src/shared/types'
import { fail, fakeFetch, fixture, ict, mockLogger, ok, timerDeps } from './helpers'

function fakeProvider(id: QuoteSource) {
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
    emit: events.emit.bind(events)
  }
  return p satisfies PollingProvider & Record<string, unknown>
}

const quote = (source: QuoteSource): Quote => ({
  id: 'vn:FPT',
  price: 53_000,
  refPrice: 52_900,
  change: 100,
  changePct: 0.19,
  state: 'live',
  source,
  updatedAt: 1
})

describe('vnSource (fake providers)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup() {
    const primary = fakeProvider('vietcap')
    const fallback = fakeProvider('cafef')
    const log = mockLogger()
    const vn = createVnSource({ primary, fallback, log, timers: realTimers })
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

describe('vnSource (real providers, forced Vietcap failure)', () => {
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
    const vn = createVnSource({
      primary: createVietcapProvider(deps),
      fallback: createCafefProvider({ ...deps, boardOf: () => 1 }),
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
