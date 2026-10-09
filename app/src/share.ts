import {
  Asset,
  AssetVisibility,
  formatDate,
  getConfigOption,
  isSupportedLocale,
  isValidDate,
  KeyType,
  log,
  parseDate,
  SharedLink,
  TtlLruCache
} from '@ipp/core'
import { DownloadAll } from './types'

/**
 * Decide whether the given shared link's download UI is shown (the "download
 * all" zip, multi-select download, and the per-asset lightbox button). The
 * `ipp.allowDownload` config controls the policy: disabled, follow the
 * per-share Immich setting, or always allowed. This is purely a UI gate - it
 * does not affect image quality (see `gallery/sizing.ts`).
 */
export function canDownload(share: SharedLink): boolean {
  const policy = getConfigOption('ipp.allowDownload', DownloadAll.disabled)
  if (policy === DownloadAll.always) return true
  if (policy === DownloadAll.perImmich) return !!share.allowDownload
  if (policy !== DownloadAll.disabled && !warnedInvalidDownloadPolicy) {
    warnedInvalidDownloadPolicy = true
    log.warn(
      'ipp.allowDownload is ' +
        JSON.stringify(policy) +
        ', which is not 0, 1 or 2. Downloads are off.'
    )
  }
  return false
}

let warnedInvalidDownloadPolicy = false

/** Where the upload service lives when `ipp.uploadUrl` is not set: a path on IPP's own hostname */
const DEFAULT_UPLOAD_URL = '/upload'

/**
 * The upload service's public base from `ipp.uploadUrl`, without a trailing
 * slash: an absolute http(s) URL for a hostname of its own, or a path on
 * IPP's hostname such as the default `/upload`. Undefined when the option is
 * empty, so the button is off, or not one of those two forms.
 */
export function uploadBase(): string | undefined {
  const configured = getConfigOption('ipp.uploadUrl', DEFAULT_UPLOAD_URL)
  if (typeof configured !== 'string') return undefined
  const base = configured.trim().replace(/\/+$/, '')
  if (/^https?:\/\//i.test(base)) return base
  // A path, but not a protocol-relative `//host`
  if (/^\/[^/\\]/.test(base)) return base
  return undefined
}

/**
 * The upload service's healthcheck URL when it is assumed to be at a path on
 * IPP's hostname, or undefined when the owner gave an absolute URL. The
 * gallery shows the "Add photos" button only once this answers, so an Immich
 * share with uploads allowed never shows a dead button on an install that has
 * no upload container. An absolute URL is the owner's word and is trusted; a
 * cross-origin check would need CORS headers anyway.
 */
export function uploadHealthcheck(): string | undefined {
  const base = uploadBase()
  return base && !/^https?:/i.test(base) ? base + '/healthcheck' : undefined
}

/**
 * The "Add photos" link to this share on the upload service, or undefined
 * when there is no usable `ipp.uploadUrl` (see `uploadBase`) or the owner has
 * not turned on "Allow public user to upload". A share opened by its slug
 * links by its slug, so the upload service resolves it the same way.
 */
export function uploadLink(share: SharedLink): string | undefined {
  const base = uploadBase()
  if (!share.allowUpload || !base) return undefined
  return share.keyType === KeyType.slug && share.slug
    ? base + '/s/' + encodeURIComponent(share.slug)
    : base + '/share/' + encodeURIComponent(share.key)
}

// Asset ids already warned about, so each warns at most once a day
const warnedUnprocessed = new TtlLruCache<true>({ ttlMs: 24 * 60 * 60_000, max: 1000 })

/**
 * Narrow a share's assets to what IPP can render: not trashed, not in the
 * owner's locked folder, and finished processing in Immich. Immich's share
 * listing does not filter on visibility, so a locked asset has to go here.
 * `thumbhash` is the readiness signal: Immich's thumbnail job writes the
 * files and only then sets it, so until it appears every image URL IPP hands
 * out would 404.
 */
export function servableAssets(assets: Asset[]): Asset[] {
  return assets.filter(asset => {
    if (asset.isTrashed) return false
    if (asset.visibility === AssetVisibility.locked) return false
    if (asset.thumbhash) return true
    if (!warnedUnprocessed.get(asset.id)) {
      warnedUnprocessed.set(asset.id, true)
      log.warn(
        'Asset ' +
          asset.id +
          ' is hidden because Immich has not generated its thumbnail yet. ' +
          'If it never appears, check the thumbnail job for that asset in Immich.'
      )
    }
    return false
  })
}

const DEFAULT_EXPIRY_FORMAT = 'YYYY-MM-DD'

/**
 * Formatted expiry date for the gallery subtitle, or undefined when the
 * feature is off, the share never expires, or the date can't be parsed.
 *
 * Gated by `ipp.gallery.showExpiryDate` (default `false`). Formatted with the
 * dayjs-style token string `ipp.gallery.expiryDateFormat` (default ISO 8601
 * date `YYYY-MM-DD`, e.g. `2026-07-10`; see `formatDate` in core for the
 * supported tokens). Name-based tokens (e.g. `MMMM` -> "July") render in the
 * operator's `ipp.gallery.expiryDateLocale` when set, otherwise English.
 */
export function expiryDate(share: SharedLink): string | undefined {
  if (!getConfigOption('ipp.gallery.showExpiryDate', false)) return undefined
  if (!share.expiresAt) return undefined
  const parsed = parseDate(share.expiresAt)
  if (!isValidDate(parsed)) return undefined
  const configured = getConfigOption('ipp.gallery.expiryDateFormat', DEFAULT_EXPIRY_FORMAT)
  const format = typeof configured === 'string' && configured ? configured : DEFAULT_EXPIRY_FORMAT
  return formatDate(parsed, format, expiryDateLocale())
}

/**
 * Resolve the locale named by `ipp.gallery.expiryDateLocale` so name-based
 * expiry tokens localise. Returns the configured value when Intl accepts it as
 * a well-formed tag, or undefined to keep the default (English) - including
 * when the value is malformed. A well-formed tag Intl has no data for also
 * renders in English.
 */
function expiryDateLocale(): string | undefined {
  const configured = getConfigOption('ipp.gallery.expiryDateLocale', '')
  if (typeof configured !== 'string' || !configured) return undefined
  return isSupportedLocale(configured) ? configured : undefined
}

/**
 * Find the shared still that a motion photo (Live Photo) clip belongs to. The
 * clip is a hidden asset that Immich authorises under the same share key;
 * requiring a shared still to point at it keeps the ids IPP serves bounded.
 */
export function findMotionPhotoStill(share: SharedLink, clipId: string): Asset | undefined {
  if (!clipId) return undefined
  return share.assets.find(asset => asset.livePhotoVideoId === clipId)
}
