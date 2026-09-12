import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/*
  tagAssetWithUploader wraps PUT /tags (upsert) + PUT /tags/{id}/assets.
  Module state (tag-ID cache, permission memo) means each test re-imports a
  fresh module - same pattern as the getSupportedMimeTypes tests.
*/

const ORIGINAL_ENV = process.env.IMMICH_API_KEY

beforeEach(() => {
  vi.resetModules()
  process.env.IMMICH_API_KEY = 'test-key'
  process.env.IMMICH_URL = 'http://immich'
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (ORIGINAL_ENV === undefined) delete process.env.IMMICH_API_KEY
  else process.env.IMMICH_API_KEY = ORIGINAL_ENV
})

function upsertResponse() {
  return new Response(
    JSON.stringify([
      { id: 'parent-id', value: 'uploaded-by' },
      { id: 'leaf-id', value: 'uploaded-by/Alice' }
    ]),
    { status: 200 }
  )
}

describe('tagAssetWithUploader', () => {
  it('upserts the tag path and tags the asset with the leaf tag ID', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upsertResponse())
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { tagAssetWithUploader } = await import('../src/immich')
    await tagAssetWithUploader('Alice', 'asset-1')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [upsertUrl, upsertInit] = fetchMock.mock.calls[0]
    expect(upsertUrl).toBe('http://immich/api/tags')
    expect(JSON.parse(upsertInit.body).tags).toEqual(['uploaded-by/Alice'])
    const [tagUrl, tagInit] = fetchMock.mock.calls[1]
    expect(tagUrl).toBe('http://immich/api/tags/leaf-id/assets')
    expect(JSON.parse(tagInit.body).ids).toEqual(['asset-1'])
  })

  it('caches the tag ID - the second upload for the same name skips the upsert', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upsertResponse())
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { tagAssetWithUploader } = await import('../src/immich')
    await tagAssetWithUploader('Alice', 'asset-1')
    await tagAssetWithUploader('Alice', 'asset-2')

    // 3 calls total: upsert once, tag-assets twice
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2][0]).toBe('http://immich/api/tags/leaf-id/assets')
  })

  it('replaces "/" in the uploader name so it cannot create extra hierarchy levels', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'leaf-id', value: 'uploaded-by/a-b' }]), { status: 200 })
      )
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { tagAssetWithUploader } = await import('../src/immich')
    await tagAssetWithUploader('a/b', 'asset-1')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tags).toEqual(['uploaded-by/a-b'])
  })

  it('self-disables silently on 403 instead of failing uploads', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    const { tagAssetWithUploader } = await import('../src/immich')
    await expect(tagAssetWithUploader('Alice', 'asset-1')).resolves.toBeUndefined()
    // Disabled: second call makes no network request at all
    await tagAssetWithUploader('Alice', 'asset-2')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('throws on non-403 errors and drops the cached tag ID for retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upsertResponse())
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      // retry path: upsert again, then succeed
      .mockResolvedValueOnce(upsertResponse())
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { tagAssetWithUploader } = await import('../src/immich')
    await expect(tagAssetWithUploader('Alice', 'asset-1')).rejects.toThrow(/tag-assets 500/)
    // Cache was dropped, so the next call re-upserts
    await tagAssetWithUploader('Alice', 'asset-2')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
