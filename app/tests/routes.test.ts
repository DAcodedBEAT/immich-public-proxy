import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'

/*
  Route-level tests against the real Express app with Immich mocked at the
  fetch boundary. These exist because route-path syntax changes (Express 5
  dropped inline regex params) and param handling (optional `{/:mode}` /
  `{/:size}` params are undefined when absent) are invisible to unit tests of
  the individual handlers.
*/

const KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789'
const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ID2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const IMMICH = 'http://immich.test'

const asset = {
  id: ID,
  type: 'IMAGE',
  isTrashed: false,
  thumbhash: 'AAAA',
  originalFileName: 'a.jpg',
  originalMimeType: 'image/jpeg',
  fileCreatedAt: '2026-01-01T00:00:00.000Z',
  exifInfo: { exifImageWidth: 100, exifImageHeight: 100 }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

describe('express routes', () => {
  let server: Server
  let base: string
  const immichCalls: string[] = []

  beforeAll(async () => {
    process.env.IMMICH_URL = IMMICH
    delete process.env.CONFIG
    delete process.env.IPP_CONFIG
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // Requests to the test server go through the real fetch; only Immich is mocked.
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.startsWith(IMMICH)) return realFetch(input, init)
      immichCalls.push(url)
      if (url.includes('/server/ping')) return json({ res: 'pong' })
      if (url.includes('/shared-links/me')) {
        return json({
          type: 'INDIVIDUAL',
          key: 'k',
          allowDownload: true,
          showMetadata: true,
          expiresAt: null,
          // Two assets: a single-asset share is served as the bare asset, not a gallery.
          assets: [asset, { ...asset, id: ID2 }]
        })
      }
      if (url.includes(`/assets/${ID}/`)) {
        return new Response('abcd', {
          headers: { 'content-type': 'image/jpeg', 'content-length': '4' }
        })
      }
      if (url.includes(`/assets/${ID}`)) return json(asset)
      return json({}, 404)
    })

    // app.ts loads the bundled config.json as it is imported
    const { app } = await import('../src/app')
    await new Promise<void>(resolve => {
      server = app.listen(0, resolve)
    })
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })

  afterAll(() => {
    server?.close()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const status = async (path: string, init?: RequestInit) =>
    (await fetch(base + path, { redirect: 'manual', ...init })).status

  it.each([
    ['gallery by key', `/share/${KEY}`],
    ['gallery by slug', `/s/${KEY}`],
    ['gallery with explicit mode', `/share/${KEY}/download`],
    ['photo, default size', `/share/photo/${KEY}/${ID}`],
    ['photo, explicit size', `/share/photo/${KEY}/${ID}/preview`],
    ['video route for an image id', `/share/video/${KEY}/${ID}`],
    ['asset metadata by key', `/share/meta/${KEY}/${ID}`],
    ['asset metadata by slug', `/s/meta/${KEY}/${ID}`],
    ['home page', '/'],
    ['home page via /share', '/share'],
    ['healthcheck', '/share/healthcheck'],
    ['legacy healthcheck', '/healthcheck']
  ])('serves %s', async (_name, path) => {
    expect(await status(path)).toBe(200)
  })

  it('answers the upload service probe with 204 when nothing is routed there', async () => {
    expect(await status('/upload/healthcheck')).toBe(204)
  })

  it.each([
    ['unknown share type', `/foo/${KEY}`],
    ['unknown mode', `/share/${KEY}/bogus`],
    ['unknown asset type', `/share/other/${KEY}/${ID}`],
    ['invalid photo size', `/share/photo/${KEY}/${ID}/badsize`],
    ['meta without an id', `/share/meta/${KEY}`],
    ['unknown path', '/nope'],
    ['deep unknown path', '/a/b/c/d']
  ])('falls through to 404 for %s', async (_name, path) => {
    expect(await status(path)).toBe(404)
  })

  it.each([
    ['unknown share type', `/x/${KEY}`],
    ['unknown share type with a mode', `/x/${KEY}/download`],
    ['unknown asset type', `/share/x/${KEY}/${ID}`],
    ['meta under an unknown share type', `/x/meta/${KEY}/${ID}`],
    ['unknown mode', `/share/${KEY}/x`]
  ])('gives OPTIONS and DELETE for an %s the 404 policy', async (_name, path) => {
    for (const method of ['OPTIONS', 'DELETE']) {
      const res = await fetch(base + path, { method })
      expect(res.status).toBe(404)
      expect(res.headers.get('allow')).toBeNull()
    }
  })

  it('falls through to 404 for a POST to an unknown path', async () => {
    expect(await status('/nope', { method: 'POST' })).toBe(404)
  })

  it('treats absent optional params as undefined, not the string "undefined"', async () => {
    // Regression: stringifying a missing {/:size} param made every default-size
    // photo request fail size validation. The plain gallery URL must also still
    // render (mode is absent there).
    const res = await fetch(`${base}/share/${KEY}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<!DOCTYPE html>')
    const photo = await fetch(`${base}/share/photo/${KEY}/${ID}`)
    expect(photo.status).toBe(200)
    expect(await photo.text()).toBe('abcd')
  })

  it('redirects a POST to a share page back to it with 303', async () => {
    const res = await fetch(`${base}/share/${KEY}`, { method: 'POST', redirect: 'manual' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/share/${KEY}`)
  })

  it('rejects an empty selective-download POST', async () => {
    expect(await status(`/share/${KEY}/download`, { method: 'POST' })).toBe(400)
  })

  it('accepts an unlock POST with no body without crashing', async () => {
    // Express 5 leaves req.body undefined when no body parser matched.
    expect(await status('/share/unlock', { method: 'POST' })).toBe(200)
  })

  describe('share-type segments in any case, as in Express 4', () => {
    it.each([
      ['gallery by key', `/SHARE/${KEY}`],
      ['gallery by slug', `/S/${KEY}`],
      ['gallery with explicit mode', `/Share/${KEY}/DOWNLOAD`],
      ['photo', `/share/PHOTO/${KEY}/${ID}`],
      ['photo, upper-case prefix', `/SHARE/Photo/${KEY}/${ID}/preview`],
      ['asset metadata by slug', `/S/meta/${KEY}/${ID}`]
    ])('serves %s', async (_name, path) => {
      expect(await status(path)).toBe(200)
    })

    it('looks up /S/<slug> by slug, not as a key', async () => {
      immichCalls.length = 0
      expect(await status(`/S/${KEY}x`)).toBe(200)
      expect(immichCalls.find(u => u.includes('/shared-links/me'))).toContain(`slug=${KEY}x`)
    })

    it('streams /share/VIDEO/... as a video', async () => {
      immichCalls.length = 0
      await status(`/share/VIDEO/${KEY}/${ID}`)
      expect(immichCalls.some(u => u.includes(`/assets/${ID}/video/playback`))).toBe(true)
    })

    it('redirects a POST to an upper-case share URL with 303', async () => {
      const res = await fetch(`${base}/SHARE/${KEY}`, { method: 'POST', redirect: 'manual' })
      expect(res.status).toBe(303)
    })

    it('routes an upper-case selective-download POST', async () => {
      expect(await status(`/S/${KEY}/DOWNLOAD`, { method: 'POST' })).toBe(400)
    })
  })

  it('keeps serving after all of the above', async () => {
    expect(await status('/share/healthcheck')).toBe(200)
  })
})
