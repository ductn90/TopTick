import { join } from 'node:path'
import { app, BrowserWindow, screen, type Rectangle } from 'electron'
import type { BarGesture, BarSettings } from '../../shared/types'

export const BAR_HEIGHT = 56
export const MIN_BAR_WIDTH = 320
/** Edges within this distance of the work area snap to it [A1]. */
export const SNAP_PX = 16
const DEFAULT_TOP_OFFSET = 8

type Point = { x: number; y: number }

export function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** Snap each edge of `bounds` to the work-area edge when it is within `threshold` px. */
export function snapToEdges(bounds: Rectangle, workArea: Rectangle, threshold = SNAP_PX): Point {
  let { x, y } = bounds
  const right = workArea.x + workArea.width
  const bottom = workArea.y + workArea.height
  if (Math.abs(x - workArea.x) <= threshold) x = workArea.x
  else if (Math.abs(x + bounds.width - right) <= threshold) x = right - bounds.width
  if (Math.abs(y - workArea.y) <= threshold) y = workArea.y
  else if (Math.abs(y + bounds.height - bottom) <= threshold) y = bottom - bounds.height
  return { x, y }
}

/** Horizontally centered, 8 px below the top of the work area. */
export function defaultPosition(width: number, workArea: Rectangle): Point {
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + DEFAULT_TOP_OFFSET
  }
}

/**
 * Bounds after dragging one edge by `dx` px. The opposite edge stays put and the width is
 * clamped to `min` and to the work-area space on the dragged side, so the dragged edge never
 * leaves the work area (and the width never exceeds the work-area width).
 */
export function resizeEdge(
  start: { x: number; width: number },
  edge: 'left' | 'right',
  dx: number,
  min: number,
  workArea: { x: number; width: number }
): { x: number; width: number } {
  const raw = edge === 'left' ? start.width - dx : start.width + dx
  const room = edge === 'left' ? start.x + start.width - workArea.x : workArea.x + workArea.width - start.x
  const max = Math.max(min, Math.min(workArea.width, room))
  const width = Math.max(min, Math.min(max, Math.round(raw)))
  return { x: edge === 'left' ? start.x + start.width - width : start.x, width }
}

/** Loads a renderer page from the dev server or from `out/renderer`. */
export function loadPage(win: BrowserWindow, page: 'bar' | 'settings'): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}/${page}.html`)
  else void win.loadFile(join(__dirname, `../renderer/${page}.html`))
}

export function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

export interface BarWindowDeps {
  bar: BarSettings
  /** Persist bounds after the user moved or resized the bar (`setBar`). */
  persist(partial: Partial<BarSettings>): void
}

export interface BarWindow {
  readonly win: BrowserWindow
  /** Apply bar settings (width, lock, click-through, visibility); unchanged fields are skipped. */
  apply(bar: BarSettings): void
  workAreaWidth(): number
  /** Move (drag anywhere) or edge resize, driven by the cursor position in main. */
  gesture(g: BarGesture): void
}

function initialBounds(bar: BarSettings): Rectangle {
  if (bar.x !== null && bar.y !== null) {
    const saved = { x: bar.x, y: bar.y, width: bar.width, height: BAR_HEIGHT }
    // Restore only onto a display that still exists.
    if (screen.getAllDisplays().some((d) => intersects(saved, d.workArea))) return saved
  }
  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.max(MIN_BAR_WIDTH, Math.min(bar.width, workArea.width))
  return { ...defaultPosition(width, workArea), width, height: BAR_HEIGHT }
}

export function createBarWindow(deps: BarWindowDeps): BarWindow {
  const bounds = initialBounds(deps.bar)
  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_BAR_WIDTH,
    minHeight: BAR_HEIGHT,
    maxHeight: BAR_HEIGHT,
    frame: false,
    transparent: true,
    // Width changes only through the custom edge handles (gesture), the same on macOS and
    // Windows; native edge resize does not work for transparent windows on Windows.
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    focusable: true,
    show: false,
    title: 'TopTick',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Lets Chromium report hide/occlusion to the page (visibilitychange) and stop frames while
      // the bar cannot be seen; data still arrives over IPC from main (NFR-1, D13).
      backgroundThrottling: true
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    app.dock?.hide()
  }

  let ready = false
  let applied: BarSettings | null = null

  const workAreaWidth = (): number => screen.getDisplayMatching(win.getBounds()).workArea.width

  function apply(bar: BarSettings): void {
    const prev = applied
    applied = { ...bar }
    if (!prev || prev.width !== bar.width) {
      const b = win.getBounds()
      if (b.width !== bar.width) win.setBounds({ x: b.x, y: b.y, width: bar.width, height: BAR_HEIGHT })
    }
    if (!prev || prev.locked !== bar.locked) win.setMovable(!bar.locked)
    if (!prev || prev.clickThrough !== bar.clickThrough) {
      if (bar.clickThrough) win.setIgnoreMouseEvents(true, { forward: false })
      else win.setIgnoreMouseEvents(false)
    }
    if (ready && (!prev || prev.visible !== bar.visible)) {
      if (bar.visible) win.showInactive()
      else win.hide()
    }
  }

  win.once('ready-to-show', () => {
    ready = true
    if (applied?.visible ?? deps.bar.visible) win.showInactive()
  })

  // Active pointer gesture: cursor and bounds when it started.
  let active: { kind: BarGesture['kind']; cursor: Point; bounds: Rectangle } | null = null

  function gesture(g: BarGesture): void {
    const bar = applied ?? deps.bar
    if (bar.locked || bar.clickThrough) {
      active = null
      return
    }
    const cursor = screen.getCursorScreenPoint()
    if (g.phase === 'start') {
      active = { kind: g.kind, cursor, bounds: win.getBounds() }
      return
    }
    if (!active || active.kind !== g.kind) return
    const start = active.bounds
    const dx = cursor.x - active.cursor.x
    const dy = cursor.y - active.cursor.y
    const end = g.phase === 'end'
    if (end) active = null
    // A press and release without travel is a click: leave the bar where it is (no snap, no save).
    if (end && dx === 0 && dy === 0) return
    if (g.kind === 'move') {
      let p = { x: start.x + dx, y: start.y + dy }
      if (end) p = snapToEdges({ ...start, ...p }, screen.getDisplayMatching({ ...start, ...p }).workArea)
      const b = win.getBounds()
      if (b.x !== p.x || b.y !== p.y) win.setPosition(p.x, p.y)
      if (end) deps.persist(p)
    } else {
      const workArea = screen.getDisplayMatching(start).workArea
      const edge = g.kind === 'resizeLeft' ? 'left' : 'right'
      const { x, width } = resizeEdge(start, edge, dx, MIN_BAR_WIDTH, workArea)
      const b = win.getBounds()
      if (b.x !== x || b.width !== width) win.setBounds({ x, y: start.y, width, height: BAR_HEIGHT })
      if (end) deps.persist({ x, y: start.y, width })
    }
  }

  win.on('moved', () => {
    if (active) return
    const b = win.getBounds()
    const p = snapToEdges(b, screen.getDisplayMatching(b).workArea)
    if (p.x !== b.x || p.y !== b.y) win.setPosition(p.x, p.y)
    deps.persist({ x: p.x, y: p.y })
  })
  win.on('resized', () => {
    if (active) return
    const b = win.getBounds()
    deps.persist({ x: b.x, y: b.y, width: b.width })
  })

  apply(deps.bar)
  loadPage(win, 'bar')
  return { win, apply, workAreaWidth, gesture }
}
