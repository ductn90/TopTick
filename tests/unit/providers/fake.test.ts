import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeProvider } from '../../../src/main/market/providers/fake'
import { realTimers } from '../../../src/main/market/providers/types'
import type { Quote, Series } from '../../../src/shared/types'

const ids = ['vn:FPT', 'vn:VNINDEX', 'us:AAPL', 'us:^GSPC', 'crypto:BTCUSDT', 'crypto:PEPEUSDT']

function run(seed: number, ticks: number) {
  const p = createFakeProvider({ now: () => Date.now(), timers: realTimers, seed })
  const quotes: Quote[] = []
  const series: Series[] = []
  p.on('quote', (q) => quotes.push(q))
  p.on('series', (s) => series.push(s))
  p.setSubscriptions(ids)
  p.start()
  vi.advanceTimersByTime(ticks * 1000)
  p.stop()
  return { quotes, series }
}

describe('FakeProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  it('emits every subscribed id once on start and then at 1 Hz', () => {
    const { quotes } = run(1, 3)
    expect(quotes).toHaveLength(ids.length * 4)
    expect(new Set(quotes.map((q) => q.id))).toEqual(new Set(ids))
    expect(quotes.every((q) => q.source === 'fake' && q.state === 'live' && q.price > 0)).toBe(true)
  })

  it('is deterministic for a given seed', () => {
    const a = run(7, 5).quotes.map((q) => q.price)
    const b = run(7, 5).quotes.map((q) => q.price)
    const c = run(8, 5).quotes.map((q) => q.price)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('keeps 60-point series whose last point is the quote price', () => {
    const { quotes, series } = run(1, 2)
    const lastQuote = quotes.filter((q) => q.id === 'vn:FPT').pop()!
    const lastSeries = series.filter((s) => s.id === 'vn:FPT').pop()!
    expect(lastSeries.points).toHaveLength(60)
    expect(lastSeries.points[59]).toBe(lastQuote.price)
    expect(lastSeries.refPrice).toBe(lastQuote.refPrice)
  })

  it('moves VN stocks in 100 VND ticks', () => {
    const { quotes } = run(3, 10)
    expect(quotes.filter((q) => q.id === 'vn:FPT').every((q) => q.price % 100 === 0)).toBe(true)
  })

  it('gives VN stocks a ±7 % ceiling and floor and keeps prices inside them', () => {
    const { quotes } = run(3, 10)
    const fpt = quotes.filter((q) => q.id === 'vn:FPT')
    for (const q of fpt) {
      expect(q.ceiling).toBe(Math.floor((q.refPrice * 1.07) / 100) * 100)
      expect(q.floor).toBe(Math.ceil((q.refPrice * 0.93) / 100) * 100)
      expect(q.price).toBeGreaterThanOrEqual(q.floor!)
      expect(q.price).toBeLessThanOrEqual(q.ceiling!)
    }
    expect(quotes.filter((q) => q.id !== 'vn:FPT').some((q) => 'ceiling' in q || 'floor' in q)).toBe(false)
  })

  it('stops emitting after stop and for unsubscribed ids', () => {
    const p = createFakeProvider({ now: () => Date.now(), timers: realTimers })
    const quotes: Quote[] = []
    p.on('quote', (q) => quotes.push(q))
    p.setSubscriptions(['vn:FPT', 'us:AAPL'])
    p.start()
    p.setSubscriptions(['us:AAPL'])
    quotes.length = 0
    vi.advanceTimersByTime(2000)
    expect(new Set(quotes.map((q) => q.id))).toEqual(new Set(['us:AAPL']))
    p.stop()
    quotes.length = 0
    vi.advanceTimersByTime(5000)
    expect(quotes).toHaveLength(0)
  })
})
