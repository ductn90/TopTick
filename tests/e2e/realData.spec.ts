import { expect, test, type Page } from '@playwright/test'
import { isolateFromRealMouse, launch, removeDir, tempDir, type Launched } from './helpers'

// REAL DATA (recorded): the real Vietcap provider parses tests/fixtures/vietcap/*-limits.json and
// gap-chart-*.json, recorded 2026-11-09 10:30 ICT. SMA was at its ceiling, CMV at its floor and
// VCI down. Not the fake provider: fixtureFetch.cjs replaces the network in the main process.
const ROWS = [
  { symbol: 'SMA', tone: 'ceiling', token: '--ceiling', price: '9,800' },
  { symbol: 'CMV', tone: 'floor', token: '--floor', price: '7,890' },
  { symbol: 'VCI', tone: 'down', token: '--down', price: '19,950' }
] as const

let dir: string
let ctx: Launched

test.beforeEach(async () => {
  dir = await tempDir()
  // The quotes arrive 1.5 s after the series, so each sparkline exists before its quote.
  ctx = await launch(dir, { fixtures: true, env: { TOPTICK_FIXTURE_QUOTE_DELAY_MS: '1500' } })
  await isolateFromRealMouse(ctx.app, ctx.bar)
})

test.afterEach(async () => {
  await ctx.app.close()
  await removeDir(dir)
})

const item = (bar: Page, symbol: string) => bar.locator(`[data-copy="0"] [data-testid="ticker-item"][data-id="vn:${symbol}"]`)

async function colors(bar: Page, symbol: string, token: string) {
  return item(bar, symbol).evaluate((el, tok) => {
    const style = (id: string) => getComputedStyle(el.querySelector(`[data-testid="${id}"]`)!)
    const probe = document.createElement('span')
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(tok)
    document.body.append(probe)
    const expected = getComputedStyle(probe).color
    probe.remove()
    return {
      expected,
      line: style('spark-line').stroke,
      area: style('spark-area').fill,
      dot: style('spark-dot').fill,
      price: style('price').color,
      pct: style('pct').color,
      glyph: style('glyph').color
    }
  }, token)
}

async function expectMatchingColors(bar: Page, label: string): Promise<void> {
  for (const theme of ['dark', 'light'] as const) {
    expect((await bar.evaluate((t) => window.ticker.command({ type: 'setTheme', theme: t }), theme)).ok).toBe(true)
    await expect(bar.locator('html')).toHaveAttribute('data-theme', theme)
    for (const row of ROWS) {
      const it = item(bar, row.symbol)
      await expect(it.getByTestId('price')).toHaveText(row.price)
      await expect(it.getByTestId('price')).not.toHaveAttribute('data-flash')
      await expect(it.getByTestId('glyph')).toHaveAttribute('data-tone', row.tone)
      await expect(it.getByTestId('sparkline')).toHaveAttribute('data-tone', row.tone)
      const c = await colors(bar, row.symbol, row.token)
      const where = `${label} ${theme} ${row.symbol}`
      expect(c.line, where).toBe(c.expected)
      expect(c.price, where).toBe(c.line)
      expect(c.pct, where).toBe(c.line)
      expect(c.glyph, where).toBe(c.line)
      expect(c.area, where).toBe(c.line)
      expect(c.dot, where).toBe(c.line)
    }
  }
}

test('real Vietcap payloads: ceiling and floor sparklines match the price color, live and after a reload', async () => {
  const { bar } = ctx
  await bar.evaluate(async (symbols) => {
    const r = await window.ticker.command({ type: 'createWatchlist', name: 'Limits' })
    if (!r.ok) throw new Error('createWatchlist failed')
    const list = r.settings.watchlists.find((w) => w.name === 'Limits')!
    for (const s of symbols) {
      const { results } = await window.ticker.search('vn', s)
      const instrument = results.find((i) => i.id === `vn:${s}`)
      if (!instrument) throw new Error(`search ${s}: no result`)
      const a = await window.ticker.command({ type: 'addItem', watchlistId: list.id, instrument })
      if (!a.ok) throw new Error(`addItem ${s}: ${a.code}`)
    }
    await window.ticker.command({ type: 'setActiveWatchlist', id: list.id })
  }, ROWS.map((r) => r.symbol))
  for (const row of ROWS) {
    await expect(item(bar, row.symbol)).toHaveAttribute('title', /Vietcap/, { timeout: 20_000 })
    await expect(item(bar, row.symbol).getByTestId('spark-line')).toHaveCount(1)
  }
  // Quote and series came in as live market:update diffs.
  await expectMatchingColors(bar, 'live')
  // A reloaded bar starts from the market:snapshot of the same data.
  await bar.reload()
  await bar.waitForSelector('[data-testid="bar"]')
  for (const row of ROWS) await expect(item(bar, row.symbol).getByTestId('spark-line')).toHaveCount(1)
  await expectMatchingColors(bar, 'snapshot')
})
