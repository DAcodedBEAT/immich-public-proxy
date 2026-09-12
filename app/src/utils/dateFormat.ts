const pad2 = (n: number) => String(n).padStart(2, '0')

// Token/literal matcher: longer tokens are listed before their prefixes
// (YYYY before YY, MMMM before MMM before MM before M, ...) so the
// alternation - which JS regex resolves left-to-right, not longest-match -
// picks the right one. `[...]` is dayjs's own escape syntax for literal text.
const TOKEN_PATTERN = /\[([^\]]+)]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a/g

/**
 * Format a Date using a small subset of dayjs's format tokens, backed by
 * native Intl.DateTimeFormat for locale-aware month/weekday names. All
 * numeric tokens read the Date in the server's local time, matching dayjs's
 * (non-UTC-plugin) default behaviour. `locale` defaults to English, same as
 * dayjs's own default, rather than the process's system locale - so output
 * is deterministic regardless of the host's ICU configuration.
 */
export function formatDate(date: Date, pattern: string, locale?: string): string {
  const loc = locale || 'en'
  const hours24 = date.getHours()
  const hours12 = hours24 % 12 || 12
  const tokens: Record<string, () => string> = {
    YYYY: () => String(date.getFullYear()),
    YY: () => String(date.getFullYear()).slice(-2),
    MMMM: () => new Intl.DateTimeFormat(loc, { month: 'long' }).format(date),
    MMM: () => new Intl.DateTimeFormat(loc, { month: 'short' }).format(date),
    MM: () => pad2(date.getMonth() + 1),
    M: () => String(date.getMonth() + 1),
    DD: () => pad2(date.getDate()),
    D: () => String(date.getDate()),
    dddd: () => new Intl.DateTimeFormat(loc, { weekday: 'long' }).format(date),
    ddd: () => new Intl.DateTimeFormat(loc, { weekday: 'short' }).format(date),
    HH: () => pad2(hours24),
    H: () => String(hours24),
    hh: () => pad2(hours12),
    h: () => String(hours12),
    mm: () => pad2(date.getMinutes()),
    m: () => String(date.getMinutes()),
    ss: () => pad2(date.getSeconds()),
    s: () => String(date.getSeconds()),
    A: () => (hours24 < 12 ? 'AM' : 'PM'),
    a: () => (hours24 < 12 ? 'am' : 'pm')
  }
  return pattern.replace(TOKEN_PATTERN, (match, literal: string | undefined) =>
    literal !== undefined ? literal : tokens[match]()
  )
}

/**
 * True if Intl.DateTimeFormat accepts `locale` as a well-formed tag. Doesn't
 * guarantee the locale has real translations - Intl silently best-fits
 * unrecognised-but-valid tags to a fallback, same as dayjs falling back to
 * English for a locale it doesn't bundle.
 */
export function isSupportedLocale(locale: string): boolean {
  try {
    new Intl.DateTimeFormat(locale)
    return true
  } catch {
    return false
  }
}
