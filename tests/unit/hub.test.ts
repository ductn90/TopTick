import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMarketHub, visibleIds } from '../../src/main/market/hub'
import { createFakeProvider } from '../../src/main/market/providers/fake'
import { Emitter, realTimers, type Provider, type ProviderEvents } from '../../src/main/market/providers/types'
import { createDefaults } from '../../src/main/settings/defaults'
import type { MarketSnapshot, Quote, QuoteSource, Series } from '../../src/shared/types'

function fakeProvider(id: QuoteSource, inSession = true) {
  const events = new Emitter<ProviderEvents>()
  const p = {
    id,
    subs: [] as string[],
    setSubscriptions: vi.fn((ids: string[]) => {
      p.subs = ids
    }),
    start: vi.fn(),
    stop: vi.fn(),
    on: events.on.bind(events),
    emit: events.emit.bind(events),
    inSession: vi.fn(() => inSession)
  }
  return p satisfies Provider & Record<string, unknown>
}

const quote = (id: string, price: number, source: QuoteSource = 'binance'): Quote => ({
  id,
  price,
  refPrice: 100,
  change: price - 100,
  changePct: price - 100,
  state: 'live',
  source,
  updatedAt: Date.now()
})

function setup() {
  const crypto = fakeProvider('binance')
  const vn = fakeProvider('vietcap')
  const us = fakeProvider('yahoo', false)
  const diffs: MarketSnapshot[] = []
  const hub = createMarketHub({
    providers: { crypto, vn, us },
    emit: (d) => diffs.push(d),
    now: () => Date.now(),
    timers: realTimers
  })
  return { hub, crypto, vn, us, diffs }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
})
afterEach(() => vi.useRealTimers())

describe('visibleIds', () => {
  it('returns the non-hidden items of the active watchlist', () => {
    const s = createDefaults('en')
    expect(visibleIds(s)).toEqual(s.watchlists[0]!.items.map((i) => i.id))
    s.watchlists[0]!.items[1]!.hidden = true
    expect(visibleIds(s)).not.toContain(s.watchlists[0]!.items[1]!.id)
    s.activeWatchlistId = 'default-cr'
    expect(visibleIds(s)).toEqual(['crypto:BTCUSDT', 'crypto:ETHUSDT', 'crypto:BNBUSDT', 'crypto:SOLUSDT', 'crypto:XRPUSDT'])
  })
})

describe('MarketHub', () => {
  it('routes ids to providers by market', () => {
    const { hub, crypto, vn, us } = setup()
    hub.setSubscriptions(['vn:FPT', 'us:AAPL', 'crypto:BTCUSDT', 'vn:VNINDEX', 'bogus'])
    expect(crypto.subs).toEqual(['crypto:BTCUSDT'])
    expect(vn.subs).toEqual(['vn:FPT', 'vn:VNINDEX'])
    expect(us.subs).toEqual(['us:AAPL'])
    expect(hub.subscriptions()).toEqual(['vn:FPT', 'us:AAPL', 'crypto:BTCUSDT', 'vn:VNINDEX'])
    hub.setSubscriptions(['crypto:ETHUSDT'])
    expect(vn.subs).toEqual([])
    expect(us.subs).toEqual([])
    expect(crypto.subs).toEqual(['crypto:ETHUSDT'])
  })

  it('reports loading, then error after 30 s without data', () => {
    const { hub } = setup()
    hub.setSubscriptions(['crypto:BTCUSDT'])
    hub.start()
    expect(hub.snapshot().quotes['crypto:BTCUSDT']).toMatchObject({ state: 'loading', source: 'binance' })
    vi.advanceTimersByTime(29_000)
    expect(hub.snapshot().quotes['crypto:BTCUSDT']!.state).toBe('loading')
    vi.advanceTimersByTime(1_000)
    expect(hub.snapshot().quotes['crypto:BTCUSDT']!.state).toBe('error')
    hub.stop()
  })

  it('coalesces 20 rapid quotes into one emit per 250 ms window', () => {
    const { hub, crypto, diffs } = setup()
    hub.setSubscriptions(['crypto:BTCUSDT', 'crypto:ETHUSDT'])
    vi.advanceTimersByTime(0)
    diffs.length = 0
    vi.advanceTimersByTime(250)
    for (let i = 0; i < 20; i++) crypto.emit('quote', quote(i % 2 ? 'crypto:ETHUSDT' : 'crypto:BTCUSDT', 100 + i))
    vi.advanceTimersByTime(0)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]!.quotes['crypto:BTCUSDT']!.price).toBe(118)
    expect(diffs[0]!.quotes['crypto:ETHUSDT']!.price).toBe(119)
    // More updates right after a flush wait for the window to end.
    crypto.emit('quote', quote('crypto:BTCUSDT', 200))
    vi.advanceTimersByTime(249)
    expect(diffs).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(diffs).toHaveLength(2)
  })

  it('emits at most 4 diffs per second under continuous updates', () => {
    const { hub, crypto, diffs } = setup()
    hub.setSubscriptions(['crypto:BTCUSDT'])
    vi.advanceTimersByTime(0)
    diffs.length = 0
    for (let ms = 0; ms < 1000; ms += 10) {
      crypto.emit('quote', quote('crypto:BTCUSDT', 100 + ms))
      vi.advanceTimersByTime(10)
    }
    expect(diffs.length).toBeLessThanOrEqual(4)
  })

  it('marks quotes stale after the market threshold while in session, never out of session', () => {
    const { hub, crypto, us, diffs } = setup()
    hub.setSubscriptions(['crypto:BTCUSDT', 'us:AAPL'])
    hub.start()
    crypto.emit('quote', quote('crypto:BTCUSDT', 101))
    us.emit('quote', { ...quote('us:AAPL', 101, 'yahoo'), state: 'closed' })
    vi.advanceTimersByTime(15_000)
    expect(hub.snapshot().quotes['crypto:BTCUSDT']!.state).toBe('live')
    vi.advanceTimersByTime(1_000)
    expect(hub.snapshot().quotes['crypto:BTCUSDT']).toMatchObject({ state: 'stale', price: 101 })
    vi.advanceTimersByTime(250) // let the coalesced diff flush
    expect(diffs.at(-1)!.quotes['crypto:BTCUSDT']!.state).toBe('stale')
    vi.advanceTimersByTime(10 * 60_000)
    expect(hub.snapshot().quotes['us:AAPL']!.state).toBe('closed') // US provider reports out of session
    // A fresh quote clears stale.
    crypto.emit('quote', quote('crypto:BTCUSDT', 102))
    expect(hub.snapshot().quotes['crypto:BTCUSDT']!.state).toBe('live')
    hub.stop()
  })

  it('keeps the cache across watchlist switches and re-sends it immediately', () => {
    const { hub, crypto, vn, diffs } = setup()
    hub.setSubscriptions(['crypto:BTCUSDT'])
    crypto.emit('quote', quote('crypto:BTCUSDT', 150))
    const s: Series = { id: 'crypto:BTCUSDT', points: [1, 2, 3], refPrice: 100, updatedAt: 1 }
    crypto.emit('series', s)
    hub.setSubscriptions(['vn:FPT'])
    expect(hub.snapshot().quotes).not.toHaveProperty('crypto:BTCUSDT')
    vn.emit('quote', quote('vn:FPT', 53_000, 'vietcap'))
    vi.advanceTimersByTime(1000)
    diffs.length = 0
    hub.setSubscriptions(['crypto:BTCUSDT'])
    vi.advanceTimersByTime(250)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]!.quotes['crypto:BTCUSDT']!.price).toBe(150)
    expect(diffs[0]!.series['crypto:BTCUSDT']).toEqual(s)
    expect(hub.snapshot().series['crypto:BTCUSDT']).toEqual(s)
  })

  it('does not emit updates for ids that are not subscribed', () => {
    const { hub, crypto, diffs } = setup()
    hub.setSubscriptions(['crypto:BTCUSDT'])
    vi.advanceTimersByTime(250)
    diffs.length = 0
    crypto.emit('quote', quote('crypto:ETHUSDT', 1))
    vi.advanceTimersByTime(1000)
    expect(diffs).toHaveLength(0)
  })

  it('start and stop reach every provider once; fake mode routes all markets to one provider', () => {
    const fake = createFakeProvider({ now: () => Date.now(), timers: realTimers })
    const diffs: MarketSnapshot[] = []
    const hub = createMarketHub({
      providers: { crypto: fake, vn: fake, us: fake },
      emit: (d) => diffs.push(d),
      now: () => Date.now(),
      timers: realTimers
    })
    hub.setSubscriptions(['vn:FPT', 'us:NVDA', 'crypto:SOLUSDT'])
    hub.start()
    vi.advanceTimersByTime(1000)
    const snap = hub.snapshot()
    expect(Object.keys(snap.quotes).sort()).toEqual(['crypto:SOLUSDT', 'us:NVDA', 'vn:FPT'])
    expect(Object.values(snap.quotes).every((q) => q.source === 'fake' && q.state === 'live')).toBe(true)
    expect(Object.values(snap.series).every((s) => s.points.length === 60)).toBe(true)
    hub.stop()
    const count = diffs.length
    vi.advanceTimersByTime(5000)
    expect(diffs.length).toBe(count)
  })
})
