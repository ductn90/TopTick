import { expect, test } from '@playwright/test'
import { launch, removeDir, tempDir } from './helpers'

// Real providers (AC 6). Run with: TOPTICK_LIVE=1 npx playwright test tests/e2e/live.spec.ts
test.skip(process.env.TOPTICK_LIVE !== '1', 'live providers: set TOPTICK_LIVE=1')

test('BTC/USDT price changes within 10 s', async () => {
  const dir = await tempDir()
  const { app, bar } = await launch(dir, { fake: false })
  try {
    const item = bar.locator('[data-copy="0"] [data-testid="ticker-item"][data-id="crypto:BTCUSDT"]')
    await expect(item).toHaveAttribute('data-state', 'live', { timeout: 20_000 })
    const price = item.getByTestId('price')
    const first = await price.textContent()
    const startedAt = Date.now()
    await expect.poll(() => price.textContent(), { timeout: 10_000, intervals: [250] }).not.toBe(first)
    const second = await price.textContent()
    console.log(`BTC/USDT ${first} -> ${second} after ${Date.now() - startedAt} ms; title: ${await item.getAttribute('title')}`)
  } finally {
    await app.close()
    await removeDir(dir)
  }
})
