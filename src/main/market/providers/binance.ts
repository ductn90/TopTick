import { z } from 'zod'
import { describeFailure } from '../../http'
import type { InstrumentId, Quote } from '../../../shared/types'
import {
  Emitter,
  isValidPrice,
  makeQuote,
  sameMembers,
  SeriesTracker,
  symbolsOf,
  toNumber,
  type PollingProvider,
  type ProviderDeps,
  type ProviderEvents
} from './types'

export const BINANCE_WS = 'wss://stream.binance.com:9443/stream'
export const BINANCE_REST = 'https://api.binance.com/api/v3'

/** Minimal WebSocket surface used here (Node/Electron global `WebSocket` satisfies it). */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  close(): void
}
export type WebSocketCtor = new (url: string) => WebSocketLike

const num = z.union([z.string(), z.number()]).transform(toNumber)

const miniTickerSchema = z.object({
  stream: z.string(),
  data: z.object({ s: z.string(), c: num, o: num, E: z.number() })
})

const ticker24hrSchema = z.array(
  z.object({ symbol: z.string(), lastPrice: num, openPrice: num, closeTime: z.number() })
)

// [openTime, open, high, low, close, ...rest]
const klinesSchema = z.array(z.tuple([z.number(), num, num, num, num], z.unknown()))

const exchangeInfoSchema = z.object({
  symbols: z.array(z.object({ symbol: z.string(), status: z.string(), baseAsset: z.string(), quoteAsset: z.string() }))
})

function quoteFrom(symbol: string, last: number, open: number, updatedAt: number): Quote | null {
  if (!isValidPrice(last) || !isValidPrice(open)) return null
  return makeQuote(`crypto:${symbol}`, last, open, 'live', 'binance', updatedAt)
}

/** One combined-stream miniTicker message -> quote (`c` price, `o` rolling-24h open). */
export function parseMiniTicker(raw: unknown): Quote | null {
  const r = miniTickerSchema.safeParse(raw)
  if (!r.success) return null
  const d = r.data.data
  return quoteFrom(d.s, d.c, d.o, d.E)
}

/** `GET /ticker/24hr?symbols=[...]` -> quotes; `null` when the payload is invalid. */
export function parseTicker24hr(raw: unknown): Quote[] | null {
  const r = ticker24hrSchema.safeParse(raw)
  if (!r.success) return null
  return r.data.flatMap((t) => quoteFrom(t.symbol, t.lastPrice, t.openPrice, t.closeTime) ?? [])
}

/** `GET /klines` -> closes in time order, the first candle's open and the last open time. */
export function parseKlines(raw: unknown): { closes: number[]; firstOpen: number; lastTime: number } | null {
  const r = klinesSchema.safeParse(raw)
  if (!r.success || r.data.length === 0) return null
  const closes = r.data.map((k) => k[4])
  if (!closes.every(isValidPrice)) return null
  return { closes, firstOpen: r.data[0]![1], lastTime: r.data[r.data.length - 1]![0] }
}

/** `GET /exchangeInfo` -> `TRADING` USDT pairs. */
export function parseExchangeInfo(raw: unknown): { symbol: string; base: string }[] | null {
  const r = exchangeInfoSchema.safeParse(raw)
  if (!r.success) return null
  return r.data.symbols
    .filter((s) => s.quoteAsset === 'USDT' && s.status === 'TRADING')
    .map((s) => ({ symbol: s.symbol, base: s.baseAsset }))
}

export function streamUrl(symbols: string[]): string {
  return `${BINANCE_WS}?streams=${symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join('/')}`
}

export const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16_000, 30_000] as const
export const RESUBSCRIBE_DEBOUNCE_MS = 500
export const PROACTIVE_RECONNECT_MS = 23 * 3600_000
export const REST_FALLBACK_AFTER_MS = 10_000
export const REST_POLL_MS = 5000
export const KLINES_REFRESH_MS = 5 * 60_000

/** Reconnect delay for the n-th consecutive attempt (0-based), with ±20 % jitter. */
export function backoffDelay(attempt: number, random: () => number): number {
  const base = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)]!
  return Math.round(base * (1 + (random() * 2 - 1) * 0.2))
}

export interface BinanceDeps extends ProviderDeps {
  WebSocket: WebSocketCtor
  /** Defaults to `Math.random` (jitter). */
  random?: () => number
}

export interface BinanceProvider extends PollingProvider {
  /** True while the WebSocket is open. */
  readonly connected: boolean
}

export function createBinanceProvider(deps: BinanceDeps): BinanceProvider {
  const { fetchJson, log, now, timers } = deps
  const random = deps.random ?? Math.random
  const events = new Emitter<ProviderEvents>()
  const series = new SeriesTracker()

  let symbols: string[] = []
  let started = false
  let ws: WebSocketLike | null = null
  let connected = false
  let attempt = 0
  let reconnectTimer: unknown = null
  let resubscribeTimer: unknown = null
  let proactiveTimer: unknown = null
  let restTimer: unknown = null
  let klinesTimer: unknown = null

  function clear(handle: unknown): null {
    if (handle !== null) timers.clearTimeout(handle)
    return null
  }

  function emitQuote(q: Quote): void {
    events.emit('quote', q)
    const s = series.applyQuote(q)
    if (s) events.emit('series', s)
  }

  function closeSocket(): void {
    const sock = ws
    ws = null
    connected = false
    proactiveTimer = clear(proactiveTimer)
    if (sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null
      try {
        sock.close()
      } catch {
        // already closed
      }
    }
  }

  function connect(): void {
    reconnectTimer = clear(reconnectTimer)
    closeSocket()
    if (!started || symbols.length === 0) return
    let sock: WebSocketLike
    try {
      sock = new deps.WebSocket(streamUrl(symbols))
    } catch (err) {
      log.warn('binance: websocket construction failed', err)
      onDown()
      return
    }
    ws = sock
    sock.onopen = () => {
      if (ws !== sock) return
      connected = true
      attempt = 0
      restTimer = clear(restTimer)
      log.info(`binance: websocket connected (${symbols.length} streams)`)
      events.emit('health', { ok: true })
      proactiveTimer = timers.setTimeout(() => {
        log.info('binance: proactive 23 h reconnect')
        connect()
      }, PROACTIVE_RECONNECT_MS)
    }
    sock.onmessage = (ev) => {
      if (ws !== sock) return
      let raw: unknown
      try {
        raw = JSON.parse(String(ev.data))
      } catch {
        log.debug('binance: non-JSON message ignored')
        return
      }
      const q = parseMiniTicker(raw)
      if (q) emitQuote(q)
    }
    sock.onerror = (ev) => {
      if (ws !== sock) return
      log.warn('binance: websocket error', (ev as { message?: unknown } | null)?.message ?? '')
    }
    sock.onclose = () => {
      if (ws !== sock) return
      log.info('binance: websocket closed')
      ws = null
      connected = false
      proactiveTimer = clear(proactiveTimer)
      onDown()
    }
  }

  /** WebSocket is down: schedule a reconnect and, after 10 s, REST polling. */
  function onDown(): void {
    if (!started) return
    events.emit('health', { ok: false, error: 'websocket down' })
    const delay = backoffDelay(attempt++, random)
    reconnectTimer = clear(reconnectTimer)
    reconnectTimer = timers.setTimeout(connect, delay)
    if (restTimer === null) restTimer = timers.setTimeout(pollRest, REST_FALLBACK_AFTER_MS)
  }

  async function pollRest(): Promise<void> {
    restTimer = null
    if (!started || connected || symbols.length === 0) return
    await pollOnce()
    if (started && !connected && restTimer === null) restTimer = timers.setTimeout(pollRest, REST_POLL_MS)
  }

  async function pollOnce(): Promise<boolean> {
    if (symbols.length === 0) return true
    const url = `${BINANCE_REST}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`
    const res = await fetchJson(url, { provider: 'binance' })
    if (!res.ok) {
      log.debug(`binance: REST 24hr failed (${describeFailure(res)})`)
      return false
    }
    const quotes = parseTicker24hr(res.data)
    if (!quotes) {
      log.warn('binance: REST 24hr schema mismatch')
      return false
    }
    for (const q of quotes) emitQuote(q)
    return true
  }

  async function fetchKlines(symbol: string): Promise<void> {
    const res = await fetchJson(`${BINANCE_REST}/klines?symbol=${symbol}&interval=15m&limit=96`, {
      provider: 'binance'
    })
    if (!res.ok) {
      log.debug(`binance: klines ${symbol} failed (${describeFailure(res)})`)
      return
    }
    const k = parseKlines(res.data)
    if (!k) {
      log.warn(`binance: klines ${symbol} schema mismatch`)
      return
    }
    const id: InstrumentId = `crypto:${symbol}`
    if (!symbols.includes(symbol)) return
    events.emit('series', series.set(id, k.closes, k.firstOpen, now()))
  }

  function refreshKlines(only?: string[]): void {
    for (const s of only ?? symbols) void fetchKlines(s)
  }

  function scheduleKlines(): void {
    klinesTimer = clear(klinesTimer)
    klinesTimer = timers.setTimeout(() => {
      refreshKlines()
      scheduleKlines()
    }, KLINES_REFRESH_MS)
  }

  return {
    id: 'binance',
    get connected() {
      return connected
    },
    setSubscriptions(ids) {
      const next = symbolsOf(ids, 'crypto')
      if (sameMembers(next, symbols)) return
      const added = next.filter((s) => !symbols.includes(s))
      symbols = next
      series.retain(next.map((s) => `crypto:${s}`))
      if (!started) return
      refreshKlines(added)
      resubscribeTimer = clear(resubscribeTimer)
      resubscribeTimer = timers.setTimeout(() => {
        resubscribeTimer = null
        attempt = 0
        connect()
      }, RESUBSCRIBE_DEBOUNCE_MS)
    },
    start() {
      if (started) return
      started = true
      connect()
      refreshKlines()
      scheduleKlines()
    },
    stop() {
      started = false
      reconnectTimer = clear(reconnectTimer)
      resubscribeTimer = clear(resubscribeTimer)
      restTimer = clear(restTimer)
      klinesTimer = clear(klinesTimer)
      closeSocket()
    },
    pollOnce,
    on: (event, cb) => events.on(event, cb),
    inSession: () => true
  }
}
