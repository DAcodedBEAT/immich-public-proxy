import { KeyType, SharedLink, SharedLinkResult } from '../types'
import { getConfigOption, getNumericConfigOption } from '../config/access'
import { log } from '../utils/log'
import { parseDate } from '../utils/dateFormat'
import { cachedPromise, TtlLruCache } from '../utils/ttlLruCache'
import { createLimiter, LimiterQueueError } from '../utils/limiter'
import { apiUrl, buildUrl } from './client'

/*
  Immich replaced the deprecated `?password=...` query-param auth for shared
  links with `POST /shared-links/login`, which returns an
  `immich_shared_link_token` cookie used on subsequent calls. This cache holds
  one such token per (keyType, key, password) so the gallery's many asset
  requests reuse a single login round-trip. Keying by password is load-bearing
  for security: a request without the correct password produces a different
  cache key (often empty) and falls through to a fresh login that Immich will
  reject - IPP never serves cached tokens to unauthenticated visitors.
*/
const tokenCache = new TtlLruCache<Promise<string | null>>({ ttlMs: 120_000, max: 100 })

/** Whether this is a slug link and the operator has turned slug links off. */
export function slugLinksDisabled(keyType: KeyType): boolean {
  return keyType === KeyType.slug && !getConfigOption('ipp.allowSlugLinks', true)
}

/**
 * Display title for a shared link. Prefers the user-set link description,
 * falls back to the album name (for album shares), or a generic placeholder.
 */
export function title(share: SharedLink): string {
  return share.description || share?.album?.albumName || 'Gallery'
}

/**
 * Time limits on resolving a share, so a hung Immich (or a flood of made-up
 * keys) can't hold every limiter slot and leave real visitors queued
 * forever. Each lookup that runs out of time is an invalid, uncached result,
 * answered like any other failed lookup.
 */
export const SHARE_RESOLUTION_LIMITS = {
  /** One `/shared-links/me` call or password login, including its body */
  lookupMs: 15_000,
  /** All of an album's timeline calls together */
  albumEnumerationMs: 30_000,
  /** Lookups waiting for a slot; one more is turned away at once */
  maxQueue: 200,
  /** Longest a lookup waits for a slot */
  maxQueueWaitMs: 15_000
}

/*
  Bounds concurrent *uncached* share resolutions, process-wide. A negative
  result is never cached (so a transient Immich blip can't stick as an
  invalid share), which otherwise leaves nothing bounding how many round
  trips a burst of requests for made-up keys can drive against Immich - and
  a per-key negative cache wouldn't help, since a made-up key never repeats.
  Each app wraps only its cache-miss path in this, so cache hits are never
  throttled. Sized for share viewing being the main traffic: dozens of
  guests opening the same album within seconds each need a fast first
  lookup. Read from `ipp.shareResolutionConcurrency` on first use.
*/
let shareResolutionLimiter: ReturnType<typeof createLimiter> | undefined

/** The process-wide limiter for uncached share lookups. See the comment above. */
export function getShareResolutionLimiter(): ReturnType<typeof createLimiter> {
  if (!shareResolutionLimiter) {
    shareResolutionLimiter = createLimiter(
      Math.max(1, getNumericConfigOption('ipp.shareResolutionConcurrency', 30)),
      {
        maxQueue: SHARE_RESOLUTION_LIMITS.maxQueue,
        maxWaitMs: SHARE_RESOLUTION_LIMITS.maxQueueWaitMs
      }
    )
  }
  return shareResolutionLimiter
}

/**
 * Run an uncached share lookup through the limiter. A lookup the limiter
 * turns away (queue full, or waited too long) is `{ valid: false }`, so it
 * gets the same answer as any other failed lookup and is never cached.
 */
export async function limitShareResolution(
  lookup: () => Promise<SharedLinkResult>
): Promise<SharedLinkResult> {
  try {
    return await getShareResolutionLimiter()(lookup)
  } catch (e) {
    if (!(e instanceof LimiterQueueError)) throw e
    log.warn('Share lookup turned away: ' + e.message)
    return { valid: false }
  }
}

/**
 * Fetch and interpret `GET /shared-links/me` for a key. Uncached: each app
 * wraps this with its own cache.
 *
 * On success the link carries `keyType` and `password`, and whatever `assets`
 * Immich sent - an empty array for album shares, which the caller enumerates
 * if it needs them. An expired link, an invalid key, an unexpected response,
 * or no answer within `SHARE_RESOLUTION_LIMITS.lookupMs` is `{ valid: false }`;
 * a 401 for anything other than a bad key is `passwordRequired`.
 */
export async function fetchSharedLink(
  key: string,
  keyType: KeyType = KeyType.key,
  password?: string
): Promise<SharedLinkResult> {
  const url = buildUrl(apiUrl() + '/shared-links/me', {
    [keyType]: key
  })
  try {
    return await interpretSharedLink(key, keyType, password, url)
  } catch (e) {
    // A timeout or network error: invalid, so it is never cached
    log(
      'Share lookup failed for key ' +
        key +
        ': ' +
        (e instanceof Error ? e.name + ' ' + e.message : String(e))
    )
    return { valid: false }
  }
}

async function interpretSharedLink(
  key: string,
  keyType: KeyType,
  password: string | undefined,
  url: string
): Promise<SharedLinkResult> {
  const headers = await authHeaders(keyType, key, password)
  // Covers the body read too
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(SHARE_RESOLUTION_LIMITS.lookupMs)
  })
  if ((res.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) {
    const jsonBody = await res.json()
    if (jsonBody) {
      if (res.status === 200) {
        const link = jsonBody as SharedLink
        link.keyType = keyType
        link.password = password
        if (link.expiresAt && parseDate(link.expiresAt) < new Date()) {
          // This link has expired
          log('Expired link ' + key)
        } else {
          return {
            valid: true,
            link
          }
        }
      } else if (res.status === 401) {
        // Immich returns 401 for both invalid keys and password-protected shares.
        // Check the message to distinguish between the two cases.
        if (
          jsonBody?.message === 'Invalid share key' ||
          jsonBody?.message === 'Invalid share slug'
        ) {
          // Known invalid key/slug - treat as invalid request
          log('Invalid share key ' + key)
        } else {
          // Default: treat as password required (fail-safe)
          return {
            valid: true,
            passwordRequired: true
          }
        }
      } else {
        console.log(JSON.stringify(jsonBody))
      }
    }
  } else {
    // Otherwise return failure
    log('Immich response ' + res.status + ' for key ' + key)
    try {
      console.log(res.headers.get('Content-Type'))
      console.log((await res.text()).slice(0, 500))
      log('Unexpected response from Immich API at ' + apiUrl())
      log('Please make sure the IPP container is able to reach this path.')
    } catch (e) {
      console.log(e)
    }
  }
  return {
    valid: false
  }
}

/**
 * Build the `Cookie` header that authenticates to Immich for a
 * password-protected share. Returns `{}` (no Cookie header) when the share
 * has no password or login failed; in those cases Immich will respond 401
 * for protected resources, which the caller handles as "password required".
 */
export async function authHeaders(
  keyType: KeyType,
  key: string,
  password?: string
): Promise<Record<string, string>> {
  if (!password) return {}
  const token = await getSharedLinkToken(key, password, keyType)
  return token ? { Cookie: `immich_shared_link_token=${token}` } : {}
}

/**
 * Cached login: fetch an `immich_shared_link_token` for the given password,
 * or return null on failure. The cache is per (keyType, key, password) so
 * that a request without the correct password can't reuse another visitor's
 * authenticated session. See `tokenCache` doc-comment for the security
 * argument.
 */
function getSharedLinkToken(
  key: string,
  password: string,
  keyType: KeyType
): Promise<string | null> {
  const cacheKey = `${keyType}:${key}:${password}`
  // Default eviction (falsy is invalid) drops a null/empty token, so a failed
  // login is never cached.
  return cachedPromise(tokenCache, cacheKey, () => sharedLinkLogin(key, password, keyType))
}

/**
 * `POST /shared-links/login`. Replaces the deprecated `?password=...` query
 * param. Returns the cookie value on success, null on any failure.
 */
async function sharedLinkLogin(
  key: string,
  password: string,
  keyType: KeyType
): Promise<string | null> {
  const url = buildUrl(apiUrl() + '/shared-links/login', { [keyType]: key })
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(SHARE_RESOLUTION_LIMITS.lookupMs)
    })
    if (res.status !== 201) return null
    const setCookie = res.headers.get('set-cookie') || ''
    const match = setCookie.match(/immich_shared_link_token=([^;,]+)/)
    return match ? match[1] : null
  } catch (e) {
    return null
  }
}
