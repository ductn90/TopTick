import type { ResolvedTheme, ThemeSetting } from '../shared/types'

/** The subset of Electron's `nativeTheme` the controller needs (injected for tests). */
export interface NativeThemeLike {
  themeSource: ThemeSetting
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

export function resolveTheme(setting: ThemeSetting, osDark: boolean): ResolvedTheme {
  if (setting === 'system') return osDark ? 'dark' : 'light'
  return setting
}

export interface ThemeControllerDeps {
  nativeTheme: NativeThemeLike
  getSetting: () => ThemeSetting
  broadcast: (theme: ResolvedTheme) => void
}

export interface ThemeController {
  resolved(): ResolvedTheme
  /** Apply the current setting to `nativeTheme.themeSource` and broadcast the resolved theme. */
  apply(): ResolvedTheme
  dispose(): void
}

/**
 * Main-owned theme resolution: mirrors the setting into `nativeTheme.themeSource`
 * (so native menus and title bars match) and forwards OS appearance changes
 * while the setting is `system`.
 */
export function createThemeController(deps: ThemeControllerDeps): ThemeController {
  const { nativeTheme, getSetting, broadcast } = deps

  const resolved = (): ResolvedTheme => resolveTheme(getSetting(), nativeTheme.shouldUseDarkColors)

  const onUpdated = (): void => {
    if (getSetting() === 'system') broadcast(resolved())
  }

  nativeTheme.themeSource = getSetting()
  nativeTheme.on('updated', onUpdated)

  return {
    resolved,
    apply() {
      nativeTheme.themeSource = getSetting()
      const theme = resolved()
      broadcast(theme)
      return theme
    },
    dispose() {
      nativeTheme.removeListener('updated', onUpdated)
    }
  }
}
