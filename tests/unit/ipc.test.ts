import { describe, expect, it } from 'vitest'
import { commandSchema, instrumentSchema, IPC, searchRequestSchema } from '../../src/shared/ipc'

const fpt = {
  id: 'vn:FPT',
  market: 'vn',
  kind: 'stock',
  symbol: 'FPT',
  displaySymbol: 'FPT',
  nameEn: 'FPT Corp',
  nameVi: 'FPT Corp'
}

describe('IPC channels', () => {
  it('uses the design channel names', () => {
    expect(IPC).toEqual({
      marketUpdate: 'market:update',
      marketSnapshot: 'market:snapshot',
      settingsChanged: 'settings:changed',
      themeChanged: 'theme:changed',
      cmd: 'cmd',
      search: 'search',
      getState: 'getState',
      openSettings: 'openSettings',
      openWatchlistMenu: 'openWatchlistMenu',
      barGesture: 'bar:gesture',
      barVisibility: 'bar:visibility'
    })
  })
})

describe('commandSchema', () => {
  it.each([
    { type: 'addItem', watchlistId: 'w1', instrument: fpt },
    { type: 'removeItem', watchlistId: 'w1', id: 'vn:FPT' },
    { type: 'moveItem', watchlistId: 'w1', from: 0, to: 3 },
    { type: 'setHidden', watchlistId: 'w1', id: 'us:^GSPC', hidden: true },
    { type: 'createWatchlist', name: 'Tech' },
    { type: 'renameWatchlist', id: 'w1', name: 'Banks' },
    { type: 'deleteWatchlist', id: 'w1' },
    { type: 'setActiveWatchlist', id: 'w1' },
    { type: 'setLanguage', lang: 'vi' },
    { type: 'setTheme', theme: 'system' },
    { type: 'setBar', bar: { width: 800, locked: true } },
    { type: 'setBar', bar: { x: -1200, y: null } }
  ])('accepts $type', (cmd) => {
    expect(commandSchema.safeParse(cmd).success).toBe(true)
  })

  it.each([
    ['unknown type', { type: 'dropTables' }],
    ['missing type', { name: 'x' }],
    ['not an object', 'addItem'],
    ['null', null],
    ['extra key', { type: 'deleteWatchlist', id: 'w1', force: true }],
    ['bad instrument id', { type: 'addItem', watchlistId: 'w1', instrument: { ...fpt, id: 'vn:FP T', symbol: 'FP T' } }],
    ['id not market:symbol', { type: 'addItem', watchlistId: 'w1', instrument: { ...fpt, id: 'vn:VCB' } }],
    ['unknown market', { type: 'addItem', watchlistId: 'w1', instrument: { ...fpt, market: 'eu' } }],
    ['extra instrument key', { type: 'addItem', watchlistId: 'w1', instrument: { ...fpt, price: 1 } }],
    ['removeItem bad id', { type: 'removeItem', watchlistId: 'w1', id: 'FPT' }],
    ['moveItem negative', { type: 'moveItem', watchlistId: 'w1', from: -1, to: 0 }],
    ['moveItem fraction', { type: 'moveItem', watchlistId: 'w1', from: 0.5, to: 0 }],
    ['moveItem string', { type: 'moveItem', watchlistId: 'w1', from: '0', to: 1 }],
    ['setHidden not boolean', { type: 'setHidden', watchlistId: 'w1', id: 'vn:FPT', hidden: 'yes' }],
    ['empty watchlist id', { type: 'setActiveWatchlist', id: '' }],
    ['name not string', { type: 'createWatchlist', name: 42 }],
    ['huge name', { type: 'createWatchlist', name: 'x'.repeat(1000) }],
    ['bad language', { type: 'setLanguage', lang: 'fr' }],
    ['bad theme', { type: 'setTheme', theme: 'sepia' }],
    ['bad speed', { type: 'setBar', bar: { speed: 'ludicrous' } }],
    ['unknown bar key', { type: 'setBar', bar: { opacity: 0.5 } }],
    ['bar width NaN', { type: 'setBar', bar: { width: Number.NaN } }]
  ])('rejects %s', (_label, cmd) => {
    expect(commandSchema.safeParse(cmd).success).toBe(false)
  })
})

describe('instrumentSchema', () => {
  it('accepts a directory instrument', () => {
    expect(instrumentSchema.parse(fpt)).toEqual(fpt)
  })
})

describe('searchRequestSchema', () => {
  it('trims the query and accepts 1-40 chars', () => {
    expect(searchRequestSchema.parse({ market: 'all', query: '  fpt ' })).toEqual({ market: 'all', query: 'fpt' })
    expect(searchRequestSchema.safeParse({ market: 'crypto', query: 'x'.repeat(40) }).success).toBe(true)
  })

  it.each([
    { market: 'all', query: '' },
    { market: 'all', query: '   ' },
    { market: 'all', query: 'x'.repeat(41) },
    { market: 'eu', query: 'sap' },
    { market: 'vn' },
    { market: 'us', query: 'nvda', extra: 1 }
  ])('rejects %j', (req) => {
    expect(searchRequestSchema.safeParse(req).success).toBe(false)
  })
})
