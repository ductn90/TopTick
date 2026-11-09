import { z } from 'zod'
import { describeFailure } from '../../http'
import { isVnIndexSymbol } from '../../../shared/instruments'
import type { Quote } from '../../../shared/types'
import { ictDateKey, vnInSession, vnPollIntervalMs } from '../schedule'
import {
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

export const VIETCAP_BASE = 'https://trading.vietcap.com.vn/api'
export const VIETCAP_URLS = {
  quotes: `${VIETCAP_BASE}/price/symbols/getList`,
  indices: `${VIETCAP_BASE}/price/marketIndex/getList`,
  chart: `${VIETCAP_BASE}/chart/OHLCChart/gap-chart`,
  directory: `${VIETCAP_BASE}/price/symbols/getAll`
} as const

const quotesSchema = z.array(
  z.object({
    listingInfo: z.object({
      symbol: z.string(),
      refPrice: z.number(),
      ceiling: z.number().nullish(),
      floor: z.number().nullish()
    }),
    matchPrice: z.object({ matchPrice: z.number().nullish(), time: z.string().nullish() }).nullish()
  })
)

const indicesSchema = z.array(
  z.object({
    symbol: z.string(),
    price: z.number(),
    refPrice: z.number(),
    change: z.number(),
    changePercent: z.number(),
    time: z.string().nullish()
  })
)

const gapChartSchema = z.array(
  z.object({
    symbol: z.string(),
    c: z.array(z.number()),
    t: z.array(z.union([z.string(), z.number()]))
  })
)

const directorySchema = z.array(
  z.object({
    symbol: z.string(),
    type: z.string(),
    board: z.string(),
    organShortName: z.string().nullish(),
    enOrganShortName: z.string().nullish(),
    enOrganName: z.string().nullish()
  })
)

function parseTime(value: string | null | undefined, fallback: number): number {
  const t = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(t) && t > 0 ? t : fallback
}

export interface PriceLimits {
  ceiling?: number | null
  floor?: number | null
}

/**
 * VN pre-open rule: a zero price means no match yet today, so the quote shows
 * the reference price with zero change and `state: 'preopen'`. Valid ceiling/floor
 * prices are kept on the quote; invalid or missing ones are left out.
 */
export function vnQuote(
  id: string,
  price: number,
  refPrice: number,
  source: Quote['source'],
  now: number,
  updatedAt: number,
  limits: PriceLimits = {}
): Quote | null {
  if (!isValidPrice(refPrice)) return null
  if (price !== 0 && !isValidPrice(price)) return null
  const q =
    price === 0
      ? makeQuote(id, refPrice, refPrice, 'preopen', source, updatedAt)
      : makeQuote(id, price, refPrice, vnInSession(now) ? 'live' : 'closed', source, updatedAt)
  if (isValidPrice(limits.ceiling)) q.ceiling = limits.ceiling
  if (isValidPrice(limits.floor)) q.floor = limits.floor
  return q
}

/** `POST /price/symbols/getList` -> stock quotes; `null` when the payload is invalid. */
export function parseVietcapQuotes(raw: unknown, now: number): Quote[] | null {
  const r = quotesSchema.safeParse(raw)
  if (!r.success) return null
  return r.data.flatMap((row) => {
    const price = row.matchPrice?.matchPrice ?? 0
    const updatedAt = parseTime(row.matchPrice?.time, now)
    const { symbol, refPrice, ceiling, floor } = row.listingInfo
    return vnQuote(`vn:${symbol}`, price, refPrice, 'vietcap', now, updatedAt, { ceiling, floor }) ?? []
  })
}

/** `POST /price/marketIndex/getList` -> index quotes (Vietcap codes, e.g. `vn:HNXIndex`). */
export function parseVietcapIndices(raw: unknown, now: number): Quote[] | null {
  const r = indicesSchema.safeParse(raw)
  if (!r.success) return null
  return r.data.flatMap((row) => vnQuote(`vn:${row.symbol}`, row.price, row.refPrice, 'vietcap', now, parseTime(row.time, now)) ?? [])
}

/** `POST /chart/OHLCChart/gap-chart` (one symbol) -> closes of the latest ICT trading day. */
export function parseGapChart(raw: unknown): { symbol: string; points: number[]; lastTime: number } | null {
  const r = gapChartSchema.safeParse(raw)
  if (!r.success) return null
  const row = r.data[0]
  if (!row || row.t.length === 0 || row.t.length !== row.c.length) return null
  const times = row.t.map((t) => Number(t) * 1000)
  const lastTime = times[times.length - 1]!
  if (!Number.isFinite(lastTime)) return null
  const day = ictDateKey(lastTime)
  const points = row.c.filter((c, i) => ictDateKey(times[i]!) === day && isValidPrice(c))
  return points.length > 0 ? { symbol: row.symbol, points, lastTime } : null
}

export type VnBoard = 'HSX' | 'HNX' | 'UPCOM'

export interface VnDirectoryEntry {
  symbol: string
  kind: 'stock' | 'etf'
  board: VnBoard
  nameVi: string
  nameEn: string
}

/** `GET /price/symbols/getAll` -> STOCK/ETF rows listed on HSX, HNX or UPCOM. */
export function parseVietcapDirectory(raw: unknown): VnDirectoryEntry[] | null {
  const r = directorySchema.safeParse(raw)
  if (!r.success) return null
  return r.data.flatMap((row) => {
    if (row.type !== 'STOCK' && row.type !== 'ETF') return []
    if (row.board !== 'HSX' && row.board !== 'HNX' && row.board !== 'UPCOM') return []
    const nameVi = row.organShortName ?? row.symbol
    return [
      {
        symbol: row.symbol,
        kind: row.type === 'ETF' ? 'etf' : 'stock',
        board: row.board,
        nameVi,
        nameEn: row.enOrganShortName ?? row.enOrganName ?? nameVi
      }
    ]
  })
}

export const CHART_STAGGER_MS = 250
export const CHART_REFRESH_MS = 60_000

/**
 * Per-symbol chart refresh rule shared by the VN providers: every 60 s in
 * session, and once out of session (one more fetch after a session ends).
 */
export class ChartSchedule {
  private readonly last = new Map<string, { inSession: boolean }>()

  due(symbol: string, inSession: boolean): boolean {
    const prev = this.last.get(symbol)
    return inSession || !prev || prev.inSession
  }

  mark(symbol: string, inSession: boolean): void {
    this.last.set(symbol, { inSession })
  }

  retain(symbols: string[]): void {
    for (const s of [...this.last.keys()]) if (!symbols.includes(s)) this.last.delete(s)
  }
}

export function createVietcapProvider(deps: ProviderDeps): PollingProvider {
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

  async function fetchList(url: string, body: unknown, parse: (raw: unknown, now: number) => Quote[] | null, what: string): Promise<boolean> {
    const res = await fetchJson(url, { method: 'POST', body, provider: 'vietcap' })
    if (!res.ok) {
      log.debug(`vietcap: ${what} failed (${describeFailure(res)})`)
      return false
    }
    const quotes = parse(res.data, now())
    if (!quotes) {
      log.warn(`vietcap: ${what} schema mismatch`)
      return false
    }
    for (const q of quotes) emitQuote(q)
    return true
  }

  async function pollOnce(): Promise<boolean> {
    const s = stocks()
    const i = indices()
    const results = await Promise.all([
      s.length > 0 ? fetchList(VIETCAP_URLS.quotes, { symbols: s }, parseVietcapQuotes, 'quotes') : true,
      i.length > 0 ? fetchList(VIETCAP_URLS.indices, { symbols: i }, parseVietcapIndices, 'indices') : true
    ])
    const ok = results.every(Boolean)
    if (!ok && !failing) log.warn('vietcap: poll cycle failed')
    failing = !ok
    return ok
  }

  async function poll(): Promise<void> {
    pollTimer = null
    if (!started) return
    if (symbols.length > 0) {
      const ok = await pollOnce()
      if (!started) return
      events.emit('health', ok ? { ok } : { ok, error: 'vietcap poll failed' })
    }
    if (started && pollTimer === null) pollTimer = timers.setTimeout(() => void poll(), vnPollIntervalMs('vietcap', now()))
  }

  async function fetchChart(symbol: string, inSession: boolean): Promise<void> {
    const res = await fetchJson(VIETCAP_URLS.chart, {
      method: 'POST',
      body: { timeFrame: 'ONE_MINUTE', symbols: [symbol], to: Math.floor(now() / 1000), countBack: 300 },
      provider: 'vietcap'
    })
    if (!res.ok) {
      log.debug(`vietcap: chart ${symbol} failed (${describeFailure(res)})`)
      return
    }
    const parsed = parseGapChart(res.data)
    if (!parsed || !symbols.includes(symbol)) return
    charts.mark(symbol, inSession)
    events.emit('series', series.set(`vn:${symbol}`, parsed.points, parsed.points[0]!, parsed.lastTime))
  }

  function runCharts(): void {
    chartTimer = null
    if (!started) return
    const inSession = vnInSession(now())
    const due = symbols.filter((s) => charts.due(s, inSession))
    due.forEach((s, i) => {
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
    id: 'vietcap',
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
