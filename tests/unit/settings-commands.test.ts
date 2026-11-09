import { describe, expect, it } from 'vitest'
import { applyCommand, clampBarWidth, randomId, type CommandContext } from '../../src/main/settings/commands'
import { createDefaults } from '../../src/main/settings/defaults'
import { settingsSchema } from '../../src/main/settings/schema'
import type { Command, Instrument, Settings } from '../../src/shared/types'

function ctx(): CommandContext {
  let n = 0
  return { workAreaWidth: 1440, newId: () => `id${String(n++).padStart(8, '0')}` }
}

function run(settings: Settings, cmd: Command, c: CommandContext = ctx()): Settings {
  const r = applyCommand(settings, cmd, c)
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`)
  return r.settings
}

function code(settings: Settings, cmd: Command, c: CommandContext = ctx()): string | null {
  const r = applyCommand(settings, cmd, c)
  return r.ok ? null : r.code
}

function stock(symbol: string): Instrument {
  return { id: `vn:${symbol}`, market: 'vn', kind: 'stock', symbol, displaySymbol: symbol, nameEn: symbol, nameVi: symbol }
}

const OV = 'default-ov'
const CR = 'default-cr'

describe('createDefaults', () => {
  it('builds the A10 watchlists with Overview active and metadata for every item', () => {
    const s = createDefaults('en')
    expect(settingsSchema.safeParse(s).success).toBe(true)
    expect(s.watchlists.map((w) => w.name)).toEqual(['Overview', 'VN', 'US', 'Crypto'])
    expect(s.activeWatchlistId).toBe(OV)
    expect(s.theme).toBe('system')
    expect(s.bar).toEqual({
      x: null,
      y: null,
      width: 960,
      locked: false,
      clickThrough: false,
      speed: 'normal',
      paused: false,
      visible: true
    })
    const display = (wl: number): string[] => s.watchlists[wl]!.items.map((it) => s.instruments[it.id]!.displaySymbol)
    expect(display(0)).toEqual(['VNINDEX', 'S&P 500', 'NASDAQ', 'BTC/USDT', 'ETH/USDT', 'FPT', 'AAPL', 'NVDA'])
    expect(display(1)).toEqual(['VNINDEX', 'VN30', 'HNX', 'UPCOM', 'FPT', 'VCB', 'HPG', 'VNM'])
    expect(s.watchlists[2]!.items.map((i) => i.id)).toEqual(['us:^GSPC', 'us:^IXIC', 'us:AAPL', 'us:NVDA'])
    expect(display(3)).toEqual(['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT'])
    expect(s.watchlists.every((w) => w.id.length === 10 && w.items.every((i) => !i.hidden))).toBe(true)
  })

  it('localizes default list names', () => {
    expect(createDefaults('vi').watchlists.map((w) => w.name)).toEqual(['Tổng quan', 'VN', 'US', 'Tiền số'])
    expect(createDefaults('vi').language).toBe('vi')
  })

  it('returns independent objects', () => {
    const a = createDefaults('en')
    a.watchlists[0]!.items.length = 0
    expect(createDefaults('en').watchlists[0]!.items.length).toBe(8)
  })
})

describe('applyCommand', () => {
  it('does not mutate the input', () => {
    const s = createDefaults('en')
    const before = JSON.stringify(s)
    run(s, { type: 'addItem', watchlistId: OV, instrument: stock('VCB') })
    run(s, { type: 'moveItem', watchlistId: OV, from: 0, to: 7 })
    run(s, { type: 'setBar', bar: { width: 500 } })
    run(s, { type: 'deleteWatchlist', id: OV })
    expect(JSON.stringify(s)).toBe(before)
  })

  describe('addItem', () => {
    it('appends a visible item and caches its metadata', () => {
      const s = run(createDefaults('en'), { type: 'addItem', watchlistId: CR, instrument: stock('MWG') })
      expect(s.watchlists[3]!.items.at(-1)).toEqual({ id: 'vn:MWG', hidden: false })
      expect(s.instruments['vn:MWG']?.nameEn).toBe('MWG')
    })

    it('rejects duplicates, unknown lists and full lists', () => {
      const s = createDefaults('en')
      expect(code(s, { type: 'addItem', watchlistId: OV, instrument: stock('FPT') })).toBe('DUPLICATE')
      expect(code(s, { type: 'addItem', watchlistId: 'nope', instrument: stock('MWG') })).toBe('NOT_FOUND')
      let full = s
      for (let i = full.watchlists[0]!.items.length; i < 50; i++) {
        full = run(full, { type: 'addItem', watchlistId: OV, instrument: stock(`S${i}`) })
      }
      expect(full.watchlists[0]!.items).toHaveLength(50)
      expect(code(full, { type: 'addItem', watchlistId: OV, instrument: stock('MWG') })).toBe('LIST_FULL')
    })
  })

  describe('removeItem', () => {
    it('removes the item', () => {
      const s = run(createDefaults('en'), { type: 'removeItem', watchlistId: OV, id: 'vn:FPT' })
      expect(s.watchlists[0]!.items.map((i) => i.id)).not.toContain('vn:FPT')
      expect(s.watchlists[0]!.items).toHaveLength(7)
    })

    it('fails for unknown list or item', () => {
      const s = createDefaults('en')
      expect(code(s, { type: 'removeItem', watchlistId: OV, id: 'vn:MWG' })).toBe('NOT_FOUND')
      expect(code(s, { type: 'removeItem', watchlistId: 'nope', id: 'vn:FPT' })).toBe('NOT_FOUND')
    })
  })

  describe('moveItem', () => {
    it('moves forward and backward', () => {
      const s = createDefaults('en')
      const fwd = run(s, { type: 'moveItem', watchlistId: CR, from: 0, to: 4 })
      expect(fwd.watchlists[3]!.items.map((i) => i.id)).toEqual([
        'crypto:ETHUSDT',
        'crypto:BNBUSDT',
        'crypto:SOLUSDT',
        'crypto:XRPUSDT',
        'crypto:BTCUSDT'
      ])
      const back = run(s, { type: 'moveItem', watchlistId: CR, from: 3, to: 1 })
      expect(back.watchlists[3]!.items.map((i) => i.id)).toEqual([
        'crypto:BTCUSDT',
        'crypto:SOLUSDT',
        'crypto:ETHUSDT',
        'crypto:BNBUSDT',
        'crypto:XRPUSDT'
      ])
      expect(run(s, { type: 'moveItem', watchlistId: CR, from: 2, to: 2 }).watchlists[3]!.items).toEqual(
        s.watchlists[3]!.items
      )
    })

    it('rejects out-of-range indices and unknown lists', () => {
      const s = createDefaults('en')
      expect(code(s, { type: 'moveItem', watchlistId: CR, from: 5, to: 0 })).toBe('BAD_REQUEST')
      expect(code(s, { type: 'moveItem', watchlistId: CR, from: 0, to: 5 })).toBe('BAD_REQUEST')
      expect(code(s, { type: 'moveItem', watchlistId: CR, from: -1, to: 0 })).toBe('BAD_REQUEST')
      expect(code(s, { type: 'moveItem', watchlistId: CR, from: 0.5, to: 0 })).toBe('BAD_REQUEST')
      expect(code(s, { type: 'moveItem', watchlistId: 'nope', from: 0, to: 0 })).toBe('NOT_FOUND')
    })
  })

  describe('setHidden', () => {
    it('hides and shows without changing position', () => {
      const s = createDefaults('en')
      const hidden = run(s, { type: 'setHidden', watchlistId: OV, id: 'crypto:BTCUSDT', hidden: true })
      expect(hidden.watchlists[0]!.items[3]).toEqual({ id: 'crypto:BTCUSDT', hidden: true })
      const shown = run(hidden, { type: 'setHidden', watchlistId: OV, id: 'crypto:BTCUSDT', hidden: false })
      expect(shown.watchlists[0]!.items).toEqual(s.watchlists[0]!.items)
    })

    it('fails for unknown list or item', () => {
      const s = createDefaults('en')
      expect(code(s, { type: 'setHidden', watchlistId: OV, id: 'vn:MWG', hidden: true })).toBe('NOT_FOUND')
      expect(code(s, { type: 'setHidden', watchlistId: 'x', id: 'vn:FPT', hidden: true })).toBe('NOT_FOUND')
    })
  })

  describe('createWatchlist', () => {
    it('creates an empty list with a trimmed name and a generated id', () => {
      const s = run(createDefaults('en'), { type: 'createWatchlist', name: '  Tech  ' })
      expect(s.watchlists.at(-1)).toEqual({ id: 'id00000000', name: 'Tech', items: [] })
      expect(s.activeWatchlistId).toBe(OV)
    })

    it('regenerates an id that collides with an existing list', () => {
      const ids = ['default-ov', 'freshid001']
      const c: CommandContext = { workAreaWidth: 1440, newId: () => ids.shift()! }
      const s = run(createDefaults('en'), { type: 'createWatchlist', name: 'Tech' }, c)
      expect(s.watchlists.at(-1)!.id).toBe('freshid001')
    })

    it('validates names', () => {
      const s = createDefaults('en')
      expect(code(s, { type: 'createWatchlist', name: '' })).toBe('NAME_INVALID')
      expect(code(s, { type: 'createWatchlist', name: '   ' })).toBe('NAME_INVALID')
      expect(code(s, { type: 'createWatchlist', name: 'x'.repeat(33) })).toBe('NAME_INVALID')
      expect(code(s, { type: 'createWatchlist', name: 'x'.repeat(32) })).toBeNull()
      expect(code(s, { type: 'createWatchlist', name: 'overview' })).toBe('NAME_TAKEN')
      expect(code(s, { type: 'createWatchlist', name: ' CRYPTO ' })).toBe('NAME_TAKEN')
    })

    it('caps at 20 watchlists', () => {
      let s = createDefaults('en')
      const c = ctx()
      for (let i = s.watchlists.length; i < 20; i++) s = run(s, { type: 'createWatchlist', name: `L${i}` }, c)
      expect(s.watchlists).toHaveLength(20)
      expect(code(s, { type: 'createWatchlist', name: 'One more' }, c)).toBe('TOO_MANY_WATCHLISTS')
    })
  })

  describe('renameWatchlist', () => {
    it('renames, allowing a case change of its own name', () => {
      const s = createDefaults('en')
      expect(run(s, { type: 'renameWatchlist', id: CR, name: 'Coins' }).watchlists[3]!.name).toBe('Coins')
      expect(run(s, { type: 'renameWatchlist', id: CR, name: 'CRYPTO' }).watchlists[3]!.name).toBe('CRYPTO')
    })

    it('rejects unknown ids, invalid and taken names', () => {
      const s = createDefaults('en')
      expect(code(s, { type: 'renameWatchlist', id: 'nope', name: 'X' })).toBe('NOT_FOUND')
      expect(code(s, { type: 'renameWatchlist', id: CR, name: ' ' })).toBe('NAME_INVALID')
      expect(code(s, { type: 'renameWatchlist', id: CR, name: 'us' })).toBe('NAME_TAKEN')
    })
  })

  describe('deleteWatchlist', () => {
    it('deletes a non-active list and keeps the active one', () => {
      const s = run(createDefaults('en'), { type: 'deleteWatchlist', id: CR })
      expect(s.watchlists.map((w) => w.id)).toEqual(['default-ov', 'default-vn', 'default-us'])
      expect(s.activeWatchlistId).toBe(OV)
    })

    it('activates the first remaining list when the active one is deleted', () => {
      let s = run(createDefaults('en'), { type: 'setActiveWatchlist', id: 'default-vn' })
      s = run(s, { type: 'deleteWatchlist', id: 'default-vn' })
      expect(s.activeWatchlistId).toBe(OV)
      s = run(s, { type: 'deleteWatchlist', id: OV })
      expect(s.activeWatchlistId).toBe('default-us')
    })

    it('never deletes the last list', () => {
      let s = createDefaults('en')
      for (const id of ['default-ov', 'default-vn', 'default-us']) s = run(s, { type: 'deleteWatchlist', id })
      expect(code(s, { type: 'deleteWatchlist', id: CR })).toBe('LAST_WATCHLIST')
      expect(code(s, { type: 'deleteWatchlist', id: 'nope' })).toBe('NOT_FOUND')
    })
  })

  describe('setActiveWatchlist', () => {
    it('switches the active list or fails for unknown ids', () => {
      const s = createDefaults('en')
      expect(run(s, { type: 'setActiveWatchlist', id: CR }).activeWatchlistId).toBe(CR)
      expect(code(s, { type: 'setActiveWatchlist', id: 'nope' })).toBe('NOT_FOUND')
    })
  })

  it('sets language and theme', () => {
    const s = createDefaults('en')
    expect(run(s, { type: 'setLanguage', lang: 'vi' }).language).toBe('vi')
    expect(run(s, { type: 'setTheme', theme: 'light' }).theme).toBe('light')
    expect(run(s, { type: 'setTheme', theme: 'system' }).theme).toBe('system')
  })

  describe('setBar', () => {
    it('merges partial fields', () => {
      const s = run(createDefaults('en'), { type: 'setBar', bar: { locked: true, speed: 'fast', x: 10, y: 20 } })
      expect(s.bar).toMatchObject({ locked: true, speed: 'fast', x: 10, y: 20, width: 960, clickThrough: false })
    })

    it('clamps width to [320, work-area width]', () => {
      const s = createDefaults('en')
      expect(run(s, { type: 'setBar', bar: { width: 100 } }).bar.width).toBe(320)
      expect(run(s, { type: 'setBar', bar: { width: 5000 } }).bar.width).toBe(1440)
      expect(run(s, { type: 'setBar', bar: { width: 700 } }).bar.width).toBe(700)
      expect(clampBarWidth(900, 200)).toBe(320)
    })
  })
})

describe('randomId', () => {
  it('produces 10 alphanumeric chars', () => {
    expect(randomId()).toMatch(/^[0-9a-zA-Z]{10}$/)
    expect(randomId(() => 0)).toBe('0000000000')
  })
})
