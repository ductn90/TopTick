import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CACHE_TTL_MS, createDirectory, filterInstruments, fold } from '../../src/main/market/directory'
import type { FetchResult } from '../../src/main/http'
import { fail, fakeFetch, fixture, mockLogger, ok } from './helpers'

let dir: string
let clock = 1_800_000_000_000

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(join(os.tmpdir(), 'ticker-dir-'))
  clock = 1_800_000_000_000
})
afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true })
})

const routes = {
  vn: () => ok(fixture('vietcap/getAll.json')),
  crypto: () => ok(fixture('binance/exchangeInfo.json')),
  us: () => ok(fixture('yahoo/search-NVDA.json'))
}

function setup(route: (url: string) => FetchResult = defaultRoute, fake = false) {
  const net = fakeFetch(route)
  const d = createDirectory({ fetchJson: net.fetchJson, log: mockLogger(), now: () => clock, cacheDir: dir, fake })
  return { d, net }
}

function defaultRoute(url: string): FetchResult {
  if (url.includes('symbols/getAll')) return routes.vn()
  if (url.includes('exchangeInfo')) return routes.crypto()
  if (url.includes('finance/search')) return routes.us()
  return fail('http', 404)
}

describe('filterInstruments', () => {
  it('ranks exact and prefix symbol matches before name matches, case- and accent-insensitive', () => {
    const list = [
      { id: 'vn:HPG', market: 'vn', kind: 'stock', symbol: 'HPG', displaySymbol: 'HPG', nameEn: 'Hoa Phat', nameVi: 'Hòa Phát' },
      { id: 'vn:FPT', market: 'vn', kind: 'stock', symbol: 'FPT', displaySymbol: 'FPT', nameEn: 'FPT Corp', nameVi: 'FPT Corp' },
      { id: 'vn:FPTS', market: 'vn', kind: 'stock', symbol: 'FPTS', displaySymbol: 'FPTS', nameEn: 'FPT Securities', nameVi: 'Chứng khoán FPT' },
      { id: 'vn:XYZ', market: 'vn', kind: 'stock', symbol: 'XYZ', displaySymbol: 'XYZ', nameEn: 'fpt partner', nameVi: 'x' }
    ] as const
    expect(filterInstruments([...list], 'fpt').map((i) => i.symbol)).toEqual(['FPT', 'FPTS', 'XYZ'])
    expect(filterInstruments([...list], 'hoa phat').map((i) => i.symbol)).toEqual(['HPG'])
    expect(filterInstruments([...list], '  ')).toEqual([])
    expect(fold('Đường Hòa')).toBe('duong hoa')
  })
})

describe('directory', () => {
  it('VN search covers STOCK/ETF on HSX/HNX/UPCOM plus the built-in indices', async () => {
    const { d } = setup()
    const fpt = await d.search('vn', 'fpt')
    expect(fpt.unavailable).toBe(false)
    expect(fpt.results[0]).toMatchObject({ id: 'vn:FPT', kind: 'stock', nameVi: 'FPT Corp' })
    expect((await d.search('vn', 'CVRE')).results).toEqual([]) // covered warrants excluded
    expect((await d.search('vn', 'upcom')).results.map((i) => i.id)).toContain('vn:HNXUpcomIndex')
    expect((await d.search('vn', 'vnindex')).results[0]!.id).toBe('vn:VNINDEX')
  })

  it('crypto search uses TRADING USDT pairs and the name table', async () => {
    const { d } = setup()
    const btc = await d.search('crypto', 'btc')
    expect(btc.results[0]).toMatchObject({ id: 'crypto:BTCUSDT', displaySymbol: 'BTC/USDT', nameEn: 'Bitcoin' })
    expect((await d.search('crypto', 'bitcoin')).results.map((i) => i.id)).toContain('crypto:BTCUSDT')
    expect((await d.search('crypto', 'BCC')).results).toEqual([]) // status BREAK
  })

  it('US search is live (not cached) and filtered to US EQUITY/ETF/INDEX', async () => {
    const { d, net } = setup()
    const r = await d.search('us', 'NVDA')
    expect(r.results[0]!.id).toBe('us:NVDA')
    expect(r.results.map((i) => i.id)).not.toContain('us:NVDA.TO')
    await d.search('us', 'NVDA')
    expect(net.calls.filter((c) => c.url.includes('finance/search'))).toHaveLength(2)
    expect(net.calls[0]!.url).toContain('q=NVDA&quotesCount=10&newsCount=0')
  })

  it('"all" merges markets and filters by market otherwise', async () => {
    const { d } = setup()
    const all = await d.search('all', 'NVDA')
    expect(all.results.map((i) => i.market)).toContain('us')
    const vnOnly = await d.search('vn', 'NVDA')
    expect(vnOnly.results.every((i) => i.market === 'vn')).toBe(true)
  })

  it('rejects empty or over-long queries without a network call', async () => {
    const { d, net } = setup()
    expect(await d.search('all', '   ')).toEqual({ results: [], unavailable: false })
    expect(await d.search('all', 'x'.repeat(41))).toEqual({ results: [], unavailable: false })
    expect(net.calls).toHaveLength(0)
  })

  it('caches VN and crypto lists on disk for 24 h', async () => {
    const a = setup()
    await a.d.search('vn', 'fpt')
    await a.d.search('crypto', 'btc')
    expect(fs.readdirSync(dir).sort()).toEqual(['binance-symbols.json', 'vietcap-symbols.json'])
    // A new instance within 24 h reads the cache without fetching.
    clock += CACHE_TTL_MS - 1
    const b = setup()
    await b.d.search('vn', 'fpt')
    await b.d.search('crypto', 'btc')
    expect(b.net.calls).toHaveLength(0)
    // After 24 h it refetches.
    clock += 1
    const c = setup()
    await c.d.search('vn', 'fpt')
    expect(c.net.calls).toHaveLength(1)
  })

  it('serves the stale cache with unavailable=true when the fetch fails', async () => {
    await setup().d.search('vn', 'fpt')
    clock += CACHE_TTL_MS + 1
    const { d } = setup(() => fail('timeout'))
    const r = await d.search('vn', 'fpt')
    expect(r.unavailable).toBe(true)
    expect(r.results[0]!.id).toBe('vn:FPT')
  })

  it('reports unavailable with built-in indices only when there is no cache at all', async () => {
    const { d } = setup(() => fail('network'))
    const r = await d.search('vn', 'vn')
    expect(r.unavailable).toBe(true)
    expect(r.results.every((i) => i.kind === 'index')).toBe(true)
    expect((await d.search('us', 'aapl')).unavailable).toBe(true)
  })

  it('boardOf maps HSX/HNX/UPCOM to CafeF boards 1/2/9 after warmUp', async () => {
    const { d } = setup()
    expect(d.boardOf('FPT')).toBeUndefined()
    await d.warmUp()
    expect(d.boardOf('FPT')).toBe(1)
    expect(d.boardOf('SHS')).toBe(2)
    expect(d.boardOf('ACV')).toBe(9)
    expect(d.boardOf('NOPE')).toBeUndefined()
  })

  it('fake mode uses a static list without network', async () => {
    const { d, net } = setup(defaultRoute, true)
    expect((await d.search('vn', 'FPT')).results[0]!.id).toBe('vn:FPT')
    expect((await d.search('us', 'NVDA')).results[0]!.id).toBe('us:NVDA')
    expect((await d.search('crypto', 'SOL')).results[0]!.id).toBe('crypto:SOLUSDT')
    expect((await d.search('all', 'NVDA')).results.map((i) => i.id)).toEqual(['us:NVDA'])
    expect(net.calls).toHaveLength(0)
  })
})
