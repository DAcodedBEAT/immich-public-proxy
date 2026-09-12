/**
 * Tests for the pure/network parts of src/client/upload.ts.
 *
 * The module is guarded (`if (typeof document !== 'undefined') initUpload()`)
 * so it can be imported here without a DOM - File, FormData, and
 * crypto.subtle are all real Node globals (no jsdom/happy-dom needed). Only
 * uploadFile, sha1Hex, checkDuplicates, and formatBytes are exported; the
 * DOM-manipulating functions (showStatus, the review sheet, initUpload
 * itself) aren't independently testable without a real DOM and are left
 * alone rather than force-testing them here.
 *
 * XMLHttpRequest doesn't exist in a plain Node environment either, so
 * uploadFile's tests stub a minimal fake satisfying exactly the interface
 * xhrSend actually uses (open/responseType/upload.addEventListener/
 * addEventListener/send/abort) - no library, matching how this codebase
 * already hand-writes fakes for Request/Response elsewhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MAX_ATTEMPTS,
  formatBytes,
  sha1Hex,
  checkDuplicates,
  uploadFile,
  type BatchState,
  type UploadEntry
} from '../src/client/upload'

function makeFile(content = 'hello', name = 'photo.jpg', type = 'image/jpeg'): File {
  return new File([content], name, { type, lastModified: Date.parse('2024-06-01T12:00:00.000Z') })
}

function makeEntry(caption = ''): UploadEntry {
  return { file: makeFile(), caption }
}

function makeState(): BatchState {
  return { cancelled: false, xhrs: new Set() }
}

describe('formatBytes', () => {
  it('formats KB, MB, and GB at the right thresholds', () => {
    expect(formatBytes(500)).toBe('1 KB') // rounds up, never shows 0
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB')
  })
})

describe('sha1Hex', () => {
  it('returns the correct hex SHA-1 for known content', async () => {
    // echo -n "hello" | sha1sum → aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
    const hash = await sha1Hex(makeFile('hello'))
    expect(hash).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d')
  })

  it('produces different hashes for different content', async () => {
    const a = await sha1Hex(makeFile('hello'))
    const b = await sha1Hex(makeFile('world'))
    expect(a).not.toBe(b)
  })
})

describe('checkDuplicates', () => {
  const savedFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = savedFetch
  })

  it('sends only checksums (never filenames or content) and marks reported duplicates', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            { id: 0, action: 'duplicate' },
            { id: 1, action: 'upload' }
          ]
        })
    })
    vi.stubGlobal('fetch', fetchMock)

    const files = [makeFile('one'), makeFile('two')]
    const dup = await checkDuplicates(files, '/share/key/upload-check', makeState())

    expect(dup).toEqual(new Set([0]))
    const [, init] = fetchMock.mock.calls[0]
    const sent = JSON.parse(init.body)
    expect(sent.files).toHaveLength(2)
    expect(sent.files[0]).toEqual({ id: 0, checksum: expect.stringMatching(/^[0-9a-f]{40}$/) })
    // No filename, no file content, no name field anywhere in the request body.
    expect(init.body).not.toContain('one')
    expect(init.body).not.toContain('two')
    expect(init.body).not.toContain('.jpg')
  })

  it('returns an empty set (never throws) when the check request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const dup = await checkDuplicates([makeFile()], '/check', makeState())
    expect(dup).toEqual(new Set())
  })

  it('returns an empty set immediately if already cancelled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const state = makeState()
    state.cancelled = true
    const dup = await checkDuplicates([makeFile()], '/check', state)
    expect(dup).toEqual(new Set())
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// uploadFile / MAX_ATTEMPTS retry behavior
// ---------------------------------------------------------------------------

type ScriptedOutcome = 'error' | 'abort' | { status: number; body?: unknown }

/**
 * Minimal fake satisfying exactly the XMLHttpRequest surface xhrSend uses.
 * Each `send()` call consumes the next entry from a shared script and fires
 * the corresponding event on the microtask queue (matching real XHR's async
 * event delivery) - so a scripted 'error' fires the 'error' listener, a
 * {status} fires 'load' with that status/body, etc.
 */
class FakeXHR {
  static instances: FakeXHR[] = []
  static script: ScriptedOutcome[] = []
  responseType = ''
  status = 0
  response: unknown = undefined
  upload = { addEventListener: () => {} }
  private listeners: Record<string, Array<() => void>> = {}

  constructor() {
    FakeXHR.instances.push(this)
  }

  open() {}

  addEventListener(event: string, cb: () => void) {
    ;(this.listeners[event] ||= []).push(cb)
  }

  abort() {
    this.listeners.abort?.forEach(cb => cb())
  }

  send() {
    const outcome = FakeXHR.script.shift()
    queueMicrotask(() => {
      if (outcome === 'error') {
        this.listeners.error?.forEach(cb => cb())
      } else if (outcome === 'abort') {
        this.listeners.abort?.forEach(cb => cb())
      } else if (outcome && typeof outcome === 'object') {
        this.status = outcome.status
        this.response = outcome.body ?? {}
        this.listeners.load?.forEach(cb => cb())
      }
    })
  }
}

beforeEach(() => {
  FakeXHR.instances = []
  FakeXHR.script = []
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadFile retry behavior (MAX_ATTEMPTS)', () => {
  // uploadFile backs off 1s * attempt between retries (real setTimeout), so
  // any test spanning more than one attempt needs fake timers - otherwise a
  // MAX_ATTEMPTS=5 run would burn 1+2+3+4=10 real seconds. advanceTimersByTimeAsync
  // also flushes the microtask queue between ticks, which is what lets
  // FakeXHR's queueMicrotask-scheduled events (unaffected by fake timers,
  // same as real Promise/microtask behavior) interleave correctly with the
  // faked delay() calls.

  it('retries a network error up to MAX_ATTEMPTS times, then gives up', async () => {
    vi.useFakeTimers()
    FakeXHR.script = Array(MAX_ATTEMPTS).fill('error' as const)

    const promise = uploadFile(makeEntry(), '/upload', 'Alice', makeState(), () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await promise

    expect(result).toEqual({ ok: false, error: `Network error after ${MAX_ATTEMPTS} attempts` })
    expect(FakeXHR.instances).toHaveLength(MAX_ATTEMPTS)
    vi.useRealTimers()
  })

  it('retries a 5xx response up to MAX_ATTEMPTS times, then gives up', async () => {
    vi.useFakeTimers()
    FakeXHR.script = Array(MAX_ATTEMPTS)
      .fill(null)
      .map(() => ({ status: 503, body: {} }))

    const promise = uploadFile(makeEntry(), '/upload', 'Alice', makeState(), () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await promise

    expect(result.ok).toBe(false)
    expect(FakeXHR.instances).toHaveLength(MAX_ATTEMPTS)
    vi.useRealTimers()
  })

  it('does NOT retry a 4xx response - fails immediately on the first attempt', async () => {
    FakeXHR.script = [{ status: 400, body: { error: 'file type not allowed' } }]

    const result = await uploadFile(makeEntry(), '/upload', 'Alice', makeState(), () => {})

    expect(result).toEqual({ ok: false, error: 'file type not allowed' })
    expect(FakeXHR.instances).toHaveLength(1)
  })

  it('succeeds on a later attempt after earlier transient failures, without exhausting all attempts', async () => {
    vi.useFakeTimers()
    FakeXHR.script = [
      'error',
      { status: 503 },
      { status: 201, body: { uploaded: 1, duplicate: false } }
    ]

    const promise = uploadFile(makeEntry(), '/upload', 'Alice', makeState(), () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await promise

    expect(result).toEqual({ ok: true, duplicate: false })
    expect(FakeXHR.instances).toHaveLength(3)
    expect(FakeXHR.instances.length).toBeLessThan(MAX_ATTEMPTS)
    vi.useRealTimers()
  })

  it('reports a duplicate result without treating it as a failure', async () => {
    FakeXHR.script = [{ status: 200, body: { uploaded: 1, duplicate: true } }]
    const result = await uploadFile(makeEntry(), '/upload', 'Alice', makeState(), () => {})
    expect(result).toEqual({ ok: true, duplicate: true })
  })

  it('stops retrying once cancelled, instead of consuming the rest of the script', async () => {
    FakeXHR.script = ['error', 'error', 'error', 'error', 'error']
    const state = makeState()

    // Cancel after the first failure's XHR is created but before its retry
    // backoff would fire the next attempt.
    const originalSend = FakeXHR.prototype.send
    let sendCount = 0
    FakeXHR.prototype.send = function (this: FakeXHR) {
      sendCount++
      if (sendCount === 1) state.cancelled = true
      originalSend.call(this)
    }

    const result = await uploadFile(makeEntry(), '/upload', 'Alice', state, () => {})

    expect(result.ok).toBe(false)
    expect(FakeXHR.instances.length).toBeLessThan(MAX_ATTEMPTS)
    FakeXHR.prototype.send = originalSend
  })
})
