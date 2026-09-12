import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { loadConfig } from '../src/config/loader'

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

  beforeAll(async () => {
    process.env.IMMICH_URL = IMMICH
    loadConfig()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // Requests to the test server go through the real fetch; only Immich is mocked.
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.startsWith(IMMICH)) return realFetch(input, init)
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
    ['healthcheck', '/share/healthcheck']
  ])('serves %s', async (_name, path) => {
    expect(await status(path)).toBe(200)
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

  it('treats absent optional params as undefined, not the string "undefined"', async () => {
    // Regression: stringifying a missing {/:size} param made every default-size
    // photo request fail size validation. The plain gallery URL must also still
    // render (mode is absent there).
    const res = await fetch(`${base}/share/${KEY}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<!DOCTYPE html>')
    expect(await status(`/share/photo/${KEY}/${ID}`)).toBe(200)
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

  it.each([`/share/${KEY}/upload`, `/s/${KEY}/upload`, `/share/${KEY}/upload-check`])(
    'forbids POST %s when uploads are not enabled',
    async path => {
      expect(await status(path, { method: 'POST' })).toBe(403)
    }
  )

  it('falls through to 404 for an upload POST with an unknown share type', async () => {
    expect(await status(`/foo/${KEY}/upload`, { method: 'POST' })).toBe(404)
  })

  it('keeps serving after all of the above', async () => {
    expect(await status('/share/healthcheck')).toBe(200)
  })
})
