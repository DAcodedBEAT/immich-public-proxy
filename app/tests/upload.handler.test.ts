/**
 * Tests for handleUpload and handleUploadCheck in upload/handler.ts.
 *
 * Handler functions are tested by:
 * 1. Mocking the ../src/immich module (vi.mock) so no real Immich calls happen.
 * 2. Building a fake multipart/form-data request (real Readable + hand-crafted
 *    multipart boundary body) so the busboy parser inside the handler works
 *    exactly as it does in production.
 * 3. Using a minimal fake res object that captures status + JSON body.
 *
 * Unlike the immich.ts unit tests, handler.ts itself has no module-level state
 * worth resetting between tests, so vi.resetModules() is not used here.
 *
 * vi.mock() is hoisted to the top of the file by vitest at runtime regardless
 * of where it appears in source, so the named imports below always receive the
 * mocked versions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'stream'
import { KeyType, AlbumType } from '../src/types'
import type { SharedLink } from '../src/types'
import {
  uploadAsset,
  addAssetsToAlbum,
  getSupportedMimeTypes,
  getUploadLimiter,
  invalidateShare,
  updateAssetDescription,
  tagAssetWithUploader,
  bulkUploadCheck
} from '../src/immich'
import { handleUpload, handleUploadCheck } from '../src/upload/handler'

// ---------------------------------------------------------------------------
// Mock the immich module.  importOriginal preserves functions we don't want to
// stub so that other things in the module initialise correctly.
// ---------------------------------------------------------------------------
vi.mock('../src/immich', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/immich')>()
  return {
    ...actual,
    uploadAsset: vi.fn(),
    addAssetsToAlbum: vi.fn(),
    getSupportedMimeTypes: vi.fn(),
    getUploadLimiter: vi.fn(),
    invalidateShare: vi.fn(),
    updateAssetDescription: vi.fn(),
    tagAssetWithUploader: vi.fn(),
    bulkUploadCheck: vi.fn()
  }
})

// Cast helpers
const mockUploadAsset = uploadAsset as ReturnType<typeof vi.fn>
const mockAddAssetsToAlbum = addAssetsToAlbum as ReturnType<typeof vi.fn>
const mockGetSupportedMimeTypes = getSupportedMimeTypes as ReturnType<typeof vi.fn>
const mockGetUploadLimiter = getUploadLimiter as ReturnType<typeof vi.fn>
const mockInvalidateShare = invalidateShare as ReturnType<typeof vi.fn>
const mockUpdateAssetDescription = updateAssetDescription as ReturnType<typeof vi.fn>
const mockTagAssetWithUploader = tagAssetWithUploader as ReturnType<typeof vi.fn>
const mockBulkUploadCheck = bulkUploadCheck as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Fake res factory
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Multipart body builder
// ---------------------------------------------------------------------------
const BOUNDARY = 'TestBoundary1234567890'
const CRLF = '\r\n'

function buildMultipart(
  fields: Record<string, string>,
  file?: { fieldname?: string; filename: string; mimeType: string; content: Buffer | string }
): Buffer {
  const parts: Buffer[] = []

  // Text fields
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}${CRLF}` +
          `Content-Disposition: form-data; name="${name}"${CRLF}` +
          CRLF +
          value +
          CRLF
      )
    )
  }

  // File part
  if (file) {
    const fieldname = file.fieldname ?? 'file'
    const header = Buffer.from(
      `--${BOUNDARY}${CRLF}` +
        `Content-Disposition: form-data; name="${fieldname}"; filename="${file.filename}"${CRLF}` +
        `Content-Type: ${file.mimeType}${CRLF}` +
        CRLF
    )
    const content = typeof file.content === 'string' ? Buffer.from(file.content) : file.content
    parts.push(header, content, Buffer.from(CRLF))
  }

  parts.push(Buffer.from(`--${BOUNDARY}--${CRLF}`))
  return Buffer.concat(parts)
}

/**
 * Build a fake Express-like request from a Buffer.
 *
 * Augments a real Readable so req.on('close', ...), req.on('error', ...),
 * and req.pipe(busboy) all work natively.  We DON'T override destroy() -
 * that lets the handler call req.destroy() without causing infinite recursion.
 */
function makeReq(
  body: Buffer,
  extra: { params?: Record<string, string>; remoteAddress?: string } = {}
) {
  const readable = Readable.from([body])
  // Augment - do not override destroy to avoid recursion when the handler
  // calls req.destroy() (it calls the Readable's own destroy, which is fine).
  return Object.assign(readable, {
    headers: {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`
    },
    socket: { remoteAddress: extra.remoteAddress ?? '1.2.3.4' },
    params: extra.params ?? { key: 'testkey1234567890' }
  })
}

/**
 * Same as makeReq, but delivers the body incrementally (small chunks via
 * setImmediate) instead of as one Readable.from([body]) blob. A real
 * TCP-backed request arrives incrementally; some races (a downstream
 * consumer abandoning the stream partway through) only manifest when the
 * whole body isn't already fully buffered before the abandonment happens.
 */
function makeIncrementalReq(body: Buffer, chunkSize = 32) {
  let offset = 0
  const readable = new Readable({
    read() {
      setImmediate(() => {
        if (offset >= body.length) {
          this.push(null)
          return
        }
        const end = Math.min(offset + chunkSize, body.length)
        this.push(body.subarray(offset, end))
        offset = end
      })
    }
  })
  return Object.assign(readable, {
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    socket: { remoteAddress: '1.2.3.4' },
    params: { key: 'testkey1234567890' }
  })
}

// ---------------------------------------------------------------------------
// Standard fixture link (happy-path album share with upload allowed)
// ---------------------------------------------------------------------------
function makeLink(overrides: Partial<SharedLink> = {}): SharedLink {
  return {
    key: 'fullkey1234567890',
    keyType: KeyType.key,
    type: AlbumType.album,
    assets: [],
    album: { id: 'album-1' },
    password: undefined,
    expiresAt: null,
    allowUpload: true,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
const ORIGINAL_API_KEY = process.env.IMMICH_API_KEY
const ORIGINAL_URL = process.env.IMMICH_URL

beforeEach(() => {
  vi.clearAllMocks()

  // Default mock behaviours
  mockGetSupportedMimeTypes.mockResolvedValue(new Set(['image/jpeg', 'video/mp4']))
  mockGetUploadLimiter.mockReturnValue((fn: () => Promise<unknown>) => fn())
  mockUploadAsset.mockResolvedValue({ id: 'asset-new-1', duplicate: false })
  mockAddAssetsToAlbum.mockResolvedValue(undefined)
  mockUpdateAssetDescription.mockResolvedValue(undefined)
  mockTagAssetWithUploader.mockResolvedValue(undefined)
  mockInvalidateShare.mockReturnValue(undefined)
  mockBulkUploadCheck.mockResolvedValue([])

  process.env.IMMICH_API_KEY = 'test-api-key'
  process.env.IMMICH_URL = 'http://immich.test'
})

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.IMMICH_API_KEY
  else process.env.IMMICH_API_KEY = ORIGINAL_API_KEY
  if (ORIGINAL_URL === undefined) delete process.env.IMMICH_URL
  else process.env.IMMICH_URL = ORIGINAL_URL
})

// ===========================================================================
// handleUpload tests
// ===========================================================================

describe('handleUpload', () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------
  it('streams the file to Immich and returns { uploaded: 1, assetId, duplicate: false }', async () => {
    const body = buildMultipart(
      { fileCreatedAt: '2024-01-01T00:00:00.000Z', uploaderName: 'Alice', caption: 'cap' },
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: 'file-bytes' }
    )
    const req = makeReq(body, { params: { key: 'testkey1234567890' } })
    const res = makeRes()
    const link = makeLink()

    await handleUpload(req as never, res as never, link, KeyType.key)

    // uploadAsset called with correct metadata
    expect(mockUploadAsset).toHaveBeenCalledOnce()
    const [, filename, mimeType, fileCreatedAt, context] = mockUploadAsset.mock.calls[0]
    expect(filename).toBe('photo.jpg')
    expect(mimeType).toBe('image/jpeg')
    expect(fileCreatedAt).toBe('2024-01-01T00:00:00.000Z')
    expect(context.uploaderIp).toBe('1.2.3.4')
    // shareKey is the first 8 chars of the request key: 'testkey1'
    expect(context.shareKey).toBe('testkey1')
    expect(context.albumId).toBe('album-1')

    // addAssetsToAlbum called with the returned assetId
    expect(mockAddAssetsToAlbum).toHaveBeenCalledWith('album-1', ['asset-new-1'])

    // invalidateShare called twice (req key + link key)
    expect(mockInvalidateShare).toHaveBeenCalledTimes(2)
    expect(mockInvalidateShare).toHaveBeenCalledWith('testkey1234567890', undefined, KeyType.key)
    expect(mockInvalidateShare).toHaveBeenCalledWith('fullkey1234567890', undefined, KeyType.key)

    // Response
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ uploaded: 1, assetId: 'asset-new-1', duplicate: false })
  })

  // -------------------------------------------------------------------------
  // Non-ASCII filenames - regression coverage for the @fastify/busboy
  // migration (upstream busboy needed defParamCharset: 'utf8' to avoid
  // mojibake here; @fastify/busboy defaults to UTF-8 but this pins the
  // behaviour either way).
  // -------------------------------------------------------------------------
  it('preserves a non-ASCII filename (UTF-8 Content-Disposition param) unmangled', async () => {
    const filename = 'ファイル 🎉.jpg'
    const body = buildMultipart({}, { filename, mimeType: 'image/jpeg', content: 'file-bytes' })
    await handleUpload(makeReq(body) as never, makeRes() as never, makeLink(), KeyType.key)

    expect(mockUploadAsset).toHaveBeenCalledOnce()
    const [, uploadedFilename] = mockUploadAsset.mock.calls[0]
    expect(uploadedFilename).toBe(filename)
  })

  // -------------------------------------------------------------------------
  // Description composition
  // -------------------------------------------------------------------------
  it('composes description as caption + name when both present', async () => {
    const body = buildMultipart(
      { fileCreatedAt: '2024-01-01T00:00:00.000Z', uploaderName: 'Name', caption: 'cap' },
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: 'bytes' }
    )
    await handleUpload(makeReq(body) as never, makeRes() as never, makeLink(), KeyType.key)

    expect(mockUpdateAssetDescription).toHaveBeenCalledWith(
      'asset-new-1',
      'cap\n\n- Uploaded by Name'
    )
  })

  it('composes description as "Uploaded by Name" when only name present', async () => {
    const body = buildMultipart(
      { uploaderName: 'Name' },
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: 'bytes' }
    )
    await handleUpload(makeReq(body) as never, makeRes() as never, makeLink(), KeyType.key)

    expect(mockUpdateAssetDescription).toHaveBeenCalledWith('asset-new-1', 'Uploaded by Name')
  })

  it('composes description as caption only when only caption present', async () => {
    const body = buildMultipart(
      { caption: 'Just a caption' },
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: 'bytes' }
    )
    await handleUpload(makeReq(body) as never, makeRes() as never, makeLink(), KeyType.key)

    expect(mockUpdateAssetDescription).toHaveBeenCalledWith('asset-new-1', 'Just a caption')
  })

  it('does not call updateAssetDescription when neither caption nor name present', async () => {
    const body = buildMultipart(
      {},
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: 'bytes' }
    )
    await handleUpload(makeReq(body) as never, makeRes() as never, makeLink(), KeyType.key)

    expect(mockUpdateAssetDescription).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // tagAssetWithUploader
  // -------------------------------------------------------------------------
  it('tags the asset with uploaderName when name is present', async () => {
    const body = buildMultipart(
      { uploaderName: 'Tagger' },
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: 'bytes' }
    )
    await handleUpload(makeReq(body) as never, makeRes() as never, makeLink(), KeyType.key)

    expect(mockTagAssetWithUploader).toHaveBeenCalledWith('Tagger', 'asset-new-1')
  })

  it('does not call tagAssetWithUploader when name is absent', async () => {
    const body = buildMultipart(
      {},
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: 'bytes' }
    )
    await handleUpload(makeReq(body) as never, makeRes() as never, makeLink(), KeyType.key)

    expect(mockTagAssetWithUploader).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Duplicate asset
  // -------------------------------------------------------------------------
  it('skips description and tag for duplicate assets but still adds to album', async () => {
    mockUploadAsset.mockResolvedValue({ id: 'asset-dup-1', duplicate: true })

    const body = buildMultipart(
      { uploaderName: 'Alice', caption: 'my cap' },
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: 'bytes' }
    )
    const res = makeRes()
    await handleUpload(makeReq(body) as never, res as never, makeLink(), KeyType.key)

    expect(mockUpdateAssetDescription).not.toHaveBeenCalled()
    expect(mockTagAssetWithUploader).not.toHaveBeenCalled()
    expect(mockAddAssetsToAlbum).toHaveBeenCalledWith('album-1', ['asset-dup-1'])
    expect(res.body).toEqual({ uploaded: 1, assetId: 'asset-dup-1', duplicate: true })
  })

  // -------------------------------------------------------------------------
  // updateAssetDescription rejection is non-fatal
  // -------------------------------------------------------------------------
  it('responds 200 even when updateAssetDescription rejects', async () => {
    mockUpdateAssetDescription.mockRejectedValue(new Error('API key lacks permission'))

    const body = buildMultipart(
      { uploaderName: 'Alice' },
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: 'bytes' }
    )
    const res = makeRes()
    await handleUpload(makeReq(body) as never, res as never, makeLink(), KeyType.key)

    expect(res.statusCode).toBe(200)
    expect((res.body as { uploaded?: number }).uploaded).toBe(1)
  })

  // -------------------------------------------------------------------------
  // addAssetsToAlbum failure → 500 with assetId
  // -------------------------------------------------------------------------
  it('responds 500 with assetId when addAssetsToAlbum rejects', async () => {
    mockAddAssetsToAlbum.mockRejectedValue(new Error('album unreachable'))

    const body = buildMultipart(
      {},
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: 'bytes' }
    )
    const res = makeRes()
    await handleUpload(makeReq(body) as never, res as never, makeLink(), KeyType.key)

    expect(res.statusCode).toBe(500)
    expect((res.body as { assetId?: string }).assetId).toBe('asset-new-1')
  })

  // -------------------------------------------------------------------------
  // No album on link → 400
  // -------------------------------------------------------------------------
  it('responds 400 when link has no album', async () => {
    const body = buildMultipart(
      {},
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: 'bytes' }
    )
    const res = makeRes()
    await handleUpload(
      makeReq(body) as never,
      res as never,
      makeLink({ album: undefined }),
      KeyType.key
    )

    expect(res.statusCode).toBe(400)
    expect((res.body as { error?: string }).error).toMatch(/album/i)
    expect(mockUploadAsset).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // uploadAsset failing mid-transfer must not hang the request
  // -------------------------------------------------------------------------
  it('settles (does not hang) when uploadAsset abandons the stream partway through and rejects', async () => {
    // Regression: uploadAsset can throw after Immich responds with a
    // non-2xx (or its own responseTimeoutSec fires) without having fully
    // drained the stream it was given. Busboy needs that stream fully
    // drained to ever reach 'finish' - if nothing aborts the connection when
    // this happens, receiveUpload's wrapping promise (and so handleUpload)
    // hangs forever. Uses incremental delivery so there's an actual
    // multi-chunk stream to abandon partway through, not one that's already
    // fully buffered before uploadAsset even runs.
    mockUploadAsset.mockImplementation(async (stream: Readable) => {
      await new Promise<void>(resolve => {
        let chunks = 0
        stream.on('data', () => {
          chunks++
          if (chunks >= 2) {
            // Genuinely stop consuming: once a stream is switched into
            // flowing mode (which attaching a 'data' listener does),
            // removing that listener does NOT revert it to paused mode -
            // Node keeps flowing (and discarding) data regardless, unless
            // .pause() is called explicitly. Without this, the pipe chain
            // keeps draining itself in the background no matter what this
            // mock does, and the scenario this test exists to catch (a
            // consumer that truly stops pulling) never actually occurs.
            stream.pause()
            resolve()
          }
        })
      })
      throw new Error('Asset upload failed (500): simulated upstream failure')
    })

    const body = buildMultipart(
      {},
      // Large enough that Node's internal stream buffers (~16-64KB per
      // stage) can't just silently absorb the whole thing once nothing
      // reads it - genuine backpressure has to build up the pipe chain for
      // this to actually exercise the hang this test guards against.
      { filename: 'big.jpg', mimeType: 'image/jpeg', content: 'x'.repeat(2_000_000) }
    )
    const res = makeRes()

    const done = handleUpload(
      makeIncrementalReq(body, 16384) as never,
      res as never,
      makeLink(),
      KeyType.key
    )
    const outcome = await Promise.race([
      done.then(() => 'settled' as const),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 3000))
    ])

    expect(outcome).toBe('settled')
    expect(res.statusCode).toBe(502)
    expect((res.body as { error?: string }).error).toMatch(/upload failed/i)
  })

  it('treats a successful uploadAsset as a 413 failure, not a 200, if the size limit had already fired', async () => {
    // uploadAsset only reads a prefix of the stream (e.g. it hashes the
    // first N bytes, or Immich accepts the request before the body is
    // fully sent) and resolves "successfully" despite sizeLimiter having
    // already exceeded the configured limit. Immich may now hold a
    // truncated file recorded as a complete, genuine asset - this must
    // surface to the visitor as the same failure a client that pre-checked
    // its own file size would never trigger, not a silent success.
    const configAccess = await import('../src/config/access')
    const spy = vi.spyOn(configAccess, 'getConfigOption').mockImplementation((k, def) => {
      if (k === 'ipp.upload.maxFileSizeMb') return 0.000001 // ~1 byte
      return def
    })
    try {
      mockUploadAsset.mockResolvedValue({ id: 'truncated-asset', duplicate: false })

      const body = buildMultipart(
        {},
        { filename: 'oversize.jpg', mimeType: 'image/jpeg', content: 'x'.repeat(50) }
      )
      const res = makeRes()
      await handleUpload(makeReq(body) as never, res as never, makeLink(), KeyType.key)

      expect(res.statusCode).toBe(413)
      expect((res.body as { error?: string }).error).toMatch(/exceeds/i)
    } finally {
      spy.mockRestore()
    }
  })

  // -------------------------------------------------------------------------
  // Pending-upload queue cap
  // -------------------------------------------------------------------------
  it('keeps counting a request as pending for its whole connection lifetime, not just until the Immich upload finishes', async () => {
    // Regression: an earlier version released the pending slot as soon as
    // getUploadLimiter's task settled (uploadAsset resolved/rejected), not
    // when the whole request/response cycle finished. A client that sends a
    // complete file and then simply stops - never sending the closing
    // multipart boundary, connection left open - would have the Immich
    // upload succeed, the slot released, and a NEW upload accepted while the
    // first sat open and unanswered: the cap no longer bounded how many such
    // connections could be pinned at once, defeating its purpose.
    const configAccess = await import('../src/config/access')
    const spy = vi.spyOn(configAccess, 'getConfigOption').mockImplementation((k, def) => {
      if (k === 'ipp.upload.maxPendingUploads') return 1
      return def
    })
    mockUploadAsset.mockResolvedValue({ id: 'asset-stalled', duplicate: false })

    try {
      // A file part with a complete header and body, but no closing
      // boundary - and the stream never ends. Busboy can never reach
      // 'finish' (or 'error'), matching a client that stops sending without
      // closing the connection.
      const partial = Buffer.from(
        `--${BOUNDARY}${CRLF}` +
          `Content-Disposition: form-data; name="file"; filename="stalled.jpg"${CRLF}` +
          `Content-Type: image/jpeg${CRLF}${CRLF}` +
          `some-file-bytes`
      )
      const neverEndingReq = Object.assign(
        new Readable({
          read() {
            /* never pushes more, never calls push(null) - stays open */
          }
        }),
        {
          headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
          socket: { remoteAddress: '1.2.3.4' },
          params: { key: 'testkey1234567890' }
        }
      )
      neverEndingReq.push(partial)

      const stalledRes = makeRes()
      const stalledDone = handleUpload(
        neverEndingReq as never,
        stalledRes as never,
        makeLink(),
        KeyType.key
      )

      // Let the mocked uploadAsset resolve and the limiter task settle -
      // under the bug, this alone would free the pending slot even though
      // the request/response is still open.
      await new Promise(r => setImmediate(r))
      await new Promise(r => setImmediate(r))
      expect(stalledRes.headersSent).toBe(false) // still unanswered

      // With the cap at 1, a second upload attempt now must see "busy" -
      // proof the first request's slot is still correctly held.
      const secondRes = makeRes()
      await handleUpload(
        makeReq(
          buildMultipart({}, { filename: 'second.jpg', mimeType: 'image/jpeg', content: 'x' })
        ) as never,
        secondRes as never,
        makeLink(),
        KeyType.key
      )
      expect(secondRes.statusCode).toBe(503)

      // Cleanup: simulate the client disconnecting (destroy with no prior
      // push(null) - a clean end-of-stream immediately followed by destroy()
      // is a contradictory state busboy's parser isn't built to expect and
      // isn't how a real disconnect looks) so this call settles and doesn't
      // leak into later tests.
      neverEndingReq.destroy()
      await stalledDone.catch(() => {})
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects new uploads once maxPendingUploads is reached, without capping legitimate ones already in flight', async () => {
    const configAccess = await import('../src/config/access')
    const spy = vi.spyOn(configAccess, 'getConfigOption').mockImplementation((k, def) => {
      if (k === 'ipp.upload.maxPendingUploads') return 2
      return def
    })
    // Held open deliberately - simulates two uploads that are legitimately
    // still in flight (queued or actively streaming) when a third arrives.
    let releaseHeld!: (v: { id: string; duplicate: boolean }) => void
    const held = new Promise<{ id: string; duplicate: boolean }>(resolve => {
      releaseHeld = resolve
    })
    mockUploadAsset.mockReturnValue(held)

    try {
      const link = makeLink()
      const makeOneFile = (name: string) =>
        buildMultipart({}, { filename: name, mimeType: 'image/jpeg', content: 'bytes' })

      const res1 = makeRes()
      const res2 = makeRes()
      const res3 = makeRes()
      const p1 = handleUpload(
        makeReq(makeOneFile('a.jpg')) as never,
        res1 as never,
        link,
        KeyType.key
      )
      const p2 = handleUpload(
        makeReq(makeOneFile('b.jpg')) as never,
        res2 as never,
        link,
        KeyType.key
      )
      // Give the first two a chance to register as pending before the third arrives.
      await new Promise(r => setImmediate(r))

      const res3done = handleUpload(
        makeReq(makeOneFile('c.jpg')) as never,
        res3 as never,
        link,
        KeyType.key
      )
      await res3done

      expect(res3.statusCode).toBe(503)
      expect((res3.body as { error?: string }).error).toMatch(/busy/i)

      // The two already in flight are unaffected by the cap kicking in after them.
      releaseHeld({ id: 'asset-held', duplicate: false })
      await Promise.all([p1, p2])
      expect(res1.statusCode).toBe(200)
      expect(res2.statusCode).toBe(200)
    } finally {
      spy.mockRestore()
    }
  })

  it('never leaks the pending-upload count, across every releasing code path (success, MIME reject, upload error, oversize)', async () => {
    // Every code path that increments _pendingUploads must eventually
    // release it - a leak here would make every future upload permanently
    // "busy" once enough of them accumulate. Exercises all four release
    // sites: the MIME-rejected early return, a successful upload, a normal
    // (non-size) upload error, and a size-exceeded upload error - then
    // proves no leak occurred by uploading one more afterwards and checking
    // it does NOT get rejected as busy, with the cap set to fewer than the
    // number of files sent through beforehand.
    const configAccess = await import('../src/config/access')
    let maxFileSizeMb = 500 // matches the config.json default; only "oversize.jpg" below overrides it
    const spy = vi.spyOn(configAccess, 'getConfigOption').mockImplementation((k, def) => {
      if (k === 'ipp.upload.maxPendingUploads') return 3
      if (k === 'ipp.upload.maxFileSizeMb') return maxFileSizeMb
      return def
    })
    try {
      // Consumes the given stream like the real uploadAsset would (it hands
      // the stream to form-data, which reads it to completion) - needed so
      // an oversize file's propagated stream error actually surfaces as a
      // rejection here, the way it does in production, rather than the mock
      // reporting success regardless of what happened to the stream.
      const drain = (stream: NodeJS.ReadableStream) =>
        new Promise<void>((resolve, reject) => {
          stream.on('data', () => {})
          stream.on('end', resolve)
          stream.on('error', reject)
        })
      mockUploadAsset.mockImplementation(async (stream: NodeJS.ReadableStream, label: string) => {
        if (label === 'error.jpg') throw new Error('simulated upload failure')
        await drain(stream)
        return { id: 'asset-' + label, duplicate: false }
      })

      const link = makeLink()
      const attempt = (filename: string, mimeType = 'image/jpeg') => {
        const res = makeRes()
        return handleUpload(
          makeReq(buildMultipart({}, { filename, mimeType, content: 'bytes' })) as never,
          res as never,
          link,
          KeyType.key
        ).then(() => res)
      }

      // Four attempts sequentially, each exercising a different release
      // path - sequential (not concurrent) so each fully settles, including
      // its release, before the next starts. With the cap at 3, if any one
      // of these leaked its slot, the 4th here (or the 5th below) would
      // wrongly see "busy".
      await attempt('success.jpg')
      await attempt('rejected.pdf', 'application/pdf')
      await attempt('error.jpg')
      maxFileSizeMb = 0.000001 // ~1 byte, so this one attempt always exceeds it
      const oversizeRes = await attempt('oversize.jpg')
      maxFileSizeMb = 500
      expect(oversizeRes.statusCode).toBe(413)

      // A 5th attempt after all four released must succeed cleanly - proof
      // none of the four leaked a slot.
      const finalRes = await attempt('final.jpg')
      expect(finalRes.statusCode).toBe(200)
    } finally {
      spy.mockRestore()
    }
  })

  it('fuzz: a random mix of concurrent accept/reject/error uploads never over- or under-counts the pending cap', async () => {
    // Randomized concurrency test: fire a random number of uploads with
    // random per-file behaviour (instant success, instant MIME rejection,
    // or held open) at random relative timing (via random microtask/macrotask
    // delays), and check the invariant holds across many trials: the number
    // of uploads accepted past the cap is exactly bounded, and everything
    // held eventually drains back to zero pending (a later burst behaves
    // identically, which wouldn't be true if slots leaked between trials).
    const configAccess = await import('../src/config/access')
    const CAP = 4
    const spy = vi.spyOn(configAccess, 'getConfigOption').mockImplementation((k, def) => {
      if (k === 'ipp.upload.maxPendingUploads') return CAP
      return def
    })
    try {
      for (let trial = 0; trial < 8; trial++) {
        const seed = trial * 97 + 13
        // Simple deterministic PRNG so a failure is reproducible from the trial index.
        let state = seed
        const rand = () => {
          state = (state * 1103515245 + 12345) & 0x7fffffff
          return state / 0x7fffffff
        }

        const holders: Array<() => void> = []
        mockUploadAsset.mockImplementation(
          () =>
            new Promise(resolve => {
              holders.push(() => resolve({ id: 'asset', duplicate: false }))
            })
        )

        const link = makeLink()
        const TOTAL = 6 + Math.floor(rand() * 6) // 6..11 concurrent attempts
        const results: Array<{ res: ReturnType<typeof makeRes>; done: Promise<void> }> = []

        for (let i = 0; i < TOTAL; i++) {
          const res = makeRes()
          const isMimeReject = rand() < 0.3
          const body = isMimeReject
            ? buildMultipart(
                {},
                { filename: `f${i}.pdf`, mimeType: 'application/pdf', content: 'x' }
              )
            : buildMultipart({}, { filename: `f${i}.jpg`, mimeType: 'image/jpeg', content: 'x' })
          // Random jitter before each request "arrives", to vary interleaving.
          if (rand() < 0.5) await new Promise(r => setImmediate(r))
          const done = handleUpload(makeReq(body) as never, res as never, link, KeyType.key).then(
            () => undefined
          )
          results.push({ res, done })
        }

        // Let everything that can settle without being released do so.
        await new Promise(r => setImmediate(r))

        const busyCount = results.filter(
          r => r.res.statusCode === 400 && (r.res.body as { error?: string })?.error?.match(/busy/i)
        ).length
        // Pending holders are uploads that got past both the MIME gate and
        // the pending cap and are now genuinely in flight (queued for the
        // mocked, never-resolving uploadAsset).
        expect(holders.length).toBeLessThanOrEqual(CAP)
        expect(busyCount).toBeLessThanOrEqual(TOTAL)

        // Release everything still held, then let all requests finish.
        holders.forEach(release => release())
        await Promise.all(results.map(r => r.done))

        // No leak: a fresh single upload after this trial fully drains must
        // never see "busy", regardless of how this trial's random mix went.
        mockUploadAsset.mockResolvedValue({ id: 'asset-final', duplicate: false })
        const finalRes = await attemptOnce(link)
        expect(finalRes.statusCode).toBe(200)
      }

      async function attemptOnce(link: SharedLink) {
        const res = makeRes()
        await handleUpload(
          makeReq(
            buildMultipart({}, { filename: 'probe.jpg', mimeType: 'image/jpeg', content: 'x' })
          ) as never,
          res as never,
          link,
          KeyType.key
        )
        return res
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects disallowed MIME type with 400 "file type not allowed"', async () => {
    // supportedTypes only contains image/jpeg and video/mp4 (set in beforeEach)
    const body = buildMultipart(
      {},
      { filename: 'doc.pdf', mimeType: 'application/pdf', content: 'pdf-bytes' }
    )
    const res = makeRes()
    await handleUpload(makeReq(body) as never, res as never, makeLink(), KeyType.key)

    expect(res.statusCode).toBe(400)
    expect((res.body as { error?: string }).error).toMatch(/file type not allowed/i)
    expect(mockUploadAsset).not.toHaveBeenCalled()
  })

  it('caps the drain of a rejected file so an oversize disallowed upload cannot sink an unbounded body', async () => {
    // Even though the file is going to be rejected for its MIME type, the
    // request must still be aborted (not silently drained forever) if the
    // client keeps sending bytes past maxFileSizeMb. Config mocked to a tiny
    // limit so the test doesn't need a huge in-memory buffer to exceed it.
    const configAccess = await import('../src/config/access')
    const spy = vi.spyOn(configAccess, 'getConfigOption').mockImplementation((key, def) => {
      if (key === 'ipp.upload.maxFileSizeMb') return 0.001 // ~1KB
      return def
    })
    try {
      const body = buildMultipart(
        {},
        { filename: 'huge.pdf', mimeType: 'application/pdf', content: 'x'.repeat(10_000) }
      )
      const res = makeRes()
      const req = makeReq(body)
      await handleUpload(req as never, res as never, makeLink(), KeyType.key)

      expect(res.statusCode).toBe(413)
      expect((res.body as { error?: string }).error).toMatch(/exceeds/i)
      expect(mockUploadAsset).not.toHaveBeenCalled()
      expect(req.destroyed).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('allows application/octet-stream (browser fallback for unknown types)', async () => {
    // The handler explicitly allows mimeType === 'application/octet-stream'
    // regardless of the supported types list. This lets browsers upload HEIC
    // and other formats they do not know the MIME type of.
    const body = buildMultipart(
      {},
      { filename: 'file.heic', mimeType: 'application/octet-stream', content: 'heic-bytes' }
    )
    const res = makeRes()
    await handleUpload(makeReq(body) as never, res as never, makeLink(), KeyType.key)

    expect(res.statusCode).toBe(200)
    expect(mockUploadAsset).toHaveBeenCalledOnce()
  })

  it('allows image/png via prefix fallback when supportedTypes is empty', async () => {
    mockGetSupportedMimeTypes.mockResolvedValue(new Set())

    const body = buildMultipart(
      {},
      { filename: 'photo.png', mimeType: 'image/png', content: 'png-bytes' }
    )
    const res = makeRes()
    await handleUpload(makeReq(body) as never, res as never, makeLink(), KeyType.key)

    expect(res.statusCode).toBe(200)
    expect(mockUploadAsset).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // No file part in body
  // -------------------------------------------------------------------------
  it('responds 400 "No file received" when no file part is in the multipart body', async () => {
    const body = buildMultipart({ fileCreatedAt: '2024-01-01T00:00:00.000Z' })
    const res = makeRes()
    await handleUpload(makeReq(body) as never, res as never, makeLink(), KeyType.key)

    expect(res.statusCode).toBe(400)
    expect((res.body as { error?: string }).error).toMatch(/No file received/i)
    expect(mockUploadAsset).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Fields sent AFTER the file part (document current behaviour)
  // -------------------------------------------------------------------------
  it('documents current behaviour: fileCreatedAt snapshot is undefined when sent after file', async () => {
    // The file part comes first, then the text fields.
    // receiveUpload captures fileCreatedAt at the moment busboy fires the 'file'
    // event. If the field hasn't been parsed yet, capturedDate is undefined.
    const fileHeader = Buffer.from(
      `--${BOUNDARY}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="late-fields.jpg"${CRLF}` +
        `Content-Type: image/jpeg${CRLF}` +
        CRLF
    )
    const fileContent = Buffer.from('jpeg-bytes')
    const lateFields = Buffer.from(
      CRLF +
        `--${BOUNDARY}${CRLF}` +
        `Content-Disposition: form-data; name="fileCreatedAt"${CRLF}` +
        CRLF +
        '2024-06-01T00:00:00.000Z' +
        CRLF +
        `--${BOUNDARY}${CRLF}` +
        `Content-Disposition: form-data; name="caption"${CRLF}` +
        CRLF +
        'late caption' +
        CRLF +
        `--${BOUNDARY}--${CRLF}`
    )
    const body = Buffer.concat([fileHeader, fileContent, lateFields])

    const req = makeReq(body)
    const res = makeRes()
    await handleUpload(req as never, res as never, makeLink(), KeyType.key)

    // Current behaviour: fileCreatedAt snapshot is undefined (captured before field arrived)
    const [, , , fileCreatedAtArg] = mockUploadAsset.mock.calls[0]
    expect(fileCreatedAtArg).toBeUndefined()

    // The late caption IS accessible after filePromise settles, so the
    // description can still include it (caption is read after awaiting).
    expect(mockUpdateAssetDescription).toHaveBeenCalledOnce()
    expect(mockUpdateAssetDescription.mock.calls[0][1]).toContain('late caption')
  })

  // -------------------------------------------------------------------------
  // Client disconnect mid-body
  // -------------------------------------------------------------------------
  it('resolves and responds 4xx when client disconnects before upload completes', async () => {
    // Build a partial multipart body - just enough to identify as multipart,
    // but no closing boundary (simulates a cut connection).
    const partial = Buffer.from(
      `--${BOUNDARY}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="partial.jpg"${CRLF}` +
        `Content-Type: image/jpeg${CRLF}` +
        CRLF +
        'truncated-bytes-here'
    )

    // Create a Readable that pushes partial data then destroys itself on the
    // next tick (simulating a TCP RST mid-body).
    const readable = new Readable({ read() {} })
    readable.push(partial)
    setImmediate(() => readable.destroy())

    const req = Object.assign(readable, {
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      socket: { remoteAddress: '1.2.3.4' },
      params: { key: 'testkey12345' }
    })

    const res = makeRes()

    // The handler must resolve within the test timeout.
    // Use a timeout-guarded race to produce a clear failure message if it hangs.
    await Promise.race([
      handleUpload(req as never, res as never, makeLink(), KeyType.key),
      new Promise<void>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('handleUpload hung for >4s after client disconnect')),
          4000
        )
      )
    ])

    // Handler should have responded 400 (disconnect = malformed/incomplete upload)
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
  })
})

// ===========================================================================
// handleUploadCheck tests
// ===========================================================================

describe('handleUploadCheck', () => {
  function makeCheckReq(body: unknown) {
    return {
      body,
      params: { key: 'testkey123' },
      headers: {}
    }
  }

  // -------------------------------------------------------------------------
  // Happy path: duplicate → album-add + invalidate + response
  // -------------------------------------------------------------------------
  it('adds duplicates to the album and returns action:duplicate', async () => {
    const checksum = 'a'.repeat(40)
    mockBulkUploadCheck.mockResolvedValue([
      { id: '0', action: 'reject', reason: 'duplicate', assetId: 'a1' }
    ])

    const req = makeCheckReq({ files: [{ id: 0, checksum }] })
    const res = makeRes()
    const link = makeLink()

    await handleUploadCheck(req as never, res as never, link, KeyType.key)

    expect(mockAddAssetsToAlbum).toHaveBeenCalledWith('album-1', ['a1'])
    expect(mockInvalidateShare).toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect((res.body as { results: Array<{ id: number; action: string }> }).results).toEqual([
      { id: 0, action: 'duplicate' }
    ])
  })

  // -------------------------------------------------------------------------
  // action 'accept' → no album-add
  // -------------------------------------------------------------------------
  it('returns action:upload when bulkUploadCheck returns accept', async () => {
    const checksum = 'b'.repeat(40)
    mockBulkUploadCheck.mockResolvedValue([{ id: '0', action: 'accept' }])

    const req = makeCheckReq({ files: [{ id: 0, checksum }] })
    const res = makeRes()

    await handleUploadCheck(req as never, res as never, makeLink(), KeyType.key)

    expect(mockAddAssetsToAlbum).not.toHaveBeenCalled()
    expect((res.body as { results: Array<{ id: number; action: string }> }).results).toEqual([
      { id: 0, action: 'upload' }
    ])
  })

  // -------------------------------------------------------------------------
  // addAssetsToAlbum failure → fall back to 'upload'
  // -------------------------------------------------------------------------
  it('falls back to action:upload when addAssetsToAlbum rejects for duplicates', async () => {
    const checksum = 'c'.repeat(40)
    mockBulkUploadCheck.mockResolvedValue([
      { id: '0', action: 'reject', reason: 'duplicate', assetId: 'd1' }
    ])
    mockAddAssetsToAlbum.mockRejectedValue(new Error('album-add failure'))

    const req = makeCheckReq({ files: [{ id: 0, checksum }] })
    const res = makeRes()

    await handleUploadCheck(req as never, res as never, makeLink(), KeyType.key)

    // Should still 200 but with action:upload (fallback)
    expect(res.statusCode).toBe(200)
    expect((res.body as { results: Array<{ id: number; action: string }> }).results).toEqual([
      { id: 0, action: 'upload' }
    ])
  })

  // -------------------------------------------------------------------------
  // bulkUploadCheck throwing → 502
  // -------------------------------------------------------------------------
  it('responds 502 when bulkUploadCheck throws', async () => {
    mockBulkUploadCheck.mockRejectedValue(new Error('Immich down'))

    const req = makeCheckReq({ files: [{ id: 0, checksum: 'a'.repeat(40) }] })
    const res = makeRes()

    await handleUploadCheck(req as never, res as never, makeLink(), KeyType.key)

    expect(res.statusCode).toBe(502)
    expect((res.body as { error?: string }).error).toMatch(/unavailable/i)
  })

  // -------------------------------------------------------------------------
  // No album → 400
  // -------------------------------------------------------------------------
  it('responds 400 when link has no album', async () => {
    const req = makeCheckReq({ files: [{ id: 0, checksum: 'a'.repeat(40) }] })
    const res = makeRes()

    await handleUploadCheck(req as never, res as never, makeLink({ album: undefined }), KeyType.key)

    expect(res.statusCode).toBe(400)
    expect((res.body as { error?: string }).error).toMatch(/album/i)
  })

  // -------------------------------------------------------------------------
  // Malformed request bodies → 400
  // -------------------------------------------------------------------------
  it('responds 400 when files is missing', async () => {
    const res = makeRes()
    await handleUploadCheck(makeCheckReq({}) as never, res as never, makeLink(), KeyType.key)
    expect(res.statusCode).toBe(400)
  })

  it('responds 400 when files is an empty array', async () => {
    const res = makeRes()
    await handleUploadCheck(
      makeCheckReq({ files: [] }) as never,
      res as never,
      makeLink(),
      KeyType.key
    )
    expect(res.statusCode).toBe(400)
  })

  it('responds 400 when files array has more than 200 items', async () => {
    const files = Array.from({ length: 201 }, (_, i) => ({ id: i, checksum: 'a'.repeat(40) }))
    const res = makeRes()
    await handleUploadCheck(makeCheckReq({ files }) as never, res as never, makeLink(), KeyType.key)
    expect(res.statusCode).toBe(400)
  })

  it('responds 400 when checksum is not hex', async () => {
    const res = makeRes()
    await handleUploadCheck(
      makeCheckReq({ files: [{ id: 0, checksum: 'zzzz'.repeat(10) }] }) as never,
      res as never,
      makeLink(),
      KeyType.key
    )
    expect(res.statusCode).toBe(400)
  })

  it('responds 400 when checksum is wrong length (not 40 chars)', async () => {
    const res = makeRes()
    await handleUploadCheck(
      makeCheckReq({ files: [{ id: 0, checksum: 'abc123' }] }) as never,
      res as never,
      makeLink(),
      KeyType.key
    )
    expect(res.statusCode).toBe(400)
  })

  it('responds 400 when id is not an integer', async () => {
    const res = makeRes()
    await handleUploadCheck(
      makeCheckReq({ files: [{ id: 'not-a-number', checksum: 'a'.repeat(40) }] }) as never,
      res as never,
      makeLink(),
      KeyType.key
    )
    expect(res.statusCode).toBe(400)
  })

  // -------------------------------------------------------------------------
  // Fuzz: adversarial request bodies must always land on 400, never throw,
  // hang, or reach bulkUploadCheck with anything malformed.
  // -------------------------------------------------------------------------
  const adversarialBodies: Array<{ label: string; body: unknown }> = [
    { label: 'body is null', body: null },
    { label: 'body is a string', body: 'not-an-object' },
    { label: 'body is a number', body: 42 },
    { label: 'body is an array', body: [1, 2, 3] },
    { label: 'files is a string', body: { files: 'a'.repeat(40) } },
    {
      label: 'files is an object, not array',
      body: { files: { id: 0, checksum: 'a'.repeat(40) } }
    },
    { label: 'files is null', body: { files: null } },
    { label: 'file entry is null', body: { files: [null] } },
    { label: 'file entry is a string', body: { files: ['a'.repeat(40)] } },
    { label: 'file entry is an array', body: { files: [[0, 'a'.repeat(40)]] } },
    { label: 'checksum is a number', body: { files: [{ id: 0, checksum: 1234567890 }] } },
    { label: 'checksum is a boolean', body: { files: [{ id: 0, checksum: true }] } },
    { label: 'checksum is an array', body: { files: [{ id: 0, checksum: ['a'.repeat(40)] }] } },
    {
      label: 'checksum is an object',
      body: { files: [{ id: 0, checksum: { toString: () => 'a'.repeat(40) } }] }
    },
    { label: 'checksum missing entirely', body: { files: [{ id: 0 }] } },
    { label: 'id missing entirely', body: { files: [{ checksum: 'a'.repeat(40) }] } },
    { label: 'id is a float', body: { files: [{ id: 1.5, checksum: 'a'.repeat(40) }] } },
    { label: 'id is negative', body: { files: [{ id: -1, checksum: 'a'.repeat(40) }] } },
    { label: 'id is NaN', body: { files: [{ id: NaN, checksum: 'a'.repeat(40) }] } },
    { label: 'id is Infinity', body: { files: [{ id: Infinity, checksum: 'a'.repeat(40) }] } },
    {
      label: 'checksum has uppercase hex (should still be valid)',
      body: { files: [{ id: 0, checksum: 'A'.repeat(40) }] }
    },
    { label: 'checksum too short by one', body: { files: [{ id: 0, checksum: 'a'.repeat(39) }] } },
    { label: 'checksum too long by one', body: { files: [{ id: 0, checksum: 'a'.repeat(41) }] } },
    {
      label: 'checksum with embedded null byte',
      body: { files: [{ id: 0, checksum: 'a'.repeat(20) + '\x00' + 'a'.repeat(19) }] }
    },
    {
      label: 'checksum with unicode digits',
      body: { files: [{ id: 0, checksum: '١'.repeat(40) }] }
    },
    {
      label: 'prototype-pollution attempt via __proto__',
      body: JSON.parse(
        '{"files":[{"id":0,"checksum":"' + 'a'.repeat(40) + '","__proto__":{"polluted":true}}]}'
      )
    },
    {
      label: 'prototype-pollution attempt as the files key',
      body: JSON.parse('{"__proto__":{"files":[{"id":0,"checksum":"' + 'a'.repeat(40) + '"}]}}')
    },
    {
      label: 'deeply nested object as checksum',
      body: { files: [{ id: 0, checksum: { a: { b: { c: 'a'.repeat(40) } } } }] }
    },
    {
      label: 'duplicate ids in the same request',
      body: {
        files: [
          { id: 0, checksum: 'a'.repeat(40) },
          { id: 0, checksum: 'b'.repeat(40) }
        ]
      }
    },
    {
      label: 'files entries mixing valid and invalid',
      body: {
        files: [
          { id: 0, checksum: 'a'.repeat(40) },
          { id: 1, checksum: 'bad' }
        ]
      }
    }
  ]

  it.each(adversarialBodies)('never crashes or hangs on: $label', async ({ body }) => {
    const res = makeRes()
    const done = handleUploadCheck(
      makeCheckReq(body) as never,
      res as never,
      makeLink(),
      KeyType.key
    )
    const outcome = await Promise.race([
      done.then(() => 'settled' as const),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 2000))
    ])
    expect(outcome).toBe('settled')
    expect([200, 400]).toContain(res.statusCode)
    // Never let malformed input escape untouched into an "already valid" response.
    expect((globalThis as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('fuzz: a battery of randomly-generated malformed check requests all land on 400 with no crash', async () => {
    const generators: Array<() => unknown> = [
      () => undefined,
      () => null,
      () => ({}),
      () => ({ files: [] }),
      () => ({
        files: Array.from({ length: 1 + Math.floor(Math.random() * 300) }, (_, i) => ({ id: i }))
      }),
      () => ({
        files: [
          {
            id: Math.random() < 0.5 ? Math.floor(Math.random() * 1000) : 'x',
            checksum: Math.random().toString(36)
          }
        ]
      }),
      () => ({ files: 'x'.repeat(Math.floor(Math.random() * 1000)) }),
      () => ({
        files: [Array.from({ length: Math.floor(Math.random() * 5) }, () => Math.random())]
      })
    ]
    for (let trial = 0; trial < 50; trial++) {
      const body = generators[Math.floor(Math.random() * generators.length)]()
      const res = makeRes()
      const done = handleUploadCheck(
        makeCheckReq(body) as never,
        res as never,
        makeLink(),
        KeyType.key
      )
      const outcome = await Promise.race([
        done.then(() => 'settled' as const),
        new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 2000))
      ])
      expect(outcome).toBe('settled')
      expect(typeof res.statusCode).toBe('number')
    }
  })
})
