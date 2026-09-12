import { existsSync, readFileSync, statSync } from 'fs'

/**
 * Enforcement side of an IP ban. IPP never bans anyone itself - it only
 * reads a plain-text, one-IP-per-line file (blank lines and `#` comments
 * ignored) and rejects matching requests. Something external (a fail2ban
 * custom action, a cron job, a human) owns writing to that file.
 *
 * This exists for deployments where a normal iptables ban can't reach the
 * real attacker - e.g. behind Tailscale Funnel, where traffic is relayed
 * over the tailnet and the box never sees a direct connection from the
 * attacker's IP to block. See docs/uploads.md for the fail2ban wiring.
 *
 * Re-read on every call but cached by the file's mtime, so a normal request
 * costs one stat() call, not a re-parse.
 */
let cachedPath: string | undefined
let cachedMtimeMs = 0
let cachedSet: Set<string> = new Set()

function loadBanlist(path: string): Set<string> {
  const stat = statSync(path)
  if (path === cachedPath && stat.mtimeMs === cachedMtimeMs) return cachedSet
  const set = new Set<string>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const ip = line.split('#')[0].trim()
    if (ip) set.add(ip)
  }
  cachedPath = path
  cachedMtimeMs = stat.mtimeMs
  cachedSet = set
  return set
}

export function isBanned(ip: string): boolean {
  const path = process.env.IPP_BANLIST_PATH
  if (!path || !ip) return false
  try {
    if (!existsSync(path)) return false
    return loadBanlist(path).has(ip)
  } catch {
    return false
  }
}

/** Test-only: drop the cached file contents so the next check re-reads. */
export function resetBanlistCacheForTests(): void {
  cachedPath = undefined
  cachedMtimeMs = 0
  cachedSet = new Set()
}
