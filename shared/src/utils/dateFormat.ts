/*
  Native replacements for the few dayjs features IPP used: its default
  timestamp format, its string parsing, and a subset of its format tokens.
  Numeric tokens and English names match dayjs exactly; other locales'
  names come from Intl (CLDR) and match dayjs 1.11's own locale data for long
  names, with known differences in some short names - see formatDate.
*/

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

// Token/literal matcher: longer tokens are listed before their prefixes
// (YYYY before YY, MMMM before MMM before MM before M, ...) so the
// alternation - which JS regex resolves left-to-right, not longest-match -
// picks the right one. `[...]` is dayjs's own escape syntax for literal text.
const TOKEN_PATTERN =
  /\[([^\]]+)]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|SSS|ZZ|Z|A|a/g

/**
 * The local UTC offset as `+HH:mm` (or `+HHmm` without the colon), as dayjs
 * prints it - including its rounding to a quarter hour, which only matters for
 * historical local-mean-time offsets.
 */
function zone(date: Date, separator: string): string {
  const offset = -Math.round(date.getTimezoneOffset() / 15) * 15
  const abs = Math.abs(offset)
  return (offset >= 0 ? '+' : '-') + pad(Math.floor(abs / 60)) + separator + pad(abs % 60)
}

// dayjs's default `format()` pattern, e.g. `2026-07-10T14:00:00+02:00`
const DEFAULT_FORMAT = 'YYYY-MM-DDTHH:mm:ssZ'

// dayjs's locales whose long month names change case after a day number
// (ru `10 июля` vs standalone `июль`), with the regex each one tests against
// the whole format string to pick the genitive form. Other locales - Czech
// included - always use the standalone (nominative) name in dayjs.
const DAY_THEN_MONTH = /D[oD]?(\[[^[\]]*\]|\s)+MMMM?/
const GENITIVE_MONTH_CONTEXT: Record<string, RegExp> = {
  be: DAY_THEN_MONTH,
  hr: DAY_THEN_MONTH,
  ru: DAY_THEN_MONTH,
  uk: DAY_THEN_MONTH,
  lt: /D[oD]?(\[[^[\]]*\]|\s)+MMMM?|MMMM?(\[[^[\]]*\]|\s)+D[oD]?/,
  pl: /D MMMM/
}

// dayjs's locales with their own meridiem names instead of AM/PM. Those
// mapped to `true` split the day into more than two periods (zh `晚上` in the
// evening, ru `утра`/`дня`/`вечера`/`ночи`), which Intl's flexible
// `dayPeriod` mirrors; the rest use the locale's plain AM/PM equivalent.
const LOCAL_MERIDIEM: Record<string, boolean> = {
  ar: false,
  be: true,
  bn: true,
  br: false,
  ja: false,
  km: false,
  ko: false,
  ku: false,
  ru: true,
  zh: true
}

/** One named part (`month`, `dayPeriod`, ...) of an Intl-formatted date. */
function intlPart(
  date: Date,
  loc: string | string[],
  options: Intl.DateTimeFormatOptions,
  type: Intl.DateTimeFormatPartTypes
): string {
  const part = new Intl.DateTimeFormat(loc, options).formatToParts(date).find(p => p.type === type)
  return part?.value ?? ''
}

/**
 * Format a Date using a subset of dayjs's format tokens, backed by native
 * Intl.DateTimeFormat for locale-aware month/weekday/meridiem names. All
 * numeric tokens read the Date in the server's local time, matching dayjs's
 * (non-UTC-plugin) default behaviour. `locale` defaults to English, same as
 * dayjs's own default, rather than the process's system locale - so output
 * is deterministic regardless of the host's ICU configuration.
 *
 * English output is identical to dayjs. For other locales, long month and
 * weekday names (including dayjs's genitive month after a day number in
 * ru/uk/pl/...) and meridiems match dayjs 1.11; short names (`MMM`, `ddd`,
 * `dd`) follow Intl's CLDR data, which for some locales differs from dayjs's
 * own (German `Feb` where dayjs printed `Feb.`). The table test in
 * dateFormat.test.ts pins both the matches and the known differences. An
 * empty pattern means the default, as with dayjs.
 */
export function formatDate(date: Date, pattern: string, locale?: string): string {
  // English as the fallback, as with dayjs, for a well-formed tag Intl has no data for
  const loc = locale ? [locale, 'en'] : 'en'
  const language = (locale ?? 'en').toLowerCase().split(/[-_]/)[0]
  const format = pattern || DEFAULT_FORMAT
  const genitive = GENITIVE_MONTH_CONTEXT[language]?.test(format) ?? false
  const hours24 = date.getHours()
  const hours12 = hours24 % 12 || 12
  const meridiem = (upper: boolean): string => {
    const flexible = LOCAL_MERIDIEM[language]
    if (flexible === undefined)
      return upper ? (hours24 < 12 ? 'AM' : 'PM') : hours24 < 12 ? 'am' : 'pm'
    const options: Intl.DateTimeFormatOptions = flexible
      ? { hour: 'numeric', hourCycle: 'h12', dayPeriod: 'short' }
      : { hour: 'numeric', hourCycle: 'h12' }
    return intlPart(date, loc, options, 'dayPeriod')
  }
  const tokens: Record<string, () => string> = {
    YYYY: () => pad(date.getFullYear(), 4),
    YY: () => String(date.getFullYear()).slice(-2),
    MMMM: () =>
      genitive
        ? intlPart(date, loc, { day: 'numeric', month: 'long' }, 'month')
        : new Intl.DateTimeFormat(loc, { month: 'long' }).format(date),
    MMM: () => new Intl.DateTimeFormat(loc, { month: 'short' }).format(date),
    MM: () => pad(date.getMonth() + 1),
    M: () => String(date.getMonth() + 1),
    DD: () => pad(date.getDate()),
    D: () => String(date.getDate()),
    dddd: () => new Intl.DateTimeFormat(loc, { weekday: 'long' }).format(date),
    ddd: () => new Intl.DateTimeFormat(loc, { weekday: 'short' }).format(date),
    // dayjs's minimal weekday name (en `Fr`): Intl has no such width, so take
    // the short name's first two characters (dayjs's own fallback), or
    // Chinese's one-character narrow name where the short one is `周五`
    dd: () =>
      language === 'zh'
        ? new Intl.DateTimeFormat(loc, { weekday: 'narrow' }).format(date)
        : new Intl.DateTimeFormat(loc, { weekday: 'short' })
            .format(date)
            .replace(/\.$/, '')
            .slice(0, 2),
    d: () => String(date.getDay()),
    HH: () => pad(hours24),
    H: () => String(hours24),
    hh: () => pad(hours12),
    h: () => String(hours12),
    mm: () => pad(date.getMinutes()),
    m: () => String(date.getMinutes()),
    ss: () => pad(date.getSeconds()),
    s: () => String(date.getSeconds()),
    SSS: () => pad(date.getMilliseconds(), 3),
    ZZ: () => zone(date, ''),
    Z: () => zone(date, ':'),
    A: () => meridiem(true),
    a: () => meridiem(false)
  }
  return format.replace(TOKEN_PATTERN, (match, literal: string | undefined) =>
    literal !== undefined ? literal : tokens[match]()
  )
}

/**
 * The current local time as `2026-07-10T14:00:00+02:00`: dayjs's default
 * `format()` output, used for log and cookie-expiry timestamps.
 */
export function localTimestamp(date: Date = new Date()): string {
  return formatDate(date, DEFAULT_FORMAT)
}

// dayjs's own parse pattern: a date and optional time with no zone designator
const LOCAL_DATE_PATTERN =
  /^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[Tt\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$/

/**
 * Parse a date string the way `dayjs(value)` does: a zone-less date or
 * date-time (`2026-07-10`, `2026-07-10 14:00`) is read as local time, where
 * `new Date()` would read a bare date as UTC; anything else goes to the native
 * parser. The result is an Invalid Date (NaN time) when unparseable.
 */
export function parseDate(value: string): Date {
  if (!/Z$/i.test(value)) {
    const d = value.match(LOCAL_DATE_PATTERN)
    if (d) {
      return new Date(
        Number(d[1]),
        Number(d[2]) - 1 || 0,
        Number(d[3] || 1),
        Number(d[4] || 0),
        Number(d[5] || 0),
        Number(d[6] || 0),
        Number((d[7] || '0').substring(0, 3))
      )
    }
  }
  return new Date(value)
}

/** True unless `date` is an Invalid Date. */
export function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime())
}

/**
 * True if Intl.DateTimeFormat accepts `locale` as a well-formed tag. Doesn't
 * guarantee the locale has real translations - Intl silently best-fits
 * unrecognised-but-valid tags to a fallback, same as dayjs falling back to
 * English for a locale it doesn't bundle.
 */
export function isSupportedLocale(locale: string): boolean {
  try {
    // The same well-formedness check Intl.DateTimeFormat's constructor makes
    Intl.getCanonicalLocales(locale)
    return true
  } catch {
    return false
  }
}
