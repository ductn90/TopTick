import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/channels'
import type { TickerApi } from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  // Never hand the raw IpcRendererEvent (and its `sender`) to page code.
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: TickerApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onSettings: (cb) => subscribe(IPC.settingsChanged, cb),
  onTheme: (cb) => subscribe(IPC.themeChanged, cb),
  onMarket: (cb) => {
    const offUpdate = subscribe(IPC.marketUpdate, cb)
    const offSnapshot = subscribe(IPC.marketSnapshot, cb)
    return () => {
      offUpdate()
      offSnapshot()
    }
  },
  command: (cmd) => ipcRenderer.invoke(IPC.cmd, cmd),
  search: (market, query) => ipcRenderer.invoke(IPC.search, { market, query }),
  openSettings: () => ipcRenderer.invoke(IPC.openSettings),
  openWatchlistMenu: () => ipcRenderer.invoke(IPC.openWatchlistMenu),
  barGesture: (gesture) => ipcRenderer.send(IPC.barGesture, gesture),
  onBarVisibility: (cb) => subscribe(IPC.barVisibility, cb)
}

contextBridge.exposeInMainWorld('ticker', api)
