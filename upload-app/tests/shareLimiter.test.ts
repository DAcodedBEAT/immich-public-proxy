import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeyType, loadConfig as loadConfigStatic } from '@ipp/core'

/*
  The upload service resolves shares through the same process-wide limiter
  as the gallery, so a burst of made-up keys can't drive unbounded uncached
  lookups against Immich. Fresh modules per test: the limiter is a singleton.
*/

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null)
    },
    json: async () => body
  }
}

beforeEach(() => {
  process.env.IMMICH_URL = 'http://immich.test'
  vi.resetModules()
})

afterEach(() => {
  delete process.env.CONFIG
  loadConfigStatic()
  vi.unstubAllGlobals()
})

describe('getShare', () => {
  it('bounds concurrent uncached lookups by ipp.shareResolutionConcurrency', async () => {
    process.env.CONFIG = JSON.stringify({ ipp: { shareResolutionConcurrency: 2 } })
    const { loadConfig } = await import('@ipp/core')
    loadConfig()
    const { getShare } = await import('../src/share')

    let active = 0
    let peak = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        return jsonResponse({ message: 'Invalid share key' }, 401)
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => getShare('made-up-' + i, KeyType.key))
    )
    expect(results.every(r => !r.valid)).toBe(true)
    expect(peak).toBe(2)
    log.mockRestore()
  })

  it('reads a lookup turned away by a full queue as an invalid share', async () => {
    process.env.CONFIG = JSON.stringify({ ipp: { shareResolutionConcurrency: 1 } })
    const core = await import('@ipp/core')
    core.loadConfig()
    core.SHARE_RESOLUTION_LIMITS.maxQueue = 0
    const { getShare } = await import('../src/share')

    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate
        return jsonResponse({ message: 'Invalid share key' }, 401)
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const stuck = getShare('made-up-1', KeyType.key)
    expect(await getShare('made-up-2', KeyType.key)).toEqual({ valid: false })
    release()
    expect((await stuck).valid).toBe(false)
    log.mockRestore()
    warn.mockRestore()
  })
})
