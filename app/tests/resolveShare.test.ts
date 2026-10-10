import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AssetType, KeyType } from '@ipp/core'
import type { SharedLink, SharedLinkResult } from '@ipp/core'
import type { Request } from 'express-serve-static-core'
import { resolveShare, resolveSharedAsset } from '../src/resolveShare'

/*
  The guard behind the photo / video, metadata and selective-download routes.
  A password-protected share must come back as `passwordRequired` (so the
  photo route redirects to the unlock page and the others answer 401), never
  as a generic 404, and never with the share's link or assets.
*/
const lookup = vi.hoisted(() => ({ result: { valid: false } as SharedLinkResult, password: undefined as string | undefined }))
vi.mock('../src/immich', () => ({
  getShareByKey: async (_key: string, password?: string) => {
    lookup.password = password
    return lookup.result
  }
}))

const KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789'
const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const link: SharedLink = {
  key: KEY,
  keyType: KeyType.key,
  type: 'INDIVIDUAL',
  assets: [{ id: ID, key: KEY, keyType: KeyType.key, type: AssetType.image, isTrashed: false }],
  expiresAt: null
}

function request (password?: string): Request {
  return { params: { key: KEY, id: ID }, path: '/share/photo/' + KEY + '/' + ID, password } as unknown as Request
}

beforeEach(() => {
  lookup.password = undefined
})

describe('resolveShare', () => {
  it('reports a locked share as password required, without its link', async () => {
    lookup.result = { valid: true, passwordRequired: true }
    const resolved = await resolveShare(request(), KeyType.key)
    expect(resolved).toEqual({ ok: false, status: 401, reason: 'Password required', passwordRequired: true })
  })

  it('reports a locked share as password required for an asset too', async () => {
    lookup.result = { valid: true, passwordRequired: true }
    const resolved = await resolveSharedAsset(request('wrong'), KeyType.key)
    expect(resolved.ok).toBe(false)
    expect(resolved).not.toHaveProperty('asset')
    expect(resolved).toMatchObject({ status: 401, passwordRequired: true })
  })

  it('serves the asset once the unlock cookie gives the right password', async () => {
    lookup.result = { valid: true, link }
    const resolved = await resolveSharedAsset(request('secret'), KeyType.key)
    expect(lookup.password).toBe('secret')
    expect(resolved).toMatchObject({ ok: true, asset: { id: ID } })
  })

  it('is a 404 for an invalid share', async () => {
    lookup.result = { valid: false }
    const resolved = await resolveShare(request(), KeyType.key)
    expect(resolved).toEqual({ ok: false, status: 404, reason: 'Invalid share link' })
  })
})
