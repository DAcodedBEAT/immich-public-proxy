import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'

/*
  The attribution layer end to end, against the real app with Immich and the
  notification webhook mocked at the fetch boundary. Without IMMICH_API_KEY
  the service must behave exactly as upstream: the same Immich calls, no
  extra page fields, the name and caption ignored.
*/

const KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789'
const IMMICH = 'http://immich.test'
const HOOK = 'http://hook.test/notify'
const ASSET = 'bbbbbbbb-0000-0000-0000-000000000003'
const KEY_BEFORE = process.env.IMMICH_API_KEY

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Seen = { method: string; path: string; headers: Headers; body?: string }

describe('attribution layer', () => {
  let server: Server
  let base: string
  let seen: Seen[]
  let assetStatus: 'created' | 'duplicate'
  // Holds the description call open until released, to show the visitor is not kept waiting
  let describeGate: Promise<void> | undefined
  let describeAnswer: () => Response

  beforeAll(async () => {
    process.env.IMMICH_URL = IMMICH
    delete process.env.IPP_CONFIG
    // The rate limit off, so the tests can send as many files as they like
    process.env.CONFIG = JSON.stringify({ ipp: { upload: { notifyUrl: HOOK, rateLimit: 0 } } })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.startsWith(IMMICH) && !url.startsWith(HOOK)) return realFetch(input, init)
      const method = init.method || 'GET'
      const path = new URL(url).pathname
      const body = typeof init.body === 'string' ? init.body : undefined
      seen.push({ method, path, headers: new Headers(init.headers), body })
      if (url.startsWith(HOOK)) return new Response('', { status: 200 })
      if (path === '/api/shared-links/me')
        return json({
          id: 'ffffffff-0000-0000-0000-000000000001',
          type: 'ALBUM',
          key: 'k',
          allowUpload: true,
          expiresAt: null,
          assets: [],
          album: { id: 'aaaaaaaa-0000-0000-0000-000000000002', albumName: 'Holiday' }
        })
      if (method === 'POST' && path === '/api/assets')
        return json({ id: ASSET, status: assetStatus }, assetStatus === 'created' ? 201 : 200)
      if (method === 'PUT' && path === '/api/assets/' + ASSET) {
        await describeGate
        return describeAnswer()
      }
      if (method === 'PUT' && path === '/api/tags')
        return json([{ id: 'leaf-id', value: JSON.parse(body!).tags[0] }])
      if (method === 'PUT' && path === '/api/tags/leaf-id/assets') return json([])
      return json({}, 404)
    })

    const { app } = await import('../src/app')
    await new Promise<void>(resolve => {
      server = app.listen(0, resolve)
    })
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })

  afterAll(() => {
    server?.close()
    delete process.env.CONFIG
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    seen = []
    assetStatus = 'created'
    describeGate = undefined
    describeAnswer = () => json({ id: ASSET })
  })

  afterEach(() => {
    if (KEY_BEFORE === undefined) delete process.env.IMMICH_API_KEY
    else process.env.IMMICH_API_KEY = KEY_BEFORE
  })

  const upload = (query: Record<string, string> = {}) =>
    fetch(
      `${base}/share/${KEY}/upload?` +
        new URLSearchParams({ filename: 'IMG_1.jpg', ...query }).toString(),
      { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: 'jpegbytes' }
    )

  /*
    The app, and so its tag-ID cache, lives for the whole file: a fresh name
    per test makes each one upsert its tag.
  */
  let n = 0
  let name: string
  let attributed: Record<string, string>
  beforeEach(() => {
    name = 'Alice' + ++n
    attributed = { uploaderName: name, caption: 'Cake cutting' }
  })

  /**
   * Wait for the calls made after the reply, then list the writes sent to
   * Immich. The share lookup is left out, as it is cached between requests.
   */
  async function immichCalls(expected: number) {
    const writes = () => seen.filter(s => s.path.startsWith('/api/') && s.method !== 'GET')
    await vi.waitFor(() => expect(writes()).toHaveLength(expected))
    return writes().map(s => s.method + ' ' + s.path)
  }

  const notification = async () => {
    await vi.waitFor(() => expect(seen.some(s => s.path === '/notify')).toBe(true))
    return JSON.parse(seen.find(s => s.path === '/notify')!.body!)
  }

  describe('without IMMICH_API_KEY', () => {
    beforeEach(() => {
      delete process.env.IMMICH_API_KEY
    })

    it('makes only the calls upstream makes, ignoring the name and caption', async () => {
      const res = await upload(attributed)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'created' })
      // Give any stray after-reply call the chance to happen
      await notification()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(await immichCalls(1)).toEqual(['POST /api/assets'])
      expect(seen.some(s => s.headers.has('x-api-key'))).toBe(false)
    })

    it('leaves the name and caption out of the notification', async () => {
      await upload(attributed)
      const payload = await notification()
      expect(payload.data).not.toHaveProperty('uploader')
      expect(payload.data).not.toHaveProperty('caption')
      expect(payload.message).toBe('ipp_upload_IMG_1.jpg (0 bytes) was uploaded to Holiday.')
    })

    it('renders no name or caption field, and a false flag in the init JSON', async () => {
      const html = await (await fetch(`${base}/share/${KEY}`)).text()
      expect(html).not.toContain('upload-name')
      expect(html).not.toContain('upload-caption')
      expect(html).toContain('"attribution":false')
    })
  })

  describe('with IMMICH_API_KEY', () => {
    beforeEach(() => {
      process.env.IMMICH_API_KEY = 'secret-api-key'
    })

    it('renders the name and caption fields and a true flag', async () => {
      const html = await (await fetch(`${base}/share/${KEY}`)).text()
      expect(html).toContain('id="upload-name"')
      expect(html).toContain('id="upload-caption"')
      expect(html).toContain('"attribution":true')
    })

    it('still forwards the file with the share key alone', async () => {
      await upload(attributed)
      await immichCalls(4)
      const forward = seen.find(s => s.method === 'POST' && s.path === '/api/assets')!
      expect(forward.headers.has('x-api-key')).toBe(false)
    })

    it('describes and tags a new asset with the API key, after the reply', async () => {
      const res = await upload(attributed)
      expect(await res.json()).toEqual({ status: 'created' })
      expect(await immichCalls(4)).toEqual([
        'POST /api/assets',
        'PUT /api/assets/' + ASSET,
        'PUT /api/tags',
        'PUT /api/tags/leaf-id/assets'
      ])
      const described = seen.find(s => s.path === '/api/assets/' + ASSET)!
      expect(JSON.parse(described.body!)).toEqual({
        description: 'Cake cutting\n\n- Uploaded by ' + name
      })
      expect(described.headers.get('x-api-key')).toBe('secret-api-key')
    })

    it('sanitises what it writes', async () => {
      await upload({ uploaderName: 'Al\u202Eice\x1b' + n, caption: '\u200BHi\x00' })
      await immichCalls(4)
      const described = seen.find(s => s.path === '/api/assets/' + ASSET)!
      expect(JSON.parse(described.body!)).toEqual({ description: 'Hi\n\n- Uploaded by ' + name })
    })

    it("never describes or tags a duplicate, as its description is the owner's", async () => {
      assetStatus = 'duplicate'
      const res = await upload(attributed)
      expect(await res.json()).toEqual({ status: 'duplicate' })
      await notification()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(await immichCalls(1)).toEqual(['POST /api/assets'])
    })

    it('makes no extra call when the visitor gave neither field', async () => {
      await upload()
      await notification()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(await immichCalls(1)).toEqual(['POST /api/assets'])
    })

    it('answers the visitor before the description call finishes', async () => {
      let release!: () => void
      describeGate = new Promise(resolve => (release = resolve))
      const res = await upload(attributed)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'created' })
      // The description call is still pending; release it so the tag calls follow
      await vi.waitFor(() => expect(seen.some(s => s.path === '/api/assets/' + ASSET)).toBe(true))
      release()
      await immichCalls(4)
    })

    it('does not fail the upload when Immich refuses the description', async () => {
      describeAnswer = () => new Response('boom', { status: 500 })
      const res = await upload(attributed)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'created' })
      // The tag is still attempted
      expect(await immichCalls(4)).toContain('PUT /api/tags/leaf-id/assets')
    })

    it('adds the name and caption to the notification', async () => {
      await upload(attributed)
      const payload = await notification()
      expect(payload.data.uploader).toBe(name)
      expect(payload.data.caption).toBe('Cake cutting')
      expect(payload.message).toBe(
        'ipp_upload_IMG_1.jpg (0 bytes) was uploaded to Holiday by ' + name + '.'
      )
    })

    it('uses the API key for nothing when the share refuses the upload', async () => {
      const res = await fetch(`${base}/share/${KEY}/upload?filename=a.svg&uploaderName=A`, {
        method: 'POST',
        headers: { 'content-type': 'image/svg+xml' },
        body: '<svg/>'
      })
      expect(res.status).toBe(415)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(seen.some(s => s.headers.has('x-api-key'))).toBe(false)
    })
  })
})
