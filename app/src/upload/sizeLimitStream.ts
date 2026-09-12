import { Transform } from 'stream'

export interface SizeLimitStream {
  stream: Transform
  /** True once the byte limit has been exceeded and the stream has been destroyed. */
  exceeded: boolean
}

/**
 * Create a pass-through Transform that counts bytes and destroys itself the
 * moment `maxBytes` is exceeded, emitting an error so the in-flight upstream
 * request is aborted before any truncated data reaches Immich.
 *
 * Callers can inspect `.exceeded` after the stream errors to distinguish a
 * size-limit abort from other stream errors.
 */
export function createSizeLimitStream(maxBytes: number): SizeLimitStream {
  const state: SizeLimitStream = { stream: null as unknown as Transform, exceeded: false }
  let bytesRead = 0
  state.stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytesRead += chunk.length
      if (bytesRead > maxBytes) {
        state.exceeded = true
        cb(new Error(`File size limit exceeded (${Math.round(maxBytes / 1024 / 1024)}MB)`))
      } else {
        cb(null, chunk)
      }
    }
  })
  return state
}
