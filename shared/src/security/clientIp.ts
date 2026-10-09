import { isIP } from 'net'
import { Request } from 'express-serve-static-core'

const MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i
const MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/

/**
 * One spelling per address, so a ban entry and a request address compare
 * equal however each was written: an IPv4-mapped IPv6 address (`req.ip` on a
 * dual-stack listener) becomes plain IPv4, and IPv6 is lower-cased and
 * zero-compressed. Anything that is not an IP address, or an IPv6 address
 * with a zone (`%eth0`), comes back unchanged.
 */
export function normalizeIp(ip: string): string {
  const dotted = MAPPED_DOTTED.exec(ip)
  if (dotted && isIP(dotted[1]) === 4) return dotted[1]
  if (isIP(ip) !== 6 || ip.includes('%')) return ip
  let canonical: string
  try {
    canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
  } catch {
    return ip
  }
  const hex = MAPPED_HEX.exec(canonical)
  if (!hex) return canonical
  const hi = parseInt(hex[1], 16)
  const lo = parseInt(hex[2], 16)
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
}

/**
 * The visitor's address, normalized (see normalizeIp). `req.ip` when it is a
 * real address; otherwise the socket's. Express keeps spaces inside one
 * `X-Forwarded-For` entry, so `req.ip` can be text like `1.2.3.4 ip=5.6.7.8`,
 * which must never reach a log line an external filter parses.
 */
export function clientIp(req: Request): string | undefined {
  const forwarded = req.ip ? normalizeIp(req.ip) : ''
  if (isIP(forwarded)) return forwarded
  const socket = req.socket?.remoteAddress
  return socket ? normalizeIp(socket) : undefined
}
