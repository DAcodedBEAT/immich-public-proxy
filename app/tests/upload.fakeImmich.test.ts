import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { loadConfig } from '../src/config/loader'
import { KeyType, AlbumType, type SharedLink } from '../src/types'

/*
  Integration test against a FAKE Immich - a real HTTP server implementing
  just enough of the real API contract (status codes, response shapes,
  header names) to drive our code over the actual network stack. No mocks:
  real fetch, real form-data serialization, real Readable.toWeb conversion,
  real multipart body on the wire.

  This exists because our other 176 tests mock `fetch` directly, which is
  fast but blind to wire-level bugs. Exhibit A: `Readable.toWeb(form)` throws
  on modern Node because form-data's FormData isn't a stream.Readable - every
  mocked test happily "passed" while this would have broken 100% of uploads
  in production. A mocked fetch never exercises the real serialization path;
  this suite does.

  Run standalone against a real Immich by pointing IMMICH_URL at it instead -
  same test bodies, same assertions, just a different server on the other end.
*/

let server: Server
let baseUrl: string
let lastRequest:
  | {
      method?: string
      url?: string
      headers: Record<string, string | string[] | undefined>
      body: Buffer
    }
  | undefined
// Route table: method+path -> handler. Lets each test swap in the exact
// fake-Immich behaviour it wants (200 vs 403 vs malformed json, etc).
type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void
let routes: Map<string, Handler>

function key(method: string, path: string) {
  return method + ' ' + path
}

function jsonHandler(status: number, body: unknown): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}

beforeAll(async () => {
  routes = new Map()
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      lastRequest = { method: req.method, url: req.url, headers: req.headers, body }
      const handler = routes.get(key(req.method || '', (req.url || '').split('?')[0]))
      if (handler) {
        handler(req, res, body)
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ message: 'no fake route registered for ' + req.method + ' ' + req.url })
        )
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server did not bind a port')
  baseUrl = `http://127.0.0.1:${addr.port}`
  process.env.IMMICH_URL = baseUrl
  process.env.IMMICH_API_KEY = 'fake-immich-test-key'
})

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

beforeEach(() => {
  routes = new Map()
  lastRequest = undefined
})

describe('uploadAsset against a fake Immich (real HTTP, no mocks)', () => {
  it('streams a real multipart body and parses a 201 created response', async () => {
    routes.set(
      key('POST', '/api/assets'),
      jsonHandler(201, { id: 'real-asset-1', status: 'created' })
    )

    const { uploadAsset } = await import('../src/immich')
    const fileBytes = Buffer.from('not-really-a-jpeg-but-enough-bytes-to-matter'.repeat(500))
    const result = await uploadAsset(
      Readable.from([fileBytes]),
      'vacation-日本-🎉.jpg',
      'image/jpeg',
      '2026-01-01T00:00:00.000Z',
      {
        uploaderName: 'Fake Tester',
        uploaderIp: '10.0.0.1',
        shareKey: 'abcd1234',
        albumId: 'album-x'
      }
    )

    expect(result).toEqual({ id: 'real-asset-1', duplicate: false })
    expect(lastRequest?.headers['x-api-key']).toBe('fake-immich-test-key')
    expect(String(lastRequest?.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/)

    const bodyText = lastRequest!.body.toString('utf8')
    // The bytes actually arrived, not truncated or mangled
    expect(bodyText).toContain('not-really-a-jpeg-but-enough-bytes-to-matter'.repeat(10))
    // UTF-8 filenames survive busboy/form-data's encoding round-trip
    expect(bodyText).toContain('vacation-日本-🎉.jpg')
    // Metadata payload made it onto the wire
    expect(bodyText).toContain('ipp-upload')
    expect(bodyText).toContain('Fake Tester')
    expect(bodyText).toContain('album-x')
  })

  it('reports status:duplicate as duplicate:true', async () => {
    routes.set(
      key('POST', '/api/assets'),
      jsonHandler(200, { id: 'existing-asset', status: 'duplicate' })
    )
    const { uploadAsset } = await import('../src/immich')
    const result = await uploadAsset(Readable.from([Buffer.from('x')]), 'f.jpg', 'image/jpeg')
    expect(result).toEqual({ id: 'existing-asset', duplicate: true })
  })

  it('throws with the real status code when Immich rejects the upload', async () => {
    routes.set(key('POST', '/api/assets'), jsonHandler(400, { message: 'Invalid file' }))
    const { uploadAsset } = await import('../src/immich')
    await expect(
      uploadAsset(Readable.from([Buffer.from('x')]), 'f.jpg', 'image/jpeg')
    ).rejects.toThrow(/400/)
  })

  it('propagates a large file end-to-end without truncation (~5MB)', async () => {
    routes.set(key('POST', '/api/assets'), jsonHandler(201, { id: 'big-asset', status: 'created' }))
    const { uploadAsset } = await import('../src/immich')
    const bigFile = Buffer.alloc(5 * 1024 * 1024, 0x41) // 5MB of 'A'
    const result = await uploadAsset(Readable.from([bigFile]), 'big.jpg', 'image/jpeg')
    expect(result.id).toBe('big-asset')
    // Body includes the multipart wrapper too, so check it's at least the
    // file size and the byte content is intact somewhere in the middle.
    expect(lastRequest!.body.length).toBeGreaterThan(5 * 1024 * 1024)
    expect(lastRequest!.body.includes(Buffer.alloc(1000, 0x41))).toBe(true)
  })
})

describe('addAssetsToAlbum against a fake Immich', () => {
  it('succeeds on a real 200 with all-success items', async () => {
    routes.set(
      key('PUT', '/api/albums/album-1/assets'),
      jsonHandler(200, [{ id: 'a1', success: true }])
    )
    const { addAssetsToAlbum } = await import('../src/immich')
    await expect(addAssetsToAlbum('album-1', ['a1'])).resolves.toBeUndefined()
    expect(String(lastRequest?.url)).toBe('/api/albums/album-1/assets')
  })

  it('retries a real 500 then succeeds on the real retry request', async () => {
    let calls = 0
    routes.set(key('PUT', '/api/albums/album-2/assets'), (_req, res) => {
      calls++
      if (calls === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: 'temporary' }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify([{ id: 'a2', success: true }]))
      }
    })
    const { addAssetsToAlbum } = await import('../src/immich')
    await addAssetsToAlbum('album-2', ['a2'])
    expect(calls).toBe(2)
  })
})

describe('handleUpload against a fake Immich (full route, real HTTP, no mocks)', () => {
  // These go through the actual route handler - real busboy parsing of a
  // real multipart request, the real sizeLimitStream/idleTimeoutStream
  // pipe chain, and the real (unmocked) uploadAsset talking to the fake
  // HTTP server above. upload.handler.test.ts covers the same handler with
  // uploadAsset mocked out, which is fast but - as this suite exists to
  // demonstrate - blind to bugs in how a real downstream stream consumer
  // interacts with that pipe chain.
  const BOUNDARY = 'FakeImmichE2EBoundary'
  const CRLF = '\r\n'

  function buildMultipart(filename: string, content: Buffer | string): Buffer {
    const header = Buffer.from(
      `--${BOUNDARY}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
        `Content-Type: application/octet-stream${CRLF}${CRLF}`
    )
    const body = typeof content === 'string' ? Buffer.from(content) : content
    return Buffer.concat([header, body, Buffer.from(`${CRLF}--${BOUNDARY}--${CRLF}`)])
  }

  function makeReq(body: Buffer) {
    // Deliver in small chunks, not as one Readable.from([body]) blob - a
    // real TCP-backed request arrives incrementally, which is what makes
    // sizeLimitStream's Transform actually fire mid-parse (before busboy has
    // seen the closing boundary) rather than after everything, including the
    // terminator, has already been buffered in a single synchronous pass.
    let offset = 0
    const chunkSize = 64
    const readable = new Readable({
      read() {
        // setImmediate, not a synchronous push, so the downstream pipe
        // chain's own async processing (the Transform's _transform
        // callback, which is where sizeLimitStream's error originates) gets
        // real turns to run between chunks - matching how a genuine
        // TCP-backed request delivers data, instead of a tight synchronous
        // loop that can race ahead of downstream error handling entirely.
        setImmediate(() => {
          if (offset >= body.length) {
            this.push(null)
            return
          }
          this.push(body.subarray(offset, offset + chunkSize))
          offset += chunkSize
        })
      }
    })
    return Object.assign(readable, {
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      socket: { remoteAddress: '10.0.0.1' },
      params: { key: 'fakeimmichkey1234' }
    })
  }

  function makeRes() {
    return {
      statusCode: 200,
      headersSent: false,
      body: undefined as unknown,
      status(c: number) {
        this.statusCode = c
        return this
      },
      json(b: unknown) {
        this.headersSent = true
        this.body = b
        return this
      }
    }
  }

  const link: SharedLink = {
    key: 'fakeimmichkey1234',
    keyType: KeyType.key,
    type: AlbumType.album,
    assets: [],
    album: { id: 'album-real-1' }
  }

  it('responds 413 (not a process crash) when the file exceeds maxFileSizeMb', async () => {
    process.env.CONFIG = JSON.stringify({ ipp: { upload: { maxFileSizeMb: 0.00001 } } })
    loadConfig()
    try {
      routes.set(
        key('GET', '/api/server/media-types'),
        // ServerMediaTypesResponseDto requires all three fields.
        jsonHandler(200, { image: [], video: [], sidecar: [] })
      )
      const { handleUpload } = await import('../src/upload/handler')

      const body = buildMultipart('big.bin', 'x'.repeat(10_000))
      const req = makeReq(body)
      const res = makeRes()

      // The bug this guards against was an uncaught exception escaping the
      // whole process (via sizeLimitStream's Transform destroying itself
      // with no 'error' listener anywhere in the pipe chain reaching a real
      // consumer) - if that regresses, this call either hangs, rejects
      // unexpectedly, or the test run reports an unhandled exception rather
      // than the awaited call simply returning.
      await handleUpload(req as never, res as never, link, KeyType.key)

      expect(res.statusCode).toBe(413)
      expect((res.body as { error: string }).error).toContain('exceeds')
    } finally {
      delete process.env.CONFIG
      loadConfig()
    }
  })

  it('responds 413 (not a hang) when an oversize body arrives in one chunk, not incrementally', async () => {
    // The chunked makeReq() above is deliberately not used here. If the
    // whole body (small enough to fit one TCP read in practice) lands in a
    // single synchronous push, req reaches `readableEnded: true` before the
    // async size-limit error even fires downstream. respondAndAbort's
    // req.destroy() then has nothing left to interrupt, and req's 'close'
    // handler skips its reject specifically because readableEnded is true -
    // so unless respondAndAbort also settles the wrapping promise itself,
    // this hangs forever (and with server.requestTimeout disabled in
    // index.ts, nothing else would ever cut the connection).
    process.env.CONFIG = JSON.stringify({ ipp: { upload: { maxFileSizeMb: 0.00001 } } })
    loadConfig()
    try {
      routes.set(
        key('GET', '/api/server/media-types'),
        jsonHandler(200, { image: [], video: [], sidecar: [] })
      )
      const { handleUpload } = await import('../src/upload/handler')

      const body = buildMultipart('big.bin', 'x'.repeat(10_000))
      const req = Object.assign(Readable.from([body]), {
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        socket: { remoteAddress: '10.0.0.1' },
        params: { key: 'fakeimmichkey1234' }
      })
      const res = makeRes()

      await handleUpload(req as never, res as never, link, KeyType.key)

      expect(res.statusCode).toBe(413)
      expect((res.body as { error: string }).error).toContain('exceeds')
    } finally {
      delete process.env.CONFIG
      loadConfig()
    }
  })

  // ---------------------------------------------------------------------
  // Adversarial-input regressions, promoted from a manual fuzz pass against
  // a live server: a batch of malformed multipart bodies and hostile
  // filenames sent to a running IPP instance, checking the process stayed
  // up and the filename that reached Immich was actually sanitized. These
  // two are the cases worth keeping as permanent, deterministic coverage;
  // the rest of that pass (random-byte bodies, abrupt disconnects) doesn't
  // fit a repeatable assertion and isn't included here.
  // ---------------------------------------------------------------------

  it('accepts an ordinary upload even when its Content-Type header CRLF is split across two writes', async () => {
    // @fastify/busboy mis-parses this file part's mimeType if the header
    // line's terminating CRLF happens to land exactly on a chunk boundary -
    // reproduced directly against the library with no IPP code involved.
    // That split is entirely plausible in production (a reverse proxy or an
    // unlucky TCP segment boundary can land anywhere). The exact symptom
    // depends on the installed version: 3.2.1 leaves a trailing "\r" on the
    // reported mimeType ("application/octet-stream\r", handled by trimming);
    // 3.2.2+ instead aborts parsing the header block entirely (a false
    // positive in its own bare-CRLF-injection check misfiring on its
    // internal end-of-headers buffering, not on anything actually injected)
    // and falls back to "text/plain" (handled by treating that fallback as
    // a generic/unrecognised type, same as the other pass-through cases).
    // Either way, without a fix this wrongly MIME-rejects an ordinary,
    // fully-supported upload - this test doesn't care which mimeType busboy
    // actually reports, only that the upload succeeds regardless.
    routes.set(
      key('GET', '/api/server/media-types'),
      jsonHandler(200, { image: [], video: [], sidecar: [] })
    )
    routes.set(key('POST', '/api/assets'), (_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'crlf-split-asset', status: 'created' }))
    })
    routes.set(
      key('PUT', '/api/albums/album-real-1/assets'),
      jsonHandler(200, [{ id: 'crlf-split-asset', success: true }])
    )
    const { handleUpload } = await import('../src/upload/handler')

    const body = buildMultipart('split.jpg', 'file bytes')
    const marker = 'Content-Type: application/octet-stream\r\n'
    const splitAt = body.indexOf(marker) + marker.length - 1 // right after the \r, before the \n
    expect(splitAt).toBeGreaterThan(0)

    const chunks = [body.subarray(0, splitAt), body.subarray(splitAt)]
    let chunkIndex = 0
    const req = Object.assign(
      new Readable({
        read() {
          if (chunkIndex >= chunks.length) {
            this.push(null)
            return
          }
          this.push(chunks[chunkIndex++])
        }
      }),
      {
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        socket: { remoteAddress: '10.0.0.1' },
        params: { key: 'fakeimmichkey1234' }
      }
    )
    const res = makeRes()

    await handleUpload(req as never, res as never, link, KeyType.key)

    expect(res.statusCode).toBe(200)
    expect((res.body as { assetId?: string }).assetId).toBe('crlf-split-asset')
  })

  it('strips path traversal and control characters from the filename before it reaches Immich', async () => {
    routes.set(
      key('GET', '/api/server/media-types'),
      jsonHandler(200, { image: [], video: [], sidecar: [] })
    )
    // lastRequest reflects whichever request the fake server saw most
    // recently, and handleUpload makes a follow-up album-add call after the
    // asset upload - capture the upload request specifically rather than
    // relying on lastRequest still pointing at it by the time we assert.
    let uploadBody: Buffer | undefined
    routes.set(key('POST', '/api/assets'), (_req, res, reqBody) => {
      uploadBody = reqBody
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'fuzz-asset-1', status: 'created' }))
    })
    routes.set(
      key('PUT', '/api/albums/album-real-1/assets'),
      jsonHandler(200, [{ id: 'fuzz-asset-1', success: true }])
    )
    const { handleUpload } = await import('../src/upload/handler')

    // Embeds a path traversal attempt, a null byte, and a CRLF pair.
    const filename = '../../../../etc/passwd\x00.jpg\r\nX-Injected: evil'
    const body = buildMultipart(filename, 'bytes')
    const req = makeReq(body)
    const res = makeRes()

    await handleUpload(req as never, res as never, link, KeyType.key)

    expect(res.statusCode).toBe(200)
    const sentFilename = uploadBody!
      .toString('utf8')
      .match(/name="assetData"; filename="([^"]*)"/)?.[1]
    expect(sentFilename).toBeDefined()
    expect(sentFilename).not.toContain('/')
    expect(sentFilename).not.toContain('\x00')
    expect(sentFilename).not.toMatch(/[\r\n]/)
  })

  it('race: a mix of concurrent normal and oversize uploads, queued behind a tiny concurrency limit, all settle correctly with no crash, hang, or leak', async () => {
    // Real (unmocked) getUploadLimiter with concurrentUploads=2, so most of
    // these 6 uploads spend real time queued - exactly the scenario the
    // idle-timeout-arms-only-after-a-slot-is-granted fix and the
    // sizeLimiter.stream.destroyed-while-queued check exist for. Runs the
    // real streaming pipe chain end-to-end against the fake HTTP server, not
    // a mocked uploadAsset - so an unhandled 'error' anywhere in that chain
    // would surface as this test hanging or vitest reporting an uncaught
    // exception, not a clean assertion failure.
    process.env.CONFIG = JSON.stringify({
      ipp: { upload: { concurrentUploads: 2, maxFileSizeMb: 0.0002 } } // ~200 bytes
    })
    loadConfig()
    try {
      routes.set(
        key('GET', '/api/server/media-types'),
        jsonHandler(200, { image: [], video: [], sidecar: [] })
      )
      let assetCounter = 0
      routes.set(key('POST', '/api/assets'), (_req, res) => {
        assetCounter++
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'race-asset-' + assetCounter, status: 'created' }))
      })
      routes.set(
        key('PUT', '/api/albums/album-real-1/assets'),
        jsonHandler(200, [{ id: 'race-asset', success: true }])
      )
      const { handleUpload } = await import('../src/upload/handler')

      const NORMAL = Buffer.from('x'.repeat(50)) // well under the ~200 byte cap
      const OVERSIZE = Buffer.from('y'.repeat(5000)) // well over it

      // Interleaved normal/oversize, so queued-behind-others includes both kinds.
      const plan = [
        { name: 'n0.jpg', content: NORMAL },
        { name: 'o0.jpg', content: OVERSIZE },
        { name: 'n1.jpg', content: NORMAL },
        { name: 'o1.jpg', content: OVERSIZE },
        { name: 'n2.jpg', content: NORMAL },
        { name: 'n3.jpg', content: NORMAL }
      ]

      const runs = plan.map(({ name, content }) => {
        const req = makeReq(buildMultipart(name, content))
        const res = makeRes()
        return handleUpload(req as never, res as never, link, KeyType.key).then(() => ({
          name,
          res
        }))
      })

      const settled = await Promise.race([
        Promise.all(runs).then(r => ({ timedOut: false as const, r })),
        new Promise<{ timedOut: true }>(resolve =>
          setTimeout(() => resolve({ timedOut: true }), 8000)
        )
      ])
      expect(settled.timedOut).toBe(false)
      if (settled.timedOut) return // unreachable, satisfies TS narrowing

      for (const { name, res } of settled.r) {
        const expectedStatus = name.startsWith('o') ? 413 : 200
        expect(res.statusCode).toBe(expectedStatus)
      }

      // No leak from any of the six: one more upload afterwards must still
      // succeed cleanly rather than being wrongly rejected as busy/queued.
      const finalReq = makeReq(buildMultipart('final.jpg', NORMAL))
      const finalRes = makeRes()
      await handleUpload(finalReq as never, finalRes as never, link, KeyType.key)
      expect(finalRes.statusCode).toBe(200)
    } finally {
      delete process.env.CONFIG
      loadConfig()
    }
  })

  it('chaos: a battery of concurrent uploads against a randomly-misbehaving Immich all settle, none hang, none crash the process', async () => {
    // Real (unmocked) concurrency limiter + real HTTP server that behaves
    // differently per request: clean success, a 500, malformed JSON, a slow
    // response past responseTimeoutSec, and an abrupt connection reset mid-
    // response - the kinds of failure a real Immich instance (or the network
    // between IPP and it) can actually produce. Deterministic PRNG so a
    // failure is reproducible from the seed. The goal isn't asserting an
    // exact status per request (the failure mode is randomised) - it's the
    // invariants: every request settles within a bounded time, the reported
    // status is always one this route is documented to return, and nothing
    // leaks a pending-upload slot or throws an unhandled exception.
    process.env.CONFIG = JSON.stringify({
      ipp: {
        upload: { concurrentUploads: 3, maxFileSizeMb: 50, responseTimeoutSec: 0.3 }
      }
    })
    loadConfig()
    try {
      routes.set(
        key('GET', '/api/server/media-types'),
        jsonHandler(200, { image: [], video: [], sidecar: [] })
      )
      routes.set(
        key('PUT', '/api/albums/album-real-1/assets'),
        jsonHandler(200, [{ id: 'chaos-asset', success: true }])
      )

      let seed = 20260909
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
      }
      const behaviors = ['success', 'server-error', 'malformed-json', 'slow', 'reset'] as const
      let assetCounter = 0
      routes.set(key('POST', '/api/assets'), (req, res) => {
        assetCounter++
        const behavior = behaviors[Math.floor(rand() * behaviors.length)]
        switch (behavior) {
          case 'success':
            res.writeHead(201, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ id: 'chaos-asset-' + assetCounter, status: 'created' }))
            break
          case 'server-error':
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ message: 'simulated Immich failure' }))
            break
          case 'malformed-json':
            res.writeHead(201, { 'Content-Type': 'application/json' })
            res.end('{not valid json')
            break
          case 'slow':
            // Never responds within responseTimeoutSec (clamped to a 1s
            // minimum by uploadAsset's own Math.max) - the AbortController
            // there must cut this off well before the 2s below.
            setTimeout(() => {
              if (!res.writableEnded) {
                res.writeHead(201, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ id: 'too-late', status: 'created' }))
              }
            }, 2000).unref()
            break
          case 'reset':
            req.socket.destroy()
            break
        }
      })

      const { handleUpload } = await import('../src/upload/handler')
      const TOTAL = 20
      const runs = Array.from({ length: TOTAL }, (_, i) => {
        const req = makeReq(buildMultipart(`chaos${i}.jpg`, 'x'.repeat(1000)))
        const res = makeRes()
        return handleUpload(req as never, res as never, link, KeyType.key).then(
          () => ({ ok: true as const, res }),
          e => ({ ok: false as const, error: e })
        )
      })

      const settled = await Promise.race([
        Promise.all(runs).then(r => ({ timedOut: false as const, r })),
        new Promise<{ timedOut: true }>(resolve =>
          setTimeout(() => resolve({ timedOut: true }), 15_000)
        )
      ])
      expect(settled.timedOut).toBe(false)
      if (settled.timedOut) return // unreachable, satisfies TS narrowing

      const allowedStatuses = new Set([200, 413, 500, 502, 504])
      for (const outcome of settled.r) {
        // handleUpload must never reject - every path resolves after
        // sending its own response, however things went wrong upstream.
        expect(outcome.ok).toBe(true)
        if (!outcome.ok) continue // unreachable, satisfies TS narrowing
        expect(allowedStatuses.has(outcome.res.statusCode)).toBe(true)
      }

      // No leak across 20 chaotic attempts: one more upload afterwards must
      // still succeed cleanly - back Immich behaving normally again.
      routes.set(
        key('POST', '/api/assets'),
        jsonHandler(201, { id: 'chaos-final-asset', status: 'created' })
      )
      const finalReq = makeReq(buildMultipart('chaos-final.jpg', 'x'.repeat(100)))
      const finalRes = makeRes()
      await handleUpload(finalReq as never, finalRes as never, link, KeyType.key)
      expect(finalRes.statusCode).toBe(200)
    } finally {
      delete process.env.CONFIG
      loadConfig()
    }
  }, 20_000)

  it('rejects a second file part cleanly (One file per request), no hang or crash', async () => {
    const twoFileBody = Buffer.from(
      `--${BOUNDARY}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="a.jpg"${CRLF}` +
        `Content-Type: image/jpeg${CRLF}${CRLF}aaa${CRLF}` +
        `--${BOUNDARY}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="b.jpg"${CRLF}` +
        `Content-Type: image/jpeg${CRLF}${CRLF}bbb${CRLF}` +
        `--${BOUNDARY}--${CRLF}`
    )
    const { handleUpload } = await import('../src/upload/handler')
    const req = makeReq(twoFileBody)
    const res = makeRes()

    await handleUpload(req as never, res as never, link, KeyType.key)

    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('One file per request')
  })
})

describe('bulkUploadCheck against a fake Immich', () => {
  it('round-trips a real request/response over HTTP', async () => {
    routes.set(key('POST', '/api/assets/bulk-upload-check'), (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          results: [{ id: '0', action: 'reject', reason: 'duplicate', assetId: 'existing-1' }]
        })
      )
    })
    const { bulkUploadCheck } = await import('../src/immich')
    const results = await bulkUploadCheck([{ id: '0', checksum: 'a'.repeat(40) }])
    expect(results[0].assetId).toBe('existing-1')
  })
})
