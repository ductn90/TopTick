import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createThemeController, resolveTheme, type NativeThemeLike } from '../../src/main/theme'
import type { ThemeSetting } from '../../src/shared/types'

describe('resolveTheme', () => {
  it.each([
    ['dark', true, 'dark'],
    ['dark', false, 'dark'],
    ['light', true, 'light'],
    ['light', false, 'light'],
    ['system', true, 'dark'],
    ['system', false, 'light']
  ] as const)('%s with osDark=%s -> %s', (setting, osDark, expected) => {
    expect(resolveTheme(setting, osDark)).toBe(expected)
  })
})

/** Mimics Electron: with themeSource dark/light, shouldUseDarkColors follows the source. */
class FakeNativeTheme extends EventEmitter implements NativeThemeLike {
  themeSource: ThemeSetting = 'system'
  osDark = false
  get shouldUseDarkColors(): boolean {
    return this.themeSource === 'system' ? this.osDark : this.themeSource === 'dark'
  }
  setOs(dark: boolean): void {
    this.osDark = dark
    this.emit('updated')
  }
}

function setup(initial: ThemeSetting) {
  const nativeTheme = new FakeNativeTheme()
  let setting = initial
  const broadcast = vi.fn()
  const controller = createThemeController({ nativeTheme, getSetting: () => setting, broadcast })
  return { nativeTheme, controller, broadcast, set: (s: ThemeSetting) => (setting = s) }
}

describe('createThemeController', () => {
  it('mirrors the setting into themeSource on creation', () => {
    expect(setup('dark').nativeTheme.themeSource).toBe('dark')
    expect(setup('light').nativeTheme.themeSource).toBe('light')
    expect(setup('system').nativeTheme.themeSource).toBe('system')
  })

  it('broadcasts OS changes only while the setting is system', () => {
    const { nativeTheme, broadcast, controller, set } = setup('system')
    nativeTheme.setOs(true)
    expect(broadcast).toHaveBeenLastCalledWith('dark')
    nativeTheme.setOs(false)
    expect(broadcast).toHaveBeenLastCalledWith('light')
    expect(broadcast).toHaveBeenCalledTimes(2)

    set('dark')
    controller.apply()
    broadcast.mockClear()
    nativeTheme.setOs(true)
    nativeTheme.setOs(false)
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('apply() updates themeSource and broadcasts the resolved theme', () => {
    const { nativeTheme, broadcast, controller, set } = setup('dark')
    nativeTheme.osDark = true
    set('light')
    expect(controller.apply()).toBe('light')
    expect(nativeTheme.themeSource).toBe('light')
    expect(broadcast).toHaveBeenLastCalledWith('light')
    set('system')
    expect(controller.apply()).toBe('dark')
    expect(nativeTheme.themeSource).toBe('system')
    expect(controller.resolved()).toBe('dark')
  })

  it('dispose() stops listening', () => {
    const { nativeTheme, broadcast, controller } = setup('system')
    controller.dispose()
    nativeTheme.setOs(true)
    expect(broadcast).not.toHaveBeenCalled()
    expect(nativeTheme.listenerCount('updated')).toBe(0)
  })
})
