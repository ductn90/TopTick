import { defineConfig } from '@playwright/test'

// Electron e2e: run `npm run test:e2e` (builds first). Each test launches the
// built app with TOPTICK_FAKE_DATA=1 and its own userData directory.
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list'
})
