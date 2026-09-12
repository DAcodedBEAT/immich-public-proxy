/**
 * Tests for uploadAsset and updateAssetDescription in immich.ts.
 *
 * Both functions have module-level state (_descriptionPermissionDenied,
 * _tagPermissionDenied) so each test must get a fresh module instance via
 * vi.resetModules() + dynamic import.  The global fetch is stubbed so no real
 * network calls are made.
 *
 * NOTE: uploadAsset calls Readable.toWeb(form) to convert a form-data stream
 * to a Web ReadableStream for Node's native fetch. The form-data package does
 * not produce a proper stream.Readable, so Readable.toWeb throws in the test
 * environment. We stub Readable.toWeb to a no-op that returns a dummy object;
 * the mocked fetch never inspects the body anyway.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'stream'

const ORIGINAL_API_KEY = process.env.IMMICH_API_KEY
const ORIGINAL_URL = process.env.IMMICH_URL

// Stub Readable.toWeb globally so form-data → web stream conversion does not throw.
// The mocked fetch does not consume the body, so this is safe.
const toWebStub = vi.spyOn(Readable, 'toWeb').mockReturnValue({} as ReadableStream)

beforeEach(() => {
  vi.resetModules()
  process.env.IMMICH_API_KEY = 'test-api-key'
  process.env.IMMICH_URL = 'http://immich.test'
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (ORIGINAL_API_KEY === undefined) delete process.env.IMMICH_API_KEY
  else process.env.IMMICH_API_KEY = ORIGINAL_API_KEY
  if (ORIGINAL_URL === undefined) delete process.env.IMMICH_URL
  else process.env.IMMICH_URL = ORIGINAL_URL
})

afterEach(() => {
  // Ensure the stub is still in place after each test (vi.resetModules does
  // not affect spies on Node builtins)
  if (!toWebStub.getMockImplementation()) {
    toWebStub.mockReturnValue({} as ReadableStream)
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStream(data = 'file-bytes') {
  return Readable.from([Buffer.from(data)])
}

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// uploadAsset
// ---------------------------------------------------------------------------

describe('uploadAsset', () => {
  it('sends a POST to /api/assets with x-api-key header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse(201, { id: 'asset-123', status: 'created' }))
    vi.stubGlobal('fetch', fetchMock)

    const { uploadAsset } = await import('../src/immich')
    await uploadAsset(makeStream(), 'photo.jpg', 'image/jpeg')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://immich.test/api/assets')
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe('test-api-key')
  })

  it('returns { id, duplicate: false } for HTTP 201 status:created', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse(201, { id: 'asset-abc', status: 'created' }))
    )

    const { uploadAsset } = await import('../src/immich')
    const result = await uploadAsset(makeStream(), 'photo.jpg', 'image/jpeg')

    expect(result).toEqual({ id: 'asset-abc', duplicate: false })
  })

  it('returns { id, duplicate: true } for HTTP 200 status:duplicate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse(200, { id: 'asset-dup', status: 'duplicate' }))
    )

    const { uploadAsset } = await import('../src/immich')
    const result = await uploadAsset(makeStream(), 'photo.jpg', 'image/jpeg')

    expect(result).toEqual({ id: 'asset-dup', duplicate: true })
  })

  it('throws on non-2xx response with status in the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(500, 'Internal Server Error')))

    const { uploadAsset } = await import('../src/immich')
    await expect(uploadAsset(makeStream(), 'photo.jpg', 'image/jpeg')).rejects.toThrow(/500/)
  })

  it('throws when the response body has no id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(201, { status: 'created' })))

    const { uploadAsset } = await import('../src/immich')
    await expect(uploadAsset(makeStream(), 'photo.jpg', 'image/jpeg')).rejects.toThrow(
      /no asset ID/i
    )
  })

  it('throws when IMMICH_API_KEY is not set', async () => {
    delete process.env.IMMICH_API_KEY
    vi.stubGlobal('fetch', vi.fn())

    const { uploadAsset } = await import('../src/immich')
    await expect(uploadAsset(makeStream(), 'photo.jpg', 'image/jpeg')).rejects.toThrow(
      /IMMICH_API_KEY/
    )
  })

  it('falls back to a valid ISO date when fileCreatedAt is invalid', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse(201, { id: 'asset-fallback', status: 'created' }))
    vi.stubGlobal('fetch', fetchMock)

    const { uploadAsset } = await import('../src/immich')
    // Should not throw even with an invalid date string
    const result = await uploadAsset(makeStream(), 'photo.jpg', 'image/jpeg', 'not-a-date')

    expect(result.id).toBe('asset-fallback')
    // fetch was called - the fallback date was used instead of throwing
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not throw when a valid fileCreatedAt is supplied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse(201, { id: 'asset-date', status: 'created' }))
    )

    const { uploadAsset } = await import('../src/immich')
    const result = await uploadAsset(
      makeStream(),
      'photo.jpg',
      'image/jpeg',
      '2024-06-01T12:00:00.000Z'
    )

    expect(result.id).toBe('asset-date')
  })

  // These two check the response-wait timer's delay argument directly via a
  // setTimeout spy, rather than actually waiting out a real (or faked) timer.
  // The response-wait timer is armed on the *request body's* 'end' event
  // (i.e. once form-data has finished piping into the outgoing stream), not
  // on fetch resolving - so the fetch mock must give that a few real event
  // loop ticks to happen before it resolves, or the assertion races the pipe
  // and finds no timer armed yet. Readable.toWeb is stubbed at file scope to
  // a dummy object (see the note at the top of this file), so nothing
  // downstream actually drains the stream the way a real fetch would; the
  // short delay stands in for that.
  function delayedResponse(status: number, body: unknown): Promise<Response> {
    return new Promise(resolve => setTimeout(() => resolve(makeResponse(status, body)), 20))
  }

  it('arms the response-wait timer with the default of 180s when unconfigured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => delayedResponse(201, { id: 'a', status: 'created' }))
    )
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

    const { uploadAsset } = await import('../src/immich')
    await uploadAsset(makeStream(), 'photo.jpg', 'image/jpeg')

    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 180_000)).toBe(true)
    setTimeoutSpy.mockRestore()
  })

  it('honors a configured ipp.upload.responseTimeoutSec value', async () => {
    process.env.CONFIG = JSON.stringify({ ipp: { upload: { responseTimeoutSec: 30 } } })
    // Must dynamically import loadConfig too (not the module's static import
    // some other file might use) - vi.resetModules() gives every import()
    // below a fresh module registry, and loadConfig() only affects the
    // config-loader instance it's called on.
    const { loadConfig } = await import('../src/config/loader')
    loadConfig()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => delayedResponse(201, { id: 'a', status: 'created' }))
    )
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

    const { uploadAsset } = await import('../src/immich')
    await uploadAsset(makeStream(), 'photo.jpg', 'image/jpeg')

    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 30_000)).toBe(true)
    setTimeoutSpy.mockRestore()
    delete process.env.CONFIG
    loadConfig()
  })
})

// ---------------------------------------------------------------------------
// updateAssetDescription
// ---------------------------------------------------------------------------

describe('updateAssetDescription', () => {
  it('sends PUT to /api/assets/<id> with description in body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    const { updateAssetDescription } = await import('../src/immich')
    await updateAssetDescription('asset-xyz', 'Hello world')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/assets/asset-xyz')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string).description).toBe('Hello world')
    expect(init.headers['x-api-key']).toBe('test-api-key')
  })

  it('resolves silently on 403 (permission memo) and makes no further fetch calls', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(403, 'Forbidden'))
    vi.stubGlobal('fetch', fetchMock)

    const { updateAssetDescription } = await import('../src/immich')

    // First call: 403 triggers the permission memo
    await expect(updateAssetDescription('a1', 'desc')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Second call: memo is set, no fetch should be made
    await updateAssetDescription('a2', 'desc2')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    warnSpy.mockRestore()
  })

  it('throws on 500 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(500, 'server error')))

    const { updateAssetDescription } = await import('../src/immich')
    await expect(updateAssetDescription('asset-1', 'text')).rejects.toThrow(/500/)
  })
})
