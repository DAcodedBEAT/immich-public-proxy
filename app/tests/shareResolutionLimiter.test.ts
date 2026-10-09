/**
 * getShareByKey wraps only its cache-miss path in the process-wide share
 * resolution limiter from @ipp/core (see getShareResolutionLimiter). The
 * limiter is module-level state, so each test gets a fresh module import
 * (vi.resetModules) to avoid bleed between tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { KeyType, loadConfig as loadConfigStatic } from '@ipp/core'

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
    const { loadConfig } = await import('@ipp/core')
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
    const { loadConfig } = await import('@ipp/core')
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
