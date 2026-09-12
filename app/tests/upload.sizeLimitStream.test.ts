import { describe, it, expect } from 'vitest'
import { createSizeLimitStream } from '../src/upload/sizeLimitStream'
import { Readable } from 'stream'

/**
 * Helper: pipe `data` through the size-limit stream and collect all output
 * chunks via 'data' events. Resolves with the concatenated buffer on success,
 * rejects with the stream error when the limit is exceeded.
 */
function pumpCollect(data: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const { stream } = createSizeLimitStream(maxBytes)
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
    const src = Readable.from([data])
    src.pipe(stream)
  })
}

describe('createSizeLimitStream', () => {
  it('passes data through unchanged when under the limit', async () => {
    const data = Buffer.from('hello world')
    const result = await pumpCollect(data, 100)
    expect(result).toEqual(data)
  })

  it('passes exactly maxBytes through without error', async () => {
    const data = Buffer.allocUnsafe(10)
    data.fill(0x41) // 'A'
    const result = await pumpCollect(data, 10)
    expect(result).toEqual(data)
  })

  it('does not set exceeded when within the limit', async () => {
    const data = Buffer.allocUnsafe(5)
    const limiter = createSizeLimitStream(10)
    await new Promise<void>((resolve, reject) => {
      limiter.stream.on('data', () => {})
      limiter.stream.on('end', resolve)
      limiter.stream.on('error', reject)
      Readable.from([data]).pipe(limiter.stream)
    })
    expect(limiter.exceeded).toBe(false)
  })

  it('destroys the stream with an error when maxBytes+1 bytes are written', async () => {
    const data = Buffer.allocUnsafe(11)
    await expect(pumpCollect(data, 10)).rejects.toThrow()
  })

  it('sets exceeded to true when the limit is exceeded', async () => {
    const data = Buffer.allocUnsafe(11)
    const limiter = createSizeLimitStream(10)
    await new Promise<void>(resolve => {
      limiter.stream.on('data', () => {})
      limiter.stream.on('error', () => resolve())
      Readable.from([data]).pipe(limiter.stream)
    })
    expect(limiter.exceeded).toBe(true)
  })

  it('error message mentions the MB limit', async () => {
    // 2MB limit, send 2MB+1
    const maxBytes = 2 * 1024 * 1024
    const data = Buffer.allocUnsafe(maxBytes + 1)
    const limiter = createSizeLimitStream(maxBytes)
    const err = await new Promise<Error>(resolve => {
      limiter.stream.on('data', () => {})
      limiter.stream.on('error', resolve)
      Readable.from([data]).pipe(limiter.stream)
    })
    expect(err.message).toMatch(/2MB/)
  })

  it('accumulates bytes across multiple chunks', async () => {
    // Three chunks of 4 bytes each = 12 bytes; limit is 10 → should fail
    const chunk = Buffer.allocUnsafe(4)
    const limiter = createSizeLimitStream(10)
    const err = await new Promise<Error | null>(resolve => {
      limiter.stream.on('data', () => {})
      limiter.stream.on('end', () => resolve(null))
      limiter.stream.on('error', resolve)
      // Feed chunks one by one
      const src = Readable.from(
        (async function* () {
          yield chunk
          yield chunk
          yield chunk
        })()
      )
      src.pipe(limiter.stream)
    })
    expect(err).not.toBeNull()
    expect(limiter.exceeded).toBe(true)
  })
})
