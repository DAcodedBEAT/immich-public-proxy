import { describe, it, expect } from 'vitest'
import { AlbumType } from '@ipp/core'
import { buildNotification } from '../src/notify'
import { share } from './helpers'

const file = { name: 'ipp_upload_IMG_0042.jpg', size: 3145728, type: 'image/jpeg' }
const asset = { id: 'bbbbbbbb-0000-0000-0000-000000000003', status: 'created' as const }

describe('buildNotification', () => {
  it('names an album share by its album id', () => {
    expect(buildNotification(share(), file, asset).data.share).toEqual({
      type: 'album',
      id: 'aaaaaaaa-0000-0000-0000-000000000002',
      title: 'Holiday 2025'
    })
  })

  it('names an individual share by the link id', () => {
    const payload = buildNotification(
      share({ type: AlbumType.individual, album: undefined, description: 'Some photos' }),
      file,
      asset
    )
    expect(payload.data.share).toEqual({
      type: 'individual',
      id: 'ffffffff-0000-0000-0000-000000000001',
      title: 'Some photos'
    })
  })

  it('carries a flat title and message for simple receivers', () => {
    const payload = buildNotification(share(), file, asset)
    expect(payload.title).toBe('Photo sent to Holiday 2025')
    expect(payload.message).toBe('ipp_upload_IMG_0042.jpg (3.0 MB) was uploaded to Holiday 2025.')
  })

  it('names the uploader in the message and the data, and leaves both plain without one', () => {
    const named = buildNotification(
      share(),
      { ...file, name: 'ipp_upload_jane-smith,IMG_0042.jpg' },
      asset,
      'jane-smith'
    )
    expect(named.message).toBe(
      'ipp_upload_jane-smith,IMG_0042.jpg (3.0 MB) was uploaded to Holiday 2025 by jane-smith.'
    )
    expect(named.data.uploader).toBe('jane-smith')
    const anonymous = buildNotification(share(), file, asset)
    expect(anonymous.message).toBe('ipp_upload_IMG_0042.jpg (3.0 MB) was uploaded to Holiday 2025.')
    expect(anonymous.data.uploader).toBe('')
  })

  it('carries a caption only when one was given, and leaves the message as it was', () => {
    const captioned = buildNotification(share(), file, asset, 'jane-smith', 'Cake cutting')
    expect(captioned.data.caption).toBe('Cake cutting')
    expect(captioned.message).toBe(
      'ipp_upload_IMG_0042.jpg (3.0 MB) was uploaded to Holiday 2025 by jane-smith.'
    )
    expect(buildNotification(share(), file, asset, 'jane-smith').data).not.toHaveProperty('caption')
    expect(buildNotification(share(), file, asset, '', '').data).not.toHaveProperty('caption')
  })

  it('never carries the share key, slug or password', () => {
    const payload = JSON.stringify(
      buildNotification(
        share({ key: 'secret-key', slug: 'secret-slug', password: 'hunter2' }),
        file,
        asset
      )
    )
    expect(payload).not.toContain('secret-key')
    expect(payload).not.toContain('secret-slug')
    expect(payload).not.toContain('hunter2')
  })
})
