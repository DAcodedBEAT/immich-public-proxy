import { describe, expect, it } from 'vitest'
import { Request } from 'express-serve-static-core'
import { clientIp, normalizeIp } from '../src/security/clientIp'

describe('normalizeIp', () => {
  it.each([
    ['1.2.3.4', '1.2.3.4'],
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['::FFFF:1.2.3.4', '1.2.3.4'],
    ['::ffff:0102:0304', '1.2.3.4'],
    ['0:0:0:0:0:ffff:1.2.3.4', '1.2.3.4'],
    ['2001:DB8:0::1', '2001:db8::1'],
    ['::1', '::1'],
    ['fe80::1%eth0', 'fe80::1%eth0'],
    ['not an ip', 'not an ip']
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizeIp(raw)).toBe(expected)
  })
})

describe('clientIp', () => {
  const req = (ip: string | undefined, remoteAddress?: string) =>
    ({ ip, socket: { remoteAddress } }) as unknown as Request

  it('uses req.ip when it is an address', () => {
    expect(clientIp(req('::ffff:203.0.113.5', '10.0.0.1'))).toBe('203.0.113.5')
  })

  it('falls back to the socket when req.ip is not an address', () => {
    expect(clientIp(req('9.9.9.9 ip=6.6.6.6', '::ffff:10.0.0.1'))).toBe('10.0.0.1')
    expect(clientIp(req(undefined, '10.0.0.1'))).toBe('10.0.0.1')
  })

  it('is undefined with no address at all', () => {
    expect(clientIp(req(undefined))).toBeUndefined()
  })
})
