import { BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { InstrumentProvenance } from './instrumentProvenance'
import type { Logger } from './log'
import { applyCommand, randomId } from './settings/commands'
import type { SettingsStore } from './settings/store'
import type { MessageKey } from '../shared/i18n'
import { barGestureSchema, commandSchema, IPC, searchRequestSchema } from '../shared/ipc'
import type {
  AppState,
  BarGesture,
  Command,
  CommandResult,
  SearchMarket,
  SearchResponse,
  Settings
} from '../shared/types'

export type RunCommand = (cmd: Command) => CommandResult<Settings>

export interface CommandRunnerDeps {
  store: SettingsStore
  workAreaWidth(): number
  broadcast(channel: string, payload: unknown): void
  /** Side effects of a successful command: bar window, hub subscriptions, tray, theme. */
  onChanged(prev: Settings, next: Settings, cmd: Command): void
}

/**
 * Applies a validated command: reduce, save (debounced), broadcast
 * `settings:changed`, then run side effects. Used by IPC and the tray.
 */
export function createCommandRunner(deps: CommandRunnerDeps): RunCommand {
  return (cmd) => {
    const prev = deps.store.get()
    const result = applyCommand(prev, cmd, { workAreaWidth: deps.workAreaWidth(), newId: randomId })
    if (!result.ok) return result
    deps.store.set(result.settings)
    deps.broadcast(IPC.settingsChanged, result.settings)
    deps.onChanged(prev, result.settings, cmd)
    return result
  }
}

/** Bar watchlist menu: the lists as radio items, then "Settings…". */
export function buildWatchlistMenuTemplate(
  settings: Settings,
  t: (key: MessageKey) => string,
  actions: { setActiveWatchlist(id: string): void; openSettings(): void }
): MenuItemConstructorOptions[] {
  return [
    ...settings.watchlists.map((w) => ({
      id: `watchlist:${w.id}`,
      label: w.name,
      type: 'radio' as const,
      checked: w.id === settings.activeWatchlistId,
      click: () => actions.setActiveWatchlist(w.id)
    })),
    { type: 'separator' },
    { id: 'settings', label: t('bar.settings'), click: () => actions.openSettings() }
  ]
}

export interface IpcHandlerDeps {
  log: Logger
  run: RunCommand
  getState(): AppState
  search(market: SearchMarket, query: string): Promise<SearchResponse>
  openSettings(): void
  watchlistMenu(): MenuItemConstructorOptions[]
  /** Bar move/resize tick; `sender` lets the caller accept it from the bar window only. */
  barGesture(sender: WebContents, gesture: BarGesture): void
  /** `addItem` accepts only instruments main returned from search or already knows. */
  provenance: InstrumentProvenance
}

const BAD_REQUEST: CommandResult<Settings> = { ok: false, code: 'BAD_REQUEST' }

/** Registers every `ipcMain.handle` channel; payloads are validated with zod. */
export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  const { log } = deps
  ipcMain.handle(IPC.getState, () => deps.getState())
  ipcMain.handle(IPC.cmd, (_event, payload: unknown) => {
    const parsed = commandSchema.safeParse(payload)
    if (!parsed.success) {
      log.warn('ipc: rejected command', parsed.error.message)
      return BAD_REQUEST
    }
    const cmd = parsed.data
    if (cmd.type === 'addItem') {
      const trusted = deps.provenance.resolve(cmd.instrument.id)
      if (!trusted) {
        log.warn('ipc: rejected addItem for an instrument not returned by search', cmd.instrument.id)
        return BAD_REQUEST
      }
      return deps.run({ ...cmd, instrument: trusted })
    }
    return deps.run(cmd)
  })
  ipcMain.handle(IPC.search, async (_event, payload: unknown): Promise<SearchResponse> => {
    const parsed = searchRequestSchema.safeParse(payload)
    if (!parsed.success) {
      log.warn('ipc: rejected search', parsed.error.message)
      return { results: [], unavailable: false }
    }
    const { results, unavailable } = await deps.search(parsed.data.market, parsed.data.query)
    deps.provenance.remember(results)
    return { results, unavailable }
  })
  ipcMain.handle(IPC.openSettings, () => {
    deps.openSettings()
  })
  ipcMain.on(IPC.barGesture, (event, payload: unknown) => {
    const parsed = barGestureSchema.safeParse(payload)
    if (!parsed.success) {
      log.warn('ipc: rejected bar gesture', parsed.error.message)
      return
    }
    deps.barGesture(event.sender, parsed.data)
  })
  ipcMain.handle(IPC.openWatchlistMenu, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    Menu.buildFromTemplate(deps.watchlistMenu()).popup({ window: win })
  })
}
