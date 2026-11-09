import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  Tray: vi.fn()
}))

import { buildTrayTemplate, type TrayActions } from '../../src/main/tray'
import { createDefaults } from '../../src/main/settings/defaults'
import { t, type MessageKey } from '../../src/shared/i18n'
import type { Language, Settings } from '../../src/shared/types'

function actions(): { [K in keyof TrayActions]: ReturnType<typeof vi.fn> } {
  return {
    toggleBar: vi.fn(),
    setActiveWatchlist: vi.fn(),
    togglePause: vi.fn(),
    toggleLock: vi.fn(),
    toggleClickThrough: vi.fn(),
    setLanguage: vi.fn(),
    openSettings: vi.fn(),
    quit: vi.fn()
  }
}

function build(settings: Settings, lang: Language = settings.language, acts = actions()) {
  const tr = (key: MessageKey): string => t(lang, key)
  return { items: buildTrayTemplate({ settings }, tr, acts as unknown as TrayActions), acts }
}

const byId = (items: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions => {
  const found = items.find((i) => i.id === id)
  if (!found) throw new Error(`no item ${id}`)
  return found
}

const submenu = (item: MenuItemConstructorOptions): MenuItemConstructorOptions[] =>
  item.submenu as MenuItemConstructorOptions[]

describe('buildTrayTemplate', () => {
  it('has every FR-7 item in order', () => {
    const { items } = build(createDefaults('en'))
    expect(items.filter((i) => i.type !== 'separator').map((i) => i.id)).toEqual([
      'toggleBar',
      'watchlist',
      'pause',
      'lock',
      'clickThrough',
      'language',
      'settings',
      'quit'
    ])
  })

  it('uses English labels', () => {
    const { items } = build(createDefaults('en'))
    expect(byId(items, 'toggleBar').label).toBe('Hide bar')
    expect(byId(items, 'watchlist').label).toBe('Watchlist')
    expect(byId(items, 'pause').label).toBe('Pause scrolling')
    expect(byId(items, 'lock').label).toBe('Lock position')
    expect(byId(items, 'clickThrough').label).toBe('Click-through')
    expect(byId(items, 'language').label).toBe('Language')
    expect(byId(items, 'settings').label).toBe('Settings…')
    expect(byId(items, 'quit').label).toBe('Quit')
    expect(submenu(byId(items, 'language')).map((i) => i.label)).toEqual(['English', 'Tiếng Việt'])
  })

  it('uses Vietnamese labels', () => {
    const { items } = build(createDefaults('vi'))
    expect(byId(items, 'toggleBar').label).toBe('Ẩn thanh giá')
    expect(byId(items, 'watchlist').label).toBe('Danh mục')
    expect(byId(items, 'pause').label).toBe('Tạm dừng cuộn')
    expect(byId(items, 'clickThrough').label).toBe('Cho chuột xuyên qua')
    expect(byId(items, 'settings').label).toBe('Cài đặt…')
    expect(byId(items, 'quit').label).toBe('Thoát')
    expect(submenu(byId(items, 'watchlist'))[0]!.label).toBe('Tổng quan')
  })

  it('mirrors settings in checked states and the show/hide label', () => {
    const base = createDefaults('en')
    const settings: Settings = {
      ...base,
      language: 'vi',
      activeWatchlistId: 'default-us',
      bar: { ...base.bar, visible: false, paused: true, locked: true, clickThrough: true }
    }
    const { items } = build(settings, 'en')
    expect(byId(items, 'toggleBar').label).toBe('Show bar')
    expect(byId(items, 'pause').checked).toBe(true)
    expect(byId(items, 'lock').checked).toBe(true)
    expect(byId(items, 'clickThrough').checked).toBe(true)
    const lists = submenu(byId(items, 'watchlist'))
    expect(lists.map((i) => i.type)).toEqual(['radio', 'radio', 'radio', 'radio'])
    expect(lists.filter((i) => i.checked).map((i) => i.id)).toEqual(['watchlist:default-us'])
    const langs = submenu(byId(items, 'language'))
    expect(langs.filter((i) => i.checked).map((i) => i.id)).toEqual(['language:vi'])

    const defaults = build(base).items
    expect(byId(defaults, 'pause').checked).toBe(false)
    expect(byId(defaults, 'lock').checked).toBe(false)
    expect(byId(defaults, 'clickThrough').checked).toBe(false)
  })

  it('wires clicks to actions', () => {
    const { items, acts } = build(createDefaults('en'))
    const click = (item: MenuItemConstructorOptions): void =>
      (item.click as unknown as () => void)()
    click(byId(items, 'toggleBar'))
    click(byId(items, 'pause'))
    click(byId(items, 'lock'))
    click(byId(items, 'clickThrough'))
    click(byId(items, 'settings'))
    click(byId(items, 'quit'))
    click(submenu(byId(items, 'watchlist'))[2]!)
    click(submenu(byId(items, 'language'))[1]!)
    expect(acts.toggleBar).toHaveBeenCalledOnce()
    expect(acts.togglePause).toHaveBeenCalledOnce()
    expect(acts.toggleLock).toHaveBeenCalledOnce()
    expect(acts.toggleClickThrough).toHaveBeenCalledOnce()
    expect(acts.openSettings).toHaveBeenCalledOnce()
    expect(acts.quit).toHaveBeenCalledOnce()
    expect(acts.setActiveWatchlist).toHaveBeenCalledWith('default-us')
    expect(acts.setLanguage).toHaveBeenCalledWith('vi')
  })
})
