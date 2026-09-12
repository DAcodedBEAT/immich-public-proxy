import { describe, it, expect } from 'vitest'
import { createLimiter } from '../src/utils/limiter'

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
})
