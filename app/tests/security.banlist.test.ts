import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isBanned, resetBanlistCacheForTests } from '../src/security/banlist'

describe('isBanned', () => {
  let dir: string
  let path: string
  const originalEnv = process.env.IPP_BANLIST_PATH

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ipp-banlist-'))
    path = join(dir, 'banned-ips.txt')
    resetBanlistCacheForTests()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    process.env.IPP_BANLIST_PATH = originalEnv
  })

  it('returns false when IPP_BANLIST_PATH is unset', () => {
    delete process.env.IPP_BANLIST_PATH
    expect(isBanned('1.2.3.4')).toBe(false)
  })

  it('returns false when the file does not exist', () => {
    process.env.IPP_BANLIST_PATH = join(dir, 'missing.txt')
    expect(isBanned('1.2.3.4')).toBe(false)
  })

  it('matches an IP listed in the file', () => {
    writeFileSync(path, '1.2.3.4\n5.6.7.8\n')
    process.env.IPP_BANLIST_PATH = path
    expect(isBanned('1.2.3.4')).toBe(true)
    expect(isBanned('5.6.7.8')).toBe(true)
    expect(isBanned('9.9.9.9')).toBe(false)
  })

  it('ignores blank lines and # comments', () => {
    writeFileSync(path, '# banned by fail2ban\n\n1.2.3.4  # scraping\n')
    process.env.IPP_BANLIST_PATH = path
    expect(isBanned('1.2.3.4')).toBe(true)
  })

  it('picks up edits without restarting (mtime-based cache)', async () => {
    writeFileSync(path, '1.2.3.4\n')
    process.env.IPP_BANLIST_PATH = path
    expect(isBanned('9.9.9.9')).toBe(false)

    // Ensure the second write lands with a distinct mtime - some filesystems
    // only have millisecond (or coarser) mtime resolution.
    await new Promise(resolve => setTimeout(resolve, 20))
    writeFileSync(path, '9.9.9.9\n')
    expect(isBanned('9.9.9.9')).toBe(true)
    // The old entry is gone once the file no longer contains it.
    expect(isBanned('1.2.3.4')).toBe(false)
  })

  it('returns false for an empty ip', () => {
    writeFileSync(path, '1.2.3.4\n')
    process.env.IPP_BANLIST_PATH = path
    expect(isBanned('')).toBe(false)
  })

  // ---------------------------------------------------------------------
  // Edge cases / chaos
  // ---------------------------------------------------------------------

  it('handles CRLF line endings without leaving a trailing \\r on the IP', () => {
    writeFileSync(path, '1.2.3.4\r\n5.6.7.8\r\n')
    process.env.IPP_BANLIST_PATH = path
    expect(isBanned('1.2.3.4')).toBe(true)
    expect(isBanned('5.6.7.8')).toBe(true)
    // A stray "1.2.3.4\r" entry (the \r not stripped) would never match a
    // real lookup, silently defeating the ban - this must not happen.
    expect(isBanned('1.2.3.4\r')).toBe(false)
  })

  it('matches IPv6 addresses', () => {
    writeFileSync(path, '2001:db8::1\n::1\nfe80::1%eth0\n')
    process.env.IPP_BANLIST_PATH = path
    expect(isBanned('2001:db8::1')).toBe(true)
    expect(isBanned('::1')).toBe(true)
    expect(isBanned('fe80::1%eth0')).toBe(true)
  })

  it('treats a genuinely empty file as an empty banlist, not an error', () => {
    writeFileSync(path, '')
    process.env.IPP_BANLIST_PATH = path
    expect(isBanned('1.2.3.4')).toBe(false)
  })

  it('handles a file containing only comments and blank lines', () => {
    writeFileSync(path, '# nothing banned yet\n\n\n   \n')
    process.env.IPP_BANLIST_PATH = path
    expect(isBanned('1.2.3.4')).toBe(false)
  })

  it('trims whitespace-padded IPs (tabs and spaces)', () => {
    writeFileSync(path, '  1.2.3.4  \n\t5.6.7.8\t\n')
    process.env.IPP_BANLIST_PATH = path
    expect(isBanned('1.2.3.4')).toBe(true)
    expect(isBanned('5.6.7.8')).toBe(true)
  })

  it('does not crash and fails open (returns false) when the path is a directory, not a file', () => {
    process.env.IPP_BANLIST_PATH = dir // dir exists, but is a directory
    expect(isBanned('1.2.3.4')).toBe(false)
  })

  it('does not crash and fails open when the file is replaced with a directory after the initial check', async () => {
    writeFileSync(path, '1.2.3.4\n')
    process.env.IPP_BANLIST_PATH = path
    expect(isBanned('1.2.3.4')).toBe(true)

    // Same mtime-resolution caveat as the "picks up edits" test above: a
    // distinct mtime from the original file is needed for the cache to
    // actually be invalidated, rather than (accurately, if confusingly)
    // reflecting this test's own reliance on stale-within-the-same-tick
    // caching being possible.
    await new Promise(resolve => setTimeout(resolve, 20))
    rmSync(path)
    // Recreate the exact same path as a directory - simulates an operator's
    // tooling doing something unexpected to the banlist file mid-run.
    // statSync succeeds on a directory (so the mtime-cache check doesn't
    // reject it up front), but readFileSync then throws EISDIR - this must
    // still be caught and fail open, not crash.
    mkdirSync(path)
    expect(() => isBanned('1.2.3.4')).not.toThrow()
    expect(isBanned('1.2.3.4')).toBe(false)
  })

  it('does not crash on binary garbage content', () => {
    const garbage = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x0a, 0xc0, 0x80, 0x0a])
    writeFileSync(path, garbage)
    process.env.IPP_BANLIST_PATH = path
    expect(() => isBanned('1.2.3.4')).not.toThrow()
    expect(isBanned('1.2.3.4')).toBe(false)
  })

  it('handles a large banlist (10,000 entries) without excessive latency', () => {
    const ips = Array.from(
      { length: 10_000 },
      (_, i) => `10.${(i >> 16) & 0xff}.${(i >> 8) & 0xff}.${i & 0xff}`
    )
    writeFileSync(path, ips.join('\n') + '\n')
    process.env.IPP_BANLIST_PATH = path

    const start = performance.now()
    expect(isBanned(ips[5000])).toBe(true)
    const firstLookupMs = performance.now() - start
    expect(firstLookupMs).toBeLessThan(1000)

    // Cached (same mtime): subsequent lookups must be effectively instant.
    const start2 = performance.now()
    for (let i = 0; i < 1000; i++) isBanned(ips[i % ips.length])
    const cachedMs = performance.now() - start2
    expect(cachedMs).toBeLessThan(200)

    expect(isBanned('255.255.255.255')).toBe(false)
  })

  it('fuzz: a battery of random file contents never throws and always returns a boolean', () => {
    const lineGenerators: Array<() => string> = [
      () => '',
      () => '   ',
      () => '#'.repeat(1 + Math.floor(Math.random() * 20)),
      () => Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join('.'),
      () => 'not-an-ip-' + Math.random().toString(36),
      () => '\t\t  ' + Math.random().toString(36) + '  \t',
      () => '1.2.3.4#trailing comment no space',
      () => '# ' + Math.random().toString(36)
    ]
    for (let trial = 0; trial < 30; trial++) {
      resetBanlistCacheForTests()
      const lineCount = Math.floor(Math.random() * 15)
      const lines = Array.from({ length: lineCount }, () =>
        lineGenerators[Math.floor(Math.random() * lineGenerators.length)]()
      )
      writeFileSync(path, lines.join(Math.random() < 0.5 ? '\n' : '\r\n'))
      process.env.IPP_BANLIST_PATH = path

      let result: boolean | undefined
      expect(() => {
        result = isBanned('1.2.3.4')
      }).not.toThrow()
      expect(typeof result).toBe('boolean')
    }
  })

  it('concurrent lookups while the file is being rewritten never throw', async () => {
    writeFileSync(path, '1.2.3.4\n')
    process.env.IPP_BANLIST_PATH = path

    let stop = false
    const rewriter = (async () => {
      let n = 0
      while (!stop) {
        writeFileSync(path, `${n % 255}.${n % 255}.${n % 255}.${n % 255}\n`)
        n++
        await new Promise(resolve => setImmediate(resolve))
      }
    })()

    const lookups: Promise<void>[] = []
    for (let i = 0; i < 200; i++) {
      lookups.push(
        (async () => {
          expect(() => isBanned('1.2.3.4')).not.toThrow()
        })()
      )
      await new Promise(resolve => setImmediate(resolve))
    }
    stop = true
    await rewriter
    await Promise.all(lookups)
  })
})
