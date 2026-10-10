import { Asset, AssetType, isId, isKey, KeyType, SharedLink, slugLinksDisabled } from '@ipp/core'
import { Request } from 'express-serve-static-core'
import { getShareByKey } from './immich'
import { findMotionPhotoStill } from './share'

/*
  Shared route guards. Several routes need the same "resolve a share, reject
  invalid / password-protected ones, optionally find the requested asset"
  preamble. These return a discriminated result so each route keeps control of
  its own response (e.g. the photo route redirects on password where the meta
  and download routes return 401), while the validation order and the
  `valid`/`link`/`passwordRequired` checks live in one place.
*/
export type ShareResolution =
  | { ok: true, link: SharedLink }
  | { ok: false, status: number, reason: string, passwordRequired?: boolean }

export type SharedAssetResolution =
  | { ok: true, link: SharedLink, asset: Asset }
  | { ok: false, status: number, reason: string, passwordRequired?: boolean }

export async function resolveShare (req: Request, keyType: KeyType): Promise<ShareResolution> {
  if (slugLinksDisabled(keyType)) {
    return { ok: false, status: 404, reason: 'Slug links are disabled in config.json' }
  }
  if (!isKey(req.params.key)) {
    return { ok: false, status: 404, reason: 'Invalid key for ' + req.path }
  }
  // The password is provided from the encrypted session cookie (if set) by
  // decodeCookie. Validating the share here prevents direct URL access from
  // bypassing password protection.
  const share = await getShareByKey(req.params.key, req.password, keyType)
  // Checked before `link`, as a password-required result never carries one
  if (share?.valid && share.passwordRequired) {
    return { ok: false, status: 401, reason: 'Password required', passwordRequired: true }
  }
  if (!share?.valid || !share.link) {
    return { ok: false, status: 404, reason: 'Invalid share link' }
  }
  return { ok: true, link: share.link }
}

export async function resolveSharedAsset (req: Request, keyType: KeyType, allowMotion = false): Promise<SharedAssetResolution> {
  if (!isId(req.params.id)) {
    return { ok: false, status: 404, reason: 'Invalid ID for ' + req.path }
  }
  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok) return resolved
  // Confirm the asset belongs to this share (defence in depth - Immich also
  // enforces this via the share key).
  const asset = resolved.link.assets.find(a => a.id === req.params.id)
  if (asset) return { ok: true, link: resolved.link, asset }
  // A motion photo's clip is a hidden asset outside the share's asset list.
  // Serve it on the video route only, and only if a shared still points at it.
  if (allowMotion) {
    const parent = findMotionPhotoStill(resolved.link, req.params.id)
    if (parent) {
      return {
        ok: true,
        link: resolved.link,
        // Streams inline, so the still's filename / mime must not carry over.
        asset: { ...parent, id: req.params.id, type: AssetType.video, originalFileName: undefined, originalMimeType: undefined }
      }
    }
  }
  return { ok: false, status: 404, reason: 'Asset not found in share' }
}
