import { expect, test, type Page } from '@playwright/test'
import { launch, openSettings, removeDir, tempDir, type Launched } from './helpers'

let dir: string
let ctx: Launched
let settings: Page

test.beforeEach(async () => {
  dir = await tempDir()
  ctx = await launch(dir)
  settings = await openSettings(ctx.app, ctx.bar)
  await settings.getByTestId('tab-preferences').click()
})

test.afterEach(async () => {
  await ctx.app.close()
  await removeDir(dir)
})

const bodyBackground = (page: Page) => page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor)

test('the default theme is System and follows the OS (A16)', async () => {
  await expect(settings.getByTestId('pref-theme-system')).toHaveAttribute('aria-pressed', 'true')
  expect(await ctx.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
  const osDark = await ctx.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
  await expect(ctx.bar.locator('html')).toHaveAttribute('data-theme', osDark ? 'dark' : 'light')
})

test('Light and Dark apply to both windows; Settings uses the bar background', async () => {
  const { bar } = ctx
  await settings.getByTestId('pref-theme-dark').click()
  await expect(bar.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(settings.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await bodyBackground(settings)).toBe('rgb(11, 13, 18)')
  await settings.getByTestId('pref-theme-light').click()
  await expect(settings.getByTestId('pref-theme-light')).toHaveAttribute('aria-pressed', 'true')
  await expect(bar.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(settings.locator('html')).toHaveAttribute('data-theme', 'light')
  const background = await bar.getByTestId('bar').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(background).toBe('rgba(255, 255, 255, 0.94)')
  expect(await bodyBackground(settings)).toBe('rgb(255, 255, 255)')
  expect(await ctx.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
})

test('Settings accents use the app green in both themes, not blue', async () => {
  const GREEN = { dark: 'rgb(22, 199, 132)', light: 'rgb(3, 122, 75)' } as const
  for (const theme of ['dark', 'light'] as const) {
    await settings.getByTestId(`pref-theme-${theme}`).click()
    await expect(settings.locator('html')).toHaveAttribute('data-theme', theme)
    const green = GREEN[theme]
    expect(await settings.locator('body').evaluate((el) => getComputedStyle(el).accentColor)).toBe(green)
    // Switch track when on.
    const sw = settings.getByTestId('pref-show-bar')
    await expect(sw).toBeChecked()
    await expect(sw).toHaveCSS('background-color', green)
    // Focus ring.
    await sw.focus()
    await settings.keyboard.press('Shift+Tab')
    await settings.keyboard.press('Tab')
    await expect(sw).toHaveCSS('outline-color', green)
    // Selected tab icon, primary button, active-watchlist dot.
    await expect(settings.getByTestId('tab-preferences')).toHaveCSS('color', green)
    await settings.getByTestId('tab-watchlists').click()
    await settings.locator('[data-testid="watchlist-row"][data-id="default-vn"]').click()
    await expect(settings.getByTestId('set-active')).toHaveCSS('background-color', green)
    const dot = await settings
      .locator('[data-testid="watchlist-row"][data-id="default-ov"] span[class*="dot"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(dot).toBe(green)
    await settings.getByTestId('tab-preferences').click()
  }
})

test('System sets nativeTheme.themeSource to system', async () => {
  await settings.getByTestId('pref-theme-system').click()
  await expect.poll(() => ctx.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
  const osDark = await ctx.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
  await expect(ctx.bar.locator('html')).toHaveAttribute('data-theme', osDark ? 'dark' : 'light')
})

test('EN <-> VI relabels the bar and Settings without restart', async () => {
  const pill = ctx.bar.getByTestId('watchlist-pill')
  await expect(pill).toHaveAttribute('title', 'Switch watchlist')
  await expect(settings.getByTestId('tab-watchlists')).toHaveText('Watchlists')

  await settings.getByTestId('pref-language').selectOption('vi')
  await expect(pill).toHaveAttribute('title', 'Đổi danh mục')
  await expect(ctx.bar.locator('html')).toHaveAttribute('lang', 'vi')
  await expect(settings.getByTestId('tab-watchlists')).toHaveText('Danh mục')
  await expect(settings.getByTestId('tab-preferences')).toHaveText('Tuỳ chọn')
  await expect(settings.getByTestId('pref-theme-dark')).toHaveText('Tối')
  await expect.poll(() => settings.title()).toBe('Cài đặt TopTick')

  await settings.getByTestId('pref-language').selectOption('en')
  await expect(pill).toHaveAttribute('title', 'Switch watchlist')
  await expect(settings.getByTestId('tab-preferences')).toHaveText('Preferences')
})
