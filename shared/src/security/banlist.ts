import { existsSync, readFileSync, statSync } from 'fs'
import { BlockList, isIP } from 'net'
import { NextFunction, Request, Response } from 'express-serve-static-core'
import { clientIp, normalizeIp } from './clientIp'

/*
  Enforcement side of an IP ban. IPP never bans anyone itself - it only reads
  a plain-text file of one address or CIDR range per line (blank lines and `#`
  comments ignored) and rejects matching requests. Something external (a
  fail2ban custom action, a cron job, a human) owns writing to that file.

  This exists for deployments where a normal iptables ban can't reach the
  real attacker - e.g. behind Tailscale Funnel, where traffic is relayed over
  the tailnet and the box never sees a direct connection from the attacker's
  IP to block.

  Re-read on every call but cached by the file's mtime, so a normal request
  costs one stat() call, not a re-parse.
*/
interface Banlist {
  /** Single addresses, normalized, plus any line that isn't an address, verbatim */
  exact: Set<string>
  /** CIDR ranges */
  ranges: BlockList
}

let cachedPath: string | undefined
let cachedMtimeMs = 0
let cachedList: Banlist = emptyBanlist()

function emptyBanlist(): Banlist {
  return { exact: new Set(), ranges: new BlockList() }
}

/** Add a `address/prefix` line to `ranges`, or return false if it isn't one. */
function addRange(ranges: BlockList, entry: string): boolean {
  const match = /^([^/\s]+)\/(\d{1,3})$/.exec(entry)
  if (!match) return false
  const address = normalizeIp(match[1])
  let prefix = Number(match[2])
  // An IPv4-mapped range (`::ffff:10.0.0.0/104`) is the IPv4 range it maps
  if (isIP(address) === 4 && isIP(match[1]) === 6) prefix -= 96
  const family = isIP(address)
  if (family === 0 || address.includes('%')) return false
  if (prefix < 0 || prefix > (family === 4 ? 32 : 128)) return false
  ranges.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6')
  return true
}

function loadBanlist(path: string): Banlist {
  const stat = statSync(path)
  if (path === cachedPath && stat.mtimeMs === cachedMtimeMs) return cachedList
  const list = emptyBanlist()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const entry = line.split('#')[0].trim()
    if (!entry) continue
    try {
      if (addRange(list.ranges, entry)) continue
    } catch {
      // A malformed range bans no one; fall through to the exact-text match
    }
    list.exact.add(normalizeIp(entry))
  }
  cachedPath = path
  cachedMtimeMs = stat.mtimeMs
  cachedList = list
  return list
}

/**
 * True if `ip` is listed in the file at `IPP_BANLIST_PATH`, as an address or
 * within a CIDR range. Both sides are normalized first (see normalizeIp), so
 * `::ffff:1.2.3.4` matches a `1.2.3.4` entry. Fails open (false) when the
 * variable is unset, or the file is missing or unreadable.
 */
export function isBanned(ip: string): boolean {
  const path = process.env.IPP_BANLIST_PATH
  if (!path || !ip) return false
  try {
    if (!existsSync(path)) return false
    const list = loadBanlist(path)
    const address = normalizeIp(ip)
    if (list.exact.has(address)) return true
    const family = isIP(address)
    if (family === 0 || address.includes('%')) return false
    return list.ranges.check(address, family === 4 ? 'ipv4' : 'ipv6')
  } catch {
    return false
  }
}

/** Test-only: drop the cached file contents so the next check re-reads. */
export function resetBanlistCacheForTests(): void {
  cachedPath = undefined
  cachedMtimeMs = 0
  cachedList = emptyBanlist()
}

/**
 * Express middleware answering 403 with no body to a banned IP. Mount it
 * before everything else, so a banned IP can't touch sessions, static assets
 * or share resolution. A no-op unless `IPP_BANLIST_PATH` is set.
 *
 * The connection closes with the answer: the server has no whole-request
 * timeout (the upload service sets none at all), so a banned sender could
 * otherwise keep trickling a body over a kept-alive connection.
 */
export function banlistMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isBanned(clientIp(req) || '')) {
    res.set('Connection', 'close')
    res.status(403).end()
    return
  }
  next()
}

/**
 * Number of reverse-proxy hops in front of the app, from `IPP_TRUST_PROXY`.
 * `0` (the default) means `req.ip` is the raw socket address - safe, but
 * behind a proxy that is the proxy's own address, which makes IP-based
 * logging, banning and rate limiting see every visitor as one. Trusting a
 * hop that doesn't exist lets a visitor spoof `X-Forwarded-For`.
 */
export function trustProxyHops(): number {
  const hops = Math.floor(Number(process.env.IPP_TRUST_PROXY))
  return Number.isFinite(hops) && hops > 0 ? hops : 0
}
