import { defineConfig } from 'vitest/config'

// Unit/integration only. Browser E2E lives in tests/e2e and runs under
// Playwright (npm run test:e2e) — vitest must not collect those specs.
export default defineConfig({
  test: {
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
})