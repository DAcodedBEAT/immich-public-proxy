/**
 * Tests for getSupportedMimeTypes.
 *
 * The function uses a module-level Promise cache (_supportedMimeTypesPromise).
 * Each test must get a fresh module instance to avoid cache bleed. We do this
 * by calling vi.resetModules() before each test and then dynamic-importing the
 * module inside the test body.
 *
 * getSupportedMimeTypes delegates to the module's own `request()` helper which
 * calls `fetch`. We stub global fetch so that request() sees our mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

function makeJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null)
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  } as unknown as Response
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => 'text/plain' },
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve('error')
  } as unknown as Response
}

beforeEach(() => {
  process.env.IMMICH_URL = 'http://immich.test'
  process.env.IMMICH_API_KEY = 'test-api-key'
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.IMMICH_URL
  delete process.env.IMMICH_API_KEY
})

describe('getSupportedMimeTypes', () => {
  it('returns a Set combining image and video types from Immich', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeJsonResponse({
          image: ['image/jpeg', 'image/png'],
          video: ['video/mp4', 'video/webm']
        })
      )
    )
    const { getSupportedMimeTypes } = await import('../src/immich')
    const result = await getSupportedMimeTypes()
    expect(result).toBeInstanceOf(Set)
    expect(result.has('image/jpeg')).toBe(true)
    expect(result.has('image/png')).toBe(true)
    expect(result.has('video/mp4')).toBe(true)
    expect(result.has('video/webm')).toBe(true)
  })

  it('caches the result so a second call does not hit fetch again', async () => {
    const spy = vi.fn().mockResolvedValue(
      makeJsonResponse({
        image: ['image/jpeg'],
        video: ['video/mp4']
      })
    )
    vi.stubGlobal('fetch', spy)
    const { getSupportedMimeTypes } = await import('../src/immich')
    const first = await getSupportedMimeTypes()
    const second = await getSupportedMimeTypes()
    // Same Set reference (cache returns the same promise)
    expect(first).toBe(second)
    // fetch was only called once (once for /server/ping ... actually once for /server/media-types)
    // Count calls to the media-types endpoint only
    const mediaCalls = spy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === 'string' && (args[0] as string).includes('media-types')
    )
    expect(mediaCalls).toHaveLength(1)
  })

  it('returns empty Set when Immich returns non-json (unreachable)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(503)))
    const { getSupportedMimeTypes } = await import('../src/immich')
    const result = await getSupportedMimeTypes()
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(0)
  })

  it('returns empty Set when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const { getSupportedMimeTypes } = await import('../src/immich')
    const result = await getSupportedMimeTypes()
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(0)
  })

  it('does NOT cache the result when the request fails - subsequent call retries fetch', async () => {
    // First call: 503 → empty set (not cached)
    // Second call: success → populated set
    const spy = vi
      .fn()
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValue(
        makeJsonResponse({
          image: ['image/jpeg'],
          video: ['video/mp4']
        })
      )
    vi.stubGlobal('fetch', spy)
    const { getSupportedMimeTypes } = await import('../src/immich')

    const first = await getSupportedMimeTypes()
    expect(first.size).toBe(0)

    // The failure should NOT have been cached, so second call retries
    const second = await getSupportedMimeTypes()
    expect(second.size).toBeGreaterThan(0)

    const mediaCalls = spy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === 'string' && (args[0] as string).includes('media-types')
    )
    expect(mediaCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('concurrent calls during cold miss coalesce into a single fetch call', async () => {
    // Use a deferred promise so we can control when fetch resolves
    let resolveFetch!: (value: Response) => void
    const fetchPromise = new Promise<Response>(resolve => {
      resolveFetch = resolve
    })
    const spy = vi.fn().mockReturnValue(fetchPromise)
    vi.stubGlobal('fetch', spy)
    const { getSupportedMimeTypes } = await import('../src/immich')

    // Fire two calls concurrently before the first has resolved
    const p1 = getSupportedMimeTypes()
    const p2 = getSupportedMimeTypes()

    // Now resolve the underlying fetch
    resolveFetch(makeJsonResponse({ image: ['image/jpeg'], video: ['video/mp4'] }))

    const [r1, r2] = await Promise.all([p1, p2])
    // Both callers get the same Set instance (same Promise was returned)
    expect(r1).toBe(r2)

    // fetch was only called once for media-types
    const mediaCalls = spy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === 'string' && (args[0] as string).includes('media-types')
    )
    expect(mediaCalls).toHaveLength(1)
  })
})
