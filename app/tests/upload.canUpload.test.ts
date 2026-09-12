import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { canUpload } from '../src/immich'
import { loadConfig } from '../src/config/loader'
import { SharedLink, KeyType, AlbumType } from '../src/types'

// A minimal SharedLink that has allowUpload=true and an album - the "happy path"
// stub. Individual tests override specific properties.
function makeLink(overrides: Partial<SharedLink> = {}): SharedLink {
  return {
    key: 'testkey',
    keyType: KeyType.key,
    type: AlbumType.album,
    assets: [],
    allowUpload: true,
    expiresAt: null,
    ...overrides
  }
}

// Save and restore env + config state around each test so they are isolated.
let savedApiKey: string | undefined
let savedConfig: string | undefined

beforeEach(() => {
  savedApiKey = process.env.IMMICH_API_KEY
  savedConfig = process.env.CONFIG
})

afterEach(() => {
  if (savedApiKey === undefined) {
    delete process.env.IMMICH_API_KEY
  } else {
    process.env.IMMICH_API_KEY = savedApiKey
  }
  if (savedConfig === undefined) {
    delete process.env.CONFIG
  } else {
    process.env.CONFIG = savedConfig
  }
  // Reload config to clear any test-applied override
  loadConfig()
})

describe('canUpload', () => {
  it('returns false when IMMICH_API_KEY is not set, even when link.allowUpload is true', () => {
    delete process.env.IMMICH_API_KEY
    process.env.CONFIG = JSON.stringify({})
    loadConfig()
    expect(canUpload(makeLink(), false)).toBe(false)
  })

  it('returns false when link.allowUpload is falsy (even with an API key)', () => {
    process.env.IMMICH_API_KEY = 'test-api-key'
    process.env.CONFIG = JSON.stringify({})
    loadConfig()
    expect(canUpload(makeLink({ allowUpload: false }), false)).toBe(false)
  })

  it('returns false when link.allowUpload is undefined', () => {
    process.env.IMMICH_API_KEY = 'test-api-key'
    process.env.CONFIG = JSON.stringify({})
    loadConfig()
    expect(canUpload(makeLink({ allowUpload: undefined }), false)).toBe(false)
  })

  it('returns false when ipp.upload.requirePassword is true and no password was provided', () => {
    process.env.IMMICH_API_KEY = 'test-api-key'
    process.env.CONFIG = JSON.stringify({ ipp: { upload: { requirePassword: true } } })
    loadConfig()
    expect(canUpload(makeLink(), false)).toBe(false)
  })

  it('returns true when ipp.upload.requirePassword is true and a password was provided', () => {
    process.env.IMMICH_API_KEY = 'test-api-key'
    process.env.CONFIG = JSON.stringify({ ipp: { upload: { requirePassword: true } } })
    loadConfig()
    expect(canUpload(makeLink(), true)).toBe(true)
  })

  it('returns true when all gates pass (API key set, allowUpload true, no password requirement)', () => {
    process.env.IMMICH_API_KEY = 'test-api-key'
    process.env.CONFIG = JSON.stringify({})
    loadConfig()
    expect(canUpload(makeLink(), false)).toBe(true)
  })

  it('returns true when requirePassword is false (default) and no password provided', () => {
    process.env.IMMICH_API_KEY = 'test-api-key'
    process.env.CONFIG = JSON.stringify({ ipp: { upload: { requirePassword: false } } })
    loadConfig()
    expect(canUpload(makeLink(), false)).toBe(true)
  })

  it('IMMICH_API_KEY empty string is treated as not set', () => {
    process.env.IMMICH_API_KEY = ''
    process.env.CONFIG = JSON.stringify({})
    loadConfig()
    // An empty string is falsy in JS, so this should return false
    expect(canUpload(makeLink(), false)).toBe(false)
  })
})
