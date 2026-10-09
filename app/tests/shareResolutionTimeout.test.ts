import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeyType, loadConfig as loadConfigStatic } from '@ipp/core'

/*
  A hung Immich, or a flood of made-up keys, must not fill every share
  resolution slot and leave real visitors waiting minutes. With all slots
  stuck, the next lookup is turned away within the queue wait, and once the
  stuck lookups time out the slots are free for the next one.
*/

const VALID = 'valid-key'
const ALBUM = 'album-key'
const ASSET = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  type: 'IMAGE',
  isTrashed: false,
  thumbhash: 'AAAA'
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** Never answers, but honours the abort signal like the real fetch. */
function hang(init?: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })
}

let immichUp = false
const fetchStub = vi.fn(async (input: string, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/shared-links/me') && url.includes('key=' + VALID) && immichUp)
    return jsonResponse({ type: 'INDIVIDUAL', key: VALID, expiresAt: null, assets: [ASSET] })
  if (url.includes('/shared-links/me') && url.includes('key=' + ALBUM))
    return jsonResponse({
      type: 'ALBUM',
      key: ALBUM,
      expiresAt: null,
      assets: [],
      album: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
    })
  return hang(init)
})

beforeEach(() => {
  process.env.IMMICH_URL = 'http://immich.test'
  delete process.env.CONFIG
  immichUp = false
  fetchStub.mockClear()
  vi.resetModules()
  vi.stubGlobal('fetch', fetchStub)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  loadConfigStatic()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function freshApp(limits: Record<string, number>) {
  const core = await import('@ipp/core')
  core.loadConfig()
  Object.assign(core.SHARE_RESOLUTION_LIMITS, limits)
  return import('../src/immich')
}

describe('share resolution with a hung Immich', () => {
  it('turns the 31st lookup away fast, and recovers once the stuck ones time out', async () => {
    const { getShareByKey } = await freshApp({ lookupMs: 400, maxQueueWaitMs: 100 })

    // The default 30 slots, all stuck on Immich
    const stuck = Array.from({ length: 30 }, (_, i) =>
      getShareByKey('made-up-' + i, undefined, KeyType.key)
    )
    const started = Date.now()
    const turnedAway = await getShareByKey('made-up-31', undefined, KeyType.key)
    expect(turnedAway).toEqual({ valid: false })
    expect(Date.now() - started).toBeLessThan(350)

    // Each stuck lookup times out as invalid, rather than hanging or throwing
    expect(await Promise.all(stuck)).toEqual(Array.from({ length: 30 }, () => ({ valid: false })))

    // Slots are free again, and nothing invalid was cached
    immichUp = true
    const recovered = await getShareByKey(VALID, undefined, KeyType.key)
    expect(recovered.valid).toBe(true)
    expect(recovered.link?.assets).toHaveLength(1)
  })

  it('turns a lookup away at once when the queue is full', async () => {
    const { getShareByKey } = await freshApp({ lookupMs: 300, maxQueue: 0 })
    const stuck = Array.from({ length: 30 }, (_, i) =>
      getShareByKey('made-up-' + i, undefined, KeyType.key)
    )
    const started = Date.now()
    expect(await getShareByKey('one-more', undefined, KeyType.key)).toEqual({ valid: false })
    expect(Date.now() - started).toBeLessThan(100)
    await Promise.all(stuck)
  })

  it('gives an album enumeration one total budget, and does not cache the failure', async () => {
    const { getShareByKey } = await freshApp({ albumEnumerationMs: 100 })
    const started = Date.now()
    expect(await getShareByKey(ALBUM, undefined, KeyType.key)).toEqual({ valid: false })
    expect(Date.now() - started).toBeLessThan(1000)
    const calls = fetchStub.mock.calls.length
    await getShareByKey(ALBUM, undefined, KeyType.key)
    expect(fetchStub.mock.calls.length).toBeGreaterThan(calls)
  })
})
