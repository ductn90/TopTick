import { z } from 'zod'
import { describeFailure } from '../../http'
import { isVnIndexSymbol } from '../../../shared/instruments'
import type { Quote } from '../../../shared/types'
import { ICT_OFFSET_MS, vnInSession, vnPollIntervalMs } from '../schedule'
import {
  Emitter,
  sameMembers,
  SeriesTracker,
  symbolsOf,
  type PollingProvider,
  type ProviderDeps,
  type ProviderEvents
} from './types'
import { CHART_REFRESH_MS, CHART_STAGGER_MS, ChartSchedule, vnQuote } from './vietcap'

export const CAFEF_BOARD_URL = 'https://banggia.cafef.vn/stockhandler.ashx'
export const CAFEF_CHART_URL = 'https://msh-appdata.cafef.vn/rest-api/api/v1/TradingViewsData'

/** CafeF board ids: 1 = HOSE, 2 = HNX, 9 = UPCOM. */
export type CafefBoard = 1 | 2 | 9
export const CAFEF_BOARDS: readonly CafefBoard[] = [1, 2, 9]

/** a = symbol, b = reference, c = ceiling, d = floor, l = last, k = change (thousand VND). */
const boardRowSchema = z.object({
  a: z.string(),
  b: z.number(),
  c: z.number().nullish(),
  d: z.number().nullish(),
  l: z.number(),
  k: z.number(),
  Time: z.string().nullish()
})

const indexSchema = z.array(
  z.object({ name: z.string(), index: z.string(), change: z.string(), percent: z.string() })
)

const chartSchema = z.object({
  succeeded: z.boolean(),
  data: z.object({
    value: z
      .object({ dataInfor: z.array(z.object({ close: z.number(), time: z.number() })) })
      .nullish()
  })
})

/** CafeF index names -> internal Vietcap codes. */
const INDEX_CODES: Record<string, string> = {
  VNINDEX: 'VNINDEX',
  VN30: 'VN30',
  HNXINDEX: 'HNXIndex',
  HNX30: 'HNX30',
  HNXUPCOMINDEX: 'HNXUpcomIndex'
}

/** Values are in thousand VND (e.g. 53.9 -> 53,900). */
const kVnd = (x: number): number => Math.round(x * 1000)

const parseCommaNumber = (s: string): number => (s.trim() === '' ? Number.NaN : Number(s.replace(/,/g, '')))

/** `"HH:mm dd/MM/yyyy"` in ICT -> epoch ms; `null` for placeholders such as `07:00 01/01/0001`. */
export function parseCafefTime(value: string | null | undefined): number | null {
  const m = value?.match(/^(\d{1,2}):(\d{2}) (\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const [, hh, mm, dd, mo, yyyy] = m.map(Number) as [number, number, number, number, number, number]
  if (yyyy < 2000) return null
  return Date.UTC(yyyy, mo - 1, dd, hh, mm) - ICT_OFFSET_MS
}

/**
 * `stockhandler.ashx?center=N` -> quotes for the wanted symbols only. Rows are
 * validated individually so one odd row elsewhere on the board does not fail it.
 */
export function parseCafefBoard(raw: unknown, wanted: ReadonlySet<string>, now: number): Quote[] | null {
  if (!Array.isArray(raw)) return null
  const out: Quote[] = []
  for (const item of raw) {
    const sym = (item as { a?: unknown } | null)?.a
    if (typeof sym !== 'string' || !wanted.has(sym)) continue
    const r = boardRowSchema.safeParse(item)
    if (!r.success) continue
    const { b, c, d, l, Time } = r.data
    const limits = { ceiling: c == null ? null : kVnd(c), floor: d == null ? null : kVnd(d) }
    const q = vnQuote(`vn:${sym}`, kVnd(l), kVnd(b), 'cafef', now, parseCafefTime(Time) ?? now, limits)
    if (q) out.push(q)
  }
  return out
}

/** `stockhandler.ashx?index=true` -> index quotes; comma-formatted strings, `refPrice = index − change`. */
export function parseCafefIndices(raw: unknown, now: number): Quote[] | null {
  const r = indexSchema.safeParse(raw)
  if (!r.success) return null
  return r.data.flatMap((row) => {
    const code = INDEX_CODES[row.name.toUpperCase()]
    if (!code) return []
    const price = parseCommaNumber(row.index)
    const change = parseCommaNumber(row.change)
    if (!Number.isFinite(price) || !Number.isFinite(change)) return []
    const refPrice = Math.round((price - change) * 100) / 100
    return vnQuote(`vn:${code}`, price, refPrice, 'cafef', now, now) ?? []
  })
}

/**
 * `TradingViewsData?type=1` (15-min bars, newest first) -> closes of the latest
 * day in time order. `time` encodes ICT wall-clock time as if it were UTC.
 */
export function parseCafefChart(raw: unknown): { points: number[]; lastTime: number } | null {
  const r = chartSchema.safeParse(raw)
  if (!r.success || !r.data.succeeded) return null
  const rows = [...(r.data.data.value?.dataInfor ?? [])].sort((x, y) => x.time - y.time)
  const last = rows[rows.length - 1]
  if (!last) return null
  const day = new Date(last.time * 1000).toISOString().slice(0, 10)
  const points = rows
    .filter((row) => new Date(row.time * 1000).toISOString().slice(0, 10) === day && row.close > 0)
    .map((row) => kVnd(row.close))
  return points.length > 0 ? { points, lastTime: last.time * 1000 - ICT_OFFSET_MS } : null
}

export interface CafefDeps extends ProviderDeps {
  /** Board of a stock from the cached directory; `undefined` -> fetch all three boards. */
  boardOf?: (symbol: string) => CafefBoard | undefined
}

export function createCafefProvider(deps: CafefDeps): PollingProvider {
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
  const hasIndices = (): boolean => symbols.some(isVnIndexSymbol)

  function emitQuote(q: Quote): void {
    events.emit('quote', q)
    const s = series.applyQuote(q)
    if (s) events.emit('series', s)
  }

  function boardsFor(list: string[]): CafefBoard[] {
    const boards = new Set<CafefBoard>()
    for (const s of list) {
      const b = deps.boardOf?.(s)
      if (b === undefined) return [...CAFEF_BOARDS]
      boards.add(b)
    }
    return [...boards]
  }

  async function fetchBoard(board: CafefBoard, wanted: Set<string>): Promise<boolean> {
    const res = await fetchJson(`${CAFEF_BOARD_URL}?center=${board}`, { provider: 'cafef' })
    if (!res.ok) {
      log.debug(`cafef: board ${board} failed (${describeFailure(res)})`)
      return false
    }
    const quotes = parseCafefBoard(res.data, wanted, now())
    if (!quotes) {
      log.warn(`cafef: board ${board} schema mismatch`)
      return false
    }
    for (const q of quotes) emitQuote(q)
    return true
  }

  async function fetchIndices(): Promise<boolean> {
    const res = await fetchJson(`${CAFEF_BOARD_URL}?index=true`, { provider: 'cafef' })
    if (!res.ok) {
      log.debug(`cafef: indices failed (${describeFailure(res)})`)
      return false
    }
    const quotes = parseCafefIndices(res.data, now())
    if (!quotes) {
      log.warn('cafef: indices schema mismatch')
      return false
    }
    const wanted = new Set(symbols)
    for (const q of quotes) if (wanted.has(q.id.slice(3))) emitQuote(q)
    return true
  }

  async function pollOnce(): Promise<boolean> {
    const list = stocks()
    const wanted = new Set(list)
    const tasks: Promise<boolean>[] = list.length > 0 ? boardsFor(list).map((b) => fetchBoard(b, wanted)) : []
    if (hasIndices()) tasks.push(fetchIndices())
    const ok = (await Promise.all(tasks)).every(Boolean)
    if (!ok && !failing) log.warn('cafef: poll cycle failed')
    failing = !ok
    return ok
  }

  async function poll(): Promise<void> {
    pollTimer = null
    if (!started) return
    if (symbols.length > 0) {
      const ok = await pollOnce()
      if (!started) return
      events.emit('health', ok ? { ok } : { ok, error: 'cafef poll failed' })
    }
    if (started && pollTimer === null) pollTimer = timers.setTimeout(() => void poll(), vnPollIntervalMs('cafef', now()))
  }

  async function fetchChart(symbol: string, inSession: boolean): Promise<void> {
    const res = await fetchJson(`${CAFEF_CHART_URL}?symbol=${encodeURIComponent(symbol)}&type=1`, { provider: 'cafef' })
    if (!res.ok) {
      log.debug(`cafef: chart ${symbol} failed (${describeFailure(res)})`)
      return
    }
    const parsed = parseCafefChart(res.data)
    if (!parsed || !symbols.includes(symbol)) return
    charts.mark(symbol, inSession)
    events.emit('series', series.set(`vn:${symbol}`, parsed.points, parsed.points[0]!, parsed.lastTime))
  }

  /** Stocks only: CafeF has no intraday index data, so index sparklines keep their cached series. */
  function runCharts(): void {
    chartTimer = null
    if (!started) return
    const inSession = vnInSession(now())
    stocks()
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
    id: 'cafef',
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
