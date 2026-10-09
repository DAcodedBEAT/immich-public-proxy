/**
 * getShareResolutionLimiter bounds concurrent *uncached* share lookups, since
 * a negative result is never cached and a burst of made-up keys would
 * otherwise drive unbounded round trips against Immich. The limiter is
 * module-level state, so each config-sensitive test gets a fresh module
 * import (vi.resetModules) to avoid bleed between tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadConfig as loadConfigStatic } from '../src/config/loader'

let savedConfig: string | undefined
let savedImmichUrl: string | undefined

beforeEach(() => {
  savedConfig = process.env.CONFIG
  savedImmichUrl = process.env.IMMICH_URL
  process.env.IMMICH_URL = 'http://immich.test'
  vi.resetModules()
})

afterEach(() => {
  if (savedConfig === undefined) delete process.env.CONFIG
  else process.env.CONFIG = savedConfig
  if (savedImmichUrl === undefined) delete process.env.IMMICH_URL
  else process.env.IMMICH_URL = savedImmichUrl
  loadConfigStatic()
  vi.unstubAllGlobals()
})

async function freshLimiter() {
  const { loadConfig } = await import('../src/config/loader')
  loadConfig()
  const { getShareResolutionLimiter } = await import('../src/immich/share')
  return getShareResolutionLimiter()
}

describe('getShareResolutionLimiter', () => {
  it('defaults to a concurrency of 30 when unconfigured', async () => {
    delete process.env.CONFIG
    const limiter = await freshLimiter()

    let active = 0
    let maxActive = 0
    const task = () =>
      new Promise<void>(resolve => {
        active++
        maxActive = Math.max(maxActive, active)
        setTimeout(() => {
          active--
          resolve()
        }, 5)
      })

    await Promise.all(Array.from({ length: 60 }, () => limiter(task)))
    expect(maxActive).toBe(30)
  })

  it('honors ipp.shareResolutionConcurrency from config', async () => {
    process.env.CONFIG = JSON.stringify({ ipp: { shareResolutionConcurrency: 3 } })
    const limiter = await freshLimiter()

    let active = 0
    let maxActive = 0
    const task = () =>
      new Promise<void>(resolve => {
        active++
        maxActive = Math.max(maxActive, active)
        setTimeout(() => {
          active--
          resolve()
        }, 5)
      })

    await Promise.all(Array.from({ length: 10 }, () => limiter(task)))
    expect(maxActive).toBe(3)
  })

  it('returns the same limiter instance across calls (module-level singleton)', async () => {
    delete process.env.CONFIG
    const { loadConfig } = await import('../src/config/loader')
    loadConfig()
    const { getShareResolutionLimiter } = await import('../src/immich/share')
    expect(getShareResolutionLimiter()).toBe(getShareResolutionLimiter())
  })
})
