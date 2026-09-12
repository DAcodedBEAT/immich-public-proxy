import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/*
  bulkUploadCheck wraps Immich's POST /assets/bulk-upload-check. Fetch is
  mocked; the module is re-imported per test (same pattern as the
  getSupportedMimeTypes tests) because immich.ts holds module-level state.
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

describe('bulkUploadCheck', () => {
  it('posts the assets and returns the results array', async () => {
    const results = [
      { id: '0', action: 'reject', reason: 'duplicate', assetId: 'abc' },
      { id: '1', action: 'accept' }
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ results }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { bulkUploadCheck } = await import('../src/immich')
    const out = await bulkUploadCheck([
      { id: '0', checksum: 'a'.repeat(40) },
      { id: '1', checksum: 'b'.repeat(40) }
    ])

    expect(out).toEqual(results)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://immich/api/assets/bulk-upload-check')
    expect(init.headers['x-api-key']).toBe('test-key')
    expect(JSON.parse(init.body).assets).toHaveLength(2)
  })

  it('returns an empty array when Immich omits results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    )
    const { bulkUploadCheck } = await import('../src/immich')
    expect(await bulkUploadCheck([{ id: '0', checksum: 'a'.repeat(40) }])).toEqual([])
  })

  it('throws on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('server error', { status: 500 })))
    const { bulkUploadCheck } = await import('../src/immich')
    await expect(bulkUploadCheck([{ id: '0', checksum: 'a'.repeat(40) }])).rejects.toThrow(
      /bulk-upload-check 500/
    )
  })

  it('throws when IMMICH_API_KEY is not set', async () => {
    delete process.env.IMMICH_API_KEY
    const { bulkUploadCheck } = await import('../src/immich')
    await expect(bulkUploadCheck([{ id: '0', checksum: 'a'.repeat(40) }])).rejects.toThrow(
      /IMMICH_API_KEY/
    )
  })
})
