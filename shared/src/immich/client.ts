import { localTimestamp } from '../utils/dateFormat'
import { ImmichVersion, KeyType } from '../types'
import { log } from '../utils/log'

/**
 * Make a request to Immich API. We're not using the SDK to limit
 * the possible attack surface of this app.
 *
 * Failures are logged with troubleshooting hints unless `quiet` is set, for a
 * caller that polls and reports state changes itself.
 */
export async function request(
  endpoint: string,
  init?: RequestInit,
  { quiet = false }: { quiet?: boolean } = {}
) {
  try {
    const res = await fetch(apiUrl() + endpoint, init)
    if (res.status === 200) {
      const contentType = res.headers.get('Content-Type') || ''
      if (contentType.includes('application/json')) {
        return res.json()
      } else {
        return res
      }
    } else if (!quiet) {
      log('Immich API status ' + res.status)
      console.log((await res.text()).slice(0, 500))
    }
  } catch (e) {
    if (quiet) return
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
 * Check if a provided ID matches the Immich ID format
 */
export function isId(id: string) {
  return !!id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
}

/**
 * Check if a provided key matches the Immich shared-link key format.
 * It appears that the key is always 67 chars long, but since I don't know that this
 * will always be the case, I've left it open-ended.
 */
export function isKey(key: string) {
  return !!key.match(/^[\w-]+$/)
}

/**
 * Map the URL path prefix (`share` or `s`) to the corresponding `KeyType`.
 */
export function getKeyTypeFromShare(shareType: string) {
  return shareType === 's' ? KeyType.slug : KeyType.key
}

/**
 * Reachability ping for the `/share/healthcheck` route.
 *
 * Capped at 3 s so a slow Immich fails the healthcheck instead of hanging it.
 * The compose healthcheck gives curl 4 s inside Docker's 5 s timeout; a check
 * that overruns gets killed and leaves a zombie curl behind (GitHub #66).
 */
export async function accessible() {
  // The catch covers a timeout during the body read, which request() does not
  return !!(await request('/server/ping', { signal: AbortSignal.timeout(3000) }).catch(() => null))
}

// Minimum Immich server version IPP is compatible with
export const MIN_IMMICH_VERSION: ImmichVersion = { major: 3, minor: 0, patch: 0 }

const HEALTH_CHECK_TIMEOUT_MS = 10_000

const formatVersion = (v: ImmichVersion) => `${v.major}.${v.minor}.${v.patch}`

/**
 * Fetch the Immich server version from the public `/server/version` endpoint
 * (no auth required). Returns null if Immich is unreachable or the response
 * isn't the expected `{ major, minor, patch }` shape. `quiet` skips the
 * failure logging and gives up after HEALTH_CHECK_TIMEOUT_MS.
 */
export async function getImmichVersion(quiet = false): Promise<ImmichVersion | null> {
  const res = quiet
    ? // The health monitor: logs only its own state changes, and never waits forever
      await request(
        '/server/version',
        { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) },
        { quiet }
      ).catch(() => null)
    : await request('/server/version')
  if (
    res &&
    typeof res.major === 'number' &&
    typeof res.minor === 'number' &&
    typeof res.patch === 'number'
  ) {
    return { major: res.major, minor: res.minor, patch: res.patch }
  }
  return null
}

/**
 * True if `version` is at least MIN_IMMICH_VERSION. A prerelease of the
 * minimum version (e.g. 3.0.0-beta) counts as supported.
 */
export function isImmichVersionSupported(version: ImmichVersion): boolean {
  if (version.major !== MIN_IMMICH_VERSION.major) return version.major > MIN_IMMICH_VERSION.major
  if (version.minor !== MIN_IMMICH_VERSION.minor) return version.minor > MIN_IMMICH_VERSION.minor
  return version.patch >= MIN_IMMICH_VERSION.patch
}

/**
 * Startup guard. If we can positively confirm the Immich server is older than
 * IPP supports, log and exit rather than silently serving broken album shares.
 * If the version can't be determined (Immich not yet reachable at boot, or an
 * unexpected response), log a warning and continue - a transient blip must not
 * crash-loop the container, and per-request handling still copes.
 */
export async function enforceMinimumImmichVersion(): Promise<void> {
  const version = await getImmichVersion()
  if (!version) {
    log(
      'Could not determine the Immich server version. Check that Immich is reachable and running ' +
        formatVersion(MIN_IMMICH_VERSION) +
        ' or newer.'
    )
    return
  }
  if (!isImmichVersionSupported(version)) {
    console.error(
      localTimestamp() +
        ' FATAL: Immich server is version ' +
        formatVersion(version) +
        ', but IPP requires Immich ' +
        formatVersion(MIN_IMMICH_VERSION) +
        ' or newer.'
    )
    process.exit(1)
  }
}

type ImmichHealthState = 'healthy' | 'unreachable' | 'unsupported-version'
/*
  Seeded optimistic so the first periodic tick only logs if it finds
  something other than healthy - enforceMinimumImmichVersion already
  reported the startup state once.
*/
let lastImmichHealthState: ImmichHealthState = 'healthy'

/**
 * One tick of the periodic Immich health check started by
 * startImmichHealthMonitor. Exported so tests can call it without a timer.
 *
 * Unlike enforceMinimumImmichVersion (a startup gate that exits on a
 * confirmed-too-old version), this never exits: a running instance shouldn't
 * kill itself over Immich being mid-upgrade or a network blip. It logs only
 * on a state change (reachable -> unreachable, version drifting below the
 * minimum, and back), so a flaky Immich doesn't spam the log every tick.
 */
export async function checkImmichHealthOnce(): Promise<void> {
  const version = await getImmichVersion(true)
  let state: ImmichHealthState
  if (!version) state = 'unreachable'
  else if (!isImmichVersionSupported(version)) state = 'unsupported-version'
  else state = 'healthy'

  if (state === lastImmichHealthState) return
  const previous = lastImmichHealthState
  lastImmichHealthState = state

  if (state === 'healthy') {
    log.info('Immich is reachable again (was ' + previous + ')')
  } else if (state === 'unreachable') {
    log.warn('Immich has become unreachable (was ' + previous + ')')
  } else {
    log.warn(
      'Immich is reachable but now running ' +
        formatVersion(version as ImmichVersion) +
        ', below the minimum supported version ' +
        formatVersion(MIN_IMMICH_VERSION) +
        ' (was ' +
        previous +
        ')'
    )
  }
}

/**
 * Start the periodic health check (default every 5 minutes) and return the
 * timer, so tests can stop it. `.unref()`'d so it never keeps the process
 * alive on its own.
 */
export function startImmichHealthMonitor(intervalMs = 5 * 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    checkImmichHealthOnce().catch(e =>
      log.error('Immich health check failed: ' + (e instanceof Error ? e.message : String(e)))
    )
  }, intervalMs)
  timer.unref()
  return timer
}
