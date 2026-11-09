import { join } from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, powerMonitor } from 'electron'
import electronLog from 'electron-log/main'
import { createBarVisibility } from './barVisibility'
import { createFetchJson, parseForceFail, type FetchJson } from './http'
import { createInstrumentProvenance } from './instrumentProvenance'
import { buildWatchlistMenuTemplate, createCommandRunner, registerIpcHandlers, type RunCommand } from './ipcHandlers'
import { createConsoleLogger, createMainLogger, type Logger } from './log'
import { createDirectory, type Directory } from './market/directory'
import { createMarketHub, visibleIds, type MarketHub } from './market/hub'
import { createBinanceProvider, type WebSocketCtor } from './market/providers/binance'
import { createCafefProvider } from './market/providers/cafef'
import { createFakeProvider } from './market/providers/fake'
import { realTimers, type Provider } from './market/providers/types'
import { createVietcapProvider } from './market/providers/vietcap'
import { createYahooProvider } from './market/providers/yahoo'
import { createVnSource } from './market/vnSource'
import { createDefaults } from './settings/defaults'
import { createSettingsStore, type SettingsStore } from './settings/store'
import { createThemeController, type ThemeController } from './theme'
import { createTray, type TrayActions, type TrayController } from './tray'
import { createBarWindow, type BarWindow } from './windows/barWindow'
import { createSettingsWindowController, type SettingsWindowController } from './windows/settingsWindow'
import { detectLanguage, t, type MessageKey } from '../shared/i18n'
import { IPC } from '../shared/ipc'
import type { BarSettings, Market, Settings } from '../shared/types'

// E2E isolation hook: must run before anything reads userData (including the single-instance lock).
const userDataOverride = process.env.TOPTICK_USER_DATA_DIR
if (userDataOverride) app.setPath('userData', userDataOverride)

const FAKE_DATA = process.env.TOPTICK_FAKE_DATA === '1'

let log: Logger = createConsoleLogger(false)
process.on('uncaughtException', (err) => log.error('uncaught exception', err))
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason))

interface Runtime {
  store: SettingsStore
  hub: MarketHub
  theme: ThemeController
  bar: BarWindow
  settingsWindow: SettingsWindowController
  tray: TrayController
  run: RunCommand
}

let runtime: Runtime | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function createProviders(fetchJson: FetchJson, boardOf: Directory['boardOf']): Record<Market, Provider> {
  const now = Date.now
  if (FAKE_DATA) {
    // One fake walk serves every market (offline UI work and e2e).
    const fake = createFakeProvider({ now, timers: realTimers })
    return { crypto: fake, vn: fake, us: fake }
  }
  const deps = { fetchJson, log, now, timers: realTimers }
  const binance = createBinanceProvider({ ...deps, WebSocket: globalThis.WebSocket as unknown as WebSocketCtor })
  const vietcap = createVietcapProvider(deps)
  const cafef = createCafefProvider({ ...deps, boardOf })
  const vn = createVnSource({ primary: vietcap, fallback: cafef, log, timers: realTimers })
  return { crypto: binance, vn, us: createYahooProvider(deps) }
}

function start(): Runtime {
  const userData = app.getPath('userData')
  log = createMainLogger(electronLog, userData)
  log.info(`starting ${app.getName()} ${app.getVersion()}${FAKE_DATA ? ' (fake data)' : ''}`)

  const store = createSettingsStore({
    dir: userData,
    log,
    now: Date.now,
    defaultLanguage: detectLanguage(app.getLocale())
  })
  const tr = (key: MessageKey): string => t(store.get().language, key)

  const fetchJson = createFetchJson({
    version: app.getVersion(),
    forceFail: parseForceFail(process.env.TOPTICK_VN_FORCE_FAIL)
  })
  const directory = createDirectory({
    fetchJson,
    log,
    now: Date.now,
    cacheDir: join(userData, 'cache'),
    fake: FAKE_DATA
  })
  void directory.warmUp().catch((err: unknown) => log.warn('directory warm-up failed', err))

  // Created below; the closures only run after construction.
  let bar: BarWindow
  let run: RunCommand

  const settingsWindow = createSettingsWindowController({
    title: () => tr('settings.title'),
    theme: () => theme.resolved(),
    onClosed: () => {
      // Hiding the Dock icon can hide app windows on macOS; keep the bar up.
      if (store.get().bar.visible && !bar.win.isDestroyed()) bar.win.showInactive()
    }
  })

  const theme = createThemeController({
    nativeTheme,
    getSetting: () => store.get().theme,
    broadcast: (resolved) => {
      settingsWindow.setTheme(resolved)
      broadcast(IPC.themeChanged, resolved)
    }
  })

  const providers = createProviders(fetchJson, directory.boardOf)
  const hub = createMarketHub({
    providers,
    emit: (diff) => {
      if (!bar.win.isDestroyed()) bar.win.webContents.send(IPC.marketUpdate, diff)
    },
    now: Date.now,
    timers: realTimers,
    log
  })
  hub.setSubscriptions(visibleIds(store.get()))

  const persistBar = (partial: Partial<BarSettings>): void => {
    const current = store.get().bar
    const changed = (Object.keys(partial) as (keyof BarSettings)[]).some((k) => partial[k] !== current[k])
    if (changed) run({ type: 'setBar', bar: partial })
  }

  bar = createBarWindow({ bar: store.get().bar, persist: persistBar })
  // Pause the marquee while the bar cannot be seen (D14). Window hide/occlusion also reaches the
  // page as visibilitychange; the OS signals below cover a locked screen and sleep.
  const visibility = createBarVisibility((visible, reason) => {
    log.debug(`bar: ${visible ? 'visible, scrolling resumes' : 'not visible, scrolling paused'} (${reason})`)
    if (!bar.win.isDestroyed()) bar.win.webContents.send(IPC.barVisibility, visible)
  })
  // The window is created hidden and shown on ready-to-show (or never, if the bar is off).
  visibility.set('windowHidden', !bar.win.isVisible())
  bar.win.on('show', () => visibility.set('windowHidden', false))
  bar.win.on('hide', () => visibility.set('windowHidden', true))
  bar.win.on('minimize', () => visibility.set('minimized', true))
  bar.win.on('restore', () => visibility.set('minimized', false))
  powerMonitor.on('lock-screen', () => visibility.set('screenLocked', true))
  powerMonitor.on('unlock-screen', () => visibility.set('screenLocked', false))
  powerMonitor.on('suspend', () => visibility.set('suspended', true))
  powerMonitor.on('resume', () => visibility.set('suspended', false))
  // macOS fast user switching: another user's session is on screen.
  powerMonitor.on('user-did-resign-active', () => visibility.set('userInactive', true))
  powerMonitor.on('user-did-become-active', () => visibility.set('userInactive', false))
  // The initial visibility goes through getState(): a message sent here would arrive before the
  // bar subscribes.
  bar.win.webContents.on('did-finish-load', () => {
    bar.win.webContents.send(IPC.marketSnapshot, hub.snapshot())
  })

  const toggleBar = (key: 'visible' | 'paused' | 'locked' | 'clickThrough'): void => {
    run({ type: 'setBar', bar: { [key]: !store.get().bar[key] } })
  }
  const actions: TrayActions = {
    toggleBar: () => toggleBar('visible'),
    setActiveWatchlist: (id) => run({ type: 'setActiveWatchlist', id }),
    togglePause: () => toggleBar('paused'),
    toggleLock: () => toggleBar('locked'),
    toggleClickThrough: () => toggleBar('clickThrough'),
    setLanguage: (lang) => run({ type: 'setLanguage', lang }),
    openSettings: () => settingsWindow.open(),
    quit: () => app.quit()
  }
  const tray = createTray({ settings: store.get() }, tr, actions)

  run = createCommandRunner({
    store,
    workAreaWidth: () => bar.workAreaWidth(),
    broadcast,
    onChanged: (prev: Settings, next: Settings) => {
      bar.apply(next.bar)
      const ids = visibleIds(next)
      if (ids.join('\n') !== hub.subscriptions().join('\n')) hub.setSubscriptions(ids)
      tray.update({ settings: next }, tr)
      if (prev.theme !== next.theme) theme.apply()
      if (prev.language !== next.language) settingsWindow.setTitle(tr('settings.title'))
    }
  })

  registerIpcHandlers({
    log,
    run: (cmd) => run(cmd),
    getState: () => ({
      settings: store.get(),
      snapshot: hub.snapshot(),
      resolvedTheme: theme.resolved(),
      barVisible: visibility.visible(),
      platform: process.platform
    }),
    search: (market, query) => directory.search(market, query),
    provenance: createInstrumentProvenance({
      now: Date.now,
      known: () => ({ ...createDefaults('en').instruments, ...store.get().instruments })
    }),
    openSettings: () => settingsWindow.open(),
    barGesture: (sender, gesture) => {
      if (sender === bar.win.webContents) bar.gesture(gesture)
    },
    watchlistMenu: () =>
      buildWatchlistMenuTemplate(store.get(), tr, {
        setActiveWatchlist: actions.setActiveWatchlist,
        openSettings: actions.openSettings
      })
  })

  hub.start()
  return { store, hub, theme, bar, settingsWindow, tray, run }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    runtime?.settingsWindow.open()
  })

  // Both windows load only local pages: deny navigation away from them, new windows and webviews.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (e, url) => {
      if (url !== contents.getURL()) {
        e.preventDefault()
        log.warn('blocked navigation', url)
      }
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', (e) => e.preventDefault())
  })

  // Quit only from the tray, the menu or the OS.
  app.on('window-all-closed', () => {})

  app.on('before-quit', () => {
    log.info('quitting')
    if (!runtime) return
    runtime.store.flushSync()
    runtime.hub.stop()
    runtime.theme.dispose()
  })

  app
    .whenReady()
    .then(() => {
      runtime = start()
    })
    .catch((err: unknown) => {
      log.error('fatal startup error', err)
      dialog.showErrorBox('TopTick', `TopTick could not start.\n\n${err instanceof Error ? err.message : String(err)}`)
      app.quit()
    })
}
