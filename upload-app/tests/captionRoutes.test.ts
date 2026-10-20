import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { setConfig } from './helpers'

/*
  The caption layer end to end, against the real app with Immich and the
  notification webhook mocked at the fetch boundary. It is on only with both
  `ipp.upload.captions: true` and IMMICH_API_KEY; with either missing the
  service must behave exactly as upstream: the same Immich calls, no caption
  box, the caption ignored.
*/

const KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789'
const IMMICH = 'http://immich.test'
const HOOK = 'http://hook.test/notify'
const ASSET = 'bbbbbbbb-0000-0000-0000-000000000003'
const KEY_BEFORE = process.env.IMMICH_API_KEY

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Seen = { method: string; path: string; headers: Headers; body?: string }

/** Turn each step of the two-step opt-in on or off. */
function optIn({ config, key }: { config: boolean; key: boolean }) {
  // The rate limit off, so the tests can send as many files as they like
  setConfig({ ipp: { upload: { notifyUrl: HOOK, rateLimit: 0, captions: config } } })
  if (key) process.env.IMMICH_API_KEY = 'secret-api-key'
  else delete process.env.IMMICH_API_KEY
}

describe('caption layer', () => {
  let server: Server
  let base: string
  let seen: Seen[]
  let assetStatus: 'created' | 'duplicate'
  // Holds the description call open until released, to show the visitor is not kept waiting
  let describeGate: Promise<void> | undefined
  let describeAnswer: () => Response | Promise<Response>

  beforeAll(async () => {
    process.env.IMMICH_URL = IMMICH
    delete process.env.IPP_CONFIG
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
    if (KEY_BEFORE === undefined) delete process.env.IMMICH_API_KEY
    else process.env.IMMICH_API_KEY = KEY_BEFORE
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    seen = []
    assetStatus = 'created'
    describeGate = undefined
    describeAnswer = () => json({ id: ASSET })
  })

  const captioned = { uploader: 'Jane Smith', caption: 'Cake cutting' }

  const upload = (query: Record<string, string> = {}) =>
    fetch(
      `${base}/share/${KEY}/upload?` +
        new URLSearchParams({ filename: 'IMG_1.jpg', ...query }).toString(),
      { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: 'jpegbytes' }
    )

  /**
   * Wait for the calls made after the reply, then list the writes sent to
   * Immich. The share lookup is left out, as it is cached between requests.
   */
  async function immichWrites(expected: number) {
    const writes = () => seen.filter(s => s.path.startsWith('/api/') && s.method !== 'GET')
    await vi.waitFor(() => expect(writes()).toHaveLength(expected))
    return writes().map(s => s.method + ' ' + s.path)
  }

  const notification = async () => {
    await vi.waitFor(() => expect(seen.some(s => s.path === '/notify')).toBe(true))
    return JSON.parse(seen.find(s => s.path === '/notify')!.body!)
  }

  // Give any stray after-reply call the chance to happen
  const settle = () => new Promise(resolve => setTimeout(resolve, 50))

  describe.each([
    ['with neither step', { config: false, key: false }],
    ['with IMMICH_API_KEY alone', { config: false, key: true }],
    ['with captions: true alone', { config: true, key: false }]
  ])('%s, exactly as upstream', (_name, steps) => {
    beforeEach(() => optIn(steps))

    it('makes only the upload call, ignoring the caption', async () => {
      const res = await upload(captioned)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'created' })
      await notification()
      await settle()
      expect(await immichWrites(1)).toEqual(['POST /api/assets'])
      expect(seen.some(s => s.headers.has('x-api-key'))).toBe(false)
    })

    it('leaves the caption out of the notification', async () => {
      await upload(captioned)
      const payload = await notification()
      expect(payload.data).not.toHaveProperty('caption')
      expect(payload.data.uploader).toBe('jane-smith')
    })

    it('renders no caption box, and a false flag in the init JSON', async () => {
      const html = await (await fetch(`${base}/share/${KEY}`)).text()
      expect(html).not.toContain('upload-caption')
      expect(html).toContain('"captions":false')
      expect(html).toContain('id="upload-name"')
    })
  })

  describe('with both steps', () => {
    beforeEach(() => optIn({ config: true, key: true }))

    it('renders the caption box and a true flag', async () => {
      const html = await (await fetch(`${base}/share/${KEY}`)).text()
      expect(html).toContain('id="upload-caption"')
      expect(html).toContain('"captions":true')
    })

    it('still forwards the file with the share key alone', async () => {
      await upload(captioned)
      await immichWrites(2)
      const forward = seen.find(s => s.method === 'POST' && s.path === '/api/assets')!
      expect(forward.headers.has('x-api-key')).toBe(false)
    })

    it('writes the caption alone as the description of a new asset, with the API key', async () => {
      const res = await upload(captioned)
      expect(await res.json()).toEqual({ status: 'created' })
      expect(await immichWrites(2)).toEqual(['POST /api/assets', 'PUT /api/assets/' + ASSET])
      const described = seen.find(s => s.path === '/api/assets/' + ASSET)!
      expect(JSON.parse(described.body!)).toEqual({ description: 'Cake cutting' })
      expect(described.headers.get('x-api-key')).toBe('secret-api-key')
    })

    it('sanitises what it writes', async () => {
      await upload({ caption: '​Hi\x00‮ there\x1b' })
      await immichWrites(2)
      const described = seen.find(s => s.path === '/api/assets/' + ASSET)!
      expect(JSON.parse(described.body!)).toEqual({ description: 'Hi there' })
    })

    it("never describes a duplicate, as its description is the owner's", async () => {
      assetStatus = 'duplicate'
      const res = await upload(captioned)
      expect(await res.json()).toEqual({ status: 'duplicate' })
      // The notification still carries the caption the visitor wrote
      expect((await notification()).data.caption).toBe('Cake cutting')
      await settle()
      expect(await immichWrites(1)).toEqual(['POST /api/assets'])
    })

    it('makes no extra call when the visitor wrote no caption', async () => {
      await upload({ uploader: 'Jane', caption: ' ​ ' })
      await notification()
      await settle()
      expect(await immichWrites(1)).toEqual(['POST /api/assets'])
    })

    it('answers the visitor before the description call finishes', async () => {
      let release!: () => void
      describeGate = new Promise(resolve => (release = resolve))
      const res = await upload(captioned)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'created' })
      // The description call is still pending
      await vi.waitFor(() => expect(seen.some(s => s.path === '/api/assets/' + ASSET)).toBe(true))
      release()
    })

    it('does not fail the upload when Immich refuses or drops the description', async () => {
      describeAnswer = () => new Response('boom', { status: 500 })
      const res = await upload(captioned)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'created' })
      await immichWrites(2)

      seen = []
      describeAnswer = () => Promise.reject(new Error('The operation was aborted due to timeout'))
      const again = await upload(captioned)
      expect(again.status).toBe(200)
      await immichWrites(2)
      // The service is still up
      expect((await upload()).status).toBe(200)
    })

    it('adds the caption to the notification beside the uploader', async () => {
      await upload(captioned)
      const payload = await notification()
      expect(payload.data.uploader).toBe('jane-smith')
      expect(payload.data.caption).toBe('Cake cutting')
    })

    it('uses the API key for nothing when the share refuses the upload', async () => {
      const res = await fetch(`${base}/share/${KEY}/upload?filename=a.svg&caption=A`, {
        method: 'POST',
        headers: { 'content-type': 'image/svg+xml' },
        body: '<svg/>'
      })
      expect(res.status).toBe(415)
      await settle()
      expect(seen.some(s => s.headers.has('x-api-key'))).toBe(false)
    })
  })
})
