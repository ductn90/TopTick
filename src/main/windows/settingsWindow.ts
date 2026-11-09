import { app, BrowserWindow } from 'electron'
import type { ResolvedTheme } from '../../shared/types'
import { loadPage, preloadPath } from './barWindow'

/**
 * Settings window background = the bar's opaque base (`--surface-0-base` in tokens.css), so
 * both windows share one look; also avoids a white flash in dark mode.
 */
export const SETTINGS_BG: Record<ResolvedTheme, string> = { dark: '#0B0D12', light: '#FFFFFF' }

/** macOS: unified title bar; traffic lights centered in the 52 px toolbar (Settings.module.css). */
const MAC_TITLE_BAR = { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } } as const

export interface SettingsWindowDeps {
  title(): string
  theme(): ResolvedTheme
  /** Called after the window closed and the Dock icon was hidden again. */
  onClosed?(): void
}

export interface SettingsWindowController {
  /** Opens the window, or focuses it when it is already open (single instance). */
  open(): BrowserWindow
  get(): BrowserWindow | null
  setTitle(title: string): void
  setTheme(theme: ResolvedTheme): void
}

export function createSettingsWindowController(deps: SettingsWindowDeps): SettingsWindowController {
  let win: BrowserWindow | null = null

  function focus(w: BrowserWindow): void {
    if (w.isMinimized()) w.restore()
    w.show()
    if (process.platform === 'darwin') app.focus({ steal: true })
    w.focus()
  }

  return {
    open() {
      if (win && !win.isDestroyed()) {
        focus(win)
        return win
      }
      const w = new BrowserWindow({
        width: 760,
        height: 560,
        minWidth: 640,
        minHeight: 480,
        show: false,
        title: deps.title(),
        backgroundColor: SETTINGS_BG[deps.theme()],
        fullscreenable: false,
        ...(process.platform === 'darwin' ? MAC_TITLE_BAR : {}),
        webPreferences: {
          preload: preloadPath(),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false
        }
      })
      win = w
      // Keep the localized title instead of the page's <title>.
      w.on('page-title-updated', (e) => e.preventDefault())
      w.once('ready-to-show', () => focus(w))
      w.on('closed', () => {
        win = null
        if (process.platform === 'darwin') app.dock?.hide()
        deps.onClosed?.()
      })
      // Show the Dock icon while Settings is open so Cmd-Tab works [A4].
      if (process.platform === 'darwin') void app.dock?.show()
      loadPage(w, 'settings')
      return w
    },
    get: () => (win && !win.isDestroyed() ? win : null),
    setTitle(title) {
      if (win && !win.isDestroyed()) win.setTitle(title)
    },
    setTheme(theme) {
      if (win && !win.isDestroyed()) win.setBackgroundColor(SETTINGS_BG[theme])
    }
  }
}
