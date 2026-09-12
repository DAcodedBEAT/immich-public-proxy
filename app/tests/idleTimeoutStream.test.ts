import { describe, it, expect, vi, afterEach } from 'vitest'
import { Readable, Writable, pipeline } from 'stream'
import { promisify } from 'util'
import { createIdleTimeoutStream } from '../src/utils/idleTimeoutStream'

const pipelineAsync = promisify(pipeline)

afterEach(() => {
  vi.useRealTimers()
})

describe('createIdleTimeoutStream', () => {
  it('passes data through unchanged', async () => {
    vi.useFakeTimers()
    const idleMs = 1000
    const transform = createIdleTimeoutStream(idleMs)

    const chunks: Buffer[] = []
    const source = Readable.from(['hello', ' ', 'world'])
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk))
        cb()
      }
    })

    const pipeResult = pipelineAsync(source, transform, sink)
    // Advance time to trigger any pending timers - the transform should have
    // reset the timer on each chunk so no timeout fires.
    await vi.runAllTimersAsync()
    await pipeResult

    expect(Buffer.concat(chunks).toString()).toBe('hello world')
  })

  it('destroys with an error if no data arrives within idleMs', async () => {
    vi.useFakeTimers()
    const idleMs = 500
    const transform = createIdleTimeoutStream(idleMs)

    const errorPromise = new Promise<Error>(resolve => {
      transform.on('error', resolve)
    })

    // Don't push any data - the initial timer should fire
    await vi.advanceTimersByTimeAsync(idleMs + 10)

    const err = await errorPromise
    expect(err.message).toMatch(/No data received/)
  })

  it('resets the timer on each chunk - slow-but-steady stream survives past idleMs total', async () => {
    // Use real timers with a short idleMs so the test completes quickly.
    const idleMs = 80

    let destroyed = false
    const chunks: Buffer[] = []

    await new Promise<void>((resolve, reject) => {
      const transform = createIdleTimeoutStream(idleMs)
      transform.on('error', err => {
        destroyed = true
        reject(err)
      })
      transform.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      transform.on('end', resolve)

      // Send 5 chunks, each 60ms apart (< idleMs), for 300ms total (> idleMs)
      let count = 0
      const interval = setInterval(() => {
        count++
        transform.write(`chunk${count}`)
        if (count >= 5) {
          clearInterval(interval)
          transform.end()
        }
      }, 60)
    })

    expect(destroyed).toBe(false)
    expect(chunks).toHaveLength(5)
  })

  it('does not destroy after a clean end - timer is cleared', async () => {
    vi.useFakeTimers()
    const idleMs = 500
    const transform = createIdleTimeoutStream(idleMs)

    let errorFired = false
    transform.on('error', () => {
      errorFired = true
    })

    const endPromise = new Promise<void>(resolve => transform.on('end', resolve))

    // Write data and end the stream
    transform.write('data')
    transform.end()

    // Drain the stream
    transform.resume()
    await endPromise

    // Advance well past idleMs - no error should fire now that the stream ended
    await vi.advanceTimersByTimeAsync(idleMs * 3)

    expect(errorFired).toBe(false)
  })

  it('clears the pending timer when destroyed externally, not just on flush', async () => {
    // Chained streams forward errors via destroy() rather than a clean end
    // (a chained size-limit Transform forwarding its overflow error, say). Without clearing
    // the timer here, it keeps running idleMs past an already-destroyed
    // stream - destroy() no-ops on the second call so it's not visibly
    // broken, but it's a dangling timer that leaks for the full idleMs on
    // every aborted transfer.
    vi.useFakeTimers()
    const idleMs = 500
    const transform = createIdleTimeoutStream(idleMs)
    // Swallow the error destroy() itself emits, so it doesn't fail the test.
    transform.on('error', () => {})

    transform.destroy(new Error('forwarded from upstream'))
    // Let _destroy's callback run (Node schedules it asynchronously).
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.getTimerCount()).toBe(0)
  })
})
