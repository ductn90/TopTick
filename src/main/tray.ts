import { join } from 'node:path'
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { MessageKey } from '../shared/i18n'
import type { Language, Settings } from '../shared/types'

export interface TrayState {
  settings: Settings
}

export type Translate = (key: MessageKey) => string

export interface TrayActions {
  toggleBar(): void
  setActiveWatchlist(id: string): void
  togglePause(): void
  toggleLock(): void
  toggleClickThrough(): void
  setLanguage(lang: Language): void
  openSettings(): void
  quit(): void
}

const LANGUAGES: { lang: Language; key: MessageKey }[] = [
  { lang: 'en', key: 'language.en' },
  { lang: 'vi', key: 'language.vi' }
]

/** Pure tray menu template (design §Tray, FR-7). Checked states mirror `state.settings`. */
export function buildTrayTemplate(
  state: TrayState,
  t: Translate,
  actions: TrayActions
): MenuItemConstructorOptions[] {
  const { settings } = state
  const { bar } = settings
  return [
    { id: 'toggleBar', label: t(bar.visible ? 'tray.hideBar' : 'tray.showBar'), click: () => actions.toggleBar() },
    {
      id: 'watchlist',
      label: t('tray.watchlist'),
      submenu: settings.watchlists.map((w) => ({
        id: `watchlist:${w.id}`,
        label: w.name,
        type: 'radio' as const,
        checked: w.id === settings.activeWatchlistId,
        click: () => actions.setActiveWatchlist(w.id)
      }))
    },
    { type: 'separator' },
    { id: 'pause', label: t('tray.pause'), type: 'checkbox', checked: bar.paused, click: () => actions.togglePause() },
    { id: 'lock', label: t('tray.lock'), type: 'checkbox', checked: bar.locked, click: () => actions.toggleLock() },
    {
      id: 'clickThrough',
      label: t('tray.clickThrough'),
      type: 'checkbox',
      checked: bar.clickThrough,
      click: () => actions.toggleClickThrough()
    },
    { type: 'separator' },
    {
      id: 'language',
      label: t('tray.language'),
      submenu: LANGUAGES.map(({ lang, key }) => ({
        id: `language:${lang}`,
        label: t(key),
        type: 'radio' as const,
        checked: settings.language === lang,
        click: () => actions.setLanguage(lang)
      }))
    },
    { id: 'settings', label: t('tray.settings'), click: () => actions.openSettings() },
    { type: 'separator' },
    { id: 'quit', label: t('tray.quit'), click: () => actions.quit() }
  ]
}

/** Directory holding the tray icons: `resources/` when packaged, `build/` in development. */
export function iconDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build')
}

export interface TrayController {
  update(state: TrayState, t: Translate): void
  destroy(): void
}

export function createTray(state: TrayState, t: Translate, actions: TrayActions): TrayController {
  const file = process.platform === 'win32' ? 'tray.ico' : 'trayTemplate.png'
  const image = nativeImage.createFromPath(join(iconDir(), file))
  // "Template" in the file name already marks it; set it explicitly as well.
  if (process.platform === 'darwin') image.setTemplateImage(true)
  const tray = new Tray(image)
  tray.setToolTip(t('tray.tooltip'))
  if (process.platform === 'win32') tray.on('click', () => tray.popUpContextMenu())

  const update = (next: TrayState, tr: Translate): void => {
    tray.setToolTip(tr('tray.tooltip'))
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate(next, tr, actions)))
  }
  update(state, t)
  return { update, destroy: () => tray.destroy() }
}
