import { describe, it, expect, afterEach, vi } from 'vitest'
import { getShareByKey, isPasswordVerified } from '../src/immich'
import { KeyType } from '../src/types'

/*
  Regression coverage for a bug where `ipp.upload.requirePassword` could be
  bypassed on a share that has no Immich password at all: `/share/unlock`
  stores whatever string a visitor posts with no validation, so `!!password`
  was true even though nothing was ever checked. isPasswordVerified instead
  re-queries the share without a password and only counts it as verified if
  Immich would actually require one - see its doc-comment in immich.ts.
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
  return 'password-verify-key-' + keyCounter++
}

describe('isPasswordVerified', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns false without even calling Immich when no password was given', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await isPasswordVerified(uniqueKey(), KeyType.key, undefined)).toBe(false)
    expect(await isPasswordVerified(uniqueKey(), KeyType.key, '')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns false for a share with no Immich password, even though a password string was given', async () => {
    // This is the exact bypass: /share/unlock accepts any string, so a
    // visitor could set req.password to something even for a share Immich
    // never asked a password for.
    const key = uniqueKey()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(individualShare(key)))
    )
    expect(await isPasswordVerified(key, KeyType.key, 'whatever-i-typed')).toBe(false)
  })

  it('returns true for a share that actually requires a password', async () => {
    const key = uniqueKey()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'Password required' }, 401))
    )
    expect(await isPasswordVerified(key, KeyType.key, 'correct-horse')).toBe(true)
  })

  it('propagates a network failure rather than silently failing open or closed', async () => {
    // If Immich is unreachable for this bare re-check, the caller
    // (validateUploadShare, wrapped in asyncHandler) must see a rejection
    // and answer with an error - not silently treat the password as
    // verified (fail-open, defeating requirePassword) or as unverified
    // (fail-closed but disguised as "uploads not allowed" with no error
    // logged, which would be confusing to operators debugging it).
    const key = uniqueKey()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    await expect(isPasswordVerified(key, KeyType.key, 'whatever')).rejects.toThrow('ECONNREFUSED')
  })

  it('reuses an already-cached bare (no-password) share lookup instead of re-fetching', async () => {
    // The doc-comment's "usually a cache hit" claim: a visitor who already
    // loaded the gallery (an unauthenticated request) before attempting to
    // unlock/upload should not cost isPasswordVerified a second round trip.
    const key = uniqueKey()
    const fetchMock = vi.fn(async () => jsonResponse(individualShare(key)))
    vi.stubGlobal('fetch', fetchMock)

    // Simulates the initial unauthenticated gallery view.
    await getShareByKey(key, undefined, KeyType.key)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // isPasswordVerified's internal bare lookup should hit that same cache
    // entry, not fire a second fetch.
    await isPasswordVerified(key, KeyType.key, 'whatever-i-typed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not amplify request cost: a bogus password never costs more than one extra bare lookup', async () => {
    // An attacker always sending some non-empty password can't turn each of
    // their own requests into more than the one extra /shared-links/me call
    // isPasswordVerified itself makes - repeat calls with the SAME bogus
    // password should coalesce via the shareCache like any other lookup.
    const key = uniqueKey()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        return jsonResponse(individualShare(key))
      })
    )
    await Promise.all(
      Array.from({ length: 10 }, () => isPasswordVerified(key, KeyType.key, 'bogus'))
    )
    expect(calls).toBe(1)
  })
})
