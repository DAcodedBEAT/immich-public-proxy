import { abortOnClose, Asset, log, readableFromWeb, respondToInvalidRequest, SharedLink } from '@ipp/core'
import {
  assetFetchUrl,
  authHeadersForAsset,
  fetchAssetDetail,
  validateImageSize
} from '../immich'
import { Response } from 'express-serve-static-core'
import { ImageSize, IncomingShareRequest } from '../types'
import { attachmentDisposition, enrichFromHeaders, findPositionInShare, getFilename, servedMimeFrom } from '../gallery/filename'
import { isVideoAsset, resolveDownloadEndpoint, resolveImageEndpoint } from '../gallery/sizing'
import { pipeline } from 'stream/promises'

/**
 * Stream an asset from Immich back to the client.
 *
 * Errors from Immich are always reported to the client as 404 - see
 * invalidRequestHandler. Upstream status codes are never surfaced. Trashed
 * or locked assets are handled implicitly: Immich's own endpoints refuse
 * to serve them, and the upstream failure surfaces as a client 404.
 */
export async function assetBuffer (req: IncomingShareRequest, res: Response, asset: Asset, size: ImageSize | string | undefined, share: SharedLink, forceVideoPlayback = false) {
  // A cancelled download must not leave Immich streaming #288
  const upstream = abortOnClose(res)

  const headerList = ['content-type', 'content-length', 'last-modified', 'etag']
  const fetchHeaders: Record<string, string> = {}
  let subpath: string
  let sizeQueryParam: string | undefined
  let attachment = false
  let servedSize: ImageSize | undefined

  const requested = validateImageSize(size)
  const useVideoPlayback = forceVideoPlayback || (isVideoAsset(asset) && requested === ImageSize.original && share.allowDownload === false)

  if (useVideoPlayback) {
    subpath = '/video/playback'
    attachment = requested === ImageSize.original
    servedSize = ImageSize.original
    res.setHeader('accept-ranges', 'bytes')
    // Only chunk when the client sent a Range header. A browser <video>
    // element does, so playback still streams in 2.5 MB chunks. Clients
    // that don't (wget, right-click "Save As", link unfurlers) get the
    // full file with 200 OK; otherwise they'd save a truncated 2.5 MB
    // partial response as the whole video.
    // The status follows Immich's answer below, never the request alone.
    const range = req.range ? upstreamRange(req.range) : undefined
    if (range) fetchHeaders.range = range
  } else {
    // Album "grid" items arrive without originalMimeType. The fullsize tier
    // needs it to pick /original (web formats) vs ?size=fullsize (RAW/HEIF), so
    // fetch the asset detail on demand (cached) before resolving.
    if (requested === ImageSize.fullsize && !asset.originalMimeType) {
      const detail = await fetchAssetDetail(asset)
      if (detail?.originalMimeType) asset = { ...asset, originalMimeType: detail.originalMimeType }
    }
    const endpoint = requested === ImageSize.original
      ? resolveDownloadEndpoint(asset, share.allowDownload !== false)
      : resolveImageEndpoint(requested, asset)
    subpath = endpoint.subpath
    sizeQueryParam = endpoint.sizeQueryParam
    attachment = endpoint.attachment
    servedSize = endpoint.servedSize
  }

  const url = assetFetchUrl(asset, subpath, sizeQueryParam)
  const reqHeaders = await authHeadersForAsset(asset)
  let data: globalThis.Response
  try {
    data = await fetch(url, { headers: { ...fetchHeaders, ...reqHeaders }, signal: upstream })
  } catch (e) {
    if (upstream.aborted) return // visitor left before Immich answered
    throw e
  }

  if (data.status < 200 || data.status >= 300) {
    let immichMessage = ''
    try {
      const json = await data.json()
      if (json.message) immichMessage = '\nResponse from Immich: ' + json.message
    } catch (e) { }
    respondToInvalidRequest(res, 404, 'Failed response from Immich for asset ' + asset.id + ' on this URL:\n' + url + immichMessage)
    return
  }

  // An original can be any format Immich accepts, so never let a browser sniff it
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (attachment) {
    res.setHeader('X-Accel-Buffering', 'no')
    // Always an attachment, so an SVG can't render inline. Album assets have
    // no originalFileName; Immich's own Content-Disposition carries it.
    const named = asset.originalFileName ? asset : enrichFromHeaders(asset, data)
    const position = findPositionInShare(share, asset.id)
    res.setHeader('Content-Disposition', attachmentDisposition(getFilename(named, servedSize, servedMimeFrom(subpath, data), position)))
  }
  // 206 only when Immich honoured the range; a 200 is the whole file
  if (fetchHeaders.range && data.status === 206) {
    res.status(206) // Partial Content
    headerList.push('cache-control', 'content-range')
  }
  headerList.forEach(header => {
    const value = data.headers.get(header)
    if (value) res.setHeader(header, value)
  })

  // Express routes HEAD through the GET handler and Node silently drops the
  // body writes, so without this we'd read the whole file from Immich for
  // nothing. The headers above are all a HEAD needs.
  if (req.req.method === 'HEAD' || !data.body) {
    await data.body?.cancel()
    res.end()
    return
  }

  /*
  pipeline (rather than a WritableStream sink around res.write) honours
  backpressure from `res`: a LAN-speed read from Immich can't pile up in
  memory ahead of a slow visitor #288.
  */
  try {
    await pipeline(readableFromWeb(data.body), res)
  } catch (e) {
    if (!isClientAbort(e)) {
      log.warn(`Stream from Immich failed for asset ${asset.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/**
 * Translate a client `Range` header into the one sent to Immich, or undefined
 * to ignore it and serve the whole file, which RFC 9110 allows for any Range.
 * A single `first-last` range passes through, an open-ended `first-` is capped
 * to one 2.5 MB chunk, and a suffix `-N` stays the last N bytes. A malformed,
 * reversed, empty suffix or multi-range header is ignored.
 */
export function upstreamRange (clientRange: string): string | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(clientRange.trim())
  if (!match) return undefined
  const start = match[1] === '' ? undefined : Number(match[1])
  const end = match[2] === '' ? undefined : Number(match[2])
  if (![start, end].every(n => n === undefined || Number.isSafeInteger(n))) return undefined
  if (start === undefined) return end ? `bytes=-${end}` : undefined
  if (end === undefined) return `bytes=${start}-${start + 2499999}`
  return end >= start ? `bytes=${start}-${end}` : undefined
}

/**
 * True when a pipeline error means the visitor went away: pipeline saw `res`
 * close early (or found it already closed), or our abort signal, fired from
 * that same close, reached the fetch body first.
 */
function isClientAbort (e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as NodeJS.ErrnoException).code
  return code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_STREAM_UNABLE_TO_PIPE' || e.name === 'AbortError'
}
