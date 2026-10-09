import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import type { Server } from 'http'
import { connect, type AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  banlistMiddleware,
  resetBanlistCacheForTests,
  trustProxyHops
} from '../src/security/banlist'
import { invalidPasswordResponse, sessionMiddleware } from '../src/session'
import { logAbuse } from '../src/utils/abuseLog'

/*
  The wiring both apps use: trust proxy hops from IPP_TRUST_PROXY, the ban
  list middleware keyed on req.ip, and the ABUSE line a wrong password logs.
*/

const savedEnv = { ...process.env }
afterEach(() => {
  for (const name of ['IPP_TRUST_PROXY', 'IPP_BANLIST_PATH', 'IPP_SESSION_SECRET']) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  resetBanlistCacheForTests()
})

describe('trustProxyHops', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['0', 0],
    ['-1', 0],
    ['lots', 0],
    ['1', 1],
    ['2', 2],
    ['1.9', 1]
  ])('reads IPP_TRUST_PROXY=%j as %d', (value, hops) => {
    if (value === undefined) delete process.env.IPP_TRUST_PROXY
    else process.env.IPP_TRUST_PROXY = value
    expect(trustProxyHops()).toBe(hops)
  })
})

describe('banlistMiddleware with trust proxy', () => {
  let server: Server
  let base: string
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ipp-banlist-mw-'))
    const app = express()
    app.set('trust proxy', 1)
    app.use(banlistMiddleware)
    app.get('/', (_req, res) => {
      res.send('ok')
    })
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })

  afterAll(() => {
    server?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const get = (ip: string) => fetch(base + '/', { headers: { 'X-Forwarded-For': ip } })

  it('answers 403 with no body to the forwarded IP of a banned visitor', async () => {
    const path = join(dir, 'banned.txt')
    writeFileSync(path, '203.0.113.7\n')
    process.env.IPP_BANLIST_PATH = path
    const banned = await get('203.0.113.7')
    expect(banned.status).toBe(403)
    expect(await banned.text()).toBe('')
    expect((await get('203.0.113.8')).status).toBe(200)
  })

  it('closes the connection on a ban, even while the body is still arriving', async () => {
    const path = join(dir, 'banned.txt')
    writeFileSync(path, '203.0.113.7\n')
    process.env.IPP_BANLIST_PATH = path
    const { port } = server.address() as AddressInfo
    const socket = connect(port, '127.0.0.1')
    let received = ''
    socket.on('data', chunk => (received += chunk))
    const closed = new Promise<void>(resolve => socket.on('close', () => resolve()))
    // A large declared body, of which only a trickle is ever sent
    socket.write(
      'POST / HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 203.0.113.7\r\n' +
        'Content-Length: 100000000\r\n\r\nabc'
    )
    const trickle = setInterval(() => socket.writable && socket.write('x'), 20)
    const outcome = await Promise.race([
      closed.then(() => 'closed'),
      new Promise(resolve => setTimeout(() => resolve('still open'), 2000))
    ])
    clearInterval(trickle)
    socket.destroy()
    expect(received).toMatch(/^HTTP\/1\.1 403/)
    expect(received.toLowerCase()).toContain('connection: close')
    expect(outcome).toBe('closed')
  })

  it('sends Connection: close on a ban without a body too', async () => {
    const path = join(dir, 'banned.txt')
    writeFileSync(path, '203.0.113.7\n')
    process.env.IPP_BANLIST_PATH = path
    const banned = await get('203.0.113.7')
    expect(banned.status).toBe(403)
    expect(banned.headers.get('connection')).toBe('close')
  })

  it('lets everyone through when IPP_BANLIST_PATH is unset', async () => {
    delete process.env.IPP_BANLIST_PATH
    expect((await get('203.0.113.7')).status).toBe(200)
  })
})

describe('banlistMiddleware on a dual-stack listener', () => {
  it('bans an IPv4 visitor whose req.ip is IPv4-mapped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipp-banlist-ds-'))
    const path = join(dir, 'banned.txt')
    writeFileSync(path, '127.0.0.0/8\n')
    process.env.IPP_BANLIST_PATH = path
    const app = express()
    let seen = ''
    app.use((req, _res, next) => {
      seen = req.ip || ''
      next()
    })
    app.use(banlistMiddleware)
    app.get('/', (_req, res) => {
      res.send('ok')
    })
    const server = await new Promise<Server>(resolve => {
      const s = app.listen(0, '::', () => resolve(s))
    })
    try {
      const res = await fetch('http://127.0.0.1:' + (server.address() as AddressInfo).port + '/')
      expect(seen).toBe('::ffff:127.0.0.1')
      expect(res.status).toBe(403)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ABUSE line with a crafted X-Forwarded-For', () => {
  it('logs the socket address, not a forwarded value that is not an address', async () => {
    const app = express()
    app.set('trust proxy', 1)
    app.get('/', (req, res) => {
      logAbuse('invalid-password', req, 'key=abcdefgh')
      res.send(req.ip)
    })
    const server = await new Promise<Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
      const res = await fetch(base + '/', { headers: { 'X-Forwarded-For': '9.9.9.9 ip=6.6.6.6' } })
      // Express hands the whole entry through as req.ip
      expect(await res.text()).toBe('9.9.9.9 ip=6.6.6.6')
      const line = String(warn.mock.calls[0][0])
      expect(line).toContain('ABUSE event=invalid-password ip=127.0.0.1 key=abcdefgh')
      expect(line.match(/ip=\S*/g)).toEqual(['ip=127.0.0.1'])

      await fetch(base + '/', { headers: { 'X-Forwarded-For': '::ffff:198.51.100.4' } })
      expect(String(warn.mock.calls[1][0])).toContain('ip=198.51.100.4 ')
    } finally {
      warn.mockRestore()
      server.close()
    }
  })
})

describe('invalidPasswordResponse', () => {
  it('logs an ABUSE line with the visitor IP and a truncated key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const req = { ip: '198.51.100.4', session: {} } as unknown as express.Request
    const res = { status: vi.fn() } as unknown as express.Response
    invalidPasswordResponse(req, res, 'abcdefghijklmnop')
    expect(warn.mock.calls[0][0]).toContain(
      'ABUSE event=invalid-password ip=198.51.100.4 key=abcdefgh'
    )
    expect(res.status).toHaveBeenCalledWith(401)
    warn.mockRestore()
    log.mockRestore()
  })
})

describe('sessionMiddleware with IPP_SESSION_SECRET', () => {
  /** Start an app that writes a session value on /set and reads it back on /get. */
  async function start(): Promise<{ server: Server; base: string }> {
    const app = express()
    app.use(sessionMiddleware({ name: 'test-session' }))
    app.get('/set', (req, res) => {
      if (req.session) req.session.value = 'kept'
      res.send()
    })
    app.get('/get', (req, res) => {
      res.send(String(req.session?.value ?? ''))
    })
    const server = await new Promise<Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    return { server, base: 'http://127.0.0.1:' + (server.address() as AddressInfo).port }
  }

  async function crossReplica(): Promise<string> {
    const a = await start()
    const b = await start()
    try {
      const cookies = (await fetch(a.base + '/set')).headers.getSetCookie()
      const cookie = cookies.map(c => c.split(';')[0]).join('; ')
      return await (await fetch(b.base + '/get', { headers: { Cookie: cookie } })).text()
    } finally {
      a.server.close()
      b.server.close()
    }
  }

  it('lets a second process verify a cookie signed by the first when the secret is shared', async () => {
    process.env.IPP_SESSION_SECRET = 'shared-test-secret'
    expect(await crossReplica()).toBe('kept')
  })

  it('keeps each process to its own random secret when unset', async () => {
    delete process.env.IPP_SESSION_SECRET
    expect(await crossReplica()).toBe('')
  })
})
