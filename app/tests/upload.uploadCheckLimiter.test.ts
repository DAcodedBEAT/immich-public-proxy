/**
 * Tests for getUploadCheckLimiter.
 *
 * It's deliberately a separate limiter from getUploadLimiter (see the
 * doc-comment on it in immich.ts): the dedup-check endpoint is a cheap JSON
 * round trip, so it gets its own, higher-throughput concurrency pool
 * (ipp.upload.concurrentChecks) rather than competing with actual file
 * uploads for the small ipp.upload.concurrentUploads pool. A burst of
 * visitors opening the review sheet at once should never be able to starve
 * real uploads of their slots.
 *
 * Like getUploadLimiter, the limiter instance is module-level state, so each
 * test gets a fresh module import (vi.resetModules) to avoid bleed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadConfig as loadConfigStatic } from '../src/config/loader'

let savedConfig: string | undefined

beforeEach(() => {
  savedConfig = process.env.CONFIG
  vi.resetModules()
})

afterEach(() => {
  if (savedConfig === undefined) delete process.env.CONFIG
  else process.env.CONFIG = savedConfig
  // Restore the STATIC module instance's config too, in case anything
  // outside this file's dynamic imports reads it later in the run.
  loadConfigStatic()
})

// vi.resetModules() gives every dynamic import() below a fresh module
// registry - config/loader.ts included. loadConfig() must be called on THAT
// same fresh instance, not the statically-imported one above (which is
// bound to the pre-reset generation), or the two disagree about config
// state despite both notionally being "the config module".
async function freshLimiter() {
  const { loadConfig } = await import('../src/config/loader')
  loadConfig()
  const { getUploadCheckLimiter } = await import('../src/immich')
  return getUploadCheckLimiter()
}

describe('getUploadCheckLimiter', () => {
  it('defaults to a concurrency of 20 when unconfigured', async () => {
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

    await Promise.all(Array.from({ length: 30 }, () => limiter(task)))
    expect(maxActive).toBe(20)
  })

  it('honors ipp.upload.concurrentChecks from config', async () => {
    process.env.CONFIG = JSON.stringify({ ipp: { upload: { concurrentChecks: 3 } } })
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
    const { getUploadCheckLimiter } = await import('../src/immich')
    expect(getUploadCheckLimiter()).toBe(getUploadCheckLimiter())
  })

  it('is a distinct limiter from getUploadLimiter - checks never share upload slots', async () => {
    process.env.CONFIG = JSON.stringify({
      ipp: { upload: { concurrentUploads: 1, concurrentChecks: 5 } }
    })
    const { loadConfig } = await import('../src/config/loader')
    loadConfig()
    const { getUploadLimiter, getUploadCheckLimiter } = await import('../src/immich')

    // Hold the single upload slot open indefinitely...
    let releaseUpload: () => void = () => {}
    const uploadHeld = new Promise<void>(resolve => {
      releaseUpload = resolve
    })
    const uploadPromise = getUploadLimiter()(() => uploadHeld)

    // ...and confirm the check limiter's 5 slots are still independently usable.
    let checksCompleted = 0
    await Promise.all(
      Array.from({ length: 5 }, () =>
        getUploadCheckLimiter()(async () => {
          checksCompleted++
        })
      )
    )
    expect(checksCompleted).toBe(5)

    releaseUpload()
    await uploadPromise
  })
})
