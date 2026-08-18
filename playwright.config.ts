import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// The app runs against a local stub provider (dev/stub-server.mjs) hardwired
// to http://localhost:8787 in the mock spec. Live specs are opt-in: they only
// run when the matching E2E_*_API_KEY env var is set (see tests/e2e/live.spec.ts).

const chromiumPath = existsSync('/snap/bin/chromium') ? '/snap/bin/chromium' : undefined

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    launchOptions: chromiumPath ? { executablePath: chromiumPath, args: ['--no-sandbox'] } : undefined,
  },
  webServer: [
    {
      command: 'npm run stub',
      url: 'http://localhost:8787/v1/models',
      reuseExistingServer: true,
      timeout: 20_000,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
})