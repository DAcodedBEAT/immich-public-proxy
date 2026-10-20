import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { KeyType } from '@ipp/core'
import type { UploadPermit } from '../src/gate'
import { readCaption, sanitizeCaption } from '../src/caption'
import { captionKey } from '../src/config'
import { resetConfig, setConfig, share } from './helpers'

/*
  The caption layer's server half: the two-step gate, sanitising, and the
  description write. The write's permission memo is module state, so its
  tests import a fresh copy.
*/

const KEY_BEFORE = process.env.IMMICH_API_KEY
const ASSET = 'bbbbbbbb-0000-0000-0000-000000000003'

function restoreKey() {
  if (KEY_BEFORE === undefined) delete process.env.IMMICH_API_KEY
  else process.env.IMMICH_API_KEY = KEY_BEFORE
}

const captionsConfig = (captions: unknown) => setConfig({ ipp: { upload: { captions } } })

afterEach(() => {
  restoreKey()
  resetConfig()
})

describe('captionKey: two deliberate steps', () => {
  it('is off with neither step', () => {
    delete process.env.IMMICH_API_KEY
    resetConfig()
    expect(captionKey()).toBeUndefined()
  })

  it('is off with only IMMICH_API_KEY, as for the bulk-tag script', () => {
    process.env.IMMICH_API_KEY = 'secret-api-key'
    resetConfig()
    expect(captionKey()).toBeUndefined()
    captionsConfig(false)
    expect(captionKey()).toBeUndefined()
  })

  it('is off with only captions: true', () => {
    delete process.env.IMMICH_API_KEY
    captionsConfig(true)
    expect(captionKey()).toBeUndefined()
    process.env.IMMICH_API_KEY = ''
    expect(captionKey()).toBeUndefined()
  })

  it('takes the boolean true only', () => {
    process.env.IMMICH_API_KEY = 'secret-api-key'
    for (const value of ['true', 1, 'yes', {}]) {
      captionsConfig(value)
      expect(captionKey()).toBeUndefined()
    }
  })

  it('is the key with both', () => {
    process.env.IMMICH_API_KEY = 'secret-api-key'
    captionsConfig(true)
    expect(captionKey()).toBe('secret-api-key')
  })
})

describe('readCaption', () => {
  const query = { caption: ' Cake!\x00‮ ', filename: 'a.jpg' }

  it('ignores the parameter unless both steps are taken', () => {
    process.env.IMMICH_API_KEY = 'secret-api-key'
    captionsConfig(false)
    expect(readCaption(query)).toBeUndefined()
    delete process.env.IMMICH_API_KEY
    captionsConfig(true)
    expect(readCaption(query)).toBeUndefined()
  })

  it('reads and sanitises the caption with both', () => {
    process.env.IMMICH_API_KEY = 'secret-api-key'
    captionsConfig(true)
    expect(readCaption(query)).toBe('Cake!')
    expect(readCaption({ filename: 'a.jpg' })).toBeUndefined()
  })
})

// Zero-width and bidi format characters: invisible, or able to make text display reversed
const INVISIBLE = ['​', '‌', '‍', '‎', '‏', '⁠', '﻿', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩']

describe('sanitizeCaption', () => {
  it('keeps newlines and tabs', () => {
    expect(sanitizeCaption('line one\nline two\ttabbed')).toBe('line one\nline two\ttabbed')
  })

  it('strips other C0 and C1 controls, the ESC of an ANSI escape included', () => {
    expect(sanitizeCaption('bad\x00text\x1b[31m\x7f\x80\x9f!')).toBe('badtext[31m!')
  })

  it.each(INVISIBLE.map(char => [char.codePointAt(0)!.toString(16), char]))(
    'strips U+%s',
    (_code, char) => {
      expect(sanitizeCaption(`Cake${char}cutting`)).toBe('Cakecutting')
    }
  )

  it('keeps punctuation a filename sanitiser would remove, and non-Latin text', () => {
    expect(sanitizeCaption('生日快乐! 🎂 très bien? "yes": <3 a/b')).toBe(
      '生日快乐! 🎂 très bien? "yes": <3 a/b'
    )
  })

  it('caps at 500 characters without splitting a surrogate pair', () => {
    expect(sanitizeCaption('x'.repeat(600))).toBe('x'.repeat(500))
    const split = sanitizeCaption('x'.repeat(499) + '🎂🎂')
    expect(split).toBe('x'.repeat(499))
    expect(split!.isWellFormed()).toBe(true)
  })

  it('trims, including whitespace left once controls are gone', () => {
    expect(sanitizeCaption('\x00  Cake \x01')).toBe('Cake')
  })

  it.each([[''], ['  \n\t '], ['\x00\x1b\x7f'], ['​‮﻿']])(
    'returns undefined for %j, which leaves nothing',
    raw => {
      expect(sanitizeCaption(raw)).toBeUndefined()
    }
  )

  it('returns undefined for anything but a string, such as a repeated parameter', () => {
    expect(sanitizeCaption(['a', 'b'])).toBeUndefined()
    expect(sanitizeCaption(undefined)).toBeUndefined()
    expect(sanitizeCaption({ toString: () => 'x' })).toBeUndefined()
  })
})

describe('writeCaption', () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }
  let calls: Call[]
  let warn: ReturnType<typeof vi.spyOn>
  let permit: () => UploadPermit

  /** Stub fetch with one answer per call, in order; past the end every call answers 200. */
  function immich(...answers: Array<Response | (() => Promise<Response>)>) {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body))
      })
      expect(init.signal).toBeInstanceOf(AbortSignal)
      const next = answers.shift()
      if (!next) return new Response('{}', { status: 200 })
      return typeof next === 'function' ? next() : next
    })
  }

  const status = (code: number) => new Response('nope', { status: code })

  /** A fresh writeCaption, and permits from the same copy of gate.ts, whose brand symbol is per module. */
  async function load() {
    vi.resetModules()
    const { authoriseUpload } = await import('../src/gate')
    permit = () => authoriseUpload(share(), 'share-key', KeyType.key) as UploadPermit
    const helpers = await import('./helpers')
    helpers.setConfig({ ipp: { upload: { captions: true } } })
    return (await import('../src/caption')).writeCaption
  }

  beforeEach(() => {
    calls = []
    process.env.IMMICH_URL = 'http://immich.test'
    process.env.IMMICH_API_KEY = 'secret-api-key'
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('writes the caption alone as the description, with the API key and a timeout', async () => {
    immich()
    const write = await load()
    await write(permit(), ASSET, 'Cake cutting')
    expect(calls).toEqual([
      {
        url: `http://immich.test/api/assets/${ASSET}`,
        method: 'PUT',
        headers: { 'x-api-key': 'secret-api-key', 'Content-Type': 'application/json' },
        body: { description: 'Cake cutting' }
      }
    ])
  })

  it('makes no call without IMMICH_API_KEY', async () => {
    delete process.env.IMMICH_API_KEY
    immich()
    const write = await load()
    await write(permit(), ASSET, 'Cake')
    expect(calls).toEqual([])
  })

  it('makes no call with captions off in config', async () => {
    immich()
    const write = await load()
    const helpers = await import('./helpers')
    helpers.setConfig({ ipp: { upload: { captions: false } } })
    await write(permit(), ASSET, 'Cake')
    expect(calls).toEqual([])
  })

  it('makes no call without a valid permit', async () => {
    immich()
    const write = await load()
    const forged = { link: share(), key: 'share-key', keyType: KeyType.key } as UploadPermit
    await expect(write(forged, ASSET, 'Cake')).resolves.toBeUndefined()
    // A permit for a share that has since stopped accepting uploads
    const stale = permit()
    ;(stale.link as { allowUpload: boolean }).allowUpload = false
    await write(stale, ASSET, 'Cake')
    expect(calls).toEqual([])
  })

  it('turns captions off after a 403, with one warning naming asset.update', async () => {
    immich(status(403))
    const write = await load()
    await write(permit(), ASSET, 'Cake')
    await write(permit(), 'other-asset', 'Cake')
    expect(calls).toHaveLength(1)
    const warnings = warn.mock.calls.map(args => String(args[0]))
    expect(warnings.filter(w => w.includes('asset.update'))).toHaveLength(1)
  })

  it('logs and swallows a network failure or timeout, and tries again next time', async () => {
    immich(() => Promise.reject(new Error('The operation was aborted due to timeout')))
    const write = await load()
    await expect(write(permit(), ASSET, 'Cake')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not caption asset ' + ASSET + ': The operation was aborted')
    )
    await write(permit(), 'other-asset', 'Cake')
    expect(calls).toHaveLength(2)
  })

  it('logs any other refusal and keeps going', async () => {
    immich(status(400))
    const write = await load()
    await expect(write(permit(), ASSET, 'Cake')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('answered 400'))
    await write(permit(), 'other-asset', 'Cake')
    expect(calls).toHaveLength(2)
  })
})
