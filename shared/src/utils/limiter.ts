/** Why a limiter turned a task away without running it. */
export class LimiterQueueError extends Error {
  constructor(readonly reason: 'queue-full' | 'wait-timeout') {
    super(
      reason === 'queue-full' ? 'Limiter queue is full' : 'Timed out waiting for a limiter slot'
    )
    this.name = 'LimiterQueueError'
  }
}

export interface LimiterOptions {
  /** Most tasks allowed to wait for a slot; one more is rejected at once. Default: unbounded. */
  maxQueue?: number
  /** Longest a task may wait for a slot before it is rejected. Default: forever. */
  maxWaitMs?: number
}

interface Waiter {
  resume: () => void
  timer?: NodeJS.Timeout
}

/**
 * Returns a function that runs at most `limit` async tasks concurrently.
 * Tasks queue when the limit is reached and resume in FIFO order. With
 * `maxQueue` or `maxWaitMs` set, a task that would queue past the first, or
 * wait longer than the second, rejects with a LimiterQueueError instead of
 * running.
 *
 * An invalid `limit` (NaN, zero, negative, non-finite - e.g. from a
 * misconfigured value slipping past its caller's own validation) falls back
 * to 1 rather than silently disabling throttling. Callers should still
 * validate their own config (see getNumericConfigOption), but this is the
 * last line of defence against that turning into unlimited concurrency.
 */
export function createLimiter(limit: number, options: LimiterOptions = {}) {
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1
  const { maxQueue = Infinity, maxWaitMs } = options
  let active = 0
  const queue: Waiter[] = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active < safeLimit) {
      active++
    } else {
      if (queue.length >= maxQueue) throw new LimiterQueueError('queue-full')
      // Woken by a finishing task's handoff below, with its slot already
      // reserved for us, so `active` is not touched here. Handing the slot
      // over directly keeps the invariant structural rather than relying on
      // microtask ordering to stop a fresh caller slipping into the gap.
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { resume: resolve }
        if (maxWaitMs !== undefined && Number.isFinite(maxWaitMs)) {
          waiter.timer = setTimeout(() => {
            // Still queued, so it holds no slot: just leave the queue
            queue.splice(queue.indexOf(waiter), 1)
            reject(new LimiterQueueError('wait-timeout'))
          }, maxWaitMs)
        }
        queue.push(waiter)
      })
    }
    try {
      return await fn()
    } finally {
      const next = queue.shift()
      if (next) {
        clearTimeout(next.timer)
        next.resume()
      } else active--
    }
  }
}
