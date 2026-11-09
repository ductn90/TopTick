import fs from 'node:fs/promises'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import type { TickerApi } from '../../src/shared/types'

declare global {
  interface Window {
    ticker: TickerApi
  }
}

export const ROOT = resolve(__dirname, '..', '..')

export interface Launched {
  app: ElectronApplication
  bar: Page
}

export function tempDir(): Promise<string> {
  return fs.mkdtemp(join(os.tmpdir(), 'ticker-e2e-'))
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

/** Launches the built app (`out/`) with an isolated userData dir; fake data unless `fake: false`. */
export async function launch(userDataDir: string, opts: { fake?: boolean } = {}): Promise<Launched> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RENDERER_URL
  delete env.TOPTICK_FAKE_DATA
  if (opts.fake !== false) env.TOPTICK_FAKE_DATA = '1'
  env.TOPTICK_USER_DATA_DIR = userDataDir
  const app = await electron.launch({ args: ['.'], cwd: ROOT, env })
  const bar = await app.firstWindow()
  await bar.waitForSelector('[data-testid="bar"]')
  return { app, bar }
}

/**
 * The bar is always on top at the top of the real screen, so a person's real cursor can hover
 * it (pausing the marquee) or click it during a run. Make the bar ignore OS mouse input and
 * park Playwright's synthetic pointer outside the marquee; synthetic input still reaches it.
 */
export async function isolateFromRealMouse(app: ElectronApplication, bar: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.setIgnoreMouseEvents(true, { forward: false })
  })
  await bar.mouse.move(1, 1)
}

/** Opens Settings through the preload API and returns its page. */
export async function openSettings(app: ElectronApplication, bar: Page): Promise<Page> {
  const existing = app.windows().find((w) => w.url().includes('settings.html'))
  if (existing) return existing
  const [page] = await Promise.all([app.waitForEvent('window'), bar.evaluate(() => window.ticker.openSettings())])
  await page.waitForSelector('[data-testid="tab-watchlists"]')
  return page
}

/** Symbols shown on the bar, in order (first marquee copy only). */
export function barSymbols(bar: Page): Promise<string[]> {
  return bar.locator('[data-copy="0"] [data-testid="symbol"]').allTextContents()
}

export function barItems(bar: Page) {
  return bar.locator('[data-copy="0"] [data-testid="ticker-item"]')
}

export interface BarWindowInfo {
  onTop: boolean
  bounds: { x: number; y: number; width: number; height: number }
  visible: boolean
}

export function barWindow(app: ElectronApplication): Promise<BarWindowInfo> {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('bar.html'))
    if (!w) throw new Error('bar window not found')
    return { onTop: w.isAlwaysOnTop(), bounds: w.getBounds(), visible: w.isVisible() }
  })
}

/** Made-up quote for `pinQuotes`: price against ref, optional VN ceiling/floor. */
export interface PinnedQuote {
  id: string
  ref: number
  price: number
  ceiling?: number
  floor?: number
}

/**
 * FAKE DATA. Sends made-up quotes and series for `rows` to the bar, and rewrites every later
 * market message for those ids so the fake provider's ticks never replace them.
 */
export async function pinQuotes(app: ElectronApplication, rows: PinnedQuote[]): Promise<void> {
  const diff: { quotes: Record<string, unknown>; series: Record<string, unknown> } = { quotes: {}, series: {} }
  for (const { id, ref, price, ceiling, floor } of rows) {
    const change = price - ref
    diff.quotes[id] = { id, price, refPrice: ref, change, changePct: (change / ref) * 100, state: 'live', source: 'fake', updatedAt: Date.now(), ceiling, floor }
    const points = Array.from({ length: 40 }, (_, i) => ref + ((price - ref) * i) / 39 + Math.sin(i / 3) * ref * 0.004)
    points[39] = price
    diff.series[id] = { id, points, refPrice: ref, updatedAt: Date.now() }
  }
  await app.evaluate(({ BrowserWindow }, d) => {
    const w = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('bar.html'))!
    const wc = w.webContents
    const send = wc.send.bind(wc)
    wc.send = (channel: string, msg: { quotes?: Record<string, unknown>; series?: Record<string, unknown> }, ...rest: unknown[]) => {
      if ((channel === 'market:update' || channel === 'market:snapshot') && msg?.quotes) {
        for (const id of Object.keys(d.quotes)) {
          if (id in msg.quotes) msg.quotes[id] = d.quotes[id]
          if (msg.series && id in msg.series) msg.series[id] = d.series[id]
        }
      }
      return send(channel, msg, ...rest)
    }
    send('market:update', d)
  }, diff)
}

export const DEFAULT_OVERVIEW = ['VNINDEX', 'S&P 500', 'NASDAQ', 'BTC/USDT', 'ETH/USDT', 'FPT', 'AAPL', 'NVDA']
