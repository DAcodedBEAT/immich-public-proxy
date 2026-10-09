import { describe, expect, it, vi } from 'vitest'
import { Request } from 'express-serve-static-core'
import { logAbuse } from '../src/utils/abuseLog'

function fakeReq(ip: string | undefined): Request {
  return { ip, socket: { remoteAddress: '10.0.0.1' } } as unknown as Request
}

describe('logAbuse', () => {
  it('logs the event and req.ip in a stable, greppable format', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logAbuse('upload-oversize', fakeReq('203.0.113.5'), 'label=big.mp4')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain(
      'ABUSE event=upload-oversize ip=203.0.113.5 label=big.mp4'
    )
    warn.mockRestore()
  })

  it('falls back to the socket address when req.ip is unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logAbuse('upload-forbidden', fakeReq(undefined))
    expect(warn.mock.calls[0][0]).toContain('ABUSE event=upload-forbidden ip=10.0.0.1')
    warn.mockRestore()
  })

  describe('detail injection (fuzzed)', () => {
    // `detail` carries visitor-controlled data (filename, MIME type) straight
    // into a line an external fail2ban/CrowdSec filter greps for `ip=`. A
    // newline in there forges an entirely separate fake log line - with
    // whatever ip= the attacker writes - that the filter reads as a real
    // event. Every case here must land on exactly one line, and that line's
    // ip= must be the real caller's IP, not anything from `detail`.

    function loggedLine(detail: string): string {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      logAbuse('upload-mime-rejected', fakeReq('203.0.113.5'), detail)
      const line = warn.mock.calls[0][0] as string
      warn.mockRestore()
      return line
    }

    const adversarialDetails = [
      'plain',
      'type=x\nABUSE event=invalid-password ip=198.51.100.9',
      'type=x\r\nABUSE event=invalid-password ip=198.51.100.9',
      'ip=198.51.100.9 type=x',
      '\n\n\nip=198.51.100.9',
      'type=x\x1b[31mred\x1b[0m',
      'type=x\x00\x01\x02',
      'a'.repeat(5000),
      '   unicode line separators',
      ''
    ]

    it.each(adversarialDetails)('never produces more than one line for %j', detail => {
      const line = loggedLine(detail)
      // No embedded \n or \r survives into the log line at all.
      expect(line).not.toMatch(/[\r\n]/)
    })

    it.each(adversarialDetails)('the logged ip= is always the real caller ip for %j', detail => {
      const line = loggedLine(detail)
      const match = line.match(/ip=(\S*)/)
      expect(match?.[1]).toBe('203.0.113.5')
    })

    it('caps an oversized detail so one field cannot blow out the log line', () => {
      const line = loggedLine('x'.repeat(5000))
      expect(line.length).toBeLessThan(300)
    })

    it('still strips a lone \\r or \\n even without a following fake ABUSE line', () => {
      expect(loggedLine('type=x\ry')).not.toMatch(/[\r\n]/)
      expect(loggedLine('type=x\ny')).not.toMatch(/[\r\n]/)
    })

    it('neutralizes a same-line decoy ip=/event= pair, not just newline-separated ones', () => {
      // No newline needed here - just embedding the filter's own keywords on
      // the same line as a decoy IP is enough to be one filter-regex tweak
      // (reordered fields, findall instead of search) away from a false ban.
      const line = loggedLine('label=evidence ip=198.51.100.9 for event=invalid-password.jpg')
      expect(line.match(/ip=\S*/g)).toEqual(['ip=203.0.113.5'])
      expect(line).not.toMatch(/event=invalid-password/)
    })

    it('neutralizes ip=/event= even with no word boundary in front (a leading "_" or digit)', () => {
      // An earlier version of this sanitizer used \b(ip|event)= - \b requires
      // a non-word character immediately before the match, but "_" and
      // digits ARE word characters, so "_ip=" and "9ip=" sailed through
      // completely untouched. Both are trivially reachable: `detail` is
      // built from an attacker-controlled filename (`label=${filename}`),
      // and "_ip=1.2.3.4.jpg" or "9ip=1.2.3.4.jpg" are ordinary-looking
      // filenames.
      expect(loggedLine('label=_ip=8.8.8.8')).not.toMatch(/ip=8\.8\.8\.8/)
      expect(loggedLine('label=9ip=8.8.8.8')).not.toMatch(/ip=8\.8\.8\.8/)
      expect(loggedLine('label=_event=fake')).not.toMatch(/event=fake/)
      expect(loggedLine('label=9event=fake')).not.toMatch(/event=fake/)
    })

    it.each([
      'IP=203.0.113.9',
      'Ip=203.0.113.9',
      'EVENT=fake-event',
      'Event=fake-event',
      '\tip=203.0.113.9', // tab is stripped as a control char first
      '(ip=203.0.113.9)',
      'a.ip=203.0.113.9',
      '_ip=203.0.113.9', // underscore is a word character - no \b before "ip="
      '9ip=203.0.113.9' // same for a leading digit
    ])('neutralizes %j regardless of case, punctuation, or leading word character', detail => {
      const line = loggedLine(detail)
      // Exactly one ip= and one event= may remain: our own real ones (the
      // line always legitimately starts "ABUSE event=... ip=..."). The
      // decoy from `detail`, whatever its case or prefix, must not add a
      // second.
      expect(line.match(/ip=\S*/gi)).toEqual(['ip=203.0.113.5'])
      expect(line.match(/event=\S*/gi)).toEqual(['event=upload-mime-rejected'])
    })

    it('fuzz: a battery of random adversarial strings never produces a second ip=/event= token', () => {
      const tokens = [
        'ip=',
        'IP=',
        '_ip=',
        '9ip=',
        'event=',
        'EVENT=',
        '_event=',
        '\n',
        '\r',
        'ABUSE ',
        'label=',
        ' ',
        'a',
        '1.2.3.4'
      ]
      let seed = 42
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
      }
      for (let trial = 0; trial < 200; trial++) {
        const len = 1 + Math.floor(rand() * 12)
        const detail = Array.from(
          { length: len },
          () => tokens[Math.floor(rand() * tokens.length)]
        ).join('')
        const line = loggedLine(detail)
        // Exactly one ip= (ours) may survive; the real caller ip must be it.
        const ipMatches = line.match(/ip=\S*/gi) || []
        expect(ipMatches.length).toBeLessThanOrEqual(1)
        expect(ipMatches.every(m => m === 'ip=203.0.113.5')).toBe(true)
        expect(line).not.toMatch(/[\r\n]/)
      }
    })

    it('stays fast (linear, not catastrophic-backtracking) on a very long detail string', () => {
      // The sanitizer's replace() runs on the FULL string before the
      // length cap (slice) is applied - a huge adversarial detail must not
      // make that regex pass slow.
      const huge = 'ip=1.2.3.4 event=x '.repeat(2000) + 'a'.repeat(100_000)
      const start = performance.now()
      const line = loggedLine(huge)
      const elapsedMs = performance.now() - start
      expect(elapsedMs).toBeLessThan(500)
      expect(line.length).toBeLessThan(300)
    })
  })
})
