import { Transform } from 'stream'

/**
 * A pass-through Transform that destroys itself if no data flows through for
 * `idleMs`. The timer is set when the transform is created and reset on every
 * chunk, so a slow-but-steady download (large video over a slow link) keeps
 * going, while a genuinely stalled connection still fails fast.
 */
export function createIdleTimeoutStream(idleMs: number): Transform {
  let timer: NodeJS.Timeout | undefined
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const transform: Transform = new Transform({
    transform(chunk, _, cb) {
      clearTimer()
      timer = setTimeout(
        () => transform.destroy(new Error(`No data received for ${idleMs}ms`)),
        idleMs
      )
      cb(null, chunk)
    },
    flush(cb) {
      clearTimer()
      cb()
    },
    // Also reached when something else destroys the stream (e.g. a chained
    // stream forwarding its own error). Without this the timer keeps running
    // and fires up to idleMs later on an already-destroyed stream - harmless
    // (destroy() no-ops when already destroyed) but leaks a live timer, and a
    // burst of aborted uploads/downloads can pile up a lot of them.
    destroy(err, cb) {
      clearTimer()
      cb(err)
    }
  })
  // Arm the timer immediately so a response that returns headers but never
  // sends a body also times out.
  timer = setTimeout(() => transform.destroy(new Error(`No data received for ${idleMs}ms`)), idleMs)
  return transform
}
