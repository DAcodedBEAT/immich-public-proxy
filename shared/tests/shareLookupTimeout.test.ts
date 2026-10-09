import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeyType } from '../src/types'

/*
  A hung Immich must not hold a share-resolution slot forever: each lookup
  gives up after SHARE_RESOLUTION_LIMITS.lookupMs and reads as invalid.
*/

/** A fetch that never answers, but honours its abort signal like the real one. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
  )
}

beforeEach(() => {
  process.env.IMMICH_URL = 'http://immich.test'
  vi.resetModules()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchSharedLink with a hung Immich', () => {
  it('gives up after lookupMs and reports the share invalid', async () => {
    const fetch = hangingFetch()
    vi.stubGlobal('fetch', fetch)
    const { fetchSharedLink, SHARE_RESOLUTION_LIMITS } = await import('../src/immich/share')
    SHARE_RESOLUTION_LIMITS.lookupMs = 50
    const started = Date.now()
    expect(await fetchSharedLink('hung', KeyType.key)).toEqual({ valid: false })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('bounds the password login as well', async () => {
    const fetch = hangingFetch()
    vi.stubGlobal('fetch', fetch)
    const { fetchSharedLink, SHARE_RESOLUTION_LIMITS } = await import('../src/immich/share')
    SHARE_RESOLUTION_LIMITS.lookupMs = 50
    expect(await fetchSharedLink('hung', KeyType.key, 'pw')).toEqual({ valid: false })
    // The login, then the lookup, each with its own deadline
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(c => c[1]?.signal instanceof AbortSignal)).toBe(true)
  })

  it('reports a network error as invalid rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    const { fetchSharedLink } = await import('../src/immich/share')
    expect(await fetchSharedLink('down', KeyType.key)).toEqual({ valid: false })
  })
})

describe('limitShareResolution', () => {
  it('maps a full queue to an invalid result', async () => {
    process.env.CONFIG = JSON.stringify({ ipp: { shareResolutionConcurrency: 1 } })
    const { loadConfig } = await import('../src/config/loader')
    loadConfig()
    const { limitShareResolution, SHARE_RESOLUTION_LIMITS } = await import('../src/immich/share')
    SHARE_RESOLUTION_LIMITS.maxQueue = 1
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const running = limitShareResolution(async () => {
      await gate
      return { valid: true }
    })
    const queued = limitShareResolution(async () => ({ valid: true }))
    expect(await limitShareResolution(async () => ({ valid: true }))).toEqual({ valid: false })
    release()
    expect(await running).toEqual({ valid: true })
    expect(await queued).toEqual({ valid: true })
    delete process.env.CONFIG
    loadConfig()
  })

  it('passes other errors through', async () => {
    const { limitShareResolution } = await import('../src/immich/share')
    await expect(
      limitShareResolution(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
  })
})
