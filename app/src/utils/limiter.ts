/**
 * Returns a function that runs at most `limit` async tasks concurrently.
 * Tasks queue when the limit is reached and resume in FIFO order.
 *
 * An invalid `limit` (NaN, zero, negative, non-finite - e.g. from a
 * misconfigured env var slipping past its caller's own validation) falls
 * back to 1 rather than silently disabling throttling. Callers should still
 * validate their own config (see getNumericConfigOption), but this is the
 * last line of defence against that turning into unlimited concurrency.
 */
export function createLimiter(limit: number) {
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1
  let active = 0
  const queue: Array<() => void> = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active < safeLimit) {
      active++
    } else {
      // Woken by a finishing task's handoff below - our slot is already
      // reserved, so don't touch `active` here. A "decrement, then let the
      // woken task increment on its own resume" version isn't actually
      // racy under JS's single-threaded, FIFO-microtask semantics (a fresh
      // caller can't observe the gap), but that safety depends on reasoning
      // through that guarantee rather than being obvious from the code.
      // Handing off the slot directly makes the invariant hold structurally,
      // with nothing to reason about.
      await new Promise<void>(resolve => queue.push(resolve))
    }
    try {
      return await fn()
    } finally {
      const next = queue.shift()
      if (next) next()
      else active--
    }
  }
}
