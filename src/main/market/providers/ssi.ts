import { z } from 'zod'
import { describeFailure } from '../../http'
import { isVnIndexSymbol } from '../../../shared/instruments'
import type { Quote } from '../../../shared/types'
import { ictDateKey, vnInSession, vnPollIntervalMs } from '../schedule'
import {
  Emitter,
  isValidPrice,
  sameMembers,
  SeriesTracker,
  symbolsOf,
  type PollingProvider,
  type ProviderDeps,
  type ProviderEvents
} from './types'
import { CHART_REFRESH_MS, CHART_STAGGER_MS, ChartSchedule, vnQuote } from './vietcap'

export const SSI_URLS = {
  stocks: 'https://iboard-query.ssi.com.vn/stock/multiple',
  indices: 'https://iboard-query.ssi.com.vn/exchange-index/multiple',
  chart: 'https://iboard-api.ssi.com.vn/statistics/charts/history'
} as const

/**
 * Chart symbol per internal index id. The mixed-case `HNXIndex` / `HNXUpcomIndex`
 * charts come back divided by 1000; the upper-case names return true values.
 */
export const SSI_INDEX_CHART_SYMBOL: Readonly<Record<string, string>> = {
  VNINDEX: 'VNINDEX',
  VN30: 'VN30',
  HNXIndex: 'HNXINDEX',
  HNX30: 'HNX30',
  HNXUpcomIndex: 'HNXUPCOMINDEX'
}

/** Chart history window: enough to reach the previous session over a weekend. */
export const SSI_CHART_WINDOW_S = 4 * 86_400

const envelopeSchema = z.object({ code: z.string(), data: z.array(z.unknown()) })

/** Prices in VND. */
const stockRowSchema = z.object({
  stockSymbol: z.string(),
  refPrice: z.number(),
  ceiling: z.number().nullish(),
  floor: z.number().nullish(),
  matchedPrice: z.number().nullish()
})

const indexRowSchema = z.object({
  indexId: z.string(),
  indexValue: z.number(),
  prevIndexValue: z.number(),
  time: z.number().nullish()
})

const chartSchema = z.object({
  code: z.string(),
  data: z.object({ t: z.array(z.number()), c: z.array(z.number()) })
})

function rows(raw: unknown): unknown[] | null {
  const r = envelopeSchema.safeParse(raw)
  return r.success && r.data.code === 'SUCCESS' ? r.data.data : null
}

/**
 * `POST /stock/multiple` -> stock/ETF quotes in VND with ceiling and floor.
 * Unknown symbols are simply absent. The payload has no per-stock trade time,
 * so `updatedAt` is the fetch time. Rows are validated individually.
 */
export function parseSsiStocks(raw: unknown, now: number): Quote[] | null {
  const list = rows(raw)
  if (!list) return null
  return list.flatMap((item) => {
    const r = stockRowSchema.safeParse(item)
    if (!r.success) return []
    const { stockSymbol, refPrice, ceiling, floor, matchedPrice } = r.data
    return vnQuote(`vn:${stockSymbol}`, matchedPrice ?? 0, refPrice, 'ssi', now, now, { ceiling, floor }) ?? []
  })
}

/** `POST /exchange-index/multiple` -> index quotes; SSI uses the internal ids (`HNXIndex`, ...). */
export function parseSsiIndices(raw: unknown, now: number): Quote[] | null {
  const list = rows(raw)
  if (!list) return null
  return list.flatMap((item) => {
    const r = indexRowSchema.safeParse(item)
    if (!r.success) return []
    const { indexId, indexValue, prevIndexValue, time } = r.data
    const updatedAt = time != null && time > 0 ? time : now
    return vnQuote(`vn:${indexId}`, indexValue, prevIndexValue, 'ssi', now, updatedAt) ?? []
  })
}

/**
 * `GET /statistics/charts/history?resolution=1` -> closes of the latest ICT day
 * in time order, multiplied by `scale` (1000 for stocks/ETFs, which come in
 * thousand VND; 1 for indices).
 */
export function parseSsiChart(raw: unknown, scale: number): { points: number[]; lastTime: number } | null {
  const r = chartSchema.safeParse(raw)
  if (!r.success || r.data.code !== 'SUCCESS') return null
  const { t, c } = r.data.data
  if (t.length === 0 || t.length !== c.length) return null
  const lastTime = t[t.length - 1]! * 1000
  const day = ictDateKey(lastTime)
  const points: number[] = []
  t.forEach((s, i) => {
    const close = c[i]!
    if (ictDateKey(s * 1000) === day && isValidPrice(close)) points.push(scale === 1 ? close : Math.round(close * scale))
  })
  return points.length > 0 ? { points, lastTime } : null
}

export function createSsiProvider(deps: ProviderDeps): PollingProvider {
  const { fetchJson, log, now, timers } = deps
  const events = new Emitter<ProviderEvents>()
  const series = new SeriesTracker()
  const charts = new ChartSchedule()
  let symbols: string[] = []
  let started = false
  let pollTimer: unknown = null
  let chartTimer: unknown = null
  let failing = false

  const stocks = (): string[] => symbols.filter((s) => !isVnIndexSymbol(s))
  const indices = (): string[] => symbols.filter(isVnIndexSymbol)

  function emitQuote(q: Quote): void {
    events.emit('quote', q)
    const s = series.applyQuote(q)
    if (s) events.emit('series', s)
  }

  async function fetchList(
    url: string,
    body: unknown,
    parse: (raw: unknown, now: number) => Quote[] | null,
    what: string
  ): Promise<boolean> {
    const res = await fetchJson(url, { method: 'POST', body, provider: 'ssi' })
    if (!res.ok) {
      log.debug(`ssi: ${what} failed (${describeFailure(res)})`)
      return false
    }
    const quotes = parse(res.data, now())
    if (!quotes) {
      log.warn(`ssi: ${what} schema mismatch`)
      return false
    }
    const wanted = new Set(symbols)
    for (const q of quotes) if (wanted.has(q.id.slice(3))) emitQuote(q)
    return true
  }

  async function pollOnce(): Promise<boolean> {
    const s = stocks()
    const i = indices()
    const results = await Promise.all([
      s.length > 0 ? fetchList(SSI_URLS.stocks, { stocks: s }, parseSsiStocks, 'stocks') : true,
      i.length > 0 ? fetchList(SSI_URLS.indices, { indexIds: i }, parseSsiIndices, 'indices') : true
    ])
    const ok = results.every(Boolean)
    if (!ok && !failing) log.warn('ssi: poll cycle failed')
    failing = !ok
    return ok
  }

  async function poll(): Promise<void> {
    pollTimer = null
    if (!started) return
    if (symbols.length > 0) {
      const ok = await pollOnce()
      if (!started) return
      events.emit('health', ok ? { ok } : { ok, error: 'ssi poll failed' })
    }
    if (started && pollTimer === null) pollTimer = timers.setTimeout(() => void poll(), vnPollIntervalMs('ssi', now()))
  }

  async function fetchChart(symbol: string, inSession: boolean): Promise<void> {
    const index = isVnIndexSymbol(symbol)
    const chartSymbol = index ? (SSI_INDEX_CHART_SYMBOL[symbol] ?? symbol) : symbol
    const to = Math.floor(now() / 1000)
    const url = `${SSI_URLS.chart}?resolution=1&symbol=${encodeURIComponent(chartSymbol)}&from=${to - SSI_CHART_WINDOW_S}&to=${to}`
    const res = await fetchJson(url, { provider: 'ssi' })
    if (!res.ok) {
      log.debug(`ssi: chart ${symbol} failed (${describeFailure(res)})`)
      return
    }
    const parsed = parseSsiChart(res.data, index ? 1 : 1000)
    if (!parsed || !symbols.includes(symbol)) return
    charts.mark(symbol, inSession)
    events.emit('series', series.set(`vn:${symbol}`, parsed.points, parsed.points[0]!, parsed.lastTime))
  }

  function runCharts(): void {
    chartTimer = null
    if (!started) return
    const inSession = vnInSession(now())
    symbols
      .filter((s) => charts.due(s, inSession))
      .forEach((s, i) => {
        timers.setTimeout(() => {
          if (started && symbols.includes(s)) void fetchChart(s, inSession)
        }, i * CHART_STAGGER_MS)
      })
    chartTimer = timers.setTimeout(runCharts, CHART_REFRESH_MS)
  }

  function restart(): void {
    if (pollTimer !== null) timers.clearTimeout(pollTimer)
    if (chartTimer !== null) timers.clearTimeout(chartTimer)
    pollTimer = chartTimer = null
    void poll()
    runCharts()
  }

  return {
    id: 'ssi',
    setSubscriptions(ids) {
      const next = symbolsOf(ids, 'vn')
      if (sameMembers(next, symbols)) return
      const added = next.some((s) => !symbols.includes(s))
      symbols = next
      series.retain(next.map((s) => `vn:${s}`))
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
    inSession: (_id, t) => vnInSession(t)
  }
}
