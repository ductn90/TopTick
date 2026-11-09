import type { FetchJson } from '../../http'
import type { Logger } from '../../log'
import type { InstrumentId, Market, Quote, QuoteSource, Series } from '../../../shared/types'

export interface ProviderHealth {
  ok: boolean
  error?: string
}

export interface ProviderEvents {
  quote: Quote
  series: Series
  health: ProviderHealth
}

export type Unsubscribe = () => void

export interface Provider {
  readonly id: QuoteSource
  /** Idempotent; ids of other markets are ignored. */
  setSubscriptions(ids: InstrumentId[]): void
  start(): void
  stop(): void
  on<E extends keyof ProviderEvents>(event: E, cb: (payload: ProviderEvents[E]) => void): Unsubscribe
  /** Whether the instrument's market is in session now (drives staleness). Defaults to true. */
  inSession?(id: InstrumentId, now: number): boolean
}

/** A provider that can run a single fetch cycle on demand (failover probes, compare-live). */
export interface PollingProvider extends Provider {
  /** One quotes cycle for the current subscriptions; resolves `true` on success. */
  pollOnce(): Promise<boolean>
}

/** Timer functions, injected so tests can use fake clocks. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Resolves the global timers at call time (so `vi.useFakeTimers()` applies). */
export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface ProviderDeps {
  fetchJson: FetchJson
  log: Logger
  now: () => number
  timers: Timers
}

export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>()

  on<E extends keyof Events>(event: E, cb: (payload: Events[E]) => void): Unsubscribe {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(cb as (payload: never) => void)
    return () => {
      set.delete(cb as (payload: never) => void)
    }
  }

  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    for (const cb of this.listeners.get(event) ?? []) (cb as (p: Events[E]) => void)(payload)
  }
}

/** Positive finite number (rejects NaN, ±Infinity, 0 and negatives). */
export function isValidPrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function marketOf(id: InstrumentId): Market | null {
  const sep = id.indexOf(':')
  const market = sep > 0 ? id.slice(0, sep) : ''
  return market === 'vn' || market === 'us' || market === 'crypto' ? market : null
}

/** Symbols of the given market from a list of ids, de-duplicated, order kept. */
export function symbolsOf(ids: InstrumentId[], market: Market): string[] {
  const prefix = `${market}:`
  return [...new Set(ids.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)))]
}

export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

export const MAX_SERIES_POINTS = 120

/** Keeps every k-th point plus the last one so the result has at most `max` points. */
export function capPoints(points: number[], max = MAX_SERIES_POINTS): number[] {
  if (points.length <= max) return points
  const step = Math.ceil(points.length / (max - 1))
  const out: number[] = []
  for (let i = 0; i < points.length - 1 && out.length < max - 1; i += step) out.push(points[i]!)
  out.push(points[points.length - 1]!)
  return out
}

/** Builds a quote from price and reference price; `change`/`changePct` are derived. */
export function makeQuote(
  id: InstrumentId,
  price: number,
  refPrice: number,
  state: Quote['state'],
  source: QuoteSource,
  updatedAt: number
): Quote {
  const change = price - refPrice
  return {
    id,
    price,
    refPrice,
    change,
    changePct: refPrice > 0 ? (change / refPrice) * 100 : 0,
    state,
    source,
    updatedAt
  }
}

/**
 * Per-id series store implementing "the last point follows the live price":
 * `setSeries` stores a fetched series, `applyQuote` replaces its last point
 * (and reference) and returns the updated series when something changed.
 */
export class SeriesTracker {
  private readonly series = new Map<InstrumentId, Series>()
  private readonly refs = new Map<InstrumentId, number>()

  /** Stores a fetched series; uses the last known quote reference when there is one. */
  set(id: InstrumentId, points: number[], fallbackRef: number, updatedAt: number): Series {
    const s: Series = { id, points: capPoints(points), refPrice: this.refs.get(id) ?? fallbackRef, updatedAt }
    this.series.set(id, s)
    return s
  }

  applyQuote(q: Quote): Series | null {
    this.refs.set(q.id, q.refPrice)
    const s = this.series.get(q.id)
    if (!s || s.points.length === 0) return null
    const last = s.points[s.points.length - 1]
    if (last === q.price && s.refPrice === q.refPrice) return null
    const next: Series = {
      ...s,
      points: [...s.points.slice(0, -1), q.price],
      refPrice: q.refPrice,
      updatedAt: Math.max(s.updatedAt, q.updatedAt)
    }
    this.series.set(q.id, next)
    return next
  }

  has(id: InstrumentId): boolean {
    return this.series.has(id)
  }

  retain(ids: Iterable<InstrumentId>): void {
    const keep = new Set(ids)
    for (const id of [...this.series.keys()]) if (!keep.has(id)) this.series.delete(id)
    for (const id of [...this.refs.keys()]) if (!keep.has(id)) this.refs.delete(id)
  }
}

/** zod helper: a numeric string such as Binance's `"76061.04000000"`. */
export function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : value.trim() === '' ? Number.NaN : Number(value)
}
