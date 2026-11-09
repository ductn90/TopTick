import { expect, test, type Page } from '@playwright/test'
import { barSymbols, DEFAULT_OVERVIEW, launch, openSettings, removeDir, tempDir, type Launched } from './helpers'

let dir: string
let ctx: Launched
let settings: Page

test.beforeEach(async () => {
  dir = await tempDir()
  ctx = await launch(dir)
  settings = await openSettings(ctx.app, ctx.bar)
})

test.afterEach(async () => {
  await ctx.app.close()
  await removeDir(dir)
})

const row = (id: string) => settings.locator(`[data-testid="item-row"][data-id="${id}"]`)

test('search and add FPT, NVDA, SOL to a new "Test" list; it shows on the bar', async () => {
  await settings.getByTestId('new-watchlist-input').fill('Test')
  await settings.getByTestId('create-watchlist').click()
  await expect(settings.getByTestId('selected-name')).toHaveText('Test')
  await expect(settings.getByTestId('items-empty')).toBeVisible()

  const input = settings.getByTestId('search-input')
  let added = 0
  for (const [query, id] of [
    ['FPT', 'vn:FPT'],
    ['NVDA', 'us:NVDA'],
    ['SOL', 'crypto:SOLUSDT']
  ] as const) {
    await input.fill(query)
    const result = settings.locator(`[data-testid="search-result"][data-id="${id}"]`)
    await result.getByTestId('add-result').click()
    // After a successful add the search is cleared and focused for the next symbol.
    await expect(settings.getByTestId('item-row')).toHaveCount(++added)
    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()
    await expect(settings.getByTestId('search-result')).toHaveCount(0)
  }
  // Searching an added symbol again reports it is already in the list.
  await input.fill('FPT')
  await expect(settings.locator('[data-testid="search-result"][data-id="vn:FPT"]').getByTestId('result-status')).toHaveText(
    'Already in list.'
  )
  await input.fill('')
  await expect(settings.getByTestId('item-row')).toHaveCount(3)

  // Adding a duplicate through the API is rejected with DUPLICATE.
  const dup = await settings.evaluate(async () => {
    const { settings: s } = await window.ticker.getState()
    const list = s.watchlists.find((w) => w.name === 'Test')!
    return window.ticker.command({ type: 'addItem', watchlistId: list.id, instrument: s.instruments['vn:FPT']! })
  })
  expect(dup).toEqual({ ok: false, code: 'DUPLICATE' })
  // An instrument that main never returned from search is rejected.
  const forged = await settings.evaluate(async () => {
    const { settings: s } = await window.ticker.getState()
    const list = s.watchlists.find((w) => w.name === 'Test')!
    const instrument = { ...s.instruments['vn:FPT']!, id: 'vn:ZZZQ', symbol: 'ZZZQ', displaySymbol: 'ZZZQ' }
    return window.ticker.command({ type: 'addItem', watchlistId: list.id, instrument })
  })
  expect(forged).toEqual({ ok: false, code: 'BAD_REQUEST' })

  await settings.getByTestId('set-active').click()
  await expect.poll(() => barSymbols(ctx.bar)).toEqual(['FPT', 'NVDA', 'SOL/USDT'])
  await expect(ctx.bar.getByTestId('watchlist-pill')).toHaveText(/Test/)
})

test('Enter adds the only result; the market dropdown sits inside the search field', async () => {
  await settings.getByTestId('new-watchlist-input').fill('Enter')
  await settings.getByTestId('create-watchlist').click()
  await expect(settings.getByTestId('selected-name')).toHaveText('Enter')
  const input = settings.getByTestId('search-input')
  const market = settings.getByTestId('search-market')
  // The dropdown is inside the input's field box.
  const [field, select] = await Promise.all([
    input.evaluate((el) => el.parentElement!.getBoundingClientRect().toJSON()),
    market.boundingBox()
  ])
  expect(select!.x).toBeGreaterThanOrEqual(field.x)
  expect(select!.x + select!.width).toBeLessThanOrEqual(field.x + field.width)
  expect(select!.y).toBeGreaterThanOrEqual(field.y)
  expect(select!.y + select!.height).toBeLessThanOrEqual(field.y + field.height)
  await expect(market.locator('option')).toHaveText(['All', 'VN', 'US', 'Crypto'])

  // Several results: Enter does nothing.
  await market.selectOption('crypto')
  await input.fill('B')
  await expect.poll(() => settings.getByTestId('search-result').count()).toBeGreaterThan(1)
  await input.press('Enter')
  await settings.waitForTimeout(300)
  await expect(settings.getByTestId('items-empty')).toBeVisible()

  // Exactly one result: Enter adds it and clears the search.
  await market.selectOption('us')
  await input.fill('NVDA')
  await expect(settings.getByTestId('search-result')).toHaveCount(1)
  await input.press('Enter')
  await expect(settings.getByTestId('item-row')).toHaveCount(1)
  await expect(settings.getByTestId('item-row').first()).toHaveAttribute('data-id', 'us:NVDA')
  await expect(input).toHaveValue('')
})

test('rename and delete are labelled icon buttons', async () => {
  const selected = settings.locator('[data-testid="watchlist-row"][data-id="default-ov"]')
  for (const [id, label] of [
    ['rename-watchlist', 'Rename “Overview”'],
    ['delete-watchlist', 'Delete “Overview”']
  ] as const) {
    const button = selected.getByTestId(id)
    await expect(button).toHaveAttribute('aria-label', label)
    await expect(button).toHaveAttribute('title', label)
    await expect(button.locator('svg')).toHaveCount(1)
    await expect(button).toHaveText('')
  }
})

test('the search field clears with a labelled Solar icon, not the native button', async () => {
  const input = settings.getByTestId('search-input')
  const clear = settings.getByTestId('search-clear')
  await expect(clear).toHaveCount(0)
  await input.fill('FPT')
  await expect(clear).toHaveAttribute('aria-label', 'Clear search')
  await expect(clear).toHaveAttribute('title', 'Clear search')
  await expect(clear.locator('svg')).toHaveCount(1)
  // getComputedStyle does not resolve WebKit's internal pseudo-elements; check the rule that hides it.
  const hidden = await input.evaluate((el) =>
    [...document.styleSheets].some((sheet) =>
      [...sheet.cssRules].some(
        (r) =>
          r instanceof CSSStyleRule &&
          r.selectorText.includes('::-webkit-search-cancel-button') &&
          r.style.display === 'none' &&
          el.matches(r.selectorText.replace('::-webkit-search-cancel-button', ''))
      )
    )
  )
  expect(hidden).toBe(true)
  await clear.click()
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
  await expect(clear).toHaveCount(0)
})

test('keyboard reorder changes the bar order', async () => {
  await expect(settings.getByTestId('item-row')).toHaveCount(8)
  await settings.getByTestId('item-row').first().getByTestId('drag-handle').focus()
  await settings.keyboard.press('Space')
  await settings.waitForTimeout(200)
  await settings.keyboard.press('ArrowDown')
  await settings.waitForTimeout(200)
  await settings.keyboard.press('Space')

  const expected = [DEFAULT_OVERVIEW[1], DEFAULT_OVERVIEW[0], ...DEFAULT_OVERVIEW.slice(2)]
  await expect.poll(() => barSymbols(ctx.bar)).toEqual(expected)
  await expect(settings.getByTestId('item-row').first()).toHaveAttribute('data-id', 'us:^GSPC')
})

test('hide removes an item from the bar and show restores its position', async () => {
  const toggle = row('us:^GSPC').getByTestId('toggle-hidden')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => barSymbols(ctx.bar)).toEqual(DEFAULT_OVERVIEW.filter((s) => s !== 'S&P 500'))

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => barSymbols(ctx.bar)).toEqual(DEFAULT_OVERVIEW)
})

test('rename and delete a watchlist', async () => {
  await settings.getByTestId('new-watchlist-input').fill('Temp')
  await settings.getByTestId('create-watchlist').click()
  const temp = settings.locator('[data-testid="watchlist-row"][data-name="Temp"]')
  await expect(temp).toHaveCount(1)

  await temp.getByTestId('rename-watchlist').click()
  await settings.getByTestId('rename-input').fill('VN')
  await settings.getByTestId('rename-save').click()
  await expect(settings.getByTestId('error')).toHaveText('A watchlist with this name already exists.')

  await settings.getByTestId('rename-input').fill('Temp 2')
  await settings.getByTestId('rename-save').click()
  const renamed = settings.locator('[data-testid="watchlist-row"][data-name="Temp 2"]')
  await expect(renamed).toHaveCount(1)
  await expect(settings.getByTestId('error')).toHaveCount(0)

  await renamed.getByTestId('delete-watchlist').click()
  await renamed.getByTestId('confirm-delete').click()
  await expect(renamed).toHaveCount(0)
  await expect(settings.getByTestId('watchlist-row')).toHaveCount(4)
})

test('the last watchlist cannot be deleted', async () => {
  const deleted = await settings.evaluate(async () => {
    const codes: boolean[] = []
    for (const id of ['default-vn', 'default-us', 'default-cr']) {
      codes.push((await window.ticker.command({ type: 'deleteWatchlist', id })).ok)
    }
    return codes
  })
  expect(deleted).toEqual([true, true, true])
  await expect(settings.getByTestId('watchlist-row')).toHaveCount(1)
  await expect(settings.getByTestId('delete-watchlist')).toBeDisabled()

  const last = await settings.evaluate(() => window.ticker.command({ type: 'deleteWatchlist', id: 'default-ov' }))
  expect(last).toEqual({ ok: false, code: 'LAST_WATCHLIST' })
})
