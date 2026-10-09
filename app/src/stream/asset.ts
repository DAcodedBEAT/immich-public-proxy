import {
  abortOnClose,
  Asset,
  log,
  readableFromWeb,
  respondToInvalidRequest,
  SharedLink
} from '@ipp/core'
import { assetFetchUrl, authHeadersForAsset, fetchAssetDetail, validateImageSize } from '../immich'
import { Response } from 'express-serve-static-core'
import { ImageSize, IncomingShareRequest } from '../types'
import {
  attachmentDisposition,
  enrichFromHeaders,
  findPositionInShare,
  getFilename,
  servedMimeFrom
} from '../gallery/filename'
import { isVideoAsset, resolveDownloadEndpoint, resolveImageEndpoint } from '../gallery/sizing'
import { pipeline } from 'stream/promises'

/** Upstream response headers always passed through to the client. */
const FORWARDED_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag']
/** Additional headers forwarded when Immich answers a playback range with 206. */
const RANGE_FORWARDED_HEADERS = ['cache-control', 'content-range']
/**
 * Offset added to the range start when the client sent an open-ended range,
 * giving a 2.5 MB chunk (inclusive end byte).
 */
const PLAYBACK_CHUNK_END_OFFSET = 2499999

/**
 * Everything needed to fetch one asset from Immich and shape the response:
 * which upstream endpoint to use, what to send with the request, and what to
 * do with the answer. `asset` may be a copy enriched with details fetched
 * while planning.
 */
type AssetRequestPlan = {
  asset: Asset
  subpath: string
  sizeQueryParam?: string
  attachment: boolean
  servedSize?: ImageSize
  /** Headers added to the upstream fetch (currently only `range`). */
  fetchHeaders: Record<string, string>
}

/**
 * Stream an asset from Immich back to the client.
 *
 * Errors from Immich are always reported to the client as 404 - see
 * invalidRequestHandler. Upstream status codes are never surfaced. Trashed
 * or locked assets are handled implicitly: Immich's own endpoints refuse
 * to serve them, and the upstream failure surfaces as a client 404.
 */
export async function assetBuffer(
  req: IncomingShareRequest,
  res: Response,
  asset: Asset,
  size: ImageSize | string | undefined,
  share: SharedLink,
  forceVideoPlayback = false
) {
  // A cancelled download must not leave Immich streaming #288
  const upstream = abortOnClose(res)
  const plan = await planAssetRequest(req, res, asset, size, share, forceVideoPlayback)

  const url = assetFetchUrl(plan.asset, plan.subpath, plan.sizeQueryParam)
  const reqHeaders = await authHeadersForAsset(plan.asset)
  let data: globalThis.Response
  try {
    data = await fetch(url, { headers: { ...plan.fetchHeaders, ...reqHeaders }, signal: upstream })
  } catch (e) {
    if (upstream.aborted) return // visitor left before Immich answered
    throw e
  }

  if (data.status < 200 || data.status >= 300) {
    const immichMessage = await upstreamErrorDetail(data)
    respondToInvalidRequest(
      res,
      404,
      'Failed response from Immich for asset ' +
        plan.asset.id +
        ' on this URL:\n' +
        url +
        immichMessage
    )
    return
  }

  applyResponseHeaders(res, data, plan, share)

  // Express routes HEAD through the GET handler and Node silently drops the
  // body writes, so without this we'd read the whole file from Immich for
  // nothing. The headers above are all a HEAD needs.
  if (req.req.method === 'HEAD' || !data.body) {
    await data.body?.cancel()
    res.end()
    return
  }

  await streamToClient(data.body, res, plan.asset.id)
}

/**
 * Decide how to fetch the requested size of this asset. Sets the response
 * headers that depend only on the request (accept-ranges). The status follows
 * Immich's answer, see applyResponseHeaders.
 */
async function planAssetRequest(
  req: IncomingShareRequest,
  res: Response,
  asset: Asset,
  size: ImageSize | string | undefined,
  share: SharedLink,
  forceVideoPlayback: boolean
): Promise<AssetRequestPlan> {
  const requested = validateImageSize(size)
  const useVideoPlayback =
    forceVideoPlayback ||
    (isVideoAsset(asset) && requested === ImageSize.original && share.allowDownload === false)
  return useVideoPlayback
    ? planVideoPlayback(req, res, asset, requested)
    : planImageRequest(asset, requested, share)
}

/** Plan a `/video/playback` response, chunked only if the client asked for a range. */
function planVideoPlayback(
  req: IncomingShareRequest,
  res: Response,
  asset: Asset,
  requested: ImageSize
): AssetRequestPlan {
  res.setHeader('accept-ranges', 'bytes')
  // Only chunk when the client sent a Range header. A browser <video>
  // element does, so playback still streams in 2.5 MB chunks. Clients
  // that don't (wget, right-click "Save As", link unfurlers) get the
  // full file with 200 OK; otherwise they'd save a truncated 2.5 MB
  // partial response as the whole video.
  const range = req.range ? upstreamRange(req.range) : undefined
  return {
    asset,
    subpath: '/video/playback',
    attachment: requested === ImageSize.original,
    servedSize: ImageSize.original,
    fetchHeaders: range ? { range } : {}
  }
}

/**
 * Translate a client `Range` header into the one sent to Immich, or undefined
 * to ignore it and serve the whole file, which RFC 9110 allows for any Range.
 * A single `first-last` range passes through, an open-ended `first-` is capped
 * to one 2.5 MB chunk, and a suffix `-N` stays the last N bytes. A malformed,
 * reversed, empty suffix or multi-range header is ignored.
 */
export function upstreamRange(clientRange: string): string | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(clientRange.trim())
  if (!match) return undefined
  const start = match[1] === '' ? undefined : Number(match[1])
  const end = match[2] === '' ? undefined : Number(match[2])
  if (![start, end].every(n => n === undefined || Number.isSafeInteger(n))) return undefined
  if (start === undefined) return end ? `bytes=-${end}` : undefined
  if (end === undefined) return `bytes=${start}-${start + PLAYBACK_CHUNK_END_OFFSET}`
  return end >= start ? `bytes=${start}-${end}` : undefined
}

/** Plan a still-image or original-file response. */
async function planImageRequest(
  asset: Asset,
  requested: ImageSize,
  share: SharedLink
): Promise<AssetRequestPlan> {
  // Album "grid" items arrive without originalMimeType. The fullsize tier
  // needs it to pick /original (web formats) vs ?size=fullsize (RAW/HEIF), so
  // fetch the asset detail on demand (cached) before resolving.
  if (requested === ImageSize.fullsize && !asset.originalMimeType) {
    const detail = await fetchAssetDetail(asset)
    if (detail?.originalMimeType) asset = { ...asset, originalMimeType: detail.originalMimeType }
  }
  const endpoint =
    requested === ImageSize.original
      ? resolveDownloadEndpoint(asset, share.allowDownload !== false)
      : resolveImageEndpoint(requested, asset)
  return {
    asset,
    subpath: endpoint.subpath,
    sizeQueryParam: endpoint.sizeQueryParam,
    attachment: endpoint.attachment,
    servedSize: endpoint.servedSize,
    fetchHeaders: {}
  }
}

/**
 * Immich's error body, if it carries a message, as a suffix for the server
 * log. Never sent to the client - see respondToInvalidRequest.
 */
async function upstreamErrorDetail(data: globalThis.Response): Promise<string> {
  try {
    const json = await data.json()
    if (json.message) return '\nResponse from Immich: ' + json.message
  } catch (e) {}
  return ''
}

/** Set the status, safety and download headers, then forward the upstream headers. */
function applyResponseHeaders(
  res: Response,
  data: globalThis.Response,
  plan: AssetRequestPlan,
  share: SharedLink
) {
  // An original can be any format Immich accepts, so never let a browser sniff it
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (plan.attachment) {
    res.setHeader('X-Accel-Buffering', 'no')
    // Always an attachment, so an SVG can't render inline. Album assets have
    // no originalFileName; Immich's own Content-Disposition carries it.
    const named = plan.asset.originalFileName ? plan.asset : enrichFromHeaders(plan.asset, data)
    const position = findPositionInShare(share, plan.asset.id)
    res.setHeader(
      'Content-Disposition',
      attachmentDisposition(
        getFilename(named, plan.servedSize, servedMimeFrom(plan.subpath, data), position)
      )
    )
  }
  // 206 only when Immich honoured the range; a 200 is the whole file
  const partial = plan.fetchHeaders.range !== undefined && data.status === 206
  if (partial) res.status(206) // Partial Content
  const forward = partial ? [...FORWARDED_HEADERS, ...RANGE_FORWARDED_HEADERS] : FORWARDED_HEADERS
  forward.forEach(header => {
    const value = data.headers.get(header)
    if (value) res.setHeader(header, value)
  })
}

/**
 * Pipe the upstream body to the visitor.
 *
 * pipeline (rather than a WritableStream sink around res.write) honours
 * backpressure from `res`: a LAN-speed read from Immich can't pile up in
 * memory ahead of a slow visitor #288.
 */
async function streamToClient(body: ReadableStream<Uint8Array>, res: Response, assetId: string) {
  try {
    await pipeline(readableFromWeb(body), res)
  } catch (e) {
    if (!isClientAbort(e)) {
      log.warn(
        `Stream from Immich failed for asset ${assetId}: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
}

/**
 * True when a pipeline error means the visitor went away: pipeline saw `res`
 * close early (or found it already closed), or our abort signal, fired from
 * that same close, reached the fetch body first.
 */
function isClientAbort(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as NodeJS.ErrnoException).code
  return (
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    code === 'ERR_STREAM_UNABLE_TO_PIPE' ||
    e.name === 'AbortError'
  )
}
