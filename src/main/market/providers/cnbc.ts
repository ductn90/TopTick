import { z } from 'zod'
import { describeFailure } from '../../http'
import type { InstrumentId, Quote } from '../../../shared/types'
import { usScheduledInSession, usScheduledRegularOpen } from '../schedule'
import {
  capPoints,
  Emitter,
  isValidPrice,
  makeQuote,
  sameMembers,
  SeriesTracker,
  symbolsOf,
  type PollingProvider,
  type ProviderDeps,
  type ProviderEvents
} from './types'
import { ChartSchedule } from './vietcap'
import { YAHOO_POLL_MS, YAHOO_STAGGER_MS } from './yahoo'

export const CNBC_QUOTE_URL = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'
export const CNBC_QUOTE_QUERY = 'requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1'
export const CNBC_CHART_URL = 'https://ts-api.cnbc.com/harmony/app/charts/5D.json'
/** Symbols per quote request. */
export const CNBC_BATCH = 25
export const CNBC_CHART_REFRESH_MS = 5 * 60_000

/** Yahoo index symbols CNBC serves; other `^` symbols have no CNBC equivalent here. */
const INDEX_SYMBOLS: Readonly<Record<string, string>> = {
  '^GSPC': '.SPX',
  '^IXIC': '.IXIC',
  '^DJI': '.DJI',
  '^NDX': '.NDX'
}

/** Internal (Yahoo) symbol -> CNBC symbol: mapped indices, `BRK-B` -> `BRK.B`; `null` when unmapped. */
export function cnbcSymbol(symbol: string): string | null {
  if (symbol.startsWith('^')) return INDEX_SYMBOLS[symbol] ?? null
  return symbol.replace(/-/g, '.')
}

export function cnbcQuoteUrl(symbols: string[]): string {
  return `${CNBC_QUOTE_URL}?symbols=${symbols.map(encodeURIComponent).join('%7C')}&${CNBC_QUOTE_QUERY}`
}

const quoteEnvelopeSchema = z.object({
  FormattedQuoteResult: z.object({ FormattedQuote: z.array(z.unknown()) })
})

const quoteRowSchema = z.object({ symbol: z.string(), code: z.literal(0), last: z.string(), change: z.string() })

const chartSchema = z.object({
  barData: z.object({
    priceBars: z.array(
      z.object({ close: z.union([z.string(), z.number()]), tradeTime: z.string(), tradeTimeinMills: z.number().nullish() })
    )
  })
})

/** `"7,376.86"`, `"+23.13"`, `"UNCH"` -> number. */
function parseFormatted(value: string): number {
  const s = value.trim().replace(/,/g, '').replace(/^\+/, '')
  if (s.toUpperCase() === 'UNCH') return 0
  return s === '' ? Number.NaN : Number(s)
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000

/**
 * `restQuote` -> quotes for the requested symbols. `previous_day_closing`
 * equals today's close after the bell, so the reference is `last − change`.
 * Rows with `code` ≠ 0 (unknown symbol) are skipped. `last_time` is a date
 * only, so `updatedAt` is the fetch time.
 */
export function parseCnbcQuotes(raw: unknown, bySymbol: ReadonlyMap<string, InstrumentId>, now: number): Quote[] | null {
  const env = quoteEnvelopeSchema.safeParse(raw)
  if (!env.success) return null
  const state = usScheduledRegularOpen(now) ? 'live' : 'closed'
  return env.data.FormattedQuoteResult.FormattedQuote.flatMap((item) => {
    const r = quoteRowSchema.safeParse(item)
    if (!r.success) return []
    const id = bySymbol.get(r.data.symbol)
    if (!id) return []
    const last = parseFormatted(r.data.last)
    const change = parseFormatted(r.data.change)
    if (!isValidPrice(last) || !Number.isFinite(change)) return []
    const refPrice = round4(last - change)
    if (!isValidPrice(refPrice)) return []
    return makeQuote(id, last, refPrice, state, 'cnbc', now)
  })
}

const weekdayOf = (ymd: string): number =>
  new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))).getUTCDay()

/**
 * `charts/5D.json` (5-minute bars, New York wall-clock `tradeTime`) -> closes of
 * the latest weekday's regular session, bars stamped 09:30 ≤ time < 16:00 (some
 * symbols stamp the bar start, others the last minute; both give 78 bars).
 * Pre/post-market bars and stray weekend bars are dropped.
 */
export function parseCnbcChart(raw: unknown): { points: number[]; lastTime: number | null } | null {
  const r = chartSchema.safeParse(raw)
  if (!r.success) return null
  const bars = r.data.barData.priceBars.filter((b) => {
    if (!/^\d{14}$/.test(b.tradeTime)) return false
    const wd = weekdayOf(b.tradeTime.slice(0, 8))
    const hhmm = b.tradeTime.slice(8, 12)
    return wd >= 1 && wd <= 5 && hhmm >= '0930' && hhmm < '1600'
  })
  const day = bars.reduce((max, b) => (b.tradeTime.slice(0, 8) > max ? b.tradeTime.slice(0, 8) : max), '')
  const session = bars
    .filter((b) => b.tradeTime.startsWith(day))
    .sort((a, b) => (a.tradeTime < b.tradeTime ? -1 : 1))
  const points = session.map((b) => Number(b.close)).filter(isValidPrice)
  if (points.length === 0) return null
  return { points: capPoints(points), lastTime: session[session.length - 1]!.tradeTimeinMills ?? null }
}

/**
 * CNBC, the US backup: batched quotes every 10 s in the scheduled regular
 * session (±5 min) and every 5 min outside; 5-day charts per symbol every
 * 5 min in session and once outside.
 */
export function createCnbcProvider(deps: ProviderDeps): PollingProvider {
  const { fetchJson, log, now, timers } = deps
  const events = new Emitter<ProviderEvents>()
  const series = new SeriesTracker()
  const charts = new ChartSchedule()
  let symbols: string[] = []
  let started = false
  let pollTimer: unknown = null
  let chartTimer: unknown = null
  let failing = false

  function emitQuote(q: Quote): void {
    events.emit('quote', q)
    const s = series.applyQuote(q)
    if (s) events.emit('series', s)
  }

  /** CNBC symbol -> internal id for the subscribed, mappable symbols. */
  function mapped(): Map<string, InstrumentId> {
    const out = new Map<string, InstrumentId>()
    for (const s of symbols) {
      const c = cnbcSymbol(s)
      if (c) out.set(c, `us:${s}`)
    }
    return out
  }

  async function fetchBatch(batch: string[], bySymbol: Map<string, InstrumentId>): Promise<boolean> {
    const res = await fetchJson(cnbcQuoteUrl(batch), { provider: 'cnbc' })
    if (!res.ok) {
      log.debug(`cnbc: quotes failed (${describeFailure(res)})`)
      return false
    }
    const quotes = parseCnbcQuotes(res.data, bySymbol, now())
    if (!quotes) {
      log.warn('cnbc: quotes schema mismatch')
      return false
    }
    for (const q of quotes) if (symbols.includes(q.id.slice(3))) emitQuote(q)
    return true
  }

  async function pollOnce(): Promise<boolean> {
    const bySymbol = mapped()
    const list = [...bySymbol.keys()]
    const batches: string[][] = []
    for (let i = 0; i < list.length; i += CNBC_BATCH) batches.push(list.slice(i, i + CNBC_BATCH))
    const ok = (await Promise.all(batches.map((b) => fetchBatch(b, bySymbol)))).every(Boolean)
    if (!ok && !failing) log.warn('cnbc: poll cycle failed')
    failing = !ok
    return ok
  }

  async function poll(): Promise<void> {
    pollTimer = null
    if (!started) return
    if (symbols.length > 0) {
      const ok = await pollOnce()
      if (!started) return
      events.emit('health', ok ? { ok } : { ok, error: 'cnbc poll failed' })
    }
    const delay = usScheduledInSession(now()) ? YAHOO_POLL_MS.inSession : YAHOO_POLL_MS.outOfSession
    if (started && pollTimer === null) pollTimer = timers.setTimeout(() => void poll(), delay)
  }

  async function fetchChart(symbol: string, inSession: boolean): Promise<void> {
    const c = cnbcSymbol(symbol)
    if (!c) return
    const res = await fetchJson(`${CNBC_CHART_URL}?symbol=${encodeURIComponent(c)}`, { provider: 'cnbc' })
    if (!res.ok) {
      log.debug(`cnbc: chart ${symbol} failed (${describeFailure(res)})`)
      return
    }
    const parsed = parseCnbcChart(res.data)
    if (!parsed || !symbols.includes(symbol)) return
    charts.mark(symbol, inSession)
    events.emit('series', series.set(`us:${symbol}`, parsed.points, parsed.points[0]!, parsed.lastTime ?? now()))
  }

  function runCharts(): void {
    chartTimer = null
    if (!started) return
    const inSession = usScheduledInSession(now())
    symbols
      .filter((s) => cnbcSymbol(s) !== null && charts.due(s, inSession))
      .forEach((s, i) => {
        timers.setTimeout(() => {
          if (started && symbols.includes(s)) void fetchChart(s, inSession)
        }, i * YAHOO_STAGGER_MS)
      })
    chartTimer = timers.setTimeout(runCharts, CNBC_CHART_REFRESH_MS)
  }

  function restart(): void {
    if (pollTimer !== null) timers.clearTimeout(pollTimer)
    if (chartTimer !== null) timers.clearTimeout(chartTimer)
    pollTimer = chartTimer = null
    void poll()
    runCharts()
  }

  return {
    id: 'cnbc',
    setSubscriptions(ids) {
      const next = symbolsOf(ids, 'us')
      if (sameMembers(next, symbols)) return
      const added = next.some((s) => !symbols.includes(s))
      symbols = next
      series.retain(next.map((s) => `us:${s}`))
      charts.retain(next)
      if (started && added) restart()
    },
    start() {
      if (started) return
      started = true
      restart()
    },
    stop() {
      started = false
      if (pollTimer !== null) timers.clearTimeout(pollTimer)
      if (chartTimer !== null) timers.clearTimeout(chartTimer)
      pollTimer = chartTimer = null
    },
    pollOnce,
    on: (event, cb) => events.on(event, cb),
    inSession: (_id, t) => usScheduledInSession(t)
  }
}
