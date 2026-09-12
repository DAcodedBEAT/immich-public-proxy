import { describe, it, expect } from 'vitest'
import { formatStartupSummary } from '../src/utils/startupSummary'

describe('formatStartupSummary', () => {
  it('reports trust proxy off and banlist off by default', () => {
    const line = formatStartupSummary({
      trustProxyHops: 0,
      banlistPath: undefined,
      publicBaseUrl: undefined
    })
    expect(line).toContain('trustProxy=off')
    expect(line).toContain('banlist=off')
    expect(line).toContain('publicBaseUrl=unset')
  })

  it('reports the configured hop count, banlist path, and public base URL', () => {
    const line = formatStartupSummary({
      trustProxyHops: 1,
      banlistPath: '/data/banned-ips.txt',
      publicBaseUrl: 'https://example.com'
    })
    expect(line).toContain('trustProxy=1 hop(s)')
    expect(line).toContain('banlist=/data/banned-ips.txt')
    expect(line).toContain('publicBaseUrl=https://example.com')
  })

  it('never crashes on any hop-count/string/undefined combination (fuzz)', () => {
    const hopsOptions = [0, 1, 2, 5]
    const stringOrUndefined = [undefined, '', '/some/path', 'https://example.com']
    for (const trustProxyHops of hopsOptions) {
      for (const banlistPath of stringOrUndefined) {
        for (const publicBaseUrl of stringOrUndefined) {
          expect(() =>
            formatStartupSummary({ trustProxyHops, banlistPath, publicBaseUrl })
          ).not.toThrow()
        }
      }
    }
  })
})
