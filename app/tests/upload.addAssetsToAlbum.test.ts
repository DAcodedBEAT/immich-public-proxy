import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { addAssetsToAlbum } from '../src/immich'

const ALBUM_ID = 'album-test-id'
const ASSET_IDS = ['asset-1']

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body)
  } as unknown as Response
}

beforeEach(() => {
  process.env.IMMICH_API_KEY = 'test-api-key'
  process.env.IMMICH_URL = 'http://immich.test'
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.IMMICH_API_KEY
  delete process.env.IMMICH_URL
})

describe('addAssetsToAlbum', () => {
  it('resolves immediately when all items succeed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse(200, [{ id: 'asset-1', success: true }]))
    )
    await expect(addAssetsToAlbum(ALBUM_ID, ASSET_IDS)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('resolves when item result is duplicate (treated as success)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          makeResponse(200, [{ id: 'asset-1', success: false, error: 'duplicate' }])
        )
    )
    await expect(addAssetsToAlbum(ALBUM_ID, ASSET_IDS)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('throws immediately on 4xx without retrying (client error)', async () => {
    // Switch to real timers for this test - the 4xx path throws synchronously
    // without scheduling any setTimeout, so fake timers aren't needed and the
    // async-timer dance can cause the rejection to escape the awaited expression.
    vi.useRealTimers()
    const spy = vi.fn().mockResolvedValue(makeResponse(403, 'Forbidden'))
    vi.stubGlobal('fetch', spy)

    await expect(addAssetsToAlbum(ALBUM_ID, ASSET_IDS)).rejects.toThrow(/album-add 403/)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('retries on 5xx and eventually succeeds', async () => {
    vi.useRealTimers()
    // Use short backoff-override-free approach: make fetch succeed on 2nd call
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(makeResponse(503, 'Service Unavailable'))
        .mockResolvedValue(makeResponse(200, [{ id: 'asset-1', success: true }]))
    )
    // Real timers; but the actual backoff is 500*2^1=1000ms - too long.
    // Patch setTimeout to fire immediately.
    const realSetTimeout = globalThis.setTimeout
    const spyTimeout = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn: TimerHandler, _delay?: number, ...args: unknown[]) => {
        return realSetTimeout(fn as (...a: unknown[]) => void, 0, ...args)
      })

    await expect(addAssetsToAlbum(ALBUM_ID, ASSET_IDS)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
    spyTimeout.mockRestore()
  })

  it('retries on 5xx up to 3 attempts then throws', async () => {
    vi.useRealTimers()
    const spy = vi.fn().mockResolvedValue(makeResponse(500, 'Internal Server Error'))
    vi.stubGlobal('fetch', spy)

    const realSetTimeout = globalThis.setTimeout
    const spyTimeout = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn: TimerHandler, _delay?: number, ...args: unknown[]) => {
        return realSetTimeout(fn as (...a: unknown[]) => void, 0, ...args)
      })

    await expect(addAssetsToAlbum(ALBUM_ID, ASSET_IDS)).rejects.toThrow(/album-add 500/)
    expect(spy).toHaveBeenCalledTimes(3)
    spyTimeout.mockRestore()
  })

  it('throws without retry when item result is no_permission', async () => {
    vi.useRealTimers()
    const spy = vi
      .fn()
      .mockResolvedValue(
        makeResponse(200, [{ id: 'asset-1', success: false, error: 'no_permission' }])
      )
    vi.stubGlobal('fetch', spy)

    await expect(addAssetsToAlbum(ALBUM_ID, ASSET_IDS)).rejects.toThrow(/no_permission/)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('throws without retry when item result is not_found', async () => {
    vi.useRealTimers()
    const spy = vi
      .fn()
      .mockResolvedValue(makeResponse(200, [{ id: 'asset-1', success: false, error: 'not_found' }]))
    vi.stubGlobal('fetch', spy)

    await expect(addAssetsToAlbum(ALBUM_ID, ASSET_IDS)).rejects.toThrow(/not_found/)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('resolves when a mix of success=true and duplicate items are returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse(200, [
          { id: 'asset-1', success: true },
          { id: 'asset-2', success: false, error: 'duplicate' }
        ])
      )
    )
    await expect(addAssetsToAlbum(ALBUM_ID, ['asset-1', 'asset-2'])).resolves.toBeUndefined()
  })

  it('throws when IMMICH_API_KEY is not set', async () => {
    delete process.env.IMMICH_API_KEY
    await expect(addAssetsToAlbum(ALBUM_ID, ASSET_IDS)).rejects.toThrow(
      'IMMICH_API_KEY not configured'
    )
  })
})
