import { describe, it, expect } from 'vitest'
import { formatStartupSummary } from '../src/utils/startupSummary'

describe('formatStartupSummary', () => {
  it('reports trust proxy off, banlist off, and uploads disabled by default', () => {
    const line = formatStartupSummary({
      trustProxyHops: 0,
      banlistPath: undefined,
      publicBaseUrl: undefined,
      uploadsEnabled: false,
      uploadRequirePassword: false
    })
    expect(line).toContain('trustProxy=off')
    expect(line).toContain('banlist=off')
    expect(line).toContain('publicBaseUrl=unset')
    expect(line).toContain('uploads=disabled')
    expect(line).toContain('uploadRequirePassword=n/a')
  })

  it('reports the configured hop count, banlist path, and public base URL', () => {
    const line = formatStartupSummary({
      trustProxyHops: 1,
      banlistPath: '/data/banned-ips.txt',
      publicBaseUrl: 'https://example.com',
      uploadsEnabled: false,
      uploadRequirePassword: false
    })
    expect(line).toContain('trustProxy=1 hop(s)')
    expect(line).toContain('banlist=/data/banned-ips.txt')
    expect(line).toContain('publicBaseUrl=https://example.com')
  })

  it('reports requirePassword as a real boolean only when uploads are enabled', () => {
    const enabledOn = formatStartupSummary({
      trustProxyHops: 0,
      banlistPath: undefined,
      publicBaseUrl: undefined,
      uploadsEnabled: true,
      uploadRequirePassword: true
    })
    expect(enabledOn).toContain('uploads=enabled')
    expect(enabledOn).toContain('uploadRequirePassword=true')

    const enabledOff = formatStartupSummary({
      trustProxyHops: 0,
      banlistPath: undefined,
      publicBaseUrl: undefined,
      uploadsEnabled: true,
      uploadRequirePassword: false
    })
    expect(enabledOff).toContain('uploadRequirePassword=false')

    // n/a regardless of what the caller passes for requirePassword, since
    // uploads being disabled makes the setting meaningless.
    const disabled = formatStartupSummary({
      trustProxyHops: 0,
      banlistPath: undefined,
      publicBaseUrl: undefined,
      uploadsEnabled: false,
      uploadRequirePassword: true
    })
    expect(disabled).toContain('uploads=disabled')
    expect(disabled).toContain('uploadRequirePassword=n/a')
  })

  it('never crashes on any boolean/string/undefined combination (fuzz)', () => {
    const hopsOptions = [0, 1, 2, 5]
    const stringOrUndefined = [undefined, '', '/some/path', 'https://example.com']
    for (const trustProxyHops of hopsOptions) {
      for (const banlistPath of stringOrUndefined) {
        for (const publicBaseUrl of stringOrUndefined) {
          for (const uploadsEnabled of [true, false]) {
            for (const uploadRequirePassword of [true, false]) {
              expect(() =>
                formatStartupSummary({
                  trustProxyHops,
                  banlistPath,
                  publicBaseUrl,
                  uploadsEnabled,
                  uploadRequirePassword
                })
              ).not.toThrow()
            }
          }
        }
      }
    }
  })
})
