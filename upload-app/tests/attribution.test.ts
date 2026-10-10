import { describe, it, expect, afterEach } from 'vitest'
import {
  describeUpload,
  readAttribution,
  sanitizeCaption,
  sanitizeUploaderName
} from '../src/attribution'

const KEY_BEFORE = process.env.IMMICH_API_KEY

afterEach(() => {
  if (KEY_BEFORE === undefined) delete process.env.IMMICH_API_KEY
  else process.env.IMMICH_API_KEY = KEY_BEFORE
})

// Zero-width and bidi format characters: invisible, or able to make text display reversed
const INVISIBLE = [
  ['U+200B zero width space', '\u200B'],
  ['U+200C zero width non-joiner', '\u200C'],
  ['U+200D zero width joiner', '\u200D'],
  ['U+200E left-to-right mark', '\u200E'],
  ['U+200F right-to-left mark', '\u200F'],
  ['U+2060 word joiner', '\u2060'],
  ['U+FEFF byte order mark', '\uFEFF'],
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

describe('sanitizeUploaderName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeUploaderName('Alice')).toBe('Alice')
  })

  it('strips C0 controls, tab and newline included', () => {
    expect(sanitizeUploaderName('bad\x00name')).toBe('badname')
    expect(sanitizeUploaderName('tab\there')).toBe('tabhere')
    expect(sanitizeUploaderName('new\nline')).toBe('newline')
  })

  it('strips the ESC that starts an ANSI escape sequence', () => {
    expect(sanitizeUploaderName('\x1b[31mred\x1b[0m')).toBe('[31mred[0m')
  })

  it('strips C1 controls', () => {
    expect(sanitizeUploaderName('a\x7fb\x80c\x9fd')).toBe('abcd')
  })

  it.each(INVISIBLE)('strips %s', (_label, char) => {
    expect(sanitizeUploaderName(`Alice${char}Bob`)).toBe('AliceBob')
  })

  it('defeats a right-to-left override spoof', () => {
    expect(sanitizeUploaderName('evil\u202Elive.dsg')).toBe('evillive.dsg')
  })

  it('trims, including whitespace left once controls are gone', () => {
    expect(sanitizeUploaderName('  Alice  ')).toBe('Alice')
    expect(sanitizeUploaderName('\x00 Alice \x01')).toBe('Alice')
  })

  it('caps the name at 100 characters', () => {
    expect(sanitizeUploaderName('a'.repeat(150))).toBe('a'.repeat(100))
    expect(sanitizeUploaderName('b'.repeat(100))).toBe('b'.repeat(100))
  })

  it('never leaves half of a surrogate pair when the cap splits an emoji', () => {
    const out = sanitizeUploaderName('a'.repeat(99) + '🎉')
    expect(out).toBe('a'.repeat(99))
    expect(out!.isWellFormed()).toBe(true)
  })

  it('keeps accents, CJK, right-to-left script and emoji', () => {
    expect(sanitizeUploaderName('Zoë 李明 عمر שלום 🎉')).toBe('Zoë 李明 عمر שלום 🎉')
  })

  it('keeps the characters a filename sanitiser would remove', () => {
    expect(sanitizeUploaderName('Ana "AJ" O\'Neil: 2/3?')).toBe('Ana "AJ" O\'Neil: 2/3?')
  })

  it.each([[''], ['   '], ['\x00\x1b\x7f'], ['\u200B\u202E\uFEFF']])(
    'returns undefined for %j, which leaves nothing',
    raw => {
      expect(sanitizeUploaderName(raw)).toBeUndefined()
    }
  )

  it('returns undefined for anything but a string, such as a repeated parameter', () => {
    expect(sanitizeUploaderName(['Alice', 'Bob'])).toBeUndefined()
    expect(sanitizeUploaderName(undefined)).toBeUndefined()
    expect(sanitizeUploaderName({ toString: () => 'x' })).toBeUndefined()
  })
})

describe('sanitizeCaption', () => {
  it('keeps newlines and tabs', () => {
    expect(sanitizeCaption('line one\nline two\ttabbed')).toBe('line one\nline two\ttabbed')
  })

  it('strips other controls and format characters', () => {
    expect(sanitizeCaption('bad\x00text\x1b[31m\u202E!')).toBe('badtext[31m!')
  })

  it('keeps punctuation and non-Latin text', () => {
    expect(sanitizeCaption('生日快乐! 🎂 très bien? "yes": <3')).toBe(
      '生日快乐! 🎂 très bien? "yes": <3'
    )
  })

  it('caps at 500 characters without splitting a surrogate pair', () => {
    expect(sanitizeCaption('x'.repeat(600))).toBe('x'.repeat(500))
    expect(sanitizeCaption('x'.repeat(499) + '🎂🎂')).toBe('x'.repeat(499))
  })

  it('returns undefined for empty or whitespace-only input', () => {
    expect(sanitizeCaption('')).toBeUndefined()
    expect(sanitizeCaption('  \n\t ')).toBeUndefined()
  })
})

describe('readAttribution', () => {
  const query = { uploaderName: ' Alice\u202E ', caption: 'Cake!\x00', filename: 'a.jpg' }

  it('ignores both parameters while IMMICH_API_KEY is unset', () => {
    delete process.env.IMMICH_API_KEY
    expect(readAttribution(query)).toBeUndefined()
  })

  it('treats an empty IMMICH_API_KEY as unset', () => {
    process.env.IMMICH_API_KEY = ''
    expect(readAttribution(query)).toBeUndefined()
  })

  it('reads and sanitises both with IMMICH_API_KEY set', () => {
    process.env.IMMICH_API_KEY = 'key'
    expect(readAttribution(query)).toEqual({ uploader: 'Alice', caption: 'Cake!' })
  })

  it('leaves out a field the visitor left empty, and is undefined when both are', () => {
    process.env.IMMICH_API_KEY = 'key'
    expect(readAttribution({ caption: 'Hi' })).toEqual({ caption: 'Hi' })
    expect(readAttribution({ uploaderName: '\u200B', caption: ' ' })).toBeUndefined()
  })
})

describe('describeUpload', () => {
  it('writes the caption, then the uploader', () => {
    expect(describeUpload({ uploader: 'Alice', caption: 'Cake cutting' })).toBe(
      'Cake cutting\n\n- Uploaded by Alice'
    )
  })

  it('writes either one alone', () => {
    expect(describeUpload({ caption: 'Cake cutting' })).toBe('Cake cutting')
    expect(describeUpload({ uploader: 'Alice' })).toBe('Uploaded by Alice')
  })

  it('writes nothing for an empty attribution', () => {
    expect(describeUpload({})).toBeUndefined()
  })
})
