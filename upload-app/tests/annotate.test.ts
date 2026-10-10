import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { KeyType } from '@ipp/core'
import type { UploadPermit } from '../src/gate'
import { share } from './helpers'

/*
  annotateUpload writes the description and the uploaded-by tag with the API
  key. Its permission memo and tag-ID cache are module state, so each test
  imports a fresh copy.
*/

const KEY_BEFORE = process.env.IMMICH_API_KEY
const ASSET = 'bbbbbbbb-0000-0000-0000-000000000003'

type Call = { url: string; method: string; headers: Record<string, string>; body: any }

let calls: Call[]
let warn: ReturnType<typeof vi.spyOn>

/** Stub fetch with one answer per call, in order; past the end every call answers 200 `[]`. */
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
    if (!next) return new Response('[]', { status: 200 })
    return typeof next === 'function' ? next() : next
  })
}

const upsert = (value = 'uploaded-by/Alice') =>
  new Response(
    JSON.stringify([
      { id: 'parent-id', value: 'uploaded-by' },
      { id: 'leaf-id', value }
    ]),
    { status: 200 }
  )
const ok = () => new Response('{}', { status: 200 })
const status = (code: number) => new Response('nope', { status: code })

let permit: () => UploadPermit

/** A fresh annotateUpload, and permits from the same copy of gate.ts, whose brand symbol is per module. */
async function load() {
  vi.resetModules()
  const { authoriseUpload } = await import('../src/gate')
  permit = () => authoriseUpload(share(), 'share-key', KeyType.key) as UploadPermit
  return (await import('../src/annotate')).annotateUpload
}

beforeEach(() => {
  calls = []
  process.env.IMMICH_URL = 'http://immich.test'
  process.env.IMMICH_API_KEY = 'secret-api-key'
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (KEY_BEFORE === undefined) delete process.env.IMMICH_API_KEY
  else process.env.IMMICH_API_KEY = KEY_BEFORE
})

describe('annotateUpload', () => {
  it('writes the description and tags the asset, with the API key', async () => {
    immich(ok(), upsert(), ok())
    const annotate = await load()
    await annotate(permit(), ASSET, { uploader: 'Alice', caption: 'Cake' })

    expect(calls.map(c => c.method + ' ' + c.url)).toEqual([
      `PUT http://immich.test/api/assets/${ASSET}`,
      'PUT http://immich.test/api/tags',
      'PUT http://immich.test/api/tags/leaf-id/assets'
    ])
    expect(calls[0].body).toEqual({ description: 'Cake\n\n- Uploaded by Alice' })
    expect(calls[1].body).toEqual({ tags: ['uploaded-by/Alice'] })
    expect(calls[2].body).toEqual({ ids: [ASSET] })
    for (const call of calls) expect(call.headers['x-api-key']).toBe('secret-api-key')
  })

  it('writes only the description for a caption with no name', async () => {
    immich(ok())
    const annotate = await load()
    await annotate(permit(), ASSET, { caption: 'Cake' })
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ description: 'Cake' })
  })

  it('makes no call without IMMICH_API_KEY', async () => {
    delete process.env.IMMICH_API_KEY
    immich()
    const annotate = await load()
    await annotate(permit(), ASSET, { uploader: 'Alice', caption: 'Cake' })
    expect(calls).toEqual([])
  })

  it('makes no call without a valid permit', async () => {
    immich()
    const annotate = await load()
    const forged = { link: share(), key: 'share-key', keyType: KeyType.key } as UploadPermit
    await expect(annotate(forged, ASSET, { uploader: 'Alice' })).resolves.toBeUndefined()
    // A permit for a share that has since stopped accepting uploads
    const stale = permit()
    ;(stale.link as { allowUpload: boolean }).allowUpload = false
    await annotate(stale, ASSET, { uploader: 'Alice' })
    expect(calls).toEqual([])
  })

  it('keeps a name with a slash to one level of the tag tree', async () => {
    immich(ok(), upsert('uploaded-by/a-b'), ok())
    const annotate = await load()
    await annotate(permit(), ASSET, { uploader: 'a/b' })
    expect(calls[1].body).toEqual({ tags: ['uploaded-by/a-b'] })
  })

  it('finds a tag Immich matched with different case', async () => {
    immich(ok(), upsert('uploaded-by/alice'), ok())
    const annotate = await load()
    await annotate(permit(), ASSET, { uploader: 'Alice' })
    expect(calls[2].url).toBe('http://immich.test/api/tags/leaf-id/assets')
  })

  it('remembers the tag ID, so the next upload by the same name skips the upsert', async () => {
    immich(ok(), upsert(), ok(), ok(), ok())
    const annotate = await load()
    await annotate(permit(), ASSET, { uploader: 'Alice' })
    await annotate(permit(), 'other-asset', { uploader: 'Alice' })
    expect(calls.map(c => c.url.replace('http://immich.test/api', ''))).toEqual([
      `/assets/${ASSET}`,
      '/tags',
      '/tags/leaf-id/assets',
      '/assets/other-asset',
      '/tags/leaf-id/assets'
    ])
  })

  it('forgets the tag ID when tagging fails, so the next upload upserts again', async () => {
    immich(ok(), upsert(), status(500), ok(), upsert(), ok())
    const annotate = await load()
    await annotate(permit(), ASSET, { uploader: 'Alice' })
    await annotate(permit(), 'other-asset', { uploader: 'Alice' })
    expect(calls.filter(c => c.url.endsWith('/tags'))).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not tag asset ' + ASSET))
  })

  it('turns the description off after a 403, with one warning naming asset.update', async () => {
    immich(status(403), upsert(), ok(), ok())
    const annotate = await load()
    await annotate(permit(), ASSET, { uploader: 'Alice', caption: 'Cake' })
    await annotate(permit(), 'other-asset', { uploader: 'Alice', caption: 'Cake' })

    // The second upload is tagged but not described
    expect(calls.filter(c => c.url.includes('/assets/') && !c.url.includes('/tags/'))).toHaveLength(
      1
    )
    expect(calls.filter(c => c.url.endsWith('/tags/leaf-id/assets'))).toHaveLength(2)
    const warnings = warn.mock.calls.map(args => String(args[0]))
    expect(warnings.filter(w => w.includes('asset.update'))).toHaveLength(1)
  })

  it('turns tagging off after a 403, with one warning naming tag.create and tag.asset', async () => {
    immich(ok(), status(403), ok())
    const annotate = await load()
    await annotate(permit(), ASSET, { uploader: 'Alice', caption: 'Cake' })
    await annotate(permit(), 'other-asset', { uploader: 'Alice', caption: 'Cake' })

    expect(calls.map(c => c.url.replace('http://immich.test/api', ''))).toEqual([
      `/assets/${ASSET}`,
      '/tags',
      '/assets/other-asset'
    ])
    const warnings = warn.mock.calls.map(args => String(args[0]))
    expect(warnings.filter(w => w.includes('tag.create') && w.includes('tag.asset'))).toHaveLength(
      1
    )
  })

  it('logs and swallows every other failure, and still tries the tag', async () => {
    immich(
      () => Promise.reject(new Error('The operation was aborted due to timeout')),
      upsert(),
      ok()
    )
    const annotate = await load()
    await expect(
      annotate(permit(), ASSET, { uploader: 'Alice', caption: 'Cake' })
    ).resolves.toBeUndefined()
    expect(calls).toHaveLength(3)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not describe asset ' + ASSET + ': The operation was aborted')
    )
  })

  it('keeps going after a non-403 refusal of the description', async () => {
    immich(status(400), ok())
    const annotate = await load()
    await annotate(permit(), ASSET, { caption: 'Cake' })
    await annotate(permit(), 'other-asset', { caption: 'Cake' })
    expect(calls).toHaveLength(2)
  })

  it('logs an upsert that names no tag', async () => {
    immich(new Response('[]', { status: 200 }))
    const annotate = await load()
    await annotate(permit(), ASSET, { uploader: 'Alice' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('returned no ID'))
  })
})
