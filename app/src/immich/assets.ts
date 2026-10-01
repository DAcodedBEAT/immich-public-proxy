import { Asset, ImageSize, KeyType } from '../types'
import { TtlLruCache } from '../utils/ttlLruCache'
import { apiUrl, authHeadersForAsset, buildUrl, cachedPromise, request } from './api'

/*
  Per-asset detail cache for the lazy album flow. When a `needsDetail` album
  item opens in the lightbox, the `/meta/` route fetches the full asset from
  `GET /assets/:id` for its exif / filename. Paging quickly through a gallery
  (or prefetching neighbours) would otherwise re-fetch the same asset; this
  coalesces repeats. Keyed by (keyType, key, id); holds Promises so concurrent
  opens of the same asset share one upstream call.
*/
const assetDetailCache = new TtlLruCache<Promise<Asset | undefined>>({ ttlMs: 120_000, max: 500 })

/**
 * Build the Immich URL that serves `subpath` for `asset` (e.g. `/original`,
 * `/video/playback`), with the share key and optional `size` query param
 * encoded. `buildUrl` drops the `size` param when it is undefined.
 */
export function assetFetchUrl(asset: Asset, subpath: string, sizeQueryParam?: string): string {
  return buildUrl(apiUrl() + '/assets/' + encodeURIComponent(asset.id) + subpath, {
    [asset.keyType || KeyType.key]: asset.key,
    size: sizeQueryParam
  })
}

/**
 * Fetch a single asset's full detail (`GET /assets/:id`) for the lazy album
 * flow, cached + de-duplicated per (keyType, key, id). The `asset` argument
 * supplies the id and the already-stamped key/keyType/password. Returns
 * undefined on any failure.
 */
export function fetchAssetDetail(asset: Asset): Promise<Asset | undefined> {
  const cacheKey = `${asset.keyType}:${asset.key}:${asset.id}`
  return cachedPromise(assetDetailCache, cacheKey, async () => {
    const headers = await authHeadersForAsset(asset)
    const res = await fetch(assetFetchUrl(asset, ''), { headers })
    if (!res.ok) return undefined
    return (await res.json()) as Asset
  })
}

/**
 * Get the content-type of a video, for the lightbox <video> element
 */
export async function getVideoContentType(asset: Asset) {
  const headers = await authHeadersForAsset(asset)
  const data = await request(
    buildUrl('/assets/' + encodeURIComponent(asset.id) + '/video/playback', {
      [asset.keyType]: asset.key
    }),
    { headers }
  )
  return data.headers.get('Content-Type')
}

/**
 * Return the image data URL for a photo
 */
export function photoUrl(key: string, id: string, size?: ImageSize) {
  const path = ['photo', key, id]
  if (size) path.push(size)
  return buildUrl('/share/' + path.join('/'))
}

/**
 * Return the video data URL for a video
 */
export function videoUrl(key: string, id: string) {
  return buildUrl(`/share/video/${key}/${id}`)
}

/**
 * Coerce an unknown `size` parameter from a URL into a valid ImageSize,
 * defaulting to preview when the input is missing or unrecognised.
 */
export function validateImageSize(size: unknown) {
  if (!size || !Object.values(ImageSize).includes(size as ImageSize)) {
    return ImageSize.preview
  } else {
    return size as ImageSize
  }
}
