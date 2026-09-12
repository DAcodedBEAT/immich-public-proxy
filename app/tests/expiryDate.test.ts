import { describe, it, expect, beforeEach } from 'vitest'
import { expiryDate } from '../src/share'
import { loadConfig } from '../src/config/loader'
import { KeyType, SharedLink } from '../src/types'

// expiryDate formats the share's Immich expiry for the gallery subtitle. It is
// gated behind ipp.gallery.showExpiryDate (default off) and formatted with
// ipp.gallery.expiryDateFormat (a dayjs-style token string, default ISO 8601 date).

function setConfig(config: unknown) {
  process.env.CONFIG = JSON.stringify(config)
  loadConfig()
}

const share = (expiresAt: string | null): SharedLink => ({
  key: 'k',
  keyType: KeyType.key,
  type: 'ALBUM',
  assets: [],
  expiresAt
})

// 2026-07-10T12:00:00.000Z - noon UTC, so the local calendar date is 2026-07-10
// in any real-world timezone (the test environment runs in UTC).
const EXPIRES = '2026-07-10T12:00:00.000Z'

describe('expiryDate', () => {
  beforeEach(() => {
    delete process.env.CONFIG
    loadConfig()
  })

  it('returns undefined when the feature is off (default)', () => {
    setConfig({})
    expect(expiryDate(share(EXPIRES))).toBeUndefined()
  })

  it('returns undefined when the share never expires, even if enabled', () => {
    setConfig({ ipp: { gallery: { showExpiryDate: true } } })
    expect(expiryDate(share(null))).toBeUndefined()
  })

  it('formats as an ISO 8601 date by default when enabled', () => {
    setConfig({ ipp: { gallery: { showExpiryDate: true } } })
    expect(expiryDate(share(EXPIRES))).toBe('2026-07-10')
  })

  it('honours a custom format string', () => {
    setConfig({ ipp: { gallery: { showExpiryDate: true, expiryDateFormat: 'D MMMM YYYY' } } })
    expect(expiryDate(share(EXPIRES))).toBe('10 July 2026')
  })

  it('falls back to the default format when the config value is not a usable string', () => {
    setConfig({ ipp: { gallery: { showExpiryDate: true, expiryDateFormat: '' } } })
    expect(expiryDate(share(EXPIRES))).toBe('2026-07-10')
  })

  it('returns undefined for an unparseable expiry date', () => {
    setConfig({ ipp: { gallery: { showExpiryDate: true } } })
    expect(expiryDate(share('not-a-date'))).toBeUndefined()
  })

  it('localises name tokens with a configured expiryDateLocale', () => {
    setConfig({
      ipp: {
        gallery: { showExpiryDate: true, expiryDateFormat: 'D MMMM YYYY', expiryDateLocale: 'de' }
      }
    })
    // "10 Juli 2026" in German, not "10 July 2026"
    expect(expiryDate(share(EXPIRES))).toBe('10 Juli 2026')
  })

  it('accepts a locale case-insensitively', () => {
    setConfig({
      ipp: {
        gallery: { showExpiryDate: true, expiryDateFormat: 'D MMMM YYYY', expiryDateLocale: 'DE' }
      }
    })
    expect(expiryDate(share(EXPIRES))).toBe('10 Juli 2026')
  })

  it('falls back to English for a malformed locale', () => {
    setConfig({
      ipp: {
        gallery: {
          showExpiryDate: true,
          expiryDateFormat: 'D MMMM YYYY',
          expiryDateLocale: '../en'
        }
      }
    })
    expect(expiryDate(share(EXPIRES))).toBe('10 July 2026')
  })
})
