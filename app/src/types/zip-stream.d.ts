declare module 'zip-stream' {
  import { Readable, Transform } from 'stream'

  /** The subset of zip-stream's API that IPP uses. */
  export default class ZipStream extends Transform {
    constructor(options?: { store?: boolean })
    entry(
      source: Readable | Buffer | string,
      data: { name: string },
      callback: (error?: Error | null) => void
    ): this
    /** End the archive once the queued entry is written. */
    finish(): void
  }
}
