import { describe, it, expect } from 'vitest'
import { isId, isKey } from '../src/immich'

/*
  isKey/isId gate almost every route (resolveShare/resolveSharedAsset call
  them before doing anything else with req.params.key/id), including the
  password-required redirect in index.ts (`res.redirect('/share/' +
  req.params.key)`). A fallow security scan flagged that redirect as an
  open-redirect candidate (non-literal target passed to res.redirect); an
  Opus-subagent deep-dive confirmed it's a false positive specifically
  BECAUSE isKey's [\w-]+ pattern can't produce a protocol-relative or
  CRLF-injecting value - but neither validator had any direct test
  coverage before this. These tests pin that property down explicitly,
  independent of the route wiring, so a future loosening of the regex
  (the isKey doc-comment says the format is deliberately left open-ended)
  gets caught here rather than only in a deep security audit.
*/

describe('isKey', () => {
  it('accepts realistic Immich share keys', () => {
    expect(isKey('a'.repeat(67))).toBe(true)
    expect(isKey('AbC123_-xyz')).toBe(true)
    expect(isKey('my-album-slug')).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isKey('')).toBe(false)
  })

  it.each([
    ['//evil.com', 'protocol-relative (decoded from %2F%2Fevil.com)'],
    ['/\\evil.com', 'backslash-as-slash browser quirk'],
    ['../../evil.com', 'path traversal'],
    ['\t//evil.com', 'leading tab before protocol-relative'],
    ['x\r\nX-Injected: 1', 'CRLF header injection'],
    ['https://evil.com', 'absolute URL with scheme'],
    ['evil.com', 'bare hostname with a dot'],
    ['key/../../etc/passwd', 'embedded slash'],
    ['key?redirect=evil.com', 'query-string injection'],
    ['key#evil.com', 'fragment injection'],
    ['key%00nullbyte', 'literal percent-encoded null (undecoded)'],
    ['key\x00null', 'raw null byte'],
    ['key with spaces', 'spaces'],
    ['ключ', 'non-ASCII (Cyrillic)']
  ])('rejects %j (%s)', key => {
    expect(isKey(key)).toBe(false)
  })

  it('fuzz: never accepts a value containing any non-word, non-hyphen character', () => {
    const dangerousChars = [
      '/',
      '\\',
      '.',
      ':',
      '?',
      '#',
      '%',
      ' ',
      '\t',
      '\r',
      '\n',
      '\x00',
      '@',
      '&'
    ]
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let trial = 0; trial < 200; trial++) {
      const len = 1 + Math.floor(rand() * 20)
      const chars = Array.from({ length: len }, () => {
        if (rand() < 0.3) {
          return dangerousChars[Math.floor(rand() * dangerousChars.length)]
        }
        return 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'[
          Math.floor(rand() * 64)
        ]
      })
      const candidate = chars.join('')
      const containsDangerous = dangerousChars.some(c => candidate.includes(c))
      expect(isKey(candidate)).toBe(!containsDangerous)
    }
  })
})

describe('isId', () => {
  it('accepts a well-formed UUID', () => {
    expect(isId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true)
  })

  it.each([
    ['', 'empty string'],
    ['not-a-uuid', 'garbage'],
    ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeeeXX', 'trailing extra characters'],
    ['../../etc/passwd', 'path traversal'],
    ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\r\nX-Injected: 1', 'CRLF injection appended'],
    ['AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', 'uppercase hex (regex is lowercase-only)']
  ])('rejects %j (%s)', id => {
    expect(isId(id)).toBe(false)
  })
})

describe('redirect defence-in-depth (encodeURIComponent over an already-valid key)', () => {
  // index.ts builds the password-required redirect as
  // '/share/' + encodeURIComponent(req.params.key). isKey already rejects
  // every dangerous payload before this point, so encodeURIComponent is a
  // no-op for anything that reaches it today - but it must ALSO neutralize
  // the same adversarial payloads on their own, so the redirect stays safe
  // even if isKey's validation is ever loosened.
  it('is a no-op for any key that isKey currently accepts', () => {
    const validKeys = ['a'.repeat(67), 'AbC123_-xyz', 'my-album-slug', 'x'.repeat(1)]
    for (const key of validKeys) {
      expect(isKey(key)).toBe(true)
      expect(encodeURIComponent(key)).toBe(key)
    }
  })

  it.each([
    '//evil.com',
    '/\\evil.com',
    '../../evil.com',
    'https://evil.com',
    'x\r\nX-Injected: 1',
    'key?redirect=evil.com',
    'key#evil.com'
  ])('neutralizes %j so it can never start a redirect target with "//" or inject a header', key => {
    const target = '/share/' + encodeURIComponent(key)
    expect(target.startsWith('/share/')).toBe(true)
    // Nothing after the fixed '/share/' prefix can reintroduce a raw '/',
    // '\\', or CR/LF once percent-encoded.
    const suffix = target.slice('/share/'.length)
    expect(suffix).not.toMatch(/[/\\\r\n]/)
  })
})
