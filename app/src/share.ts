import { DownloadAll, SharedLink } from './types'
import { getConfigOption } from './config/access'
import { formatDate, isSupportedLocale } from './utils/dateFormat'

/**
 * Display title for a shared link. Prefers the user-set link description,
 * falls back to the album name (for album shares), or a generic placeholder.
 * Used by the gallery view-model and as the zip filename in the download
 * pipeline.
 */
export function title(share: SharedLink): string {
  return share.description || share?.album?.albumName || 'Gallery'
}

/**
 * Decide whether the given shared link's download UI is shown (the "download
 * all" zip, multi-select download, and the per-asset lightbox button). The
 * `ipp.allowDownload` config controls the policy: disabled, follow the
 * per-share Immich setting, or always allowed. This is purely a UI gate - it
 * does not affect image quality (see `gallery/sizing.ts`).
 */
export function canDownload(share: SharedLink): boolean {
  const allowDownloadConfig = getConfigOption('ipp.allowDownload', 0) as DownloadAll
  if (!allowDownloadConfig) {
    // Downloading is disabled in config.json
    return false
  } else if (allowDownloadConfig === DownloadAll.always) {
    // Always allowed to download in config.json
    return true
  } else {
    // Return Immich's setting for this shared link
    return !!share.allowDownload
  }
}

const DEFAULT_EXPIRY_FORMAT = 'YYYY-MM-DD'

/**
 * Formatted expiry date for the gallery subtitle, or undefined when the
 * feature is off, the share never expires, or the date can't be parsed.
 *
 * Gated by `ipp.gallery.showExpiryDate` (default `false`). Formatted with the
 * dayjs-style token string `ipp.gallery.expiryDateFormat` (default ISO 8601
 * date `YYYY-MM-DD`, e.g. `2026-07-10`; see `utils/dateFormat.ts` for the
 * supported tokens). Name-based tokens (e.g. `MMMM` -> "July") render in the
 * operator's `ipp.gallery.expiryDateLocale` when set, otherwise English.
 */
export function expiryDate(share: SharedLink): string | undefined {
  if (!getConfigOption('ipp.gallery.showExpiryDate', false)) return undefined
  if (!share.expiresAt) return undefined
  const parsed = new Date(share.expiresAt)
  if (isNaN(parsed.getTime())) return undefined
  const configured = getConfigOption('ipp.gallery.expiryDateFormat', DEFAULT_EXPIRY_FORMAT)
  const format = typeof configured === 'string' && configured ? configured : DEFAULT_EXPIRY_FORMAT
  return formatDate(parsed, format, expiryDateLocale())
}

/**
 * Resolve the locale named by `ipp.gallery.expiryDateLocale` so name-based
 * expiry tokens localise. Returns the configured value verbatim when
 * Intl.DateTimeFormat accepts it as a well-formed tag, or undefined to keep
 * the default (English) - including when the value is malformed.
 */
function expiryDateLocale(): string | undefined {
  const configured = getConfigOption('ipp.gallery.expiryDateLocale', '')
  if (typeof configured !== 'string' || !configured) return undefined
  return isSupportedLocale(configured) ? configured : undefined
}
