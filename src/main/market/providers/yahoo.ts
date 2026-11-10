import { z } from 'zod'
import { describeFailure } from '../../http'
import { displaySymbol, INSTRUMENT_ID_RE } from '../../../shared/instruments'
import type { Instrument, Quote, Series } from '../../../shared/types'
import { usInSession, usRegularOpen, type TradingPeriod } from '../schedule'
import {
  capPoints,
  Emitter,
  isValidPrice,
  makeQuote,
  sameMembers,
  symbolsOf,
  type PollingProvider,
  type ProviderDeps,
  type ProviderEvents
} from './types'

export const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart'
export const YAHOO_SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search'

const chartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({
            symbol: z.string(),
            regularMarketPrice: z.number(),
            chartPreviousClose: z.number(),
            regularMarketTime: z.number(),
            currentTradingPeriod: z
              .object({ regular: z.object({ start: z.number(), end: z.number() }) })
              .nullish()
          }),
          indicators: z.object({
            quote: z.array(z.object({ close: z.array(z.number().nullable()).nullish() }))
          })
        })
      )
      .min(1)
  })
})

const searchSchema = z.object({
  quotes: z.array(
    z.object({
      symbol: z.string(),
      quoteType: z.string().nullish(),
      exchange: z.string().nullish(),
      shortname: z.string().nullish(),
      longname: z.string().nullish()
    })
  )
})

export interface YahooChart {
  quote: Quote
  series: Series
  period: TradingPeriod | null
}

/** `GET /v8/finance/chart/<sym>?range=1d&interval=5m` -> quote, series (nulls dropped) and regular period. */
export function parseYahooChart(raw: unknown, now: number): YahooChart | null {
  const r = chartSchema.safeParse(raw)
  if (!r.success) return null
  const res = r.data.chart.result[0]!
  const m = res.meta
  if (!isValidPrice(m.regularMarketPrice) || !isValidPrice(m.chartPreviousClose)) return null
  const period = m.currentTradingPeriod?.regular ?? null
  const id = `us:${m.symbol}`
  const updatedAt = m.regularMarketTime * 1000
  const state = usRegularOpen(now, period) ? 'live' : 'closed'
  const points = (res.indicators.quote[0]?.close ?? []).filter((c): c is number => c !== null && isValidPrice(c))
  return {
    quote: makeQuote(id, m.regularMarketPrice, m.chartPreviousClose, state, 'yahoo', updatedAt),
    series: { id, points: capPoints(points), refPrice: m.chartPreviousClose, updatedAt },
    period
  }
}

/** US listing venues as reported by Yahoo search (`exchange`). */
export const US_EXCHANGES: ReadonlySet<string> = new Set([
  'NMS', 'NGM', 'NCM', 'NAS', 'NYQ', 'NYS', 'ASE', 'PCX', 'BTS', 'CXI', // equities and ETFs
  'SNP', 'NIM', 'DJI', 'WCB' // index publishers
])

const KIND_BY_QUOTE_TYPE: Record<string, Instrument['kind']> = { EQUITY: 'stock', ETF: 'etf', INDEX: 'index' }

/** `GET /v1/finance/search` -> US EQUITY/ETF/INDEX instruments. */
export function parseYahooSearch(raw: unknown): Instrument[] | null {
  const r = searchSchema.safeParse(raw)
  if (!r.success) return null
  return r.data.quotes.flatMap((q) => {
    const kind = KIND_BY_QUOTE_TYPE[q.quoteType ?? '']
    if (!kind || !q.exchange || !US_EXCHANGES.has(q.exchange)) return []
    const id = `us:${q.symbol}`
    if (!INSTRUMENT_ID_RE.test(id)) return []
    const name = q.longname ?? q.shortname ?? q.symbol
    return [{ id, market: 'us', kind, symbol: q.symbol, displaySymbol: displaySymbol('us', q.symbol), nameEn: name, nameVi: name }]
  })
}

export const YAHOO_POLL_MS = { inSession: 10_000, outOfSession: 5 * 60_000 } as const
export const YAHOO_BACKOFF_BASE_MS = 10_000
export const YAHOO_BACKOFF_MAX_MS = 120_000
export const YAHOO_STAGGER_MS = 500
const BACKOFF_STATUSES = new Set([401, 403, 429])

export interface YahooProvider extends PollingProvider {
  /** Current backoff delay in ms (0 when not backing off). */
  readonly backoffMs: number
}

export function createYahooProvider(deps: ProviderDeps): YahooProvider {
  const { fetchJson, log, now, timers } = deps
  const events = new Emitter<ProviderEvents>()
  const periods = new Map<string, TradingPeriod | null>()
  const pollTimers = new Map<string, unknown>()

  let symbols: string[] = []
  let started = false
  /** Consecutive 401/403/429 responses, shared by all symbols (rate limits are per client). */
  let blockedFailures = 0
  /** Latest result per symbol (404s left out), for the health signal. */
  const latest = new Map<string, boolean>()

  const backoffMs = (): number =>
    blockedFailures === 0 ? 0 : Math.min(YAHOO_BACKOFF_MAX_MS, YAHOO_BACKOFF_BASE_MS * 2 ** blockedFailures)

  function normalInterval(symbol: string): number {
    const period = periods.get(symbol)
    // Unknown period (never fetched): poll at the in-session rate until we learn it.
    if (period === undefined) return YAHOO_POLL_MS.inSession
    return usInSession(now(), period) ? YAHOO_POLL_MS.inSession : YAHOO_POLL_MS.outOfSession
  }

  type FetchOutcome = 'ok' | 'blocked' | 'failed' | 'missing'

  /** Fetches one symbol and records the outcome for the health signal (404s are left out). */
  async function fetchSymbol(symbol: string): Promise<FetchOutcome> {
    const result = await fetchChart(symbol)
    if (result === 'missing' || !symbols.includes(symbol)) latest.delete(symbol)
    else latest.set(symbol, result === 'ok')
    return result
  }

  /** `missing` = HTTP 404 (unknown or delisted symbol): Yahoo answered, so it is not a failed cycle. */
  async function fetchChart(symbol: string): Promise<FetchOutcome> {
    const res = await fetchJson(`${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?range=1d&interval=5m`, {
      provider: 'yahoo'
    })
    if (!res.ok && res.kind === 'http' && res.status === 404) {
      log.debug(`yahoo: ${symbol} not found`)
      return 'missing'
    }
    if (!res.ok) {
      const blocked = res.kind === 'http' && res.status !== undefined && BACKOFF_STATUSES.has(res.status)
      if (blocked) blockedFailures++
      log.debug(`yahoo: ${symbol} failed (${describeFailure(res)})`)
      return blocked ? 'blocked' : 'failed'
    }
    const parsed = parseYahooChart(res.data, now())
    if (!parsed) {
      log.warn(`yahoo: ${symbol} schema mismatch`)
      return 'failed'
    }
    blockedFailures = 0
    if (!symbols.includes(symbol)) return 'ok'
    periods.set(symbol, parsed.period)
    events.emit('quote', parsed.quote)
    if (parsed.series.points.length > 0) events.emit('series', parsed.series)
    return 'ok'
  }

  function schedule(symbol: string, delay: number): void {
    const prev = pollTimers.get(symbol)
    if (prev !== undefined) timers.clearTimeout(prev)
    pollTimers.set(
      symbol,
      timers.setTimeout(() => void loop(symbol), delay)
    )
  }

  async function loop(symbol: string): Promise<void> {
    pollTimers.delete(symbol)
    if (!started || !symbols.includes(symbol)) return
    const result = await fetchSymbol(symbol)
    if (!started || !symbols.includes(symbol)) return
    // Health per fetch: ok while any symbol's latest fetch worked, so one bad symbol (which may
    // poll more often than the others) does not count as a failed Yahoo cycle.
    if (result !== 'missing') {
      const anyOk = [...latest.values()].some(Boolean)
      events.emit('health', anyOk ? { ok: true } : { ok: false, error: `yahoo ${symbol} ${result}` })
    }
    if (pollTimers.has(symbol)) return
    schedule(symbol, Math.max(normalInterval(symbol), backoffMs()))
  }

  function restartAll(): void {
    for (const h of pollTimers.values()) timers.clearTimeout(h)
    pollTimers.clear()
    symbols.forEach((s, i) => schedule(s, i * YAHOO_STAGGER_MS))
  }

  return {
    id: 'yahoo',
    get backoffMs() {
      return backoffMs()
    },
    setSubscriptions(ids) {
      const next = symbolsOf(ids, 'us')
      if (sameMembers(next, symbols)) return
      const added = next.filter((s) => !symbols.includes(s))
      for (const s of symbols) {
        if (next.includes(s)) continue
        const h = pollTimers.get(s)
        if (h !== undefined) timers.clearTimeout(h)
        pollTimers.delete(s)
        periods.delete(s)
        latest.delete(s)
      }
      symbols = next
      if (started) added.forEach((s, i) => schedule(s, i * YAHOO_STAGGER_MS))
    },
    start() {
      if (started) return
      started = true
      restartAll()
    },
    stop() {
      started = false
      for (const h of pollTimers.values()) timers.clearTimeout(h)
      pollTimers.clear()
    },
    async pollOnce() {
      const results = await Promise.all(symbols.map(fetchSymbol))
      // Same rule as the health signal: Yahoo works if any symbol answered (404s are answers).
      return results.length === 0 || results.some((r) => r === 'ok') || results.every((r) => r === 'missing')
    },
    on: (event, cb) => events.on(event, cb),
    inSession: (id, t) => usInSession(t, periods.get(id.slice(3)))
  }
}
