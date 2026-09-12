import Busboy from '@fastify/busboy'
import { Readable } from 'stream'
import { Request, Response } from 'express-serve-static-core'
import {
  addAssetsToAlbum,
  bulkUploadCheck,
  getSupportedMimeTypes,
  getUploadCheckLimiter,
  getUploadLimiter,
  invalidateShare,
  tagAssetWithUploader,
  updateAssetDescription,
  uploadAsset
} from '../immich'
import { KeyType, SharedLink } from '../types'
import { UploadCheckResponse, UploadResponse } from '../shared/types'
import { getConfigOption } from '../config/access'
import { log } from '../utils/log'
import { createIdleTimeoutStream } from '../utils/idleTimeoutStream'
import { sanitizeCaption, sanitizeUploaderName } from './sanitize'
import { createSizeLimitStream } from './sizeLimitStream'
import { logAbuse } from '../utils/abuseLog'

// Total uploads currently being received - whether actively streaming to
// Immich or still queued behind getUploadLimiter's concurrentUploads cap -
// across all visitors and shares. The limiter bounds concurrent Immich
// calls, but its queue is otherwise unbounded: a visitor whose upload never
// finishes (sends a small valid-looking file, then goes idle) sits queued
// forever with no idle timeout of its own (see the idle-timeout comment
// below for why arming one there would kill legitimate long queue waits at
// a busy event). Nothing stops an attacker from opening far more connections
// than concurrentUploads and holding each one queued this way indefinitely.
// This caps how many can be pinned at once; past the cap, new upload
// attempts are rejected immediately (503) instead of accepted and queued.
let _pendingUploads = 0
function maxPendingUploads(): number {
  return Math.max(1, Number(getConfigOption('ipp.upload.maxPendingUploads', 50)) || 50)
}

/**
 * Result of receiving one multipart upload and streaming it to Immich.
 * `responded: true` means receiveUpload already sent a response (the
 * oversize path must respond before destroying the shared socket - see
 * the comment at that site) and the caller must not respond again.
 */
type ReceiveOutcome =
  | { ok: true; assetId: string; duplicate: boolean; caption?: string; uploaderName?: string }
  | { ok: false; status: number; error: string; responded?: boolean }

/**
 * Every upload response goes through here so tsc enforces the shared
 * UploadResponse contract (res.json alone accepts `any`).
 */
function respond(res: Response, status: number, body: UploadResponse) {
  res.status(status).json(body)
}

function respondCheck(res: Response, status: number, body: UploadCheckResponse) {
  res.status(status).json(body)
}

/**
 * Pre-upload duplicate check for an already-validated share link.
 *
 * The client sends SHA-1 checksums of the files it is about to upload; Immich
 * reports which already exist. For those, this handler adds the existing
 * asset to the album server-side and tells the client to skip the byte
 * transfer entirely.
 *
 * SECURITY: the client never supplies asset IDs, only checksums, and the IDs
 * added to the album come exclusively from Immich's own checksum lookup - so
 * accepting client-sent IDs here (which would let anyone add ANY asset in
 * the library, sight unseen) is specifically ruled out. That said, a
 * checksum alone is a weaker bar than "possesses the file content" might
 * suggest: bulk-upload-check is scoped to the API-key user's whole library
 * (not just this album), so a visitor who merely knows a file's SHA-1 - e.g.
 * a photo they've seen published elsewhere, or previously sent to the
 * owner - gets a yes/no "does the owner have this exact file" oracle, and a
 * hit pulls that asset (with its EXIF/description) into the public album.
 * There's no cheap server-side fix for this without narrowing what Immich's
 * own endpoint checks against; see the security notes in docs/uploads.md.
 */
export async function handleUploadCheck(
  req: Request,
  res: Response,
  link: SharedLink,
  keyType: KeyType
) {
  if (!link.album?.id) {
    respondCheck(res, 400, { error: 'Upload requires an album share' })
    return
  }

  const files: unknown = req.body?.files
  if (!Array.isArray(files) || files.length === 0 || files.length > 200) {
    logAbuse('upload-check-malformed', req)
    respondCheck(res, 400, { error: 'Malformed check request' })
    return
  }
  const items: Array<{ id: string; checksum: string }> = []
  for (const f of files) {
    const id = Number((f as { id?: unknown })?.id)
    const checksum = (f as { checksum?: unknown })?.checksum
    if (
      !Number.isInteger(id) ||
      typeof checksum !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(checksum)
    ) {
      logAbuse('upload-check-malformed', req)
      respondCheck(res, 400, { error: 'Malformed check request' })
      return
    }
    items.push({ id: String(id), checksum })
  }

  let results: Awaited<ReturnType<typeof bulkUploadCheck>>
  try {
    // Own limiter, not the upload one: a burst of visitors opening the
    // review sheet at once (e.g. right after a ceremony) would otherwise
    // starve every upload slot with cheap JSON round trips, blocking actual
    // file transfers.
    results = await getUploadCheckLimiter()(() => bulkUploadCheck(items))
  } catch (e) {
    log.error('bulk-upload-check failed: ' + (e instanceof Error ? e.message : String(e)))
    respondCheck(res, 502, { error: 'Duplicate check unavailable' })
    return
  }

  const duplicates = results.filter(
    r => r.action === 'reject' && r.reason === 'duplicate' && r.assetId
  )
  const duplicateIds = new Set(duplicates.map(d => d.id))

  if (duplicates.length > 0) {
    try {
      await addAssetsToAlbum(
        link.album.id,
        duplicates.map(d => d.assetId as string)
      )
      // Both calls target the same cache entry today (the bundled client's
      // uploadPath is always built from share.key, never the slug - see
      // gallery/builder.ts), making this a no-op duplicate in practice. Kept
      // as defence-in-depth for a slug-originated request, if one ever
      // reaches here directly: it does NOT currently invalidate a
      // slug-keyed cache entry, since we have no way to recover the
      // original slug from `link` once resolved by key.
      invalidateShare(req.params.key, link.password, keyType)
      invalidateShare(link.key, link.password, KeyType.key)
    } catch (e) {
      // Album-add failed: report these files as needing a normal upload.
      // POST /assets will dedup them by checksum anyway and the per-file
      // album-add path has its own retries - a clean recovery route.
      log.error(
        'Album-add for duplicates failed, falling back to upload: ' +
          (e instanceof Error ? e.message : String(e))
      )
      duplicateIds.clear()
    }
  }

  respondCheck(res, 200, {
    results: items.map(item => ({
      id: Number(item.id),
      action: duplicateIds.has(item.id) ? 'duplicate' : 'upload'
    }))
  })
}

/**
 * Handle an upload request for an already-validated share link.
 *
 * The caller (the route in index.ts) is responsible for share validation:
 * link exists, password satisfied, canUpload passed, album present. This
 * function owns everything after that - multipart parsing, streaming to
 * Immich, album-add, cache invalidation, and the HTTP response.
 *
 * Accepts multipart/form-data with one file part (field "file") and optional
 * text fields "fileCreatedAt" (ISO 8601) and "uploaderName", sent before the
 * binary. Responds with JSON: `{ uploaded: 1, assetId, duplicate }` on
 * success, `{ error }` otherwise.
 *
 * One file per request keeps memory bounded and makes per-file retry
 * straightforward on the client. Files are streamed directly to Immich via a
 * size-limiting Transform - no application-level buffering. A module-level
 * concurrency limiter (ipp.upload.concurrentUploads, default 4) caps
 * simultaneous Immich calls; when the queue is full, backpressure propagates
 * naturally through the TCP stack to the browser.
 */
export async function handleUpload(
  req: Request,
  res: Response,
  link: SharedLink,
  keyType: KeyType
) {
  if (!link.album?.id) {
    respond(res, 400, { error: 'Upload requires an album share' })
    return
  }

  // Held for this call's entire lifetime - not just while queued for an
  // Immich upload slot - since that's how long the connection itself stays
  // open. Checked and incremented here, before any multipart parsing starts,
  // so a client that never gets past the busboy preamble (or that stops
  // sending mid-file, or whose upload fails after Immich has already been
  // contacted) is covered too; the previous version only tracked the narrower
  // "queued or actively uploading to Immich" window, which let all three of
  // those cases pin a connection invisibly to the cap.
  if (_pendingUploads >= maxPendingUploads()) {
    logAbuse('upload-queue-full', req)
    respond(res, 503, { error: 'Server busy, try again shortly' })
    req.destroy()
    return
  }
  _pendingUploads++
  try {
    await handleUploadInner(req, res, link, keyType, link.album.id)
  } finally {
    _pendingUploads--
  }
}

async function handleUploadInner(
  req: Request,
  res: Response,
  link: SharedLink,
  keyType: KeyType,
  albumId: string
) {
  const outcome = await receiveUpload(req, res, albumId)

  if (!outcome.ok) {
    if (!outcome.responded) {
      respond(res, outcome.status, { error: outcome.error })
    }
    return
  }

  // Surface the visitor's caption and/or attribution in the Immich UI via
  // the asset description. Only for newly-created assets - a duplicate's
  // description belongs to the library owner and must not be clobbered.
  // Best-effort: a failure here never fails the upload.
  if (!outcome.duplicate) {
    let description: string | undefined
    if (outcome.caption && outcome.uploaderName) {
      description = `${outcome.caption}\n\n- Uploaded by ${outcome.uploaderName}`
    } else if (outcome.caption) {
      description = outcome.caption
    } else if (outcome.uploaderName) {
      description = `Uploaded by ${outcome.uploaderName}`
    }
    if (description) {
      try {
        await updateAssetDescription(outcome.assetId, description)
      } catch (e) {
        log.warn(
          `Could not set description on asset ${outcome.assetId}: ` +
            (e instanceof Error ? e.message : String(e))
        )
      }
    }
    // Tag the asset `uploaded-by/<name>` so the owner can filter one
    // visitor's uploads in the Immich UI. Best-effort, like the description.
    if (outcome.uploaderName) {
      try {
        await tagAssetWithUploader(outcome.uploaderName, outcome.assetId)
      } catch (e) {
        log.warn(
          `Could not tag asset ${outcome.assetId} for uploader: ` +
            (e instanceof Error ? e.message : String(e))
        )
      }
    }
  }

  try {
    await addAssetsToAlbum(albumId, [outcome.assetId])
  } catch (e) {
    // Always name the orphan: the asset is in the library but not the album,
    // and this line is what an admin greps for to recover it. The asset's
    // own ipp-upload metadata also records the intended albumId.
    log.error(
      `Orphaned upload: asset ${outcome.assetId} could not be added to album ${albumId} after retries: ` +
        (e instanceof Error ? e.message : String(e))
    )
    // Include the assetId so an admin can manually add it in Immich if needed.
    respond(res, 500, {
      error: 'File reached Immich but could not be added to the album after 3 attempts',
      assetId: outcome.assetId
    })
    return
  }

  // Both calls target the same cache entry today (the bundled client's
  // uploadPath is always built from share.key, never the slug - see
  // gallery/builder.ts), making this a no-op duplicate in practice. Kept as
  // defence-in-depth for a slug-originated request, if one ever reaches here
  // directly: it does NOT currently invalidate a slug-keyed cache entry,
  // since we have no way to recover the original slug from `link` once
  // resolved by key - a visitor who loaded the gallery via /s/<slug> may see
  // a stale asset list for up to the share-cache TTL (2 minutes) after
  // uploading, until it expires on its own.
  invalidateShare(req.params.key, link.password, keyType)
  invalidateShare(link.key, link.password, KeyType.key)

  respond(res, 200, { uploaded: 1, assetId: outcome.assetId, duplicate: outcome.duplicate })
}

/**
 * Parse the multipart body and stream the file to Immich. Returns an outcome
 * instead of responding, except for the abort paths (oversize file, too many
 * files) which respond here directly and flag it via `responded` - see
 * `respondAndAbort` below for why.
 */
async function receiveUpload(
  req: Request,
  res: Response,
  albumId: string
): Promise<ReceiveOutcome> {
  const maxFileSizeMb = Number(getConfigOption('ipp.upload.maxFileSizeMb', 500)) || 500
  const maxBytes = maxFileSizeMb * 1024 * 1024

  // Fetch the MIME types Immich accepts. Falls back to an empty Set (which
  // triggers broad prefix matching below) only if Immich is unreachable; the
  // first successful response is cached for the lifetime of the process.
  const supportedTypes = await getSupportedMimeTypes()

  // Audit IPs. The socket address is the only value the client cannot forge;
  // X-Forwarded-For is client-settable and recorded separately as untrusted
  // context (it holds the real client IP when IPP runs behind a reverse
  // proxy such as Tailscale Funnel, and garbage when an attacker sets it).
  const uploaderIp = req.socket.remoteAddress || ''
  const xff = req.headers['x-forwarded-for']
  const forwardedFor =
    (typeof xff === 'string' ? xff : Array.isArray(xff) ? xff.join(', ') : '').slice(0, 200) ||
    undefined

  // Captured from text fields sent before the file binary.
  let fileCreatedAt: string | undefined
  let uploaderName: string | undefined
  let caption: string | undefined
  let uploadedId: string | undefined
  let uploadDuplicate = false
  let uploadError: string | undefined
  let earlyResponse: { status: number; error: string } | undefined
  let filePromise: Promise<void> | undefined

  // Set once the wrapping promise below is constructed, so respondAndAbort
  // can settle it directly instead of trusting busboy/req events to fire.
  let settleAbort: (() => void) | undefined

  // req and res share a socket, so the response has to go out before
  // req.destroy() - nothing can be sent after. Used for the abort paths
  // (oversize file, too many files) that need to kill the request mid-parse.
  const respondAndAbort = (status: number, error: string) => {
    if (!res.headersSent) {
      respond(res, status, { error })
    }
    earlyResponse = { status, error }
    req.destroy()
    // req.destroy() normally surfaces below via req's 'close' handler, which
    // settles the wrapping promise. But if the whole body had already been
    // fully read into req by the time this runs (a small-but-over-the-limit
    // file that arrived in one TCP read is enough to trigger this, not just
    // a legitimately large one), req is already `readableEnded` and busboy's
    // own bookkeeping for the aborted file part never reaches 'finish' or
    // 'error' - nothing would fire and receiveUpload would hang forever,
    // pinning the connection and (with server.requestTimeout disabled) never
    // getting reaped. We already responded and decided to abort, so settle
    // immediately rather than wait on events that may never come.
    settleAbort?.()
  }

  let busboyError: Error | undefined
  try {
    const busboy = Busboy({
      // multipart/form-data always carries a Content-Type header - required
      // to even reach this route (Express selects it by path, not header),
      // and busboy itself needs it to read the boundary. The cast only tells
      // TS what's already runtime-true; @fastify/busboy's stricter header
      // type doesn't allow the optional `content-type` IncomingHttpHeaders has.
      headers: req.headers as typeof req.headers & { 'content-type': string },
      // @fastify/busboy decodes Content-Disposition params (the FILENAME) as
      // UTF-8 by default (unlike upstream busboy, which defaults to latin1
      // for this specifically) - set explicitly anyway so intent survives a
      // future default change. Without it, a non-ASCII filename (日本語,
      // emoji, accents) would reach Immich as mojibake in originalFileName.
      defCharset: 'utf8',
      limits: {
        fields: 6, // generous cap; we only need three
        fieldSize: 4000, // caption is ≤1000 chars (≤4KB in UTF-8); name/date are tiny
        files: 1 // one file per request; extras rejected via filesLimit below
      }
    })

    busboy.on('field', (name: string, value: string) => {
      if (name === 'fileCreatedAt') fileCreatedAt = value
      if (name === 'uploaderName') {
        uploaderName = sanitizeUploaderName(value)
      }
      if (name === 'caption') {
        caption = sanitizeCaption(value)
      }
    })

    // A second file part means a client that doesn't speak our protocol
    // (the bundled client always sends one file per request). Fail loudly
    // rather than silently draining the extra file and reporting success
    // for just the first - that would be silent data loss for the caller.
    busboy.on('filesLimit', () => {
      log.warn('Upload request contained more than one file part - rejecting')
      logAbuse('upload-multi-file', req)
      respondAndAbort(400, 'One file per request')
    })

    busboy.on(
      'file',
      (
        _fieldname: string,
        fileStream: Readable,
        filename: string,
        _transferEncoding: string,
        mimeType: string
      ) => {
        const label = filename || 'file'
        const capturedDate = fileCreatedAt

        // Busboy needs a rejected file's stream drained to advance its parser
        // and reach 'finish' - a bare fileStream.resume() would do that, but
        // with no cap on how much (or how long) it drains, which lets a
        // rejected upload's body be any size - or any duration, trickled
        // slowly - the client feels like sending. Route it through the same
        // size limiter a real upload gets, plus an idle timeout, so a client
        // can't abuse a rejection path to sink an unbounded body or pin the
        // connection open indefinitely; on either, abort the connection
        // outright rather than let it keep draining.
        const boundedReject = (error: string) => {
          uploadError = error
          const drain = createSizeLimitStream(maxBytes)
          const drainIdle = createIdleTimeoutStream(30_000)
          drain.stream.on('error', err => drainIdle.destroy(err))
          drainIdle.on('error', () => {
            if (drain.exceeded) {
              logAbuse('upload-oversize', req, `label=${label}`)
              respondAndAbort(413, `${label}: exceeds ${maxFileSizeMb}MB limit`)
            } else {
              respondAndAbort(408, `${label}: upload stalled`)
            }
          })
          fileStream.pipe(drain.stream).pipe(drainIdle).resume()
        }

        // Browsers report an empty or generic type for formats they don't
        // recognise (commonly HEIC outside Safari) - pass those through, since
        // Immich validates by file extension on ingest and rejects real
        // garbage anyway. supportedTypes is empty only if /server/media-types
        // was unreachable; in that case allow broadly rather than reject all.
        //
        // @fastify/busboy can also hand back a mimeType that doesn't reflect
        // the real Content-Type header at all, for a reason with nothing to
        // do with the actual bytes sent - two known cases, both reproduced
        // directly against the library with no IPP code involved, both
        // triggered by an ordinary chunk boundary (a reverse proxy, Tailscale
        // Funnel, or just an unlucky TCP segment - never anything IPP or the
        // client controls):
        //  - 3.2.1: if the header's terminating CRLF is split across two
        //    reads ("...stream\r" | "\n\r\n<body>"), the reported mimeType
        //    keeps a trailing "\r". Trim it before ever comparing or using it.
        //  - 3.2.2+: same split, different symptom. That release added a
        //    (correct in intent) rejection of bare \r/\n inside a header
        //    value to stop real CRLF injection, but deps/dicer's own
        //    end-of-headers buffering can leave a legitimate header's
        //    trailing "\r" stranded with no paired "\n" (consumed instead by
        //    the terminator-matching logic) right when that split lands - so
        //    the new check misfires on busboy's OWN buffering artifact, not
        //    an injected value, aborts parsing the header block entirely,
        //    and busboy's Content-Type-missing fallback ("text/plain")
        //    surfaces instead. There's no way to recover the real value from
        //    busboy's public API once this happens - treat the fallback the
        //    same as the other generic/unrecognised cases below rather than
        //    reject a perfectly ordinary upload.
        mimeType = mimeType.trim()
        const allowed =
          !mimeType ||
          mimeType === 'application/octet-stream' ||
          mimeType === 'text/plain' ||
          (supportedTypes.size === 0
            ? mimeType.startsWith('image/') || mimeType.startsWith('video/')
            : supportedTypes.has(mimeType))
        if (!allowed) {
          logAbuse('upload-mime-rejected', req, `type=${mimeType}`)
          boundedReject(`${label}: file type not allowed (${mimeType})`)
          return
        }

        // Wrap the busboy stream in a Transform that counts bytes and destroys
        // itself the moment the limit is exceeded, aborting the in-flight Immich
        // request before any truncated data reaches the library. This runs
        // immediately (not gated on the limiter below) so a rejected/oversize
        // file is caught as soon as its bytes arrive, even while queued.
        const sizeLimiter = createSizeLimitStream(maxBytes)
        // Attached immediately, not deferred into the limiter callback below -
        // an overflow while this upload is still queued behind others would
        // otherwise be an 'error' event with no listener, which crashes the
        // process. The real handling (413 vs. treating the pending stream as
        // failed) happens once the limiter slot is granted, via the
        // `sizeLimiter.stream.destroyed` check there.
        sizeLimiter.stream.on('error', () => {})
        const timedFile = fileStream.pipe(sizeLimiter.stream)

        // Acquire a limiter slot before streaming to Immich. If the queue is
        // full, the size limiter's internal buffer fills quickly (~16 KB) and
        // backpressure pauses fileStream, which backs up into the TCP receive
        // buffer - the browser stalls without any application-level queuing.
        const capturedName = uploaderName

        filePromise = getUploadLimiter()(async () => {
          if (sizeLimiter.stream.destroyed) {
            // Already failed (most likely oversize) while queued for a slot.
            // timedFile.pipe(idleStream) below would hang forever on an
            // already-destroyed source, since pipe() never sees another
            // 'data'/'end'/'error' event from it. Either way, .pipe() has
            // already unpiped fileStream from the now-dead sizeLimiter,
            // leaving it undrained - busboy needs it drained to ever reach
            // 'finish', so this must abort rather than merely record an
            // error and hope. (If something else already aborted - e.g. a
            // second file part's filesLimit handler racing this one - this
            // is a harmless no-op: respondAndAbort no-ops once headers are
            // sent, and settling an already-settled promise is a no-op too.)
            if (sizeLimiter.exceeded) {
              logAbuse('upload-oversize', req, `label=${label}`)
              respondAndAbort(413, `${label}: exceeds ${maxFileSizeMb}MB limit`)
            } else {
              log.error(`Upload stream for ${label} failed while queued`)
              respondAndAbort(400, `${label}: upload failed`)
            }
            return
          }
          // Idle timeout guards the *active* transfer, not the queue wait: a
          // client trickling bytes (or stalling entirely) once it's actually
          // this upload's turn would otherwise hold a concurrentUploads slot
          // forever. Deliberately created here, not before the limiter grants
          // a slot - a queued-but-otherwise-healthy upload has no consumer
          // reading it yet, so its stream stops advancing (backpressure) well
          // within 30s purely from waiting in line, which would previously
          // self-destroy it before its turn ever came.
          const idleStream = createIdleTimeoutStream(30_000)
          // Belt-and-braces: uploadAsset passes timedStream into form-data,
          // which reads it lazily - in practice it attaches its own consumer
          // synchronously (before this function's next await), so idleStream's
          // 'error' event normally always has a listener downstream by the
          // time sizeLimiter's overflow (forwarded below) can fire. But that's
          // an implementation-detail timing assumption, not a guarantee - if
          // it ever doesn't hold (a slower/different consumer, or a caller
          // that doesn't fully consume the stream at all, as some tests
          // mocking uploadAsset do), an 'error' event with no listener at all
          // crashes the whole process. A permanent no-op listener here makes
          // that structurally impossible regardless of what consumes the
          // stream or when - the real handling still happens via the
          // catch block below, which uploadAsset's own consumption (or
          // rejection) reaches independently of this listener.
          idleStream.on('error', () => {})
          // .pipe() doesn't forward errors between chained streams, and an
          // unhandled 'error' on sizeLimiter (thrown when it self-destroys on
          // exceeding the byte limit) used to crash the whole process. Forward
          // it downstream so it reaches the catch block below, which checks
          // sizeLimiter.exceeded and responds 413 instead.
          sizeLimiter.stream.on('error', err => idleStream.destroy(err))
          const timedStream = timedFile.pipe(idleStream)
          try {
            const result = await uploadAsset(timedStream, label, mimeType, capturedDate, {
              uploaderName: capturedName,
              uploaderIp,
              forwardedFor,
              // Prefix only: enough to identify which share was used without
              // persisting the full key (a live access credential) in the
              // Immich database.
              shareKey: req.params.key.slice(0, 8),
              // Recorded so an orphan (uploaded but album-add failed) is
              // self-describing: the asset itself says where it belonged.
              albumId
            })
            if (sizeLimiter.exceeded) {
              // uploadAsset resolved successfully despite the size limiter
              // having already fired - e.g. it only reads a prefix of the
              // stream before Immich responds. Immich may now hold a
              // truncated file recorded as a genuine, complete asset; report
              // this as the same failure a client that checked its own
              // file.size against maxFileSizeMb would never trigger, not a
              // silent success.
              logAbuse('upload-oversize', req, `label=${label}`)
              respondAndAbort(413, `${label}: exceeds ${maxFileSizeMb}MB limit`)
              return
            }
            uploadedId = result.id
            uploadDuplicate = result.duplicate
            if (result.duplicate)
              log.warn('Duplicate asset for ' + label + ', using existing asset ' + result.id)
          } catch (e) {
            if (sizeLimiter.exceeded) {
              // Stop reading the request. Without this the route would drain
              // the entire remaining body (unbounded - the client controls the
              // size). Honest clients never hit this path: they pre-check
              // file.size against maxFileSizeMb before uploading.
              logAbuse('upload-oversize', req, `label=${label}`)
              respondAndAbort(413, `${label}: exceeds ${maxFileSizeMb}MB limit`)
            } else {
              log.error(
                'Upload error for ' + label + ': ' + (e instanceof Error ? e.message : String(e))
              )
              // uploadAsset may have abandoned timedStream mid-read (e.g.
              // after a non-2xx from Immich, or its own responseTimeoutSec
              // abort) without draining it to the end. Busboy needs it fully
              // drained to reach 'finish' - waiting for that would hang the
              // request forever, so abort outright instead, the same as the
              // size-exceeded case. 502: the failure is upstream (Immich),
              // not a bad request, so the client's retry-on-5xx logic applies.
              respondAndAbort(502, `${label}: upload failed`)
            }
          }
        })
      }
    )

    await new Promise<void>((resolve, reject) => {
      settleAbort = resolve
      busboy.on('finish', resolve)
      busboy.on('error', reject)
      // If the connection dies mid-body (client cancel, network drop, or our
      // own req.destroy()), pipe() just unpipes - busboy never emits finish
      // or error, so this promise hangs forever. readableEnded tells that
      // apart from a normal close after a full body, where a late reject
      // here is a harmless no-op (finish already resolved).
      req.on('close', () => {
        if (!req.readableEnded) reject(new Error('Client disconnected before the upload completed'))
      })
      // An unhandled 'error' on req would escalate to uncaughtException
      // (which exits the process) - always consume it.
      req.on('error', reject)
      req.pipe(busboy)
    })
  } catch (e) {
    busboyError = e instanceof Error ? e : new Error(String(e))
  }

  if (filePromise) await filePromise

  // An abort path (oversize file, multiple files) already responded and
  // destroyed the request (which also surfaces above as a busboy error).
  if (earlyResponse) {
    // Edge case: a small first file can finish uploading before the abort
    // (e.g. a second file part) triggers. That asset is now an orphan -
    // name it so it can be recovered.
    if (uploadedId) {
      log.warn(
        `Orphaned upload: asset ${uploadedId} was created before the request was aborted; intended album ${albumId}`
      )
    }
    return { ok: false, ...earlyResponse, responded: true }
  }

  if (busboyError) {
    log.error('Busboy error during upload: ' + busboyError.message)
    return { ok: false, status: 400, error: 'Malformed upload request' }
  }

  if (!uploadedId) {
    return { ok: false, status: 400, error: uploadError || 'No file received' }
  }

  return { ok: true, assetId: uploadedId, duplicate: uploadDuplicate, caption, uploaderName }
}
