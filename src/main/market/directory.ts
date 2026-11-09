import fs from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { describeFailure, type FetchJson } from '../http'
import type { Logger } from '../log'
import { createDefaults } from '../settings/defaults'
import { cryptoName, displaySymbol, INSTRUMENT_ID_RE, VN_INDEX_INSTRUMENTS } from '../../shared/instruments'
import type { Instrument, Market, SearchMarket } from '../../shared/types'
import { BINANCE_REST, parseExchangeInfo } from './providers/binance'
import type { CafefBoard } from './providers/cafef'
import { parseVietcapDirectory, VIETCAP_URLS, type VnDirectoryEntry } from './providers/vietcap'
import { parseYahooSearch, YAHOO_SEARCH_URL } from './providers/yahoo'

export const CACHE_TTL_MS = 24 * 3600_000
export const MAX_RESULTS = 30
/** exchangeInfo is ~17 MB; give it more time than the default 8 s. */
const EXCHANGE_INFO_TIMEOUT_MS = 30_000

export interface SearchResult {
  results: Instrument[]
  /** True when a source failed; `results` then holds whatever the (stale) cache had. */
  unavailable: boolean
}

export interface Directory {
  search(market: SearchMarket, query: string): Promise<SearchResult>
  /** CafeF board of a VN stock from the cached directory (`undefined` when unknown). */
  boardOf(symbol: string): CafefBoard | undefined
  /** Loads the VN directory (cache or network) so `boardOf` works early. */
  warmUp(): Promise<void>
}

export interface DirectoryDeps {
  fetchJson: FetchJson
  log: Logger
  now: () => number
  /** `<userData>/cache` */
  cacheDir: string
  /** Static list, no network (`TOPTICK_FAKE_DATA=1`). */
  fake?: boolean
}

interface CacheFile<T> {
  fetchedAt: number
  items: T[]
}

const vnEntrySchema = z.object({
  symbol: z.string(),
  kind: z.enum(['stock', 'etf']),
  board: z.enum(['HSX', 'HNX', 'UPCOM']),
  nameVi: z.string(),
  nameEn: z.string()
})
const cryptoEntrySchema = z.object({ symbol: z.string(), base: z.string() })
type CryptoEntry = z.infer<typeof cryptoEntrySchema>

const BOARD_IDS: Record<VnDirectoryEntry['board'], CafefBoard> = { HSX: 1, HNX: 2, UPCOM: 9 }

/** Accent-insensitive lower-case form (so "hoa phat" matches "Hòa Phát"). */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
}

/** Symbol/display-symbol prefix matches first, then name-contains matches. */
export function filterInstruments(list: Instrument[], query: string, limit = MAX_RESULTS): Instrument[] {
  const q = fold(query.trim())
  if (q === '') return []
  const exact: Instrument[] = []
  const prefix: Instrument[] = []
  const name: Instrument[] = []
  for (const i of list) {
    const sym = fold(i.symbol)
    const disp = fold(i.displaySymbol)
    if (sym === q || disp === q) exact.push(i)
    else if (sym.startsWith(q) || disp.startsWith(q)) prefix.push(i)
    else if (fold(i.nameEn).includes(q) || fold(i.nameVi).includes(q)) name.push(i)
  }
  return [...exact, ...prefix, ...name].slice(0, limit)
}

function vnInstrument(e: VnDirectoryEntry): Instrument {
  return { id: `vn:${e.symbol}`, market: 'vn', kind: e.kind, symbol: e.symbol, displaySymbol: e.symbol, nameEn: e.nameEn, nameVi: e.nameVi }
}

function cryptoInstrument(e: CryptoEntry): Instrument {
  const name = cryptoName(e.symbol)
  return {
    id: `crypto:${e.symbol}`,
    market: 'crypto',
    kind: 'crypto',
    symbol: e.symbol,
    displaySymbol: displaySymbol('crypto', e.symbol),
    nameEn: name,
    nameVi: name
  }
}

const validId = (i: Instrument): boolean => INSTRUMENT_ID_RE.test(i.id)

/** Offline list for fake mode: the default instruments plus a few extras. */
export function fakeInstruments(): Instrument[] {
  const defaults = Object.values(createDefaults('en').instruments)
  const extras: Instrument[] = [
    vnInstrument({ symbol: 'MWG', kind: 'stock', board: 'HSX', nameVi: 'Thế Giới Di Động', nameEn: 'Mobile World' }),
    vnInstrument({ symbol: 'SHS', kind: 'stock', board: 'HNX', nameVi: 'Chứng khoán SHS', nameEn: 'SHS Securities' }),
    { id: 'us:MSFT', market: 'us', kind: 'stock', symbol: 'MSFT', displaySymbol: 'MSFT', nameEn: 'Microsoft Corporation', nameVi: 'Microsoft Corporation' },
    { id: 'us:SPY', market: 'us', kind: 'etf', symbol: 'SPY', displaySymbol: 'SPY', nameEn: 'SPDR S&P 500 ETF Trust', nameVi: 'SPDR S&P 500 ETF Trust' },
    cryptoInstrument({ symbol: 'DOGEUSDT', base: 'DOGE' }),
    cryptoInstrument({ symbol: 'ADAUSDT', base: 'ADA' })
  ]
  const byId = new Map<string, Instrument>()
  for (const i of [...defaults, ...extras]) byId.set(i.id, i)
  return [...byId.values()]
}

export function createDirectory(deps: DirectoryDeps): Directory {
  const { fetchJson, log, now, cacheDir } = deps

  function readCache<T>(file: string, schema: z.ZodType<T>): CacheFile<T> | null {
    try {
      const raw = JSON.parse(fs.readFileSync(join(cacheDir, file), 'utf8')) as unknown
      const r = z.object({ fetchedAt: z.number(), items: z.array(schema) }).safeParse(raw)
      return r.success ? r.data : null
    } catch {
      return null
    }
  }

  function writeCache<T>(file: string, data: CacheFile<T>): void {
    try {
      fs.mkdirSync(cacheDir, { recursive: true })
      const path = join(cacheDir, file)
      fs.writeFileSync(`${path}.tmp`, JSON.stringify(data))
      fs.renameSync(`${path}.tmp`, path)
    } catch (err) {
      log.warn(`directory: could not write cache ${file}`, err)
    }
  }

  /** Memory -> fresh disk cache -> network -> stale cache, with in-flight de-duplication. */
  function cachedList<T>(file: string, schema: z.ZodType<T>, fetchItems: () => Promise<T[] | null>) {
    let memory: CacheFile<T> | null = null
    let inflight: Promise<{ items: T[]; unavailable: boolean }> | null = null

    async function load(): Promise<{ items: T[]; unavailable: boolean }> {
      if (!memory) memory = readCache(file, schema)
      if (memory && now() - memory.fetchedAt < CACHE_TTL_MS) return { items: memory.items, unavailable: false }
      const items = await fetchItems()
      if (items) {
        memory = { fetchedAt: now(), items }
        writeCache(file, memory)
        return { items, unavailable: false }
      }
      return { items: memory?.items ?? [], unavailable: true }
    }

    return {
      get: (): Promise<{ items: T[]; unavailable: boolean }> => {
        inflight ??= load().finally(() => {
          inflight = null
        })
        return inflight
      },
      peek: (): T[] => memory?.items ?? []
    }
  }

  const vn = cachedList('vietcap-symbols.json', vnEntrySchema, async () => {
    const res = await fetchJson(VIETCAP_URLS.directory, { provider: 'vietcap' })
    if (!res.ok) {
      log.warn(`directory: Vietcap getAll failed (${describeFailure(res)})`)
      return null
    }
    const items = parseVietcapDirectory(res.data)
    if (!items) log.warn('directory: Vietcap getAll schema mismatch')
    return items
  })

  const crypto = cachedList('binance-symbols.json', cryptoEntrySchema, async () => {
    const res = await fetchJson(`${BINANCE_REST}/exchangeInfo?permissions=SPOT`, {
      provider: 'binance',
      timeoutMs: EXCHANGE_INFO_TIMEOUT_MS
    })
    if (!res.ok) {
      log.warn(`directory: Binance exchangeInfo failed (${describeFailure(res)})`)
      return null
    }
    const items = parseExchangeInfo(res.data)
    if (!items) log.warn('directory: Binance exchangeInfo schema mismatch')
    return items
  })

  async function searchUs(query: string): Promise<SearchResult> {
    const url = `${YAHOO_SEARCH_URL}?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`
    const res = await fetchJson(url, { provider: 'yahoo' })
    if (!res.ok) {
      log.warn(`directory: Yahoo search failed (${describeFailure(res)})`)
      return { results: [], unavailable: true }
    }
    const items = parseYahooSearch(res.data)
    if (!items) {
      log.warn('directory: Yahoo search schema mismatch')
      return { results: [], unavailable: true }
    }
    return { results: items, unavailable: false }
  }

  async function searchMarket(market: Market, query: string, limit: number): Promise<SearchResult> {
    if (deps.fake) {
      return { results: filterInstruments(fakeInstruments().filter((i) => i.market === market), query, limit), unavailable: false }
    }
    switch (market) {
      case 'vn': {
        const { items, unavailable } = await vn.get()
        const list = [...VN_INDEX_INSTRUMENTS, ...items.map(vnInstrument)]
        return { results: filterInstruments(list, query, limit), unavailable }
      }
      case 'crypto': {
        const { items, unavailable } = await crypto.get()
        return { results: filterInstruments(items.map(cryptoInstrument).filter(validId), query, limit), unavailable }
      }
      case 'us': {
        const r = await searchUs(query)
        return { ...r, results: r.results.slice(0, limit) }
      }
    }
  }

  return {
    async search(market, query) {
      const q = query.trim()
      if (q.length < 1 || q.length > 40) return { results: [], unavailable: false }
      const markets: Market[] = market === 'all' ? ['vn', 'us', 'crypto'] : [market]
      // With "all", each market gets an equal share so one market cannot crowd out the others.
      const limit = Math.floor(MAX_RESULTS / markets.length)
      const parts = await Promise.all(markets.map((m) => searchMarket(m, q, limit)))
      return {
        results: parts.flatMap((p) => p.results),
        unavailable: parts.some((p) => p.unavailable)
      }
    },
    boardOf(symbol) {
      const e = vn.peek().find((x) => x.symbol === symbol)
      return e ? BOARD_IDS[e.board] : undefined
    },
    async warmUp() {
      if (!deps.fake) await vn.get()
    }
  }
}
