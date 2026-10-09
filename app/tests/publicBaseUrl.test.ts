import { describe, it, expect, afterEach } from 'vitest'
import { AssetType, KeyType } from '@ipp/core'
import type { SharedLink } from '@ipp/core'
import type { Response } from 'express-serve-static-core'
import { gallery } from '../src/gallery/builder'

/*
  Without PUBLIC_BASE_URL the og:image URL comes from the request's Host, on a
  page sent with a public Cache-Control. The page must vary on Host, so a
  shared cache keeps one copy per Host rather than serving a forged one to
  every visitor.
*/
const share: SharedLink = {
  key: 'share-key',
  keyType: KeyType.key,
  type: 'INDIVIDUAL',
  assets: [
    {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      key: 'share-key',
      keyType: KeyType.key,
      type: AssetType.image,
      isTrashed: false
    }
  ],
  expiresAt: null
}

async function render(host: string | undefined) {
  let html = ''
  const vary: string[] = []
  const res = {
    req: { protocol: 'https', headers: { host } },
    header: () => {},
    vary: (field: string) => {
      vary.push(field)
    },
    send: (body: string) => {
      html = body
    }
  } as unknown as Response
  await gallery(res, share)
  const ogImage = html.match(/<meta property="og:image" content="([^"]*)"/)?.[1]
  return { html, vary, ogImage }
}

afterEach(() => {
  delete process.env.PUBLIC_BASE_URL
})

describe('og:image base URL', () => {
  it('builds it from a valid Host, and varies the page on Host', async () => {
    const { vary, ogImage } = await render('photos.example.com:8443')
    expect(ogImage).toMatch(/^https:\/\/photos\.example\.com:8443\/share\/photo\/share-key\//)
    expect(vary).toContain('Host')
  })

  it('builds it from an IPv6 literal Host', async () => {
    const { vary, ogImage } = await render('[::1]:3000')
    expect(ogImage).toMatch(/^https:\/\/\[::1\]:3000\/share\/photo\/share-key\//)
    expect(vary).toContain('Host')
  })

  it('builds it from a punycode Host', async () => {
    const { vary, ogImage } = await render('xn--bcher-kva.example')
    expect(ogImage).toMatch(/^https:\/\/xn--bcher-kva\.example\/share\/photo\/share-key\//)
    expect(vary).toContain('Host')
  })

  it('keeps PUBLIC_BASE_URL as is, without varying on Host', async () => {
    process.env.PUBLIC_BASE_URL = 'https://ipp.example.org'
    const { vary, ogImage } = await render('evil.com/x?')
    expect(ogImage).toMatch(/^https:\/\/ipp\.example\.org\/share\/photo\//)
    expect(vary).toEqual([])
  })
})
