/**
 * IPC channel names (design §IPC). Kept free of imports so the sandboxed
 * preload can bundle it without pulling in zod.
 */
export const IPC = {
  marketUpdate: 'market:update',
  marketSnapshot: 'market:snapshot',
  settingsChanged: 'settings:changed',
  themeChanged: 'theme:changed',
  cmd: 'cmd',
  search: 'search',
  getState: 'getState',
  openSettings: 'openSettings',
  openWatchlistMenu: 'openWatchlistMenu',
  /** One-way (`send`): bar move/resize gesture ticks; main reads the cursor itself. */
  barGesture: 'bar:gesture',
  /** main -> bar: false while the bar cannot be seen (hidden, screen locked, asleep). */
  barVisibility: 'bar:visibility'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
