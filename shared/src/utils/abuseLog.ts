import { Request } from 'express-serve-static-core'
import { clientIp } from '../security/clientIp'
import { log } from './log'

/**
 * `detail` can embed visitor-controlled data. Strip control characters -
 * especially \r\n - before it reaches the log line. Without this, a crafted
 * value like `x\nABUSE event=... ip=<victim>` forges an entire fake log line,
 * which an external fail2ban/CrowdSec filter would read as a real ban
 * trigger for whatever IP the attacker wrote in. Capped short too - this is
 * a one-line log tag, not a message body.
 */
// oxlint-disable-next-line no-control-regex -- deliberate: stripping all control chars, not just CR/LF
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g

/*
  An external filter keys on the literal tokens `event=` and `ip=` in this
  line. Stripping newlines already stops a crafted detail forging a second
  line, but it could still embed a decoy `ip=`/`event=` pair on the SAME
  line - harmless against a filter that takes the first match, but one
  filter tweak (reordered fields, `findall`) away from not being. Break up
  both tokens rather than rely on match order.

  Deliberately NOT `\b(ip|event)=`: a word boundary needs a non-word
  character right before the token, so `_ip=1.2.3.4` or `9ip=1.2.3.4` would
  sail through untouched. The cost is that a token merely containing "ip="
  as a substring (e.g. "zip=") is also mangled, which is harmless here.
*/
const ABUSE_TOKENS = /(ip|event)=/gi

function sanitizeDetail(detail: string): string {
  return detail.replace(CONTROL_CHARS, '').replace(ABUSE_TOKENS, '$1_').slice(0, 200)
}

/**
 * Structured log line for a rejected/abusive request, meant to be grepped by
 * an external tool (fail2ban or similar) rather than parsed by IPP itself.
 * The `ABUSE event=... ip=...` shape is a documented contract (see
 * `IPP_BANLIST_PATH` in docs/config/environment-variables.md) - changing it
 * breaks operators' filters.
 */
export function logAbuse(event: string, req: Request, detail?: string): void {
  // Never req.ip as is: it can hold spaces, and so a forged ` ip=` field
  const ip = clientIp(req) || 'unknown'
  const safeDetail = detail ? sanitizeDetail(detail) : ''
  log.warn(`ABUSE event=${event} ip=${ip}${safeDetail ? ' ' + safeDetail : ''}`)
}
