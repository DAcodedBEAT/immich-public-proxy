import { describe, it, expect, vi } from 'vitest'
import { createLimiter, LimiterQueueError } from '../src/utils/limiter'

describe('createLimiter', () => {
  it('runs a single task and returns its value', async () => {
    const run = createLimiter(2)
    const result = await run(() => Promise.resolve(42))
    expect(result).toBe(42)
  })

  it('never exceeds N concurrent tasks', async () => {
    const limit = 3
    const run = createLimiter(limit)
    let active = 0
    let maxSeen = 0

    const tasks = Array.from({ length: 10 }, () =>
      run(async () => {
        active++
        if (active > maxSeen) maxSeen = active
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
      })
    )
    await Promise.all(tasks)
    expect(maxSeen).toBeLessThanOrEqual(limit)
  })

  it('resumes queued tasks in FIFO order', async () => {
    const run = createLimiter(1)
    const order: number[] = []

    // Block the limiter with a controlled task
    let unblock!: () => void
    const blocker = run(async () => {
      await new Promise<void>(resolve => {
        unblock = resolve
      })
    })

    // Queue three tasks while blocked - they must queue in order
    const p1 = run(async () => {
      order.push(1)
    })
    const p2 = run(async () => {
      order.push(2)
    })
    const p3 = run(async () => {
      order.push(3)
    })

    // Give the microtask queue a tick to ensure queuing
    await Promise.resolve()

    unblock()
    await Promise.all([blocker, p1, p2, p3])
    expect(order).toEqual([1, 2, 3])
  })

  it('frees its slot even when the task rejects', async () => {
    const run = createLimiter(1)

    // This task rejects - the slot must still be freed
    await expect(run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')

    // The limiter should now accept a new task without hanging
    const result = await run(() => Promise.resolve('ok'))
    expect(result).toBe('ok')
  })

  it('propagates return values through the queue', async () => {
    const run = createLimiter(1)
    const values = [10, 20, 30]
    const results = await Promise.all(values.map(v => run(() => Promise.resolve(v))))
    expect(results).toEqual(values)
  })

  it('runs tasks up to the limit in parallel without queuing', async () => {
    const limit = 4
    const run = createLimiter(limit)
    let active = 0

    const resolvers: Array<() => void> = []
    const tasks = Array.from({ length: limit }, () =>
      run(async () => {
        active++
        await new Promise<void>(resolve => {
          resolvers.push(resolve)
        })
        active--
      })
    )

    // All should have started immediately (no queuing for exactly `limit` tasks)
    await Promise.resolve()
    expect(active).toBe(limit)

    resolvers.forEach(r => r())
    await Promise.all(tasks)
  })

  it('never exceeds N when new callers keep arriving via microtasks only (stress)', async () => {
    // Heavy concurrency stress test with no timer/macrotask boundaries at
    // all: each new task is spawned from inside the previous one's own
    // completion, on pure microtask timing, keeping a backlog queued
    // throughout - the same shape as HTTP upload requests arriving while
    // others are finishing. Exercises the handoff path (queue -> resume)
    // far more densely than the other tests here, which all have real
    // await/timer gaps between steps.
    const limit = 3
    const run = createLimiter(limit)
    let active = 0
    let maxSeen = 0
    let spawned = 0
    const TOTAL = 500
    const finished: Promise<void>[] = []

    function spawnNext() {
      if (spawned >= TOTAL) return
      spawned++
      finished.push(
        run(async () => {
          active++
          if (active > maxSeen) maxSeen = active
          await Promise.resolve()
          await Promise.resolve()
          active--
          spawnNext()
        })
      )
    }

    // Prime with more than `limit` initial callers so some queue immediately.
    for (let i = 0; i < limit * 2; i++) spawnNext()

    while (finished.length < TOTAL) {
      await Promise.resolve()
    }
    await Promise.all(finished)

    expect(maxSeen).toBeLessThanOrEqual(limit)
  })

  it('falls back to serial (not unlimited) on a NaN, zero or negative limit', async () => {
    for (const limit of [NaN, 0, -3, Infinity]) {
      const run = createLimiter(limit)
      let active = 0
      let peak = 0
      await Promise.all(
        Array.from({ length: 5 }, () =>
          run(async () => {
            active++
            peak = Math.max(peak, active)
            await new Promise(resolve => setTimeout(resolve, 1))
            active--
          })
        )
      )
      expect(peak).toBe(1)
    }
  })

  describe('queue bounds', () => {
    /** A task that holds its slot until released. */
    function blocker() {
      let release!: () => void
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      return { task: () => gate, release }
    }

    it('rejects at once when the queue is full, without running the task', async () => {
      const run = createLimiter(1, { maxQueue: 2 })
      const hold = blocker()
      const running = run(hold.task)
      const queued = [run(async () => 'a'), run(async () => 'b')]
      const fn = vi.fn(async () => 'c')
      const rejected = run(fn)
      await expect(rejected).rejects.toBeInstanceOf(LimiterQueueError)
      await expect(rejected).rejects.toMatchObject({ reason: 'queue-full' })
      expect(fn).not.toHaveBeenCalled()
      hold.release()
      await running
      expect(await Promise.all(queued)).toEqual(['a', 'b'])
    })

    it('rejects a task that waits longer than maxWaitMs', async () => {
      vi.useFakeTimers()
      try {
        const run = createLimiter(1, { maxWaitMs: 1000 })
        const hold = blocker()
        const running = run(hold.task)
        const fn = vi.fn(async () => 'late')
        const waiting = run(fn)
        const outcome = waiting.then(
          () => 'resolved',
          (e: unknown) => e
        )
        await vi.advanceTimersByTimeAsync(999)
        expect(fn).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(await outcome).toMatchObject({ reason: 'wait-timeout' })
        expect(fn).not.toHaveBeenCalled()
        hold.release()
        await running
      } finally {
        vi.useRealTimers()
      }
    })

    it('frees nothing it never held: a timed-out waiter leaves the slot count intact', async () => {
      vi.useFakeTimers()
      try {
        const run = createLimiter(2, { maxWaitMs: 100 })
        const a = blocker()
        const b = blocker()
        const runningA = run(a.task)
        const runningB = run(b.task)
        const timedOut = run(async () => 'never')
        const outcome = timedOut.then(
          () => 'resolved',
          (e: unknown) => e
        )
        await vi.advanceTimersByTimeAsync(100)
        expect(await outcome).toMatchObject({ reason: 'wait-timeout' })
        // Both slots are still held: a new task waits rather than running
        let started = false
        const next = run(async () => {
          started = true
        })
        await vi.advanceTimersByTimeAsync(50)
        expect(started).toBe(false)
        a.release()
        await runningA
        await next
        expect(started).toBe(true)
        // And once everything is done, the full limit is available again
        b.release()
        await runningB
        let active = 0
        let peak = 0
        const gates = [blocker(), blocker(), blocker()]
        const tasks = gates.map(g =>
          run(async () => {
            active++
            peak = Math.max(peak, active)
            await g.task()
            active--
          })
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(peak).toBe(2)
        gates.forEach(g => g.release())
        await Promise.all(tasks)
      } finally {
        vi.useRealTimers()
      }
    })

    it('clears the wait timer of a task that got its slot in time', async () => {
      vi.useFakeTimers()
      try {
        const run = createLimiter(1, { maxWaitMs: 100 })
        const hold = blocker()
        const running = run(hold.task)
        const waiting = run(async () => 'ran')
        hold.release()
        await running
        expect(await waiting).toBe('ran')
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('queues without bound by default', async () => {
      const run = createLimiter(1)
      const hold = blocker()
      const running = run(hold.task)
      const queued = Array.from({ length: 1000 }, (_, i) => run(async () => i))
      hold.release()
      await running
      expect((await Promise.all(queued)).length).toBe(1000)
    })
  })
})
