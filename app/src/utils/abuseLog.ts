import { Request } from 'express-serve-static-core'
import { log } from './log'

/**
 * `detail` often embeds visitor-controlled data (a filename, a MIME type).
 * Strip control characters - especially \r\n - before it reaches the log
 * line. Without this, a crafted filename like `x\nABUSE event=... ip=<victim>`
 * forges an entire fake log line, which an external fail2ban/CrowdSec filter
 * would read as a real ban trigger for whatever IP the attacker wrote in.
 * Capped short too - this is a one-line log tag, not a message body.
 */
// eslint-disable-next-line no-control-regex -- deliberate: stripping all control chars, not just CR/LF
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g

// The shipped fail2ban/CrowdSec filter (docs/uploads.md) keys on the literal
// tokens `event=` and `ip=` in this line. Stripping newlines above already
// stops a crafted detail from forging a second log line, but a detail could
// still embed a decoy `ip=`/`event=` pair on the SAME line - harmless
// against the shipped regex (`ABUSE event=\S+ ip=<HOST>`, which takes the
// first match) but one filter tweak (reordered fields, `findall`) away from
// not being. Break up both tokens rather than rely on match order staying
// in our favour.
//
// Deliberately NOT `\b(ip|event)=` - a word boundary requires a non-word
// character right before the token, so `_ip=1.2.3.4` or `9ip=1.2.3.4`
// (underscore and digits are word characters) would sail through untouched.
// The cosmetic cost is that a token merely containing "ip=" as a substring
// (e.g. a hypothetical "zip=" field) would also get mangled, but nothing in
// this log line's own format uses such a field, and even if a future one
// did, that's a self-inflicted false positive - not a hole an attacker can
// walk through.
const ABUSE_TOKENS = /(ip|event)=/gi

function sanitizeDetail(detail: string): string {
  return detail.replace(CONTROL_CHARS, '').replace(ABUSE_TOKENS, '$1_').slice(0, 200)
}

/**
 * Structured log line for a rejected/abusive request, meant to be grepped by
 * an external tool (fail2ban or similar) rather than parsed by IPP itself.
 * The `ABUSE event=... ip=...` shape is part of the documented contract in
 * docs/uploads.md - changing it requires updating the shipped filter there.
 */
export function logAbuse(event: string, req: Request, detail?: string): void {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  const safeDetail = detail ? sanitizeDetail(detail) : ''
  log.warn(`ABUSE event=${event} ip=${ip}${safeDetail ? ' ' + safeDetail : ''}`)
}
