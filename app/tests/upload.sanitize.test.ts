import { describe, it, expect } from 'vitest'
import { sanitizeCaption, sanitizeUploaderName } from '../src/upload/sanitize'

describe('sanitizeUploaderName', () => {
  it('returns the value unchanged when it contains no control chars', () => {
    expect(sanitizeUploaderName('Alice')).toBe('Alice')
  })

  it('strips C0 control characters (0x00–0x1f)', () => {
    expect(sanitizeUploaderName('bad\x00name')).toBe('badname')
    expect(sanitizeUploaderName('tab\there')).toBe('tabhere')
    expect(sanitizeUploaderName('newline\nhere')).toBe('newlinehere')
  })

  it('strips ESC character from ANSI escape sequences (0x1b is in C0 range)', () => {
    // \x1b is stripped; '[', '3', '1', 'm' etc. are printable and kept.
    // So '\x1b[31mred\x1b[0m' → '[31mred[0m'
    expect(sanitizeUploaderName('\x1b[31mred\x1b[0m')).toBe('[31mred[0m')
  })

  it('strips C1 control characters (0x7f–0x9f)', () => {
    expect(sanitizeUploaderName('bad\x7fname')).toBe('badname')
    expect(sanitizeUploaderName('bad\x9fname')).toBe('badname')
    expect(sanitizeUploaderName('bad\x80name')).toBe('badname')
  })

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeUploaderName('  Alice  ')).toBe('Alice')
  })

  it('caps the result at 100 characters', () => {
    const long = 'a'.repeat(150)
    expect(sanitizeUploaderName(long)).toBe('a'.repeat(100))
  })

  it('returns undefined for empty string', () => {
    expect(sanitizeUploaderName('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only string', () => {
    expect(sanitizeUploaderName('   ')).toBeUndefined()
  })

  it('returns undefined for all-control-char string', () => {
    expect(sanitizeUploaderName('\x00\x1b\x7f')).toBeUndefined()
  })

  it('strips control chars then trims so surrounding whitespace after strip is also removed', () => {
    // Control chars on both sides, then spaces: '\x00 Alice \x01'
    expect(sanitizeUploaderName('\x00 Alice \x01')).toBe('Alice')
  })

  it('returns exactly 100 chars when input is exactly 100 printable chars', () => {
    const exact = 'b'.repeat(100)
    expect(sanitizeUploaderName(exact)).toBe(exact)
  })

  it('passes non-ASCII Unicode through untouched (accents, CJK, RTL, emoji)', () => {
    expect(sanitizeUploaderName('Zoë 李明 عمر 🎉')).toBe('Zoë 李明 عمر 🎉')
  })

  it('never leaves an unpaired surrogate when the length cap splits an emoji', () => {
    // 99 chars then an emoji (2 UTF-16 units) - slice(0,100) would cut it in half
    const input = 'a'.repeat(99) + '🎉'
    const out = sanitizeUploaderName(input) as string
    expect(out).toBe('a'.repeat(99))
    expect(out).toEqual(out.normalize()) // well-formed - normalize throws on lone surrogates in some engines
  })

  describe('invisible/bidi spoofing chars (fuzzed)', () => {
    // These are Unicode "format" characters with no legitimate use in a
    // display name: they either render nothing (zero-width) or change which
    // direction surrounding text renders in (bidi override/isolate), which
    // is enough to make "eviltxt.exe" display as "exe.txtlivee" in a UI or
    // log viewer that doesn't defend against it. Real RTL text (Arabic,
    // Hebrew) needs none of these to render correctly, so stripping them
    // doesn't touch legitimate input.
    const invisibleChars = [
      ['U+200B zero width space', '\u200B'],
      ['U+200C zero width non-joiner', '\u200C'],
      ['U+200D zero width joiner', '\u200D'],
      ['U+2060 word joiner', '\u2060'],
      ['U+FEFF BOM / zero width no-break space', '\uFEFF'],
      ['U+202A LRE', '\u202A'],
      ['U+202B RLE', '\u202B'],
      ['U+202C PDF', '\u202C'],
      ['U+202D LRO', '\u202D'],
      ['U+202E RLO', '\u202E'],
      ['U+2066 LRI', '\u2066'],
      ['U+2067 RLI', '\u2067'],
      ['U+2068 FSI', '\u2068'],
      ['U+2069 PDI', '\u2069']
    ] as const

    it.each(invisibleChars)('strips %s from an uploader name', (_label, char) => {
      expect(sanitizeUploaderName(`Alice${char}Bob`)).toBe('AliceBob')
    })

    it('strips a classic RLO display-spoof so the reversed rendering cannot happen', () => {
      // Without stripping, a UI would render this as "cod.evil" instead of
      // the literal characters - the RLO flips display order from its point
      // to the next direction-reset, spoofing a fake extension/name.
      const spoofed = 'evil\u202Elive.dsg'
      expect(sanitizeUploaderName(spoofed)).toBe('evillive.dsg')
    })

    it('returns undefined when the input is entirely invisible characters', () => {
      expect(sanitizeUploaderName('\u200B\u200C\u202E\uFEFF')).toBeUndefined()
    })

    it('still passes real RTL script text through untouched', () => {
      expect(sanitizeUploaderName('عمر')).toBe('عمر')
      expect(sanitizeUploaderName('שלום')).toBe('שלום')
    })
  })
})

describe('sanitizeCaption', () => {
  it('preserves newlines and tabs (multi-line captions)', () => {
    expect(sanitizeCaption('line one\nline two\ttabbed')).toBe('line one\nline two\ttabbed')
  })

  it('strips other control characters', () => {
    expect(sanitizeCaption('bad\x00text\x1b[31m')).toBe('badtext[31m')
  })

  it('passes non-ASCII Unicode through untouched', () => {
    expect(sanitizeCaption('生日快乐! 🎂🎈 très bien')).toBe('生日快乐! 🎂🎈 très bien')
  })

  it('caps at 1000 characters without splitting a surrogate pair', () => {
    const input = 'x'.repeat(999) + '🎂🎂'
    const out = sanitizeCaption(input) as string
    expect(out).toBe('x'.repeat(999))
  })

  it('returns undefined for empty or whitespace-only input', () => {
    expect(sanitizeCaption('')).toBeUndefined()
    expect(sanitizeCaption('  \n  ')).toBeUndefined()
  })
})
