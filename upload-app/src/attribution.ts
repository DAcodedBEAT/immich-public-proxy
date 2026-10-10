import { attributionKey } from './config'
import { stripFormatChars } from './filename'
import { CAPTION_MAX_LENGTH, UPLOADER_NAME_MAX_LENGTH } from './shared/upload'

/*
  The opt-in attribution layer: a visitor's name and a caption, sent with
  each file as the `uploaderName` and `caption` query parameters. Read only
  when `IMMICH_API_KEY` is set; otherwise both parameters are ignored and the
  service behaves exactly as without this layer.

  `sanitize` from @ipp/core is a filename sanitiser: it would strip `?`, `:`
  and quotes, which a caption may well contain. These keep all printable
  text and remove only what can hide or disguise it.
*/

/*
  Lengths are in UTF-16 code units. The caption travels in the query string,
  and nginx's default limit for a request line is 8 KB: 500 characters of
  percent-encoded non-Latin text stay inside it, next to a long filename.
*/

// oxlint-disable-next-line no-control-regex -- deliberate: C0 and C1 controls, ANSI escapes included
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g
// The same set, keeping tab and newline, which a caption may use
// oxlint-disable-next-line no-control-regex -- deliberate, as above
const CAPTION_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g

/**
 * Cap at `max` code units without leaving half of a surrogate pair at the
 * end, so an emoji on the boundary is dropped whole.
 */
function truncate(value: string, max: number): string {
  return value.slice(0, max).replace(/[\uD800-\uDBFF]$/, '')
}

function clean(raw: unknown, controls: RegExp, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const stripped = stripFormatChars(raw.normalize('NFC').replace(controls, '')).trim()
  return truncate(stripped, max).trim() || undefined
}

/**
 * A visitor-supplied name, safe to store in Immich and print in a log:
 * control, zero-width and bidi characters removed, trimmed, at most 100
 * characters. Undefined when nothing is left, or the value is not a string.
 */
export function sanitizeUploaderName(raw: unknown): string | undefined {
  return clean(raw, CONTROL_CHARS, UPLOADER_NAME_MAX_LENGTH)
}

/** A visitor-supplied caption, as `sanitizeUploaderName` but keeping tabs and newlines, at most 500 characters. */
export function sanitizeCaption(raw: unknown): string | undefined {
  return clean(raw, CAPTION_CONTROL_CHARS, CAPTION_MAX_LENGTH)
}

export interface Attribution {
  uploader?: string
  caption?: string
}

/**
 * The attribution sent with a request, sanitised. Undefined when the layer
 * is off (no `IMMICH_API_KEY`) or the visitor left both fields empty.
 */
export function readAttribution(query: Record<string, unknown>): Attribution | undefined {
  if (!attributionKey()) return undefined
  const uploader = sanitizeUploaderName(query.uploaderName)
  const caption = sanitizeCaption(query.caption)
  if (!uploader && !caption) return undefined
  return { ...(uploader && { uploader }), ...(caption && { caption }) }
}

/** The asset description for an attribution, or undefined when there is nothing to write. */
export function describeUpload({ uploader, caption }: Attribution): string | undefined {
  if (caption && uploader) return `${caption}\n\n- Uploaded by ${uploader}`
  if (caption) return caption
  if (uploader) return 'Uploaded by ' + uploader
  return undefined
}
