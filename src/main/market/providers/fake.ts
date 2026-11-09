import { isVnIndexSymbol } from '../../../shared/instruments'
import type { InstrumentId, Series } from '../../../shared/types'
import { Emitter, makeQuote, marketOf, type Provider, type ProviderEvents, type Timers } from './types'

export const FAKE_TICK_MS = 1000
export const FAKE_SERIES_POINTS = 60

/** mulberry32: small, fast, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

const KNOWN_BASE: Record<string, number> = {
  'vn:VNINDEX': 1740,
  'vn:VN30': 1865,
  'vn:HNXIndex': 256,
  'vn:HNX30': 440,
  'vn:HNXUpcomIndex': 122,
  'us:^GSPC': 7350,
  'us:^IXIC': 25000,
  'crypto:BTCUSDT': 76000,
  'crypto:ETHUSDT': 2500,
  'crypto:BNBUSDT': 900,
  'crypto:SOLUSDT': 160,
  'crypto:XRPUSDT': 2.2
}

function basePrice(id: InstrumentId, rnd: () => number): number {
  const known = KNOWN_BASE[id]
  if (known !== undefined) return known
  const market = marketOf(id)
  const symbol = id.slice(id.indexOf(':') + 1)
  if (market === 'vn') return isVnIndexSymbol(symbol) ? 1000 : Math.round((10 + rnd() * 90) * 10) * 100
  if (market === 'us') return symbol.startsWith('^') ? 5000 : Math.round((20 + rnd() * 480) * 100) / 100
  return Math.round((0.5 + rnd() * 200) * 10_000) / 10_000
}

/** VN stocks move in 100 VND ticks; everything else keeps 8 significant digits. */
function roundPrice(id: InstrumentId, price: number): number {
  const symbol = id.slice(id.indexOf(':') + 1)
  if (marketOf(id) === 'vn' && !isVnIndexSymbol(symbol)) return Math.max(100, Math.round(price / 100) * 100)
  return Number(price.toPrecision(8))
}

interface Walk {
  rnd: () => number
  ref: number
  points: number[]
  /** VN stocks only: ref ±7 % in 100 VND ticks (the HOSE band). */
  limits?: { ceiling: number; floor: number }
}

const VN_BAND = 0.07

function vnLimits(id: InstrumentId, ref: number): Walk['limits'] {
  const symbol = id.slice(id.indexOf(':') + 1)
  if (marketOf(id) !== 'vn' || isVnIndexSymbol(symbol)) return undefined
  return { ceiling: Math.floor((ref * (1 + VN_BAND)) / 100) * 100, floor: Math.ceil((ref * (1 - VN_BAND)) / 100) * 100 }
}

export interface FakeDeps {
  now: () => number
  timers: Timers
  seed?: number
}

/**
 * Deterministic random walk at 1 Hz for every subscribed id (any market), with a
 * 60-point series. Used by e2e tests and offline UI work (`TOPTICK_FAKE_DATA=1`).
 */
export function createFakeProvider(deps: FakeDeps): Provider & { tick(): void } {
  const { now, timers } = deps
  const seed = deps.seed ?? 42
  const events = new Emitter<ProviderEvents>()
  const walks = new Map<InstrumentId, Walk>()
  let ids: InstrumentId[] = []
  let timer: unknown = null

  function walkFor(id: InstrumentId): Walk {
    let w = walks.get(id)
    if (w) return w
    const rnd = mulberry32(hash(id) ^ seed)
    const ref = roundPrice(id, basePrice(id, rnd))
    const limits = vnLimits(id, ref)
    const points = [ref]
    while (points.length < FAKE_SERIES_POINTS) points.push(step(id, rnd, points[points.length - 1]!, limits))
    w = { rnd, ref, points, limits }
    walks.set(id, w)
    return w
  }

  function step(id: InstrumentId, rnd: () => number, price: number, limits: Walk['limits']): number {
    const next = roundPrice(id, price * (1 + (rnd() - 0.5) * 0.004))
    return limits ? Math.min(limits.ceiling, Math.max(limits.floor, next)) : next
  }

  function emit(id: InstrumentId, w: Walk): void {
    const t = now()
    const price = w.points[w.points.length - 1]!
    events.emit('quote', { ...makeQuote(id, price, w.ref, 'live', 'fake', t), ...w.limits })
    const s: Series = { id, points: [...w.points], refPrice: w.ref, updatedAt: t }
    events.emit('series', s)
  }

  function tick(): void {
    for (const id of ids) {
      const w = walkFor(id)
      w.points.push(step(id, w.rnd, w.points[w.points.length - 1]!, w.limits))
      if (w.points.length > FAKE_SERIES_POINTS) w.points.shift()
      emit(id, w)
    }
  }

  function loop(): void {
    tick()
    timer = timers.setTimeout(loop, FAKE_TICK_MS)
  }

  return {
    id: 'fake',
    setSubscriptions(next) {
      const added = next.filter((id) => !ids.includes(id) && marketOf(id) !== null)
      ids = [...new Set(next.filter((id) => marketOf(id) !== null))]
      if (timer !== null) for (const id of added) emit(id, walkFor(id))
    },
    start() {
      if (timer !== null) return
      for (const id of ids) emit(id, walkFor(id))
      timer = timers.setTimeout(loop, FAKE_TICK_MS)
    },
    stop() {
      if (timer !== null) timers.clearTimeout(timer)
      timer = null
    },
    tick,
    on: (event, cb) => events.on(event, cb),
    inSession: () => true
  }
}
