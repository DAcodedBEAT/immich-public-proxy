import { describe, it, expect } from 'vitest'
import {
  formatDate,
  isSupportedLocale,
  isValidDate,
  localTimestamp,
  parseDate
} from '../src/utils/dateFormat'

// These replace dayjs; the expected strings are what dayjs 1.11 printed for
// the same input. Dates are built in local time so the assertions hold in any
// timezone the tests run in.

const offset = (date: Date, separator: string) => {
  const minutes = -date.getTimezoneOffset()
  const abs = Math.abs(minutes)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (minutes >= 0 ? '+' : '-') + pad(Math.floor(abs / 60)) + separator + pad(abs % 60)
}

describe('formatDate', () => {
  const date = new Date(2026, 6, 10, 14, 5, 9, 42) // Fri 10 July 2026, 14:05:09.042

  it('formats numeric tokens with and without padding', () => {
    expect(formatDate(date, 'YYYY-MM-DD HH:mm:ss.SSS')).toBe('2026-07-10 14:05:09.042')
    expect(formatDate(date, 'YY M D H m s d')).toBe('26 7 10 14 5 9 5')
    expect(formatDate(date, 'hh:mm a h A')).toBe('02:05 pm 2 PM')
    expect(formatDate(new Date(2026, 0, 3, 0, 30), 'h:mm A')).toBe('12:30 AM')
  })

  it('pads the year to four digits', () => {
    const early = new Date(2026, 0, 1)
    early.setFullYear(999)
    expect(formatDate(early, 'YYYY')).toBe('0999')
  })

  it('renders month and weekday names in English by default', () => {
    expect(formatDate(date, 'dddd, D MMMM YYYY')).toBe('Friday, 10 July 2026')
    expect(formatDate(date, 'ddd D MMM')).toBe('Fri 10 Jul')
  })

  it('renders long names in a given locale', () => {
    expect(formatDate(date, 'dddd, D. MMMM YYYY', 'de')).toBe('Freitag, 10. Juli 2026')
  })

  it('falls back to English for a well-formed locale with no data', () => {
    expect(formatDate(date, 'MMMM', 'zz')).toBe('July')
  })

  it('keeps [bracketed] text literal', () => {
    expect(formatDate(date, '[Expires] YYYY [at] HH:mm')).toBe('Expires 2026 at 14:05')
  })

  it('prints the local UTC offset', () => {
    expect(formatDate(date, 'Z')).toBe(offset(date, ':'))
    expect(formatDate(date, 'ZZ')).toBe(offset(date, ''))
  })

  it('uses the default format for an empty pattern', () => {
    expect(formatDate(date, '')).toBe('2026-07-10T14:05:09' + offset(date, ':'))
  })
})

// Locale parity with dayjs 1.11.23: each row's fourth column is what dayjs
// printed (generated once from a throwaway dayjs install with its locale
// files loaded), and a fifth column, where present, is the known difference
// IPP prints instead - Intl's CLDR short names don't always match dayjs's
// own locale data. Those differences are listed under `expiryDateFormat` in
// docs/config/gallery.md.
describe('formatDate locale parity with dayjs', () => {
  const jul = new Date(2026, 6, 10, 14, 5, 9) // Friday
  const feb = new Date(2026, 1, 3, 9, 5, 9) // Tuesday
  const late = new Date(2026, 8, 6, 23, 0, 0) // Sunday evening
  const table: [string, string, Date, string, string?][] = [
    ['en', 'D MMMM YYYY', jul, '10 July 2026'],
    ['en', 'D MMMM YYYY', feb, '3 February 2026'],
    ['en', 'MMMM YYYY', jul, 'July 2026'],
    ['en', 'MMMM YYYY', feb, 'February 2026'],
    ['en', 'MMM', jul, 'Jul'],
    ['en', 'MMM', feb, 'Feb'],
    ['en', 'dddd', jul, 'Friday'],
    ['en', 'dddd', feb, 'Tuesday'],
    ['en', 'ddd', jul, 'Fri'],
    ['en', 'ddd', feb, 'Tue'],
    ['en', 'dd', jul, 'Fr'],
    ['en', 'dd', feb, 'Tu'],
    ['en', 'h:mm A', jul, '2:05 PM'],
    ['en', 'h:mm A', feb, '9:05 AM'],
    ['en', 'h:mm A', late, '11:00 PM'],
    ['en', 'h:mm a', jul, '2:05 pm'],
    ['en', 'h:mm a', feb, '9:05 am'],
    ['de', 'D MMMM YYYY', jul, '10 Juli 2026'],
    ['de', 'D MMMM YYYY', feb, '3 Februar 2026'],
    ['de', 'MMMM YYYY', jul, 'Juli 2026'],
    ['de', 'MMMM YYYY', feb, 'Februar 2026'],
    ['de', 'MMM', jul, 'Juli', 'Jul'],
    ['de', 'MMM', feb, 'Feb.', 'Feb'],
    ['de', 'dddd', jul, 'Freitag'],
    ['de', 'dddd', feb, 'Dienstag'],
    ['de', 'ddd', jul, 'Fr.', 'Fr'],
    ['de', 'ddd', feb, 'Di.', 'Di'],
    ['de', 'dd', jul, 'Fr'],
    ['de', 'dd', feb, 'Di'],
    ['de', 'h:mm A', jul, '2:05 PM'],
    ['de', 'h:mm A', feb, '9:05 AM'],
    ['de', 'h:mm A', late, '11:00 PM'],
    ['de', 'h:mm a', jul, '2:05 pm'],
    ['de', 'h:mm a', feb, '9:05 am'],
    ['fr', 'D MMMM YYYY', jul, '10 juillet 2026'],
    ['fr', 'D MMMM YYYY', feb, '3 février 2026'],
    ['fr', 'MMMM YYYY', jul, 'juillet 2026'],
    ['fr', 'MMMM YYYY', feb, 'février 2026'],
    ['fr', 'MMM', jul, 'juil.'],
    ['fr', 'MMM', feb, 'févr.'],
    ['fr', 'dddd', jul, 'vendredi'],
    ['fr', 'dddd', feb, 'mardi'],
    ['fr', 'ddd', jul, 'ven.'],
    ['fr', 'ddd', feb, 'mar.'],
    ['fr', 'dd', jul, 've'],
    ['fr', 'dd', feb, 'ma'],
    ['fr', 'h:mm A', jul, '2:05 PM'],
    ['fr', 'h:mm A', feb, '9:05 AM'],
    ['fr', 'h:mm A', late, '11:00 PM'],
    ['fr', 'h:mm a', jul, '2:05 pm'],
    ['fr', 'h:mm a', feb, '9:05 am'],
    ['es', 'D MMMM YYYY', jul, '10 julio 2026'],
    ['es', 'D MMMM YYYY', feb, '3 febrero 2026'],
    ['es', 'MMMM YYYY', jul, 'julio 2026'],
    ['es', 'MMMM YYYY', feb, 'febrero 2026'],
    ['es', 'MMM', jul, 'jul'],
    ['es', 'MMM', feb, 'feb'],
    ['es', 'dddd', jul, 'viernes'],
    ['es', 'dddd', feb, 'martes'],
    ['es', 'ddd', jul, 'vie.', 'vie'],
    ['es', 'ddd', feb, 'mar.', 'mar'],
    ['es', 'dd', jul, 'vi'],
    ['es', 'dd', feb, 'ma'],
    ['es', 'h:mm A', jul, '2:05 PM'],
    ['es', 'h:mm A', feb, '9:05 AM'],
    ['es', 'h:mm A', late, '11:00 PM'],
    ['es', 'h:mm a', jul, '2:05 pm'],
    ['es', 'h:mm a', feb, '9:05 am'],
    ['it', 'D MMMM YYYY', jul, '10 luglio 2026'],
    ['it', 'D MMMM YYYY', feb, '3 febbraio 2026'],
    ['it', 'MMMM YYYY', jul, 'luglio 2026'],
    ['it', 'MMMM YYYY', feb, 'febbraio 2026'],
    ['it', 'MMM', jul, 'lug'],
    ['it', 'MMM', feb, 'feb'],
    ['it', 'dddd', jul, 'venerdì'],
    ['it', 'dddd', feb, 'martedì'],
    ['it', 'ddd', jul, 'ven'],
    ['it', 'ddd', feb, 'mar'],
    ['it', 'dd', jul, 've'],
    ['it', 'dd', feb, 'ma'],
    ['it', 'h:mm A', jul, '2:05 PM'],
    ['it', 'h:mm A', feb, '9:05 AM'],
    ['it', 'h:mm A', late, '11:00 PM'],
    ['it', 'h:mm a', jul, '2:05 pm'],
    ['it', 'h:mm a', feb, '9:05 am'],
    ['nl', 'D MMMM YYYY', jul, '10 juli 2026'],
    ['nl', 'D MMMM YYYY', feb, '3 februari 2026'],
    ['nl', 'MMMM YYYY', jul, 'juli 2026'],
    ['nl', 'MMMM YYYY', feb, 'februari 2026'],
    ['nl', 'MMM', jul, 'jul'],
    ['nl', 'MMM', feb, 'feb'],
    ['nl', 'dddd', jul, 'vrijdag'],
    ['nl', 'dddd', feb, 'dinsdag'],
    ['nl', 'ddd', jul, 'vr.', 'vr'],
    ['nl', 'ddd', feb, 'di.', 'di'],
    ['nl', 'dd', jul, 'vr'],
    ['nl', 'dd', feb, 'di'],
    ['nl', 'h:mm A', jul, '2:05 PM'],
    ['nl', 'h:mm A', feb, '9:05 AM'],
    ['nl', 'h:mm A', late, '11:00 PM'],
    ['nl', 'h:mm a', jul, '2:05 pm'],
    ['nl', 'h:mm a', feb, '9:05 am'],
    ['ru', 'D MMMM YYYY', jul, '10 июля 2026'],
    ['ru', 'D MMMM YYYY', feb, '3 февраля 2026'],
    ['ru', 'MMMM YYYY', jul, 'июль 2026'],
    ['ru', 'MMMM YYYY', feb, 'февраль 2026'],
    ['ru', 'MMM', jul, 'июль'],
    ['ru', 'MMM', feb, 'февр.'],
    ['ru', 'dddd', jul, 'пятница'],
    ['ru', 'dddd', feb, 'вторник'],
    ['ru', 'ddd', jul, 'птн', 'пт'],
    ['ru', 'ddd', feb, 'втр', 'вт'],
    ['ru', 'dd', jul, 'пт'],
    ['ru', 'dd', feb, 'вт'],
    ['ru', 'h:mm A', jul, '2:05 дня'],
    ['ru', 'h:mm A', feb, '9:05 утра'],
    ['ru', 'h:mm A', late, '11:00 вечера', '11:00 ночи'],
    ['ru', 'h:mm a', jul, '2:05 дня'],
    ['ru', 'h:mm a', feb, '9:05 утра'],
    ['pl', 'D MMMM YYYY', jul, '10 lipca 2026'],
    ['pl', 'D MMMM YYYY', feb, '3 lutego 2026'],
    ['pl', 'MMMM YYYY', jul, 'lipiec 2026'],
    ['pl', 'MMMM YYYY', feb, 'luty 2026'],
    ['pl', 'MMM', jul, 'lip'],
    ['pl', 'MMM', feb, 'lut'],
    ['pl', 'dddd', jul, 'piątek'],
    ['pl', 'dddd', feb, 'wtorek'],
    ['pl', 'ddd', jul, 'pt', 'pt.'],
    ['pl', 'ddd', feb, 'wt', 'wt.'],
    ['pl', 'dd', jul, 'Pt', 'pt'],
    ['pl', 'dd', feb, 'Wt', 'wt'],
    ['pl', 'h:mm A', jul, '2:05 PM'],
    ['pl', 'h:mm A', feb, '9:05 AM'],
    ['pl', 'h:mm A', late, '11:00 PM'],
    ['pl', 'h:mm a', jul, '2:05 pm'],
    ['pl', 'h:mm a', feb, '9:05 am'],
    ['uk', 'D MMMM YYYY', jul, '10 липня 2026'],
    ['uk', 'D MMMM YYYY', feb, '3 лютого 2026'],
    ['uk', 'MMMM YYYY', jul, 'липень 2026'],
    ['uk', 'MMMM YYYY', feb, 'лютий 2026'],
    ['uk', 'MMM', jul, 'лип', 'лип.'],
    ['uk', 'MMM', feb, 'лют', 'лют.'],
    ['uk', 'dddd', jul, 'п’ятниця', 'пʼятниця'],
    ['uk', 'dddd', feb, 'вівторок'],
    ['uk', 'ddd', jul, 'птн', 'пт'],
    ['uk', 'ddd', feb, 'втр', 'вт'],
    ['uk', 'dd', jul, 'пт'],
    ['uk', 'dd', feb, 'вт'],
    ['uk', 'h:mm A', jul, '2:05 PM'],
    ['uk', 'h:mm A', feb, '9:05 AM'],
    ['uk', 'h:mm A', late, '11:00 PM'],
    ['uk', 'h:mm a', jul, '2:05 pm'],
    ['uk', 'h:mm a', feb, '9:05 am'],
    ['cs', 'D MMMM YYYY', jul, '10 červenec 2026'],
    ['cs', 'D MMMM YYYY', feb, '3 únor 2026'],
    ['cs', 'MMMM YYYY', jul, 'červenec 2026'],
    ['cs', 'MMMM YYYY', feb, 'únor 2026'],
    ['cs', 'MMM', jul, 'čvc'],
    ['cs', 'MMM', feb, 'úno'],
    ['cs', 'dddd', jul, 'pátek'],
    ['cs', 'dddd', feb, 'úterý'],
    ['cs', 'ddd', jul, 'pá'],
    ['cs', 'ddd', feb, 'út'],
    ['cs', 'dd', jul, 'pá'],
    ['cs', 'dd', feb, 'út'],
    ['cs', 'h:mm A', jul, '2:05 PM'],
    ['cs', 'h:mm A', feb, '9:05 AM'],
    ['cs', 'h:mm A', late, '11:00 PM'],
    ['cs', 'h:mm a', jul, '2:05 pm'],
    ['cs', 'h:mm a', feb, '9:05 am'],
    ['ja', 'D MMMM YYYY', jul, '10 7月 2026'],
    ['ja', 'D MMMM YYYY', feb, '3 2月 2026'],
    ['ja', 'MMMM YYYY', jul, '7月 2026'],
    ['ja', 'MMMM YYYY', feb, '2月 2026'],
    ['ja', 'MMM', jul, '7月'],
    ['ja', 'MMM', feb, '2月'],
    ['ja', 'dddd', jul, '金曜日'],
    ['ja', 'dddd', feb, '火曜日'],
    ['ja', 'ddd', jul, '金'],
    ['ja', 'ddd', feb, '火'],
    ['ja', 'dd', jul, '金'],
    ['ja', 'dd', feb, '火'],
    ['ja', 'h:mm A', jul, '2:05 午後'],
    ['ja', 'h:mm A', feb, '9:05 午前'],
    ['ja', 'h:mm A', late, '11:00 午後'],
    ['ja', 'h:mm a', jul, '2:05 午後'],
    ['ja', 'h:mm a', feb, '9:05 午前'],
    ['zh-cn', 'D MMMM YYYY', jul, '10 七月 2026'],
    ['zh-cn', 'D MMMM YYYY', feb, '3 二月 2026'],
    ['zh-cn', 'MMMM YYYY', jul, '七月 2026'],
    ['zh-cn', 'MMMM YYYY', feb, '二月 2026'],
    ['zh-cn', 'MMM', jul, '7月'],
    ['zh-cn', 'MMM', feb, '2月'],
    ['zh-cn', 'dddd', jul, '星期五'],
    ['zh-cn', 'dddd', feb, '星期二'],
    ['zh-cn', 'ddd', jul, '周五'],
    ['zh-cn', 'ddd', feb, '周二'],
    ['zh-cn', 'dd', jul, '五'],
    ['zh-cn', 'dd', feb, '二'],
    ['zh-cn', 'h:mm A', jul, '2:05 下午'],
    ['zh-cn', 'h:mm A', feb, '9:05 上午'],
    ['zh-cn', 'h:mm A', late, '11:00 晚上'],
    ['zh-cn', 'h:mm a', jul, '2:05 下午'],
    ['zh-cn', 'h:mm a', feb, '9:05 上午'],
    ['pt', 'D MMMM YYYY', jul, '10 julho 2026'],
    ['pt', 'D MMMM YYYY', feb, '3 fevereiro 2026'],
    ['pt', 'MMMM YYYY', jul, 'julho 2026'],
    ['pt', 'MMMM YYYY', feb, 'fevereiro 2026'],
    ['pt', 'MMM', jul, 'jul', 'jul.'],
    ['pt', 'MMM', feb, 'fev', 'fev.'],
    ['pt', 'dddd', jul, 'sexta-feira'],
    ['pt', 'dddd', feb, 'terça-feira'],
    ['pt', 'ddd', jul, 'sex', 'sex.'],
    ['pt', 'ddd', feb, 'ter', 'ter.'],
    ['pt', 'dd', jul, '6ª', 'se'],
    ['pt', 'dd', feb, '3ª', 'te'],
    ['pt', 'h:mm A', jul, '2:05 PM'],
    ['pt', 'h:mm A', feb, '9:05 AM'],
    ['pt', 'h:mm A', late, '11:00 PM'],
    ['pt', 'h:mm a', jul, '2:05 pm'],
    ['pt', 'h:mm a', feb, '9:05 am'],
    ['sv', 'D MMMM YYYY', jul, '10 juli 2026'],
    ['sv', 'D MMMM YYYY', feb, '3 februari 2026'],
    ['sv', 'MMMM YYYY', jul, 'juli 2026'],
    ['sv', 'MMMM YYYY', feb, 'februari 2026'],
    ['sv', 'MMM', jul, 'jul', 'juli'],
    ['sv', 'MMM', feb, 'feb', 'feb.'],
    ['sv', 'dddd', jul, 'fredag'],
    ['sv', 'dddd', feb, 'tisdag'],
    ['sv', 'ddd', jul, 'fre'],
    ['sv', 'ddd', feb, 'tis'],
    ['sv', 'dd', jul, 'fr'],
    ['sv', 'dd', feb, 'ti'],
    ['sv', 'h:mm A', jul, '2:05 PM'],
    ['sv', 'h:mm A', feb, '9:05 AM'],
    ['sv', 'h:mm A', late, '11:00 PM'],
    ['sv', 'h:mm a', jul, '2:05 pm'],
    ['sv', 'h:mm a', feb, '9:05 am']
  ]

  it.each(table)('%s %s %s', (locale, pattern, date, dayjs, known) => {
    expect(formatDate(date, pattern, locale)).toBe(known ?? dayjs)
  })

  it('uses the nominative month without a day before it, as dayjs does', () => {
    expect(formatDate(jul, 'MMMM', 'ru')).toBe('июль')
    expect(formatDate(jul, 'MMMM D', 'pl')).toBe('lipiec 10')
    expect(formatDate(jul, 'D MMMM YYYY', 'cs')).toBe('10 červenec 2026')
  })

  it('reads the genitive rule from the language subtag', () => {
    expect(formatDate(jul, 'D MMMM', 'ru-RU')).toBe('10 июля')
  })
})

describe('localTimestamp', () => {
  it('matches dayjs().format()', () => {
    const date = new Date(2026, 6, 10, 14, 5, 9)
    expect(localTimestamp(date)).toBe('2026-07-10T14:05:09' + offset(date, ':'))
  })

  it('round-trips through parseDate to the second', () => {
    const date = new Date(2026, 6, 10, 14, 5, 9)
    expect(parseDate(localTimestamp(date)).getTime()).toBe(date.getTime())
  })
})

describe('parseDate', () => {
  it('reads a UTC or offset timestamp natively', () => {
    expect(parseDate('2026-09-14T07:18:00.000Z').toISOString()).toBe('2026-09-14T07:18:00.000Z')
    expect(parseDate('2026-09-14T07:18:00+05:00').toISOString()).toBe('2026-09-14T02:18:00.000Z')
  })

  it('reads a zone-less date or date-time as local time', () => {
    expect(parseDate('2026-09-14').getTime()).toBe(new Date(2026, 8, 14).getTime())
    expect(parseDate('2026-09-14 07:18').getTime()).toBe(new Date(2026, 8, 14, 7, 18).getTime())
    expect(parseDate('2026/9/4').getTime()).toBe(new Date(2026, 8, 4).getTime())
    expect(parseDate('20260914').getTime()).toBe(new Date(2026, 8, 14).getTime())
    expect(parseDate('2026').getTime()).toBe(new Date(2026, 0, 1).getTime())
  })

  it('keeps milliseconds to three digits', () => {
    expect(parseDate('2026-09-14T07:18:00.123456').getTime()).toBe(
      new Date(2026, 8, 14, 7, 18, 0, 123).getTime()
    )
  })

  it('gives an Invalid Date for junk', () => {
    expect(isValidDate(parseDate('not a date'))).toBe(false)
    expect(isValidDate(parseDate('2026-09-14T07:18:00Z'))).toBe(true)
  })
})

describe('isSupportedLocale', () => {
  it('accepts well-formed tags and rejects malformed ones', () => {
    expect(isSupportedLocale('de')).toBe(true)
    expect(isSupportedLocale('en-GB')).toBe(true)
    expect(isSupportedLocale('../en')).toBe(false)
  })
})
