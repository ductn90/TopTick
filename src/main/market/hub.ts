import type { Logger } from '../log'
import type { InstrumentId, Market, MarketSnapshot, Quote, Series, Settings } from '../../shared/types'
import { marketOf, type Provider, type Timers } from './providers/types'
import { markStale } from './staleness'

export const COALESCE_MS = 250
export const LOADING_TIMEOUT_MS = 30_000
export const TICK_MS = 1000

/** Non-hidden items of the active watchlist, in order. */
export function visibleIds(settings: Settings): InstrumentId[] {
  const list = settings.watchlists.find((w) => w.id === settings.activeWatchlistId)
  return list ? list.items.filter((i) => !i.hidden).map((i) => i.id) : []
}

export interface MarketHubDeps {
  /** Provider per market. In fake mode pass the same FakeProvider for all three. */
  providers: Record<Market, Provider>
  /** Receives coalesced diffs (sent to the bar as `market:update`). */
  emit: (diff: MarketSnapshot) => void
  now: () => number
  timers: Timers
  log?: Logger
  coalesceMs?: number
  loadingTimeoutMs?: number
}

export interface MarketHub {
  setSubscriptions(ids: InstrumentId[]): void
  subscriptions(): InstrumentId[]
  /** Full state for the subscribed ids (sent as `market:snapshot`). */
  snapshot(): MarketSnapshot
  start(): void
  stop(): void
}

interface Entry {
  quote: Quote
  /** Local time of the last successful fetch carrying this id. */
  receivedAt: number
}

const emptyDiff = (): MarketSnapshot => ({ quotes: {}, series: {} })

/**
 * Routes subscriptions to providers by market, caches the latest quote/series
 * per id (kept across watchlist switches), derives `stale`/`loading`/`error`,
 * and emits diffs at most every 250 ms.
 */
export function createMarketHub(deps: MarketHubDeps): MarketHub {
  const { providers, emit, now, timers } = deps
  const coalesceMs = deps.coalesceMs ?? COALESCE_MS
  const loadingTimeoutMs = deps.loadingTimeoutMs ?? LOADING_TIMEOUT_MS
  const unique = [...new Set(Object.values(providers))]

  const quotes = new Map<InstrumentId, Entry>()
  const series = new Map<InstrumentId, Series>()
  /** Subscribed ids -> time they were subscribed (for loading -> error). */
  const subscribed = new Map<InstrumentId, number>()
  const lastState = new Map<InstrumentId, Quote['state']>()

  let order: InstrumentId[] = []
  let pending = emptyDiff()
  let pendingCount = 0
  let flushTimer: unknown = null
  let tickTimer: unknown = null
  let lastFlushAt = Number.NEGATIVE_INFINITY
  let started = false

  function derive(id: InstrumentId): Quote {
    const market = marketOf(id)!
    const provider = providers[market]
    const t = now()
    const entry = quotes.get(id)
    if (!entry) {
      const since = subscribed.get(id) ?? t
      return {
        id,
        price: 0,
        refPrice: 0,
        change: 0,
        changePct: 0,
        state: t - since >= loadingTimeoutMs ? 'error' : 'loading',
        source: provider.id,
        updatedAt: 0
      }
    }
    const inSession = provider.inSession?.(id, t) ?? true
    return markStale(entry.quote, market, entry.receivedAt, t, inSession)
  }

  function queueQuote(id: InstrumentId): void {
    const q = derive(id)
    lastState.set(id, q.state)
    pending.quotes[id] = q
    pendingCount++
    scheduleFlush()
  }

  function queueSeries(s: Series): void {
    pending.series[s.id] = s
    pendingCount++
    scheduleFlush()
  }

  function flush(): void {
    flushTimer = null
    if (pendingCount === 0) return
    const diff = pending
    pending = emptyDiff()
    pendingCount = 0
    lastFlushAt = now()
    emit(diff)
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) return
    const delay = Math.max(0, lastFlushAt + coalesceMs - now())
    flushTimer = timers.setTimeout(flush, delay)
  }

  function tick(): void {
    tickTimer = null
    if (!started) return
    for (const id of subscribed.keys()) {
      if (derive(id).state !== lastState.get(id)) queueQuote(id)
    }
    tickTimer = timers.setTimeout(tick, TICK_MS)
  }

  for (const p of unique) {
    p.on('quote', (q) => {
      const market = marketOf(q.id)
      if (!market || providers[market] !== p) return
      quotes.set(q.id, { quote: q, receivedAt: now() })
      if (subscribed.has(q.id)) queueQuote(q.id)
    })
    p.on('series', (s) => {
      const market = marketOf(s.id)
      if (!market || providers[market] !== p) return
      series.set(s.id, s)
      if (subscribed.has(s.id)) queueSeries(s)
    })
  }

  return {
    setSubscriptions(ids) {
      const next = [...new Set(ids.filter((id) => marketOf(id) !== null))]
      const t = now()
      for (const id of [...subscribed.keys()]) {
        if (!next.includes(id)) {
          subscribed.delete(id)
          lastState.delete(id)
        }
      }
      for (const id of next) {
        if (subscribed.has(id)) continue
        subscribed.set(id, t)
        // Cached values make switching back to a watchlist instant.
        queueQuote(id)
        const s = series.get(id)
        if (s) queueSeries(s)
      }
      order = next
      const groups = new Map<Provider, InstrumentId[]>(unique.map((p) => [p, []]))
      for (const id of next) groups.get(providers[marketOf(id)!])!.push(id)
      for (const [p, list] of groups) p.setSubscriptions(list)
      deps.log?.debug(`hub: ${next.length} subscriptions`)
    },
    subscriptions: () => [...order],
    snapshot() {
      const snap = emptyDiff()
      for (const id of order) {
        snap.quotes[id] = derive(id)
        const s = series.get(id)
        if (s) snap.series[id] = s
      }
      return snap
    },
    start() {
      if (started) return
      started = true
      for (const p of unique) p.start()
      tickTimer = timers.setTimeout(tick, TICK_MS)
    },
    stop() {
      started = false
      for (const p of unique) p.stop()
      if (tickTimer !== null) timers.clearTimeout(tickTimer)
      if (flushTimer !== null) timers.clearTimeout(flushTimer)
      tickTimer = flushTimer = null
    }
  }
}
