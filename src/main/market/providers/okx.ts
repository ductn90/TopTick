import { z } from 'zod'
import { describeFailure } from '../../http'
import type { InstrumentId, Quote } from '../../../shared/types'
import {
  backoffDelay,
  KLINES_REFRESH_MS,
  REST_FALLBACK_AFTER_MS,
  REST_POLL_MS,
  RESUBSCRIBE_DEBOUNCE_MS
} from './binance'
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
import type { SendingWebSocketCtor, SendingWebSocketLike } from './ws'

export const OKX_WS = 'wss://ws.okx.com/ws/v5/public'
export const OKX_REST = 'https://www.okx.com/api/v5'
/** OKX closes a socket after 30 s without traffic; a text `ping` keeps it open. */
export const OKX_PING_MS = 25_000

const num = z.union([z.string(), z.number()]).transform(toNumber)

const tickerRowSchema = z.object({ instId: z.string(), last: num, open24h: num, ts: num })

const tickerMessageSchema = z.object({
  arg: z.object({ channel: z.literal('tickers') }),
  data: z.array(z.unknown())
})

const envelopeSchema = z.object({ code: z.string(), data: z.array(z.unknown()) })

// [ts, open, high, low, close, ...rest], newest first
const candlesSchema = z.array(z.tuple([num, num, num, num, num], z.unknown()))

/** `BTCUSDT` -> `BTC-USDT`; `null` for anything that is not a USDT pair. */
export function okxInstId(symbol: string): string | null {
  return symbol.length > 4 && symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}-USDT` : null
}

/** `BTC-USDT` -> `BTCUSDT` (the internal Binance-style symbol); `null` for other quotes. */
export function symbolFromInstId(instId: string): string | null {
  const m = /^([A-Z0-9]+)-USDT$/.exec(instId)
  return m ? `${m[1]}USDT` : null
}

/** One ticker row -> quote (`last` price, rolling-24h `open24h` reference, same basis as Binance). */
function quoteFromRow(item: unknown): Quote | null {
  const r = tickerRowSchema.safeParse(item)
  if (!r.success) return null
  const symbol = symbolFromInstId(r.data.instId)
  const { last, open24h, ts } = r.data
  if (!symbol || !isValidPrice(last) || !isValidPrice(open24h) || !Number.isFinite(ts)) return null
  return makeQuote(`crypto:${symbol}`, last, open24h, 'live', 'okx', ts)
}

/** A `tickers` channel push -> quotes; events (`subscribe`, `error`) and other messages -> `[]`. */
export function parseOkxTickerMessage(raw: unknown): Quote[] {
  const r = tickerMessageSchema.safeParse(raw)
  if (!r.success) return []
  return r.data.data.flatMap((item) => quoteFromRow(item) ?? [])
}

/** `GET /market/tickers?instType=SPOT` -> quotes for the wanted symbols; `null` unless `code` is `"0"`. */
export function parseOkxTickers(raw: unknown, wanted: ReadonlySet<string>): Quote[] | null {
  const r = envelopeSchema.safeParse(raw)
  if (!r.success || r.data.code !== '0') return null
  return r.data.data.flatMap((item) => {
    const q = quoteFromRow(item)
    return q && wanted.has(q.id.slice('crypto:'.length)) ? q : []
  })
}

/** `GET /market/candles` -> closes in time order, the first candle's open and the last open time. */
export function parseOkxCandles(raw: unknown): { closes: number[]; firstOpen: number; lastTime: number } | null {
  const env = envelopeSchema.safeParse(raw)
  if (!env.success || env.data.code !== '0') return null
  const r = candlesSchema.safeParse(env.data.data)
  if (!r.success || r.data.length === 0) return null
  const rows = [...r.data].sort((a, b) => a[0] - b[0])
  const closes = rows.map((k) => k[4])
  if (!closes.every(isValidPrice)) return null
  return { closes, firstOpen: rows[0]![1], lastTime: rows[rows.length - 1]![0] }
}

export interface OkxDeps extends ProviderDeps {
  WebSocket: SendingWebSocketCtor
  /** Defaults to `Math.random` (jitter). */
  random?: () => number
}

/**
 * OKX public spot data, the crypto backup. Same structure and timings as the
 * Binance provider: one socket subscribed to `tickers` for every mapped pair,
 * reconnect with backoff, REST polling (with `health`) after 10 s down, and
 * 15m x 96 candles every 5 min. Pairs OKX does not list get no quotes.
 */
export function createOkxProvider(deps: OkxDeps): PollingProvider {
  const { fetchJson, log, now, timers } = deps
  const random = deps.random ?? Math.random
  const events = new Emitter<ProviderEvents>()
  const series = new SeriesTracker()
  let symbols: string[] = []
  let started = false
  let ws: SendingWebSocketLike | null = null
  let connected = false
  let attempt = 0
  let reconnectTimer: unknown = null
  let resubscribeTimer: unknown = null
  let pingTimer: unknown = null
  let restTimer: unknown = null
  let candlesTimer: unknown = null

  const instIds = (): string[] => symbols.flatMap((s) => okxInstId(s) ?? [])

  function clear(handle: unknown): null {
    if (handle !== null) timers.clearTimeout(handle)
    return null
  }

  function emitQuote(q: Quote): void {
    if (!symbols.includes(q.id.slice('crypto:'.length))) return
    events.emit('quote', q)
    const s = series.applyQuote(q)
    if (s) events.emit('series', s)
  }

  function closeSocket(): void {
    const sock = ws
    ws = null
    connected = false
    pingTimer = clear(pingTimer)
    if (sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null
      try {
        sock.close()
      } catch {
        // already closed
      }
    }
  }

  function schedulePing(sock: SendingWebSocketLike): void {
    pingTimer = timers.setTimeout(() => {
      pingTimer = null
      if (ws !== sock || !connected) return
      try {
        sock.send('ping')
      } catch (err) {
        log.debug('okx: ping failed', err)
      }
      schedulePing(sock)
    }, OKX_PING_MS)
  }

  function connect(): void {
    reconnectTimer = clear(reconnectTimer)
    closeSocket()
    const args = instIds().map((instId) => ({ channel: 'tickers', instId }))
    if (!started || args.length === 0) return
    let sock: SendingWebSocketLike
    try {
      sock = new deps.WebSocket(OKX_WS)
    } catch (err) {
      log.warn('okx: websocket construction failed', err)
      onDown()
      return
    }
    ws = sock
    sock.onopen = () => {
      if (ws !== sock) return
      connected = true
      attempt = 0
      restTimer = clear(restTimer)
      try {
        sock.send(JSON.stringify({ op: 'subscribe', args }))
      } catch (err) {
        log.warn('okx: subscribe failed', err)
      }
      log.info(`okx: websocket connected (${args.length} tickers)`)
      events.emit('health', { ok: true })
      schedulePing(sock)
    }
    sock.onmessage = (ev) => {
      if (ws !== sock) return
      const text = String(ev.data)
      if (text === 'pong') return
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        log.debug('okx: non-JSON message ignored')
        return
      }
      const event = (raw as { event?: unknown } | null)?.event
      if (event === 'error') {
        // e.g. 60018 for a pair OKX does not list; the other subscriptions keep streaming.
        log.debug('okx: subscribe error', (raw as { msg?: unknown }).msg ?? '')
        return
      }
      for (const q of parseOkxTickerMessage(raw)) emitQuote(q)
    }
    sock.onerror = (ev) => {
      if (ws !== sock) return
      log.warn('okx: websocket error', (ev as { message?: unknown } | null)?.message ?? '')
    }
    sock.onclose = () => {
      if (ws !== sock) return
      log.info('okx: websocket closed')
      ws = null
      connected = false
      pingTimer = clear(pingTimer)
      onDown()
    }
  }

  /** Socket down: reconnect with backoff and, after 10 s, poll REST (which reports health). */
  function onDown(): void {
    if (!started) return
    reconnectTimer = clear(reconnectTimer)
    reconnectTimer = timers.setTimeout(connect, backoffDelay(attempt++, random))
    if (restTimer === null) restTimer = timers.setTimeout(pollRest, REST_FALLBACK_AFTER_MS)
  }

  async function pollRest(): Promise<void> {
    restTimer = null
    if (!started || connected || symbols.length === 0) return
    const ok = await pollOnce()
    if (started && !connected) events.emit('health', ok ? { ok } : { ok, error: 'okx rest failed' })
    if (started && !connected && restTimer === null) restTimer = timers.setTimeout(pollRest, REST_POLL_MS)
  }

  async function pollOnce(): Promise<boolean> {
    if (symbols.length === 0) return true
    const res = await fetchJson(`${OKX_REST}/market/tickers?instType=SPOT`, { provider: 'okx' })
    if (!res.ok) {
      log.debug(`okx: REST tickers failed (${describeFailure(res)})`)
      return false
    }
    const quotes = parseOkxTickers(res.data, new Set(symbols))
    if (!quotes) {
      log.warn('okx: REST tickers schema mismatch')
      return false
    }
    for (const q of quotes) emitQuote(q)
    return true
  }

  async function fetchCandles(symbol: string): Promise<void> {
    const instId = okxInstId(symbol)
    if (!instId) return
    const res = await fetchJson(`${OKX_REST}/market/candles?instId=${instId}&bar=15m&limit=96`, { provider: 'okx' })
    if (!res.ok) {
      log.debug(`okx: candles ${symbol} failed (${describeFailure(res)})`)
      return
    }
    const k = parseOkxCandles(res.data)
    if (!k) {
      log.debug(`okx: no candles for ${symbol}`)
      return
    }
    const id: InstrumentId = `crypto:${symbol}`
    if (!symbols.includes(symbol)) return
    events.emit('series', series.set(id, k.closes, k.firstOpen, now()))
  }

  function refreshCandles(only?: string[]): void {
    for (const s of only ?? symbols) void fetchCandles(s)
  }

  function scheduleCandles(): void {
    candlesTimer = clear(candlesTimer)
    candlesTimer = timers.setTimeout(() => {
      refreshCandles()
      scheduleCandles()
    }, KLINES_REFRESH_MS)
  }

  return {
    id: 'okx',
    setSubscriptions(ids) {
      const next = symbolsOf(ids, 'crypto')
      if (sameMembers(next, symbols)) return
      const added = next.filter((s) => !symbols.includes(s))
      symbols = next
      series.retain(next.map((s) => `crypto:${s}`))
      if (!started) return
      refreshCandles(added)
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
      refreshCandles()
      scheduleCandles()
    },
    stop() {
      started = false
      reconnectTimer = clear(reconnectTimer)
      resubscribeTimer = clear(resubscribeTimer)
      restTimer = clear(restTimer)
      candlesTimer = clear(candlesTimer)
      closeSocket()
    },
    pollOnce,
    on: (event, cb) => events.on(event, cb),
    inSession: () => true
  }
}
