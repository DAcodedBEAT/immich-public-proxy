/**
 * Tests for getShareResolutionLimiter and its wiring into getShareByKey.
 *
 * Bounds concurrent *uncached* share resolutions - without it, a burst of
 * requests for made-up/nonexistent keys (or just internet background noise -
 * automated scanners hit every public endpoint) costs an unbounded pile of
 * uncached round trips against a private Immich instance, since invalid
 * results are deliberately never cached (see the shareCache doc-comment).
 *
 * Like getUploadLimiter/getUploadCheckLimiter, the limiter instance is
 * module-level state, so each config-sensitive test gets a fresh module
 * import (vi.resetModules) to avoid bleed between tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadConfig as loadConfigStatic } from '../src/config/loader'
import { KeyType } from '../src/types'

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
  const { getShareResolutionLimiter } = await import('../src/immich')
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
    const { getShareResolutionLimiter } = await import('../src/immich')
    expect(getShareResolutionLimiter()).toBe(getShareResolutionLimiter())
  })
})

describe('getShareByKey uses the share resolution limiter', () => {
  interface MockResponse {
    ok: boolean
    status: number
    headers: { get: (h: string) => string | null }
    json: () => Promise<unknown>
  }
  function jsonResponse(body: unknown, status = 200): MockResponse {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null)
      },
      json: async () => body
    }
  }

  it('bounds concurrent uncached lookups for distinct (e.g. made-up) keys', async () => {
    process.env.CONFIG = JSON.stringify({ ipp: { shareResolutionConcurrency: 4 } })
    const { loadConfig } = await import('../src/config/loader')
    loadConfig()
    const { getShareByKey } = await import('../src/immich')

    let active = 0
    let maxActive = 0
    let releaseAll!: () => void
    const gate = new Promise<void>(resolve => {
      releaseAll = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await gate
        active--
        // Every key is bogus - Immich would 401 with "Invalid share key".
        return jsonResponse({ message: 'Invalid share key' }, 401)
      })
    )

    // 20 DIFFERENT keys - a negative cache would do nothing here, since none
    // of them repeat.
    const pending = Array.from({ length: 20 }, (_, i) =>
      getShareByKey('nonexistent-key-' + i, undefined, KeyType.key)
    )

    // Let everything that can start actually start before releasing the gate.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    releaseAll()
    await Promise.all(pending)

    expect(maxActive).toBeLessThanOrEqual(4)
  })

  it('does not throttle a cache hit, even while the limiter is saturated with slow misses', async () => {
    process.env.CONFIG = JSON.stringify({ ipp: { shareResolutionConcurrency: 2 } })
    const { loadConfig } = await import('../src/config/loader')
    loadConfig()
    const { getShareByKey } = await import('../src/immich')

    const validKey = 'warm-valid-key'
    let releaseSlow!: () => void
    const slowGate = new Promise<void>(resolve => {
      releaseSlow = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('key=' + validKey)) {
          return jsonResponse({
            type: 'INDIVIDUAL',
            assets: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', isTrashed: false }],
            allowDownload: true,
            expiresAt: null,
            showMetadata: true,
            key: validKey
          })
        }
        await slowGate
        return jsonResponse({ message: 'Invalid share key' }, 401)
      })
    )

    // Warm the cache for the valid key first, uncontended.
    const warm = await getShareByKey(validKey, undefined, KeyType.key)
    expect(warm.valid).toBe(true)

    // Saturate both limiter slots with slow, never-yet-released misses.
    const slowMisses = [
      getShareByKey('slow-miss-1', undefined, KeyType.key),
      getShareByKey('slow-miss-2', undefined, KeyType.key)
    ]
    await Promise.resolve()
    await Promise.resolve()

    // The cache hit must still resolve immediately, without waiting on the
    // saturated limiter - it's a genuinely separate, un-gated code path.
    const hitOrTimeout = await Promise.race([
      getShareByKey(validKey, undefined, KeyType.key).then(() => 'hit' as const),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 200))
    ])
    expect(hitOrTimeout).toBe('hit')

    releaseSlow()
    await Promise.all(slowMisses)
  })
})
