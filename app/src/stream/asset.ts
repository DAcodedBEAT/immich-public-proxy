import { authHeadersForAsset } from '../immich/api'
import { assetFetchUrl, fetchAssetDetail, validateImageSize } from '../immich/assets'
import { Response } from 'express-serve-static-core'
import { Asset, ImageSize, IncomingShareRequest, SharedLink } from '../types'
import { respondToInvalidRequest } from '../invalidRequestHandler'
import { getFilename } from '../gallery/filename'
import { isVideoAsset, resolveDownloadEndpoint, resolveImageEndpoint } from '../gallery/sizing'
import { pipeline } from 'stream/promises'
import { readableFromWeb } from '../utils/webStream'
import { log } from '../utils/log'

/** Upstream response headers always passed through to the client. */
const FORWARDED_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag']
/** Additional headers forwarded for a ranged (206) playback response. */
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
  /** Upstream headers to forward to the client, if present. */
  forwardHeaders: string[]
  useVideoPlayback: boolean
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
  size?: ImageSize | string,
  share?: SharedLink,
  forceVideoPlayback = false
) {
  const upstream = abortWhenClientLeaves(res)
  const plan = await planAssetRequest(req, res, asset, size, share, forceVideoPlayback)

  const url = assetFetchUrl(plan.asset, plan.subpath, plan.sizeQueryParam)
  const reqHeaders = await authHeadersForAsset(plan.asset)
  let data: globalThis.Response
  try {
    data = await fetch(url, {
      headers: { ...plan.fetchHeaders, ...reqHeaders },
      signal: upstream.signal
    })
  } catch (e) {
    if (upstream.signal.aborted) return // visitor left before Immich answered
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

  applyResponseHeaders(res, data, plan)

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
 * Abort the upstream fetch as soon as the visitor goes away, so a cancelled
 * download doesn't leave Immich streaming #288.
 */
function abortWhenClientLeaves(res: Response): AbortController {
  const upstream = new AbortController()
  const onClose = () => {
    if (!res.writableFinished) upstream.abort()
  }
  res.once('close', onClose)
  if (res.closed) onClose()
  return upstream
}

/**
 * Decide how to fetch the requested size of this asset. Sets the response
 * headers and status that depend only on the request (accept-ranges, 206).
 */
async function planAssetRequest(
  req: IncomingShareRequest,
  res: Response,
  asset: Asset,
  size: ImageSize | string | undefined,
  share: SharedLink | undefined,
  forceVideoPlayback: boolean
): Promise<AssetRequestPlan> {
  const requested = validateImageSize(size)
  const useVideoPlayback =
    forceVideoPlayback ||
    (isVideoAsset(asset) && requested === ImageSize.original && share?.allowDownload === false)
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
  const range = req.range ? upstreamRangeHeader(req.range) : undefined
  if (range) res.status(206) // Partial Content
  return {
    asset,
    subpath: '/video/playback',
    attachment: requested === ImageSize.original,
    servedSize: ImageSize.original,
    fetchHeaders: range ? { range } : {},
    forwardHeaders: range
      ? [...FORWARDED_HEADERS, ...RANGE_FORWARDED_HEADERS]
      : [...FORWARDED_HEADERS],
    useVideoPlayback: true
  }
}

/**
 * Translate a client `Range` request header into the one we send upstream.
 * An absent or unparseable start means byte 0, and an open-ended range is
 * capped to a single 2.5 MB chunk.
 */
export function upstreamRangeHeader(clientRange: string): string {
  const range = clientRange.replace(/bytes=/, '').split('-')
  const start = parseInt(range[0], 10) || 0
  const end = parseInt(range[1], 10) || start + PLAYBACK_CHUNK_END_OFFSET
  return `bytes=${start}-${end}`
}

/** Plan a still-image or original-file response. */
async function planImageRequest(
  asset: Asset,
  requested: ImageSize,
  share: SharedLink | undefined
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
      ? resolveDownloadEndpoint(asset, share?.allowDownload !== false)
      : resolveImageEndpoint(requested, asset)
  return {
    asset,
    subpath: endpoint.subpath,
    sizeQueryParam: endpoint.sizeQueryParam,
    attachment: endpoint.attachment,
    servedSize: endpoint.servedSize,
    fetchHeaders: {},
    forwardHeaders: [...FORWARDED_HEADERS],
    useVideoPlayback: false
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

/** Set the download headers (if any) and forward the upstream headers. */
function applyResponseHeaders(res: Response, data: globalThis.Response, plan: AssetRequestPlan) {
  if (plan.attachment) {
    res.setHeader('X-Accel-Buffering', 'no')
    if (plan.asset.originalFileName) {
      // Playback downloads serve Immich's transcode, so the filename extension
      // must follow the response's content-type, not the original file's.
      const playbackMime = plan.useVideoPlayback
        ? (data.headers.get('content-type') || '').split(';')[0].trim() || undefined
        : undefined
      const filename = encodeURI(getFilename(plan.asset, plan.servedSize, playbackMime))
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
    }
  }
  plan.forwardHeaders.forEach(header => {
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
