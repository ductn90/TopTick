import fs from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { barSymbols, barWindow, launch, openSettings, removeDir, tempDir } from './helpers'

let dir: string

test.beforeEach(async () => {
  dir = await tempDir()
})

test.afterEach(async () => {
  await removeDir(dir)
})

test('all settings survive a relaunch', async () => {
  let { app, bar } = await launch(dir)
  const settings = await openSettings(app, bar)

  const ok = await settings.evaluate(async () => {
    const api = window.ticker
    const { settings: s } = await api.getState()
    const results = []
    const created = await api.command({ type: 'createWatchlist', name: 'Persist' })
    if (!created.ok) return false
    const id = created.settings.watchlists[created.settings.watchlists.length - 1]!.id
    for (const iid of ['crypto:BTCUSDT', 'vn:FPT', 'us:AAPL']) {
      results.push(await api.command({ type: 'addItem', watchlistId: id, instrument: s.instruments[iid]! }))
    }
    results.push(await api.command({ type: 'moveItem', watchlistId: id, from: 2, to: 0 }))
    results.push(await api.command({ type: 'setHidden', watchlistId: id, id: 'vn:FPT', hidden: true }))
    results.push(await api.command({ type: 'setActiveWatchlist', id }))
    results.push(await api.command({ type: 'setBar', bar: { width: 800, locked: true, speed: 'fast' } }))
    return results.every((r) => r.ok)
  })
  expect(ok).toBe(true)

  // Language, theme and click-through through the UI.
  await settings.getByTestId('tab-preferences').click()
  await settings.getByTestId('pref-language').selectOption('vi')
  await settings.getByTestId('pref-theme-light').click()
  await settings.getByTestId('pref-click-through').check()
  await expect(bar.locator('html')).toHaveAttribute('data-theme', 'light')
  await settings.waitForTimeout(500)

  const before = (await bar.evaluate(() => window.ticker.getState())).settings
  expect(before).toMatchObject({
    language: 'vi',
    theme: 'light',
    bar: { width: 800, locked: true, clickThrough: true, speed: 'fast' }
  })
  await app.close()

  ;({ app, bar } = await launch(dir))
  const after = (await bar.evaluate(() => window.ticker.getState())).settings
  expect(after).toEqual(before)
  const active = after.watchlists.find((w) => w.id === after.activeWatchlistId)!
  expect(active.name).toBe('Persist')
  expect(active.items).toEqual([
    { id: 'us:AAPL', hidden: false },
    { id: 'crypto:BTCUSDT', hidden: false },
    { id: 'vn:FPT', hidden: true }
  ])
  await expect.poll(() => barSymbols(bar)).toEqual(['AAPL', 'BTC/USDT'])
  await expect(bar.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(bar.locator('html')).toHaveAttribute('lang', 'vi')
  // Locked: no resize handle and no drag cursor.
  await expect(bar.getByTestId('resize-left')).toHaveCount(0)
  await expect(bar.getByTestId('resize-right')).toHaveCount(0)
  expect((await barWindow(app)).bounds.width).toBe(800)
  await app.close()
})

test('a corrupt settings.json is backed up and replaced by defaults', async () => {
  await fs.writeFile(join(dir, 'settings.json'), '{ not json', 'utf8')
  const { app, bar } = await launch(dir)
  const { settings } = await bar.evaluate(() => window.ticker.getState())
  expect(settings.activeWatchlistId).toBe('default-ov')
  expect(settings.watchlists.map((w) => w.id)).toEqual(['default-ov', 'default-vn', 'default-us', 'default-cr'])

  const files = await fs.readdir(dir)
  const backups = files.filter((f) => /^settings\.corrupt-\d+\.json$/.test(f))
  expect(backups).toHaveLength(1)
  expect(await fs.readFile(join(dir, backups[0]!), 'utf8')).toBe('{ not json')
  await app.close()
})
