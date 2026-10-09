import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express-serve-static-core'

/*
  An unlocked share must survive a restart, or a different replica answering,
  when IPP_SESSION_SECRET is set: the cookie signature already does, and the
  encrypted password inside it has to as well. Each "process" here is a fresh
  module instance, so it has its own per-process random key.
*/

const KEY = 'share-key'
const saved = process.env.IPP_SESSION_SECRET

afterEach(() => {
  if (saved === undefined) delete process.env.IPP_SESSION_SECRET
  else process.env.IPP_SESSION_SECRET = saved
})

async function freshProcess() {
  vi.resetModules()
  return import('../src/session')
}

/** Unlock in one process, then read the cookie contents back in another. */
async function passwordSeenByAnotherProcess(
  writerSecret: string | undefined,
  readerSecret: string | undefined
): Promise<string | undefined> {
  if (writerSecret === undefined) delete process.env.IPP_SESSION_SECRET
  else process.env.IPP_SESSION_SECRET = writerSecret
  const writer = await freshProcess()
  const sent = { session: {} as Record<string, unknown> } as unknown as Request
  writer.storeUnlock(sent, KEY, 'hunter2')
  // What the browser sends back: the session as JSON, not the same object
  const session = JSON.parse(JSON.stringify(sent.session))

  if (readerSecret === undefined) delete process.env.IPP_SESSION_SECRET
  else process.env.IPP_SESSION_SECRET = readerSecret
  const reader = await freshProcess()
  return readPassword(reader.decodeCookie, session)
}

function readPassword(
  decodeCookie: (req: Request<{ key: string }>, res: Response, next: () => void) => void,
  session: Record<string, unknown>
): string | undefined {
  const req = { params: { key: KEY }, session } as unknown as Request<{ key: string }>
  const next = vi.fn()
  decodeCookie(req, {} as Response, next)
  expect(next).toHaveBeenCalledOnce()
  return req.password
}

describe('unlock payload across processes', () => {
  it('stays unlocked in another process sharing IPP_SESSION_SECRET', async () => {
    expect(await passwordSeenByAnotherProcess('shared-secret', 'shared-secret')).toBe('hunter2')
  })

  it('is unreadable by another process when the secret is unset', async () => {
    expect(await passwordSeenByAnotherProcess(undefined, undefined)).toBeUndefined()
  })

  it('is unreadable by a process with a different secret', async () => {
    expect(await passwordSeenByAnotherProcess('secret-a', 'secret-b')).toBeUndefined()
  })

  it('is unreadable once the secret is removed', async () => {
    expect(await passwordSeenByAnotherProcess('shared-secret', undefined)).toBeUndefined()
  })

  it('fails closed on garbage and old-format payloads', async () => {
    process.env.IPP_SESSION_SECRET = 'shared-secret'
    const { decodeCookie } = await freshProcess()
    const { encrypt } = await import('../src/encrypt')
    const crypto = await import('crypto')
    // A payload encrypted under a random key, as before the key was derived
    const oldKey = crypto.randomBytes(32)
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', oldKey, iv)
    const body = JSON.stringify({ password: 'old', expires: '2999-01-01T00:00:00' })
    const old = {
      iv: iv.toString('hex'),
      cr: cipher.update(body, 'utf8', 'hex') + cipher.final('hex')
    }
    const expired = encrypt(JSON.stringify({ password: 'x', expires: '2000-01-01T00:00:00' }))
    const notJson = encrypt('not json')
    for (const entry of [
      old,
      expired,
      notJson,
      { iv: 'zz', cr: 'zz' },
      { iv: '00', cr: '' },
      { iv: ['a'], cr: { b: 1 } },
      'string'
    ]) {
      expect(readPassword(decodeCookie, { [KEY]: entry })).toBeUndefined()
    }
  })
})
