import crypto from 'crypto'

interface EncryptedPayload {
  iv: string // Initialization Vector (IV)
  cr: string // Encrypted data
}

const algorithm = 'aes-256-cbc'

// Distinct from the cookie-signing use of the same secret, so the two keys never share bytes
const KEY_INFO = 'ipp session payload aes-256-cbc v1'

// Used when IPP_SESSION_SECRET is unset: random per process, so a restart signs everyone out
const randomKey = crypto.randomBytes(32)
let derived: { secret: string; key: Buffer } | undefined

/**
 * The AES key for the session payload. Derived from `IPP_SESSION_SECRET` with
 * HKDF when it is set, so every process sharing the secret can read a cookie
 * another one wrote; otherwise random per process. Read lazily, so the env
 * var only has to be set before the first cookie is handled.
 */
function payloadKey(): Buffer {
  const secret = process.env.IPP_SESSION_SECRET
  if (!secret) return randomKey
  if (derived?.secret !== secret) {
    const key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), KEY_INFO, 32))
    derived = { secret, key }
  }
  return derived.key
}

/**
 * Encrypt text data for storing in the session cookie
 */
export function encrypt(text: string): EncryptedPayload {
  try {
    const ivBuf = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(algorithm, payloadKey(), ivBuf)
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return {
      iv: ivBuf.toString('hex'),
      cr: encrypted
    }
  } catch (e) {}

  return {
    cr: '',
    iv: ''
  }
}

/**
 * Decrypt data which was stored in the session cookie
 */
export function decrypt(payload: EncryptedPayload): string {
  try {
    const decipher = crypto.createDecipheriv(
      algorithm,
      payloadKey(),
      Buffer.from(payload.iv, 'hex')
    )
    let decrypted = decipher.update(payload.cr, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch (e) {}
  return ''
}
