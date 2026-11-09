import { expect, test } from '@playwright/test'
import {
  barItems,
  barSymbols,
  barWindow,
  DEFAULT_OVERVIEW,
  isolateFromRealMouse,
  launch,
  removeDir,
  tempDir,
  type Launched
} from './helpers'

let dir: string
let ctx: Launched

test.beforeEach(async () => {
  dir = await tempDir()
  ctx = await launch(dir)
  await isolateFromRealMouse(ctx.app, ctx.bar)
})

test.afterEach(async () => {
  await ctx.app.close()
  await removeDir(dir)
})

const trackStyle = (ctx: Launched) =>
  ctx.bar.getByTestId('track').evaluate((el) => {
    const s = getComputedStyle(el)
    return {
      name: s.animationName,
      state: s.animationPlayState,
      timing: s.animationTimingFunction,
      transform: s.transform,
      x: s.transform === 'none' ? 0 : -new DOMMatrixReadOnly(s.transform).m41
    }
  })
/** Scroll rate in px/s, measured in the page over `ms`; wraps at one copy width. */
const scrollRate = (ctx: Launched, ms = 800) =>
  ctx.bar.getByTestId('track').evaluate(
    (el, ms) =>
      new Promise<number>((resolve) => {
        const loop = el.querySelector('[data-copy="0"]')!.getBoundingClientRect().width
        const x = (): number => -new DOMMatrixReadOnly(getComputedStyle(el).transform).m41
        const [x0, t0] = [x(), performance.now()]
        setTimeout(() => resolve((((x() - x0) % loop) + loop) % loop / ((performance.now() - t0) / 1000)), ms)
      }),
    ms
  )

test('bar is always on top and every item has the reference layout', async () => {
  const { app, bar } = ctx
  expect((await barWindow(app)).onTop).toBe(true)
  expect((await barWindow(app)).bounds.height).toBe(56)

  const items = barItems(bar)
  await expect(items).toHaveCount(8)
  await expect(bar.locator('[data-copy="0"] [data-testid="ticker-item"][data-state="live"]')).toHaveCount(8)
  expect(await barSymbols(bar)).toEqual(DEFAULT_OVERVIEW)

  for (let i = 0; i < 8; i++) {
    const item = items.nth(i)
    await expect(item.getByTestId('glyph')).toHaveText(/^[▲▼•]$/)
    await expect(item.getByTestId('symbol')).not.toBeEmpty()
    await expect(item.getByTestId('name')).not.toBeEmpty()
    await expect(item.getByTestId('ref-line')).toHaveAttribute('stroke-dasharray', '2 2')
    await expect(item.getByTestId('price')).toHaveText(/\d/)
    await expect(item.getByTestId('pct')).toHaveText(/^[+-]?\d+\.\d{2}%$/)
    await expect(item).toHaveAttribute('title', /^.+ · Fake data · \d{2}:\d{2}:\d{2}$/)

    // Left column, then sparkline, then right column.
    const [sym, spark, price] = await Promise.all([
      item.getByTestId('symbol').boundingBox(),
      item.getByTestId('sparkline').boundingBox(),
      item.getByTestId('price').boundingBox()
    ])
    expect(sym!.x).toBeLessThan(spark!.x)
    expect(spark!.x + spark!.width).toBeLessThanOrEqual(price!.x + 1)
    expect(Math.round(spark!.width)).toBe(64)
    expect(Math.round(spark!.height)).toBe(24)
  }
})

test('overflowing items scroll and loop; hover pauses', async () => {
  const { bar } = ctx
  await expect(bar.getByTestId('track')).toHaveAttribute('data-scrolling', 'true')
  await expect(bar.locator('[data-copy="1"]')).toHaveAttribute('aria-hidden', 'true')
  await expect(bar.locator('[data-copy="1"] [data-testid="ticker-item"]')).toHaveCount(8)
  await expect.poll(async () => (await trackStyle(ctx)).state).toBe('running')
  // Linear timing on every display frame (A19/D20), not steps().
  expect((await trackStyle(ctx)).timing).toBe('linear')
  const start = (await trackStyle(ctx)).x
  await expect.poll(async () => (await trackStyle(ctx)).x).not.toBe(start)

  await bar.getByTestId('marquee').hover()
  await expect.poll(async () => (await trackStyle(ctx)).state).toBe('paused')
  const held = (await trackStyle(ctx)).x
  await bar.waitForTimeout(300)
  expect((await trackStyle(ctx)).x).toBe(held)
})

test('speed sets the scroll rate', async () => {
  const { bar } = ctx
  await expect.poll(async () => (await trackStyle(ctx)).state).toBe('running')
  await expect(bar.locator('[data-copy="0"] [data-testid="ticker-item"][data-state="live"]')).toHaveCount(8)
  const normal = await scrollRate(ctx)
  expect(normal).toBeGreaterThan(40 * 0.8)
  expect(normal).toBeLessThan(40 * 1.2)

  const result = await bar.evaluate(() => window.ticker.command({ type: 'setBar', bar: { speed: 'fast' } }))
  expect(result.ok).toBe(true)
  // The first window may straddle the switch; poll until the new speed applies.
  await expect.poll(() => scrollRate(ctx)).toBeGreaterThan(64 * 0.8)
  expect(await scrollRate(ctx)).toBeLessThan(64 * 1.2)
})

test('two items in a 1200 px bar render one static copy', async () => {
  const { app, bar } = ctx
  const ok = await bar.evaluate(async () => {
    const api = window.ticker
    const { settings } = await api.getState()
    const created = await api.command({ type: 'createWatchlist', name: 'Two' })
    if (!created.ok) return false
    const id = created.settings.watchlists[created.settings.watchlists.length - 1]!.id
    for (const iid of ['crypto:BTCUSDT', 'us:AAPL']) {
      const r = await api.command({ type: 'addItem', watchlistId: id, instrument: settings.instruments[iid]! })
      if (!r.ok) return false
    }
    const active = await api.command({ type: 'setActiveWatchlist', id })
    const width = await api.command({ type: 'setBar', bar: { width: 1200 } })
    return active.ok && width.ok
  })
  expect(ok).toBe(true)
  await expect.poll(() => barSymbols(bar)).toEqual(['BTC/USDT', 'AAPL'])
  await expect(bar.getByTestId('track')).toHaveAttribute('data-scrolling', 'false')
  await expect(bar.locator('[data-copy]')).toHaveCount(1)
  expect(await trackStyle(ctx)).toMatchObject({ name: 'none', transform: 'none' })
  const { bounds } = await barWindow(app)
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea.width)
  expect(bounds.width).toBe(Math.min(1200, workArea))
})

/** Makes main's `screen.getCursorScreenPoint()` return `p` (Playwright cannot move the OS cursor). */
const setCursor = (ctx: Launched, p: { x: number; y: number }) =>
  ctx.app.evaluate(({ screen }, point) => {
    screen.getCursorScreenPoint = () => point
  }, p)

test('dragging anywhere on the bar moves it and persists the position', async () => {
  const { app, bar } = ctx
  const start = (await barWindow(app)).bounds
  await expect(bar.getByTestId('bar')).toHaveCSS('cursor', 'grab')
  // Start on a ticker item (not the grip, which no longer exists).
  const item = await barItems(bar).nth(1).boundingBox()
  await setCursor(ctx, { x: 500, y: 300 })
  await bar.mouse.move(item!.x + 10, item!.y + 10)
  await bar.mouse.down()
  await setCursor(ctx, { x: 450, y: 400 })
  await bar.mouse.move(item!.x + 20, item!.y + 12)
  await setCursor(ctx, { x: 400, y: 500 })
  await bar.mouse.move(item!.x + 30, item!.y + 14)
  await bar.mouse.up()
  const expected = { x: start.x - 100, y: start.y + 200 }
  await expect.poll(async () => (await barWindow(app)).bounds).toMatchObject({ ...expected, width: start.width })
  await expect
    .poll(async () => (await bar.evaluate(() => window.ticker.getState())).settings.bar)
    .toMatchObject(expected)
})

/** Presses on `testId`, moves main's cursor by dx, releases. */
async function dragHandle(ctx: Launched, testId: string, dx: number): Promise<void> {
  const box = await ctx.bar.getByTestId(testId).boundingBox()
  await setCursor(ctx, { x: 600, y: 300 })
  await ctx.bar.mouse.move(box!.x + 2, box!.y + 20)
  await ctx.bar.mouse.down()
  await setCursor(ctx, { x: 600 + dx, y: 310 })
  await ctx.bar.mouse.move(box!.x + 3, box!.y + 20)
  await ctx.bar.mouse.up()
}

test('dragging the left edge resizes the bar; the right edge stays put', async () => {
  const { app, bar } = ctx
  const start = (await barWindow(app)).bounds
  const handle = bar.getByTestId('resize-left')
  await expect(handle).toHaveCSS('cursor', 'ew-resize')
  expect((await handle.boundingBox())!.x).toBeLessThanOrEqual(1)
  await dragHandle(ctx, 'resize-left', -80)
  const expected = { x: start.x - 80, y: start.y, width: start.width + 80 }
  await expect.poll(async () => (await barWindow(app)).bounds).toMatchObject(expected)
  await expect
    .poll(async () => (await bar.evaluate(() => window.ticker.getState())).settings.bar)
    .toMatchObject(expected)
  // Shrinking stops at the 320 px minimum, right edge unchanged.
  await dragHandle(ctx, 'resize-left', 5000)
  await expect.poll(async () => (await barWindow(app)).bounds.width).toBe(320)
  expect((await barWindow(app)).bounds.x + 320).toBe(expected.x + expected.width)
})

test('dragging the right edge resizes the bar; the left edge stays put', async () => {
  const { app, bar } = ctx
  const start = (await barWindow(app)).bounds
  const handle = bar.getByTestId('resize-right')
  await expect(handle).toHaveCSS('cursor', 'ew-resize')
  const box = (await handle.boundingBox())!
  expect(box.x + box.width).toBeGreaterThanOrEqual(start.width - 1)
  await dragHandle(ctx, 'resize-right', -160)
  const expected = { x: start.x, y: start.y, width: start.width - 160 }
  await expect.poll(async () => (await barWindow(app)).bounds).toMatchObject(expected)
  await expect
    .poll(async () => (await bar.evaluate(() => window.ticker.getState())).settings.bar)
    .toMatchObject(expected)
  // Widening stops at the right edge of the work area, left edge unchanged.
  await dragHandle(ctx, 'resize-right', 10000)
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  const right = workArea.x + workArea.width
  await expect.poll(async () => (await barWindow(app)).bounds.width).toBe(right - start.x)
  expect((await barWindow(app)).bounds.x).toBe(start.x)
})

test('widening from the left edge stops at the left edge of the work area', async () => {
  const { app } = ctx
  const start = (await barWindow(app)).bounds
  await dragHandle(ctx, 'resize-left', -10000)
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  await expect.poll(async () => (await barWindow(app)).bounds).toMatchObject({
    x: workArea.x,
    width: start.x + start.width - workArea.x
  })
})

test('a click without movement leaves the bar where it is and saves nothing', async () => {
  const { app, bar } = ctx
  const start = (await barWindow(app)).bounds
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  // Default position is 8 px below the top, inside the 16 px snap distance.
  expect(start.y).toBe(workArea.y + 8)
  const item = await barItems(bar).nth(1).boundingBox()
  await setCursor(ctx, { x: 500, y: 300 })
  await bar.mouse.move(item!.x + 10, item!.y + 10)
  await bar.mouse.down()
  await bar.mouse.up()
  await bar.waitForTimeout(300)
  expect((await barWindow(app)).bounds).toEqual(start)
  const saved = (await bar.evaluate(() => window.ticker.getState())).settings.bar
  expect({ x: saved.x, y: saved.y }).toEqual({ x: null, y: null })
})

test('scrolling pauses while the bar is hidden or the screen is locked, and resumes', async () => {
  const { app, bar } = ctx
  await expect(bar.getByTestId('track')).toHaveAttribute('data-scrolling', 'true')
  await expect.poll(async () => (await trackStyle(ctx)).state).toBe('running')
  // Hidden from the tray / Preferences: the window 'hide' event. (Page visibility and macOS
  // occlusion cannot be observed under Playwright, which keeps the page visible; they are
  // verified without Playwright, see task log.)
  await bar.evaluate(() => window.ticker.command({ type: 'setBar', bar: { visible: false } }))
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-visible', 'false')
  expect((await trackStyle(ctx)).state).toBe('paused')
  await bar.evaluate(() => window.ticker.command({ type: 'setBar', bar: { visible: true } }))
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-visible', 'true')
  await expect.poll(async () => (await trackStyle(ctx)).state).toBe('running')
  // powerMonitor signals (emitted here; a real lock/sleep is not triggered by the test).
  for (const [off, on] of [
    ['lock-screen', 'unlock-screen'],
    ['suspend', 'resume'],
    ['user-did-resign-active', 'user-did-become-active']
  ] as const) {
    await app.evaluate(({ powerMonitor }, e) => void powerMonitor.emit(e), off)
    await expect(bar.getByTestId('bar')).toHaveAttribute('data-visible', 'false')
    expect((await trackStyle(ctx)).state).toBe('paused')
    await app.evaluate(({ powerMonitor }, e) => void powerMonitor.emit(e), on)
    await expect(bar.getByTestId('bar')).toHaveAttribute('data-visible', 'true')
    await expect.poll(async () => (await trackStyle(ctx)).state).toBe('running')
  }
  // Prices keep updating while paused.
  await app.evaluate(({ powerMonitor }) => void powerMonitor.emit('lock-screen'))
  // getState() carries main's current visibility, so a renderer that loads now starts paused.
  expect((await bar.evaluate(() => window.ticker.getState())).barVisible).toBe(false)
  const tooltip = await barItems(bar).first().getAttribute('title')
  await expect.poll(() => barItems(bar).first().getAttribute('title'), { timeout: 5000 }).not.toBe(tooltip)
  await app.evaluate(({ powerMonitor }) => void powerMonitor.emit('unlock-screen'))
})

test('locked bar ignores drags and has no resize handle', async () => {
  const { app, bar } = ctx
  expect((await bar.evaluate(() => window.ticker.command({ type: 'setBar', bar: { locked: true } }))).ok).toBe(true)
  await expect(bar.getByTestId('resize-left')).toHaveCount(0)
  await expect(bar.getByTestId('resize-right')).toHaveCount(0)
  await expect(bar.getByTestId('bar')).toHaveCSS('cursor', 'default')
  const start = (await barWindow(app)).bounds
  const item = await barItems(bar).first().boundingBox()
  await setCursor(ctx, { x: 500, y: 300 })
  await bar.mouse.move(item!.x + 10, item!.y + 10)
  await bar.mouse.down()
  await setCursor(ctx, { x: 300, y: 500 })
  await bar.mouse.move(item!.x + 30, item!.y + 14)
  await bar.mouse.up()
  await bar.waitForTimeout(300)
  expect((await barWindow(app)).bounds).toEqual(start)
})

test('each item is a separate tile without divider lines; the marquee moves on every frame', async () => {
  const { bar } = ctx
  await expect.poll(async () => (await trackStyle(ctx)).state).toBe('running')
  const tile = await barItems(bar).first().evaluate((el) => {
    const s = getComputedStyle(el)
    return { bg: s.backgroundColor, radius: s.borderTopLeftRadius, height: el.getBoundingClientRect().height }
  })
  expect(tile.bg).not.toBe('rgba(0, 0, 0, 0)')
  expect(tile.radius).toBe('8px')
  expect(tile.height).toBe(44)
  await expect(bar.locator('[data-copy-sep]')).toHaveCount(0)
  // Every rect is read in one evaluate, so a marquee step cannot land between the reads.
  const [a, b] = await bar.locator('[data-copy="0"]').evaluate((copy) =>
    [...copy.querySelectorAll('[data-testid="ticker-item"]')].slice(0, 2).map((el) => el.getBoundingClientRect().toJSON() as DOMRect)
  )
  expect(Math.round(b!.x - (a!.x + a!.width))).toBe(4)
  // 8 px from the sparkline to the price column; the column has no fixed width.
  const first = barItems(bar).first()
  const [spark, price, pct] = await first.evaluate((item) =>
    ['sparkline', 'price', 'pct'].map(
      (id) => item.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().toJSON() as DOMRect
    )
  )
  const column = Math.min(price!.x, pct!.x)
  expect(Math.round(column - (spark!.x + spark!.width))).toBe(8)
  expect(Math.round(price!.x + price!.width)).toBe(Math.round(pct!.x + pct!.width))
  // Tabular digits: same digit count -> same width (card width does not jitter on updates).
  const widths = await first.getByTestId('price').evaluate((el) => {
    const original = el.textContent!
    const measure = (digit: string): number => {
      el.textContent = original.replace(/\d/g, digit)
      return el.getBoundingClientRect().width
    }
    const out = [measure('1'), measure('8'), measure('0')]
    el.textContent = original
    return out
  })
  expect(new Set(widths).size).toBe(1)
  // No frame-rate cap: the track's position changes on (nearly) every display frame.
  const { frames, moves } = await bar.getByTestId('track').evaluate(
    (el) =>
      new Promise<{ frames: number; moves: number }>((resolve) => {
        let frames = 0
        let moves = 0
        const read = (): string => getComputedStyle(el).transform
        let last = read()
        const end = performance.now() + 1000
        requestAnimationFrame(function tick(now) {
          frames++
          const now2 = read()
          if (now2 !== last) (moves++, (last = now2))
          if (now < end) requestAnimationFrame(tick)
          else resolve({ frames, moves })
        })
      })
  )
  expect(frames).toBeGreaterThan(40)
  expect(moves / frames).toBeGreaterThan(0.9)
})
