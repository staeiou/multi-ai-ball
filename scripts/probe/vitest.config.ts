import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/probe/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
})
