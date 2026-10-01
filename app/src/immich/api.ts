import { Asset, KeyType } from '../types'
import { log } from '../utils/log'
import { TtlLruCache } from '../utils/ttlLruCache'

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

/**
 * Memoise an in-flight Promise in `cache`, coalescing concurrent callers onto
 * a single upstream call. The entry is evicted as soon as it resolves to an
 * invalid value (per `isValid`, default "falsy is invalid") or rejects, so a
 * transient Immich blip never poisons the cache with a negative result.
 *
 * This is the shared form of the "should this stay cached?" policy that
 * TtlLruCache deliberately leaves to its callers (see its doc-comment): the
 * cache stays storage-only; the eviction rule lives here, once, instead of
 * being hand-copied at each call site.
 */
export function cachedPromise<T>(
  cache: TtlLruCache<Promise<T>>,
  key: string,
  factory: () => Promise<T>,
  isValid: (value: T) => boolean = value => !!value
): Promise<T> {
  const cached = cache.get(key)
  if (cached) return cached

  const promise = factory()
  cache.set(key, promise)
  promise.then(
    value => {
      if (!isValid(value)) cache.delete(key)
    },
    () => {
      cache.delete(key)
    }
  )
  return promise
}

/**
 * Make a request to Immich API. We're not using the SDK to limit
 * the possible attack surface of this app.
 */
export async function request(endpoint: string, init?: RequestInit) {
  try {
    const res = await fetch(apiUrl() + endpoint, init)
    if (res.status === 200) {
      const contentType = res.headers.get('Content-Type') || ''
      if (contentType.includes('application/json')) {
        return res.json()
      } else {
        return res
      }
    } else {
      log('Immich API status ' + res.status)
      console.log(await res.text())
    }
  } catch (e) {
    log('Unable to reach Immich on ' + process.env.IMMICH_URL)
    log(
      `From the container IPP is running in, run this and check you receive a JSON result: node -e "fetch('${apiUrl()}/server/ping').then(r => r.text()).then(console.log).catch(console.error)"`
    )
    log(
      'Avoid testing with curl - curl uses its own DNS resolver and can succeed even when the resolver Node/IPP uses (musl getaddrinfo) fails. See https://github.com/alangrainger/immich-public-proxy/issues/263'
    )
  }
}

export function apiUrl() {
  return (process.env.IMMICH_URL || '').replace(/\/*$/, '') + '/api'
}

/**
 * Build safely-encoded URL string.
 */
export function buildUrl(baseUrl: string, params: { [key: string]: string | undefined } = {}) {
  // Remove empty properties
  params = Object.fromEntries(Object.entries(params).filter(([_, value]) => !!value))
  let query = ''
  // Safely encode query parameters
  if (Object.entries(params).length) {
    query =
      '?' +
      new URLSearchParams(
        params as {
          [key: string]: string
        }
      ).toString()
  }
  return baseUrl + query
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
 * `authHeaders` for an asset whose key/keyType/password are already stamped on
 * it (the common case for share-scoped fetches).
 */
export function authHeadersForAsset(asset: Asset): Promise<Record<string, string>> {
  return authHeaders(asset.keyType || KeyType.key, asset.key, asset.password)
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
      body: JSON.stringify({ password })
    })
    if (res.status !== 201) return null
    const setCookie = res.headers.get('set-cookie') || ''
    const match = setCookie.match(/immich_shared_link_token=([^;,]+)/)
    return match ? match[1] : null
  } catch (e) {
    return null
  }
}
