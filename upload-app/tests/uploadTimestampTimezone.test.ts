import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uploadTimestamp } from '../src/receive'

/*
  Under UTC a date-only string reads the same as local or as UTC, so this
  runs in a zone far from it: the visitor's date is local midnight there.
*/
const savedTz = process.env.TZ

beforeAll(() => {
  process.env.TZ = 'Pacific/Auckland'
})

afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

describe('uploadTimestamp outside UTC', () => {
  it('reads a date-only value as local midnight', () => {
    expect(new Date(2026, 8, 14).getTimezoneOffset()).toBe(-720)
    expect(uploadTimestamp('2026-09-14')).toBe('2026-09-13T12:00:00.000Z')
  })

  it('keeps an explicit UTC value as given', () => {
    expect(uploadTimestamp('2026-09-14T00:00:00.000Z')).toBe('2026-09-14T00:00:00.000Z')
  })
})
