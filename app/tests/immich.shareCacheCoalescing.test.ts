import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getShareByKey } from '../src/immich'
import { KeyType } from '../src/types'

/*
  getShareByKey caches by (keyType, key, password) and holds Promises (not
  resolved values) so concurrent cold-miss callers coalesce onto one upstream
  fetch instead of each firing their own - see the shareCache doc-comment in
  immich.ts. These tests exercise that guarantee directly under real
  concurrency (overlapping in-flight requests, not just sequential calls),
  plus the security-relevant flip side: a wrong password must never coalesce
  onto - or reuse - another visitor's cached result for the same key.
*/

interface MockResponse {
  ok: boolean
  status: number
  headers: { get: (h: string) => string | null }
  json: () => Promise<unknown>
}

function jsonResponse(body: unknown, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null)
    },
    json: async () => body
  }
}

const individualShare = (key: string) => ({
  type: 'INDIVIDUAL',
  assets: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', isTrashed: false }],
  allowDownload: true,
  expiresAt: null,
  showMetadata: true,
  key
})

let keyCounter = 0
function uniqueKey() {
  return 'coalesce-key-' + keyCounter++
}

describe('getShareByKey concurrent-request coalescing', () => {
  beforeEach(() => {
    process.env.IMMICH_URL = 'http://immich.test'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fires exactly one upstream fetch for N concurrent callers with the same key', async () => {
    const key = uniqueKey()
    let calls = 0
    let releaseAll!: () => void
    const gate = new Promise<void>(resolve => {
      releaseAll = resolve
    })

    // All N calls are genuinely in-flight together, not sequential: the mock
    // fetch doesn't resolve until every caller has already made its request.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        await gate
        return jsonResponse(individualShare(key))
      })
    )

    const N = 10
    const pending = Array.from({ length: N }, () => getShareByKey(key, undefined, KeyType.key))

    // Let all N calls actually start (and hit fetch, or join the one
    // in-flight promise) before releasing the gate they're all blocked on.
    await Promise.resolve()
    await Promise.resolve()
    releaseAll()
    const results = await Promise.all(pending)

    expect(calls).toBe(1)
    expect(results.every(r => r.valid)).toBe(true)
    // Coalesced callers share the exact same link object (see the cache's
    // documented read-only-reference contract).
    expect(results.every(r => r.link === results[0].link)).toBe(true)
  })

  it('does not coalesce different passwords for the same key', async () => {
    // A password is part of the cache key precisely so a wrong-password
    // request can never be served another visitor's cached, already-unlocked
    // result for the same key - see the tokenCache doc-comment in immich.ts.
    // A password triggers its own POST /shared-links/login first; that
    // login is mocked to always fail (no Cookie), isolating this test to
    // just the cache-key-separation property: however many distinct
    // passwords are used for the same key, each gets its own
    // /shared-links/me call.
    const key = uniqueKey()
    let meCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/shared-links/login')) return jsonResponse({ message: 'bad' }, 401)
        meCalls++
        return jsonResponse(individualShare(key))
      })
    )

    await Promise.all([
      getShareByKey(key, 'correct-horse', KeyType.key),
      getShareByKey(key, 'wrong-guess', KeyType.key),
      getShareByKey(key, undefined, KeyType.key)
    ])

    expect(meCalls).toBe(3)
  })

  it('a failed upstream call is never cached, so a retry immediately re-fetches', async () => {
    const key = uniqueKey()
    let attempt = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempt++
        if (attempt === 1) return jsonResponse({ message: 'boom' }, 500)
        return jsonResponse(individualShare(key))
      })
    )

    const first = await getShareByKey(key, undefined, KeyType.key)
    expect(first.valid).toBe(false)

    const second = await getShareByKey(key, undefined, KeyType.key)
    expect(second.valid).toBe(true)
    expect(attempt).toBe(2)
  })
})
