import { apiUrl, log, TtlLruCache } from '@ipp/core'
import { Attribution, describeUpload } from './attribution'
import { attributionKey } from './config'
import { assertPermit, UploadPermit } from './gate'

/*
  The only code in the upload service that uses an API key, and only when
  `IMMICH_API_KEY` is set. Once a visitor's file is stored and the visitor
  has been answered, it writes the visitor's caption and name into the new
  asset's description and tags it `uploaded-by/<name>`.

  Best effort throughout: every call has a timeout, every failure is logged
  and swallowed, and nothing here can fail or delay an upload.

  Each feature needs its own permission on the key: `asset.update` for the
  description, `tag.create` and `tag.asset` for the tag. The first 403 for
  either logs one warning naming the permission and turns that feature off
  until the service restarts, rather than failing on every upload.
*/

const REQUEST_TIMEOUT_MS = 15_000

const disabled = { description: false, tag: false }

/*
  Tag path to Immich tag ID, so a returning name skips the upsert. Bounded,
  because the name is visitor input and a fresh one per upload would
  otherwise grow it without limit. Tag IDs do not change, so a long TTL is
  safe; an evicted name costs one more upsert.
*/
const tagIds = new TtlLruCache<string>({ ttlMs: 24 * 60 * 60_000, max: 1000 })

/** Thrown for a failed Immich call; the message is safe to log. */
class ImmichCallError extends Error {}

async function immich(
  key: string,
  method: string,
  path: string,
  body: unknown,
  label: string
): Promise<globalThis.Response | 'forbidden'> {
  const res = await fetch(apiUrl() + path, {
    method,
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (res.status === 403) return 'forbidden'
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ImmichCallError(`${label} answered ${res.status}: ${text.slice(0, 200)}`)
  }
  return res
}

async function setDescription(key: string, assetId: string, description: string) {
  const res = await immich(
    key,
    'PUT',
    '/assets/' + encodeURIComponent(assetId),
    { description },
    'Description update'
  )
  if (res === 'forbidden') {
    disabled.description = true
    log.warn(
      'IMMICH_API_KEY lacks the asset.update permission: captions and "Uploaded by" descriptions are off until restart. Grant asset.update to turn them on.'
    )
  }
}

async function tagWithUploader(key: string, assetId: string, uploader: string) {
  const forbidden = () => {
    disabled.tag = true
    log.warn(
      'IMMICH_API_KEY lacks the tag.create or tag.asset permission: uploaded-by tags are off until restart. Grant both to turn them on.'
    )
  }
  // `/` separates levels of Immich's tag tree; a name must stay one level
  const path = 'uploaded-by/' + uploader.replace(/\//g, '-')

  let tagId = tagIds.get(path)
  if (!tagId) {
    const res = await immich(key, 'PUT', '/tags', { tags: [path] }, 'Tag upsert')
    if (res === 'forbidden') return forbidden()
    // The upsert answers with every tag on the path, parent included. Immich
    // may match an existing tag that differs only in case.
    const tags = ((await res.json().catch(() => [])) || []) as Array<{
      id?: string
      value?: string
    }>
    const leaf =
      tags.find(t => t.value === path) ||
      tags.find(t => t.value?.toLowerCase() === path.toLowerCase())
    if (!leaf?.id) throw new ImmichCallError('Tag upsert returned no ID for ' + path)
    tagId = leaf.id
    tagIds.set(path, tagId)
  }

  try {
    const res = await immich(
      key,
      'PUT',
      '/tags/' + encodeURIComponent(tagId) + '/assets',
      { ids: [assetId] },
      'Tagging'
    )
    if (res === 'forbidden') forbidden()
  } catch (e) {
    // The tag may have been deleted in Immich; look it up afresh next time
    tagIds.delete(path)
    throw e
  }
}

async function attempt(what: string, assetId: string, call: () => Promise<void>) {
  try {
    await call()
  } catch (e) {
    log.warn(`Could not ${what} asset ${assetId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Write the attribution onto a newly created asset. Call only for a
 * `created` result, never a duplicate: a duplicate is an asset the owner
 * already had, and its description is the owner's. Never rejects.
 *
 * Takes the request's permit, so the API key is used only for an upload that
 * passed the gate, and only for the asset that upload created.
 */
export async function annotateUpload(
  permit: UploadPermit,
  assetId: string,
  attribution: Attribution
): Promise<void> {
  const key = attributionKey()
  if (!key || !assetId) return
  try {
    assertPermit(permit)
  } catch (e) {
    log.error('Attribution skipped: ' + (e instanceof Error ? e.message : String(e)))
    return
  }
  const description = describeUpload(attribution)
  if (description && !disabled.description)
    await attempt('describe', assetId, () => setDescription(key, assetId, description))
  const uploader = attribution.uploader
  if (uploader && !disabled.tag)
    await attempt('tag', assetId, () => tagWithUploader(key, assetId, uploader))
}
