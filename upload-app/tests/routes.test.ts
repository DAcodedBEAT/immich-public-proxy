import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { Server } from 'http'
import { connect, type AddressInfo } from 'net'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetBanlistCacheForTests } from '@ipp/core'

/*
  Route-level tests against the real upload app with Immich mocked at the
  fetch boundary. The router is mounted both under /upload and at the root,
  and its share-type param is constrained by router.param rather than inline
  regex (Express 5), so route matching is checked through both mounts here.
*/

const KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789'
const IMMICH = 'http://immich.test'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

describe('upload app routes', () => {
  let server: Server
  let base: string

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
      if (url.includes('/server/ping')) return json({ res: 'pong' })
      if (url.includes('/shared-links/me')) {
        return json({
          id: 'ffffffff-0000-0000-0000-000000000001',
          type: 'ALBUM',
          key: 'k',
          allowUpload: true,
          expiresAt: null,
          assets: [],
          album: { id: 'aaaaaaaa-0000-0000-0000-000000000002', albumName: 'Holiday' }
        })
      }
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
    ['/healthcheck'],
    ['/share/healthcheck'],
    ['/upload/healthcheck'],
    ['/upload/share/healthcheck']
  ])('serves the healthcheck at %s', async path => {
    const res = await fetch(base + path)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it.each([
    ['root mount, key', '', 'share'],
    ['root mount, slug', '', 's'],
    ['/upload mount, key', '/upload', 'share'],
    ['/upload mount, slug', '/upload', 's']
  ])('serves the upload page on the %s', async (_name, prefix, shareType) => {
    const res = await fetch(`${base}${prefix}/${shareType}/${KEY}`)
    expect(res.status).toBe(200)
    // The page posts back under the prefix it was reached by (req.baseUrl)
    expect(await res.text()).toContain(`${prefix}/${shareType}/${KEY}/upload`)
  })

  it.each([
    ['root mount, key', '', 'SHARE', 'share'],
    ['root mount, slug', '', 'S', 's'],
    ['/upload mount, key', '/upload', 'Share', 'share'],
    ['/upload mount, slug', '/upload', 'S', 's']
  ])(
    'serves the upload page for an upper-case share type on the %s',
    async (_n, prefix, typed, canonical) => {
      const res = await fetch(`${base}${prefix}/${typed}/${KEY}`)
      expect(res.status).toBe(200)
      // URLs built from the share type use its canonical, lower-case form
      expect(await res.text()).toContain(`"${prefix}/${canonical}/${KEY}/upload"`)
    }
  )

  it.each([[`/SHARE/${KEY}/upload`], [`/upload/S/${KEY}/upload`]])(
    'routes an upload POST with an upper-case share type at %s',
    async path => {
      expect(await status(path, { method: 'POST', body: '' })).toBe(400)
    }
  )

  it.each([
    ['unknown share type at the root', `/x/${KEY}`],
    ['unknown share type under /upload', `/upload/x/${KEY}`],
    ['upload under an unknown share type', `/x/${KEY}/upload`],
    ['upload under an unknown share type, /upload', `/upload/x/${KEY}/upload`]
  ])('gives OPTIONS for an %s the 404 policy', async (_n, path) => {
    const res = await fetch(base + path, { method: 'OPTIONS' })
    expect(res.status).toBe(404)
    expect(res.headers.get('allow')).toBeNull()
  })

  it.each([
    ['unknown share type at the root', `/foo/${KEY}`],
    ['unknown share type under /upload', `/upload/foo/${KEY}`],
    ['the root', '/'],
    ['the bare mount', '/upload'],
    ['unknown path', '/nope'],
    ['deep unknown path', '/a/b/c/d']
  ])('falls through to 404 for %s', async (_name, path) => {
    expect(await status(path)).toBe(404)
  })

  it.each([
    ['at the root', `/foo/${KEY}/upload`],
    ['under /upload', `/upload/foo/${KEY}/upload`]
  ])('answers 404 to an upload POST with an unknown share type %s', async (_name, path) => {
    expect(await status(path, { method: 'POST', body: 'x' })).toBe(404)
  })

  it.each([
    ['at the root', `/share/${KEY}/upload`],
    ['under /upload', `/upload/share/${KEY}/upload`]
  ])('routes an upload POST to the receiver %s', async (_name, path) => {
    // An empty body is refused by the receiver itself, which proves the route matched
    const res = await fetch(base + path, { method: 'POST', body: '' })
    expect(res.status).toBe(400)
    expect(res.headers.get('connection')).toBe('close')
  })

  it.each([['/share/unlock'], ['/upload/share/unlock']])(
    'accepts an unlock POST with no body at %s without crashing',
    async path => {
      // Express 5 leaves req.body undefined when no body parser matched.
      expect(await status(path, { method: 'POST' })).toBe(200)
    }
  )

  const expectLockedDown = (res: Response) => {
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(res.headers.get('cache-control')).toContain('no-store')
  }

  it.each([
    ['the upload page', `/share/${KEY}`, undefined],
    ['the upload page under /upload', `/upload/s/${KEY}`, undefined],
    ['an upload POST', `/share/${KEY}/upload`, { method: 'POST', body: '' }],
    ['an unlock POST', '/upload/share/unlock', { method: 'POST' }]
  ])('forbids framing and caching of %s', async (_name, path, init) => {
    const res = await fetch(base + path, init)
    expect(res.status).toBeLessThan(500)
    expectLockedDown(res)
  })

  it('answers 429 with Retry-After once the rate limit is used up', async () => {
    // The bundled config allows 60 files a minute per address and share
    const send = () =>
      fetch(`${base}/share/${KEY}/upload?filename=a.jpg`, {
        method: 'POST',
        headers: { 'content-type': 'image/jpeg' },
        body: 'abc'
      })
    for (let i = 0; i < 60; i++) {
      const res = await send()
      expect(res.status).not.toBe(429)
      await res.arrayBuffer()
    }
    const limited = await send()
    expect(limited.status).toBe(429)
    const retryAfter = Number(limited.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect(await limited.json()).toEqual({ error: expect.stringContaining('Too many uploads') })
    expectLockedDown(limited)
  })

  it('drops an unlock POST whose body stalls past its deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tick = () => new Promise(resolve => setImmediate(resolve))
    try {
      const socket = connect((server.address() as AddressInfo).port, '127.0.0.1')
      let closed = false
      socket.on('close', () => (closed = true))
      socket.on('error', () => {})
      socket.write(
        'POST /share/unlock HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n' +
          'Content-Length: 100\r\n\r\n{"key":'
      )
      // Wait for the route to arm its deadline
      for (let i = 0; i < 500 && vi.getTimerCount() === 0; i++) await tick()
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      vi.advanceTimersByTime(9_999)
      for (let i = 0; i < 20; i++) await tick()
      expect(closed).toBe(false)
      vi.advanceTimersByTime(1)
      for (let i = 0; i < 500 && !closed; i++) await tick()
      expect(closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('with the requesting address banned', () => {
    let dir: string
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'ipp-upload-ban-'))
      const path = join(dir, 'banned.txt')
      // req.ip is ::ffff:127.0.0.1 on this dual-stack listener
      writeFileSync(path, '127.0.0.1\n')
      process.env.IPP_BANLIST_PATH = path
    })
    afterAll(() => {
      delete process.env.IPP_BANLIST_PATH
      resetBanlistCacheForTests()
      rmSync(dir, { recursive: true, force: true })
    })

    it.each([
      ['GET', '/healthcheck'],
      ['GET', '/upload/healthcheck'],
      ['GET', '/share/static/favicon.ico'],
      ['GET', `/share/${KEY}`],
      ['GET', `/upload/s/${KEY}`],
      ['POST', '/share/unlock'],
      ['POST', `/upload/share/${KEY}/upload`],
      ['GET', '/nope']
    ])('answers 403 and closes the connection for %s %s', async (method, path) => {
      const init: RequestInit = method === 'POST' ? { method, body: 'x' } : {}
      const res = await fetch(base + path, { ...init, redirect: 'manual' })
      expect(res.status).toBe(403)
      expect(res.headers.get('connection')).toBe('close')
      expect(await res.text()).toBe('')
    })
  })

  it('keeps serving after all of the above', async () => {
    expect(await status('/healthcheck')).toBe(200)
  })
})
