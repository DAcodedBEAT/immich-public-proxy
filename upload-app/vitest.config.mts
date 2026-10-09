import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Test against core's source, so `npm test` needs no build of shared/
    alias: { '@ipp/core': resolve(import.meta.dirname, '../shared/src/index.ts') }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
