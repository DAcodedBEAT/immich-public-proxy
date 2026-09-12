/**
 * Tests for checkImmichHealthOnce / startImmichHealthMonitor.
 *
 * Unlike enforceMinimumImmichVersion (the one-time startup gate, which can
 * exit the process on a confirmed-too-old version), this is a background,
 * advisory-only check: it should only log on a STATE CHANGE (reachable ->
 * unreachable, version drifting below the minimum, and back), never on
 * every tick, and it must never exit the process.
 *
 * checkImmichHealthOnce holds module-level "last known state", so each test
 * gets a fresh module import (vi.resetModules) to avoid state bleeding
 * between tests - same pattern as the limiter singleton tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null)
    },
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
}

const SUPPORTED_VERSION = { major: 3, minor: 0, patch: 2, prerelease: null }
const UNSUPPORTED_VERSION = { major: 1, minor: 100, patch: 0, prerelease: null }

beforeEach(() => {
  process.env.IMMICH_URL = 'http://immich.test'
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('checkImmichHealthOnce', () => {
  it('logs nothing on a healthy tick (seeded state is already healthy)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(SUPPORTED_VERSION))
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { checkImmichHealthOnce } = await import('../src/immich')

    await checkImmichHealthOnce()

    expect(warn).not.toHaveBeenCalled()
    // console.log is used for plain log() calls too - filter to ones that
    // look like our message, since other unrelated startup logging could
    // theoretically share the spy in a shared module registry.
    expect(log.mock.calls.some(c => String(c[0]).includes('reachable again'))).toBe(false)
    warn.mockRestore()
    log.mockRestore()
  })

  it('logs a transition when Immich becomes unreachable, but not on repeated unreachable ticks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { checkImmichHealthOnce } = await import('../src/immich')

    await checkImmichHealthOnce()
    const callsAfterFirst = warn.mock.calls.filter(c => String(c[0]).includes('unreachable')).length
    expect(callsAfterFirst).toBe(1)

    await checkImmichHealthOnce()
    await checkImmichHealthOnce()
    const callsAfterRepeats = warn.mock.calls.filter(c =>
      String(c[0]).includes('unreachable')
    ).length
    expect(callsAfterRepeats).toBe(1) // still just the one, no repeat spam

    warn.mockRestore()
  })

  it('logs recovery when Immich becomes reachable again after being unreachable', async () => {
    let reachable = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!reachable) throw new Error('ECONNREFUSED')
        return jsonResponse(SUPPORTED_VERSION)
      })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { checkImmichHealthOnce } = await import('../src/immich')

    await checkImmichHealthOnce() // -> unreachable
    reachable = true
    await checkImmichHealthOnce() // -> healthy again

    expect(log.mock.calls.some(c => String(c[0]).includes('reachable again'))).toBe(true)
    warn.mockRestore()
    log.mockRestore()
  })

  it('logs a transition when the version drifts below the supported minimum', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(UNSUPPORTED_VERSION))
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { checkImmichHealthOnce } = await import('../src/immich')

    await checkImmichHealthOnce()

    const message = warn.mock.calls.find(c => String(c[0]).includes('minimum supported'))
    expect(message).toBeDefined()
    expect(String(message?.[0])).toContain('1.100.0')
    warn.mockRestore()
  })

  it('never throws even if the underlying request rejects unexpectedly', async () => {
    // getImmichVersion/request already swallow fetch errors internally, but
    // this pins the contract: a health check tick must never propagate an
    // exception, since startImmichHealthMonitor's timer callback has no
    // caller to hand a rejection to.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { checkImmichHealthOnce } = await import('../src/immich')

    await expect(checkImmichHealthOnce()).resolves.toBeUndefined()
    warn.mockRestore()
  })
})

describe('startImmichHealthMonitor', () => {
  it('runs the check on the given interval and stops when cleared', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        return jsonResponse(SUPPORTED_VERSION)
      })
    )
    const { startImmichHealthMonitor } = await import('../src/immich')

    const timer = startImmichHealthMonitor(1000)
    expect(calls).toBe(0) // does not run immediately on start

    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toBe(3)

    clearInterval(timer)
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(3) // no further ticks once cleared
  })

  it('is unref()d so it cannot keep the process alive on its own', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(SUPPORTED_VERSION))
    )
    const { startImmichHealthMonitor } = await import('../src/immich')

    const timer = startImmichHealthMonitor(60_000)
    expect(timer.hasRef()).toBe(false)
    clearInterval(timer)
  })
})
