/**
 * Sanitize a visitor-supplied uploader name so the stored value is safe to
 * print in a terminal or log viewer. Control characters (C0 0x00–0x1f and C1
 * 0x7f–0x9f, including ANSI escape sequences starting with 0x1b) are stripped,
 * the result is trimmed, and then capped at 100 characters.
 *
 * Returns `undefined` when the result would be an empty string (whitespace-only
 * or all-control input) so callers can treat absence and empty the same way.
 */
/*
 * The strip ranges cover C0/C1 control characters plus the invisible Unicode
 * "format" characters (zero-width spaces/joiners, bidi override/isolate
 * controls like RLO/LRO) that a normal caption or name has no legitimate use
 * for but that can spoof how text displays (e.g. RLO to make a name render
 * reversed) or hide characters entirely. Real RTL script text (Arabic,
 * Hebrew) is untouched - it needs no explicit direction-override characters
 * to render correctly. All other Unicode (accents, CJK, emoji) also passes
 * through untouched. The length caps count UTF-16 code units, so `slice` can
 * land in the middle of a surrogate pair (an emoji at the boundary);
 * `dropTrailingSurrogate` removes the resulting unpaired half so the output
 * is always well-formed Unicode.
 */
// eslint-disable-next-line no-control-regex -- deliberate: stripping C0/C1 control chars
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g
// U+200B-200D zero-width space/joiners, U+2060 word joiner, U+FEFF BOM,
// U+202A-202E bidi embedding/override (LRE/RLE/PDF/LRO/RLO), U+2066-2069
// bidi isolates (LRI/RLI/FSI/PDI).
const INVISIBLE_FORMAT_CHARS = /[\u200b-\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069]/g

function dropTrailingSurrogate(value: string): string {
  return value.replace(/[\uD800-\uDBFF]$/, '')
}

export function sanitizeUploaderName(value: string): string | undefined {
  return (
    dropTrailingSurrogate(
      value.replace(CONTROL_CHARS, '').replace(INVISIBLE_FORMAT_CHARS, '').trim().slice(0, 100)
    ) || undefined
  )
}

/**
 * Sanitize a visitor-supplied caption for use as an Immich asset description.
 * Same character strips as the uploader name, except newlines and tabs
 * survive (captions are multi-line-capable). Capped at 1000 characters.
 */
export function sanitizeCaption(value: string): string | undefined {
  return (
    dropTrailingSurrogate(
      value
        // eslint-disable-next-line no-control-regex -- deliberate: stripping C0/C1 control chars except \n and \t
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
        .replace(INVISIBLE_FORMAT_CHARS, '')
        .trim()
        .slice(0, 1000)
    ) || undefined
  )
}
