import { apiUrl, log } from '@ipp/core'
import { captionKey } from './config'
import { stripFormatChars } from './filename'
import { assertPermit, UploadPermit } from './gate'
import { CAPTION_MAX_LENGTH } from './shared/upload'

/*
  The opt-in caption layer: a caption the visitor types once per batch, sent
  with each file as the `caption` query parameter and written as the new
  asset's description. The only code in the upload service that uses an API
  key, and only with both `ipp.upload.captions` and `IMMICH_API_KEY` set (see
  `captionKey`). Otherwise the parameter is ignored and the service makes no
  call beyond the upload itself.

  Best effort throughout: the call has a timeout, every failure is logged and
  swallowed, and nothing here can fail or delay an upload. The first 403
  logs one warning naming `asset.update` and turns captions off until the
  service restarts, rather than failing on every upload.
*/

const REQUEST_TIMEOUT_MS = 15_000

/*
  C0 and C1 controls, ANSI escapes included, but not tab and newline, which a
  caption may use. `sanitize` from @ipp/core is a filename sanitiser: it would
  strip `?`, `:` and quotes, which a caption may well contain.
*/
// oxlint-disable-next-line no-control-regex -- deliberate: control characters are what it removes
const CAPTION_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g

let disabled = false

/**
 * A visitor-supplied caption, safe to store in Immich and print in a log:
 * control, zero-width and bidi characters removed, trimmed, at most 500 code
 * units without splitting a surrogate pair. Undefined when nothing is left,
 * or the value is not a string (a repeated parameter).
 */
export function sanitizeCaption(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const stripped = stripFormatChars(raw.normalize('NFC').replace(CAPTION_CONTROL_CHARS, '')).trim()
  return (
    stripped
      .slice(0, CAPTION_MAX_LENGTH)
      .replace(/[\uD800-\uDBFF]$/, '')
      .trim() || undefined
  )
}

/** The caption sent with a request, sanitised. Undefined while the layer is off or none was given. */
export function readCaption(query: Record<string, unknown>): string | undefined {
  return captionKey() ? sanitizeCaption(query.caption) : undefined
}

/**
 * Write the caption as the description of a newly created asset. Call only
 * for a `created` result, never a duplicate: a duplicate is an asset the
 * owner already had, and its description is the owner's. Never rejects.
 *
 * Takes the request's permit, so the API key is used only for an upload that
 * passed the gate, and only for the asset that upload created.
 */
export async function writeCaption(
  permit: UploadPermit,
  assetId: string,
  caption: string
): Promise<void> {
  const key = captionKey()
  if (!key || !assetId || disabled) return
  try {
    assertPermit(permit)
    const res = await fetch(apiUrl() + '/assets/' + encodeURIComponent(assetId), {
      method: 'PUT',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: caption }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (res.status === 403) {
      disabled = true
      log.warn(
        'IMMICH_API_KEY lacks the asset.update permission: captions are off until restart. Grant asset.update to turn them on.'
      )
    } else if (!res.ok) {
      const text = await res.text().catch(() => '')
      log.warn(
        `Could not caption asset ${assetId}: Immich answered ${res.status}: ${text.slice(0, 200)}`
      )
    }
  } catch (e) {
    log.warn(`Could not caption asset ${assetId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
