// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  chooseFiles,
  click,
  dragEvent,
  FakeXHR,
  loadClient,
  makeFile,
  renderUploadPage,
  stubObjectUrls,
  submitReview
} from './clientDom'

/*
  The review sheet in front of the upload queue: files chosen or dropped are
  listed for the visitor to check, and nothing is sent until Upload. After
  that the queue behaves as before: rows, progress, two at a time, retries.
*/

let urls: ReturnType<typeof stubObjectUrls>

beforeEach(async () => {
  FakeXHR.reset()
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  urls = stubObjectUrls()
  localStorage.clear()
  renderUploadPage()
  await loadClient()
})

afterEach(() => {
  urls.restore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const sheet = () => document.getElementById('upload-review') as HTMLElement
const rows = () => Array.from(sheet().querySelectorAll<HTMLLIElement>('.upload-review-row'))
const submit = () => document.getElementById('upload-review-submit') as HTMLButtonElement
const removeButtons = () => sheet().querySelectorAll('.upload-review-remove')
const panelRows = () =>
  Array.from(document.querySelectorAll<HTMLLIElement>('#upload-list .upload-row'))
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('opening the sheet', () => {
  it('lists chosen files with name, size and thumbnail, and sends nothing yet', async () => {
    expect(sheet().hidden).toBe(true)
    chooseFiles([makeFile('a.jpg', 2048), makeFile('b.mp4', 3 * 1024 * 1024, 'video/mp4')])

    expect(sheet().hidden).toBe(false)
    expect(rows().map(r => r.querySelector('.upload-review-name')?.textContent)).toEqual([
      'a.jpg',
      'b.mp4'
    ])
    expect(rows()[0].querySelector('.upload-review-detail')?.textContent).toBe('2 KB')
    expect(rows()[0].querySelector('img')?.getAttribute('src')).toMatch(/^blob:test\//)
    expect(submit().textContent).toBe('Upload 2')
    expect(document.getElementById('upload-review-summary')?.textContent).toBe('2 files, 3.0 MB')

    await flush()
    expect(FakeXHR.instances).toHaveLength(0)
    expect((document.getElementById('upload-panel') as HTMLElement).hidden).toBe(true)
  })

  it('shows a video as an icon, without reading it into an object URL', () => {
    chooseFiles([makeFile('clip.mp4', 1024, 'video/mp4')])
    expect(rows()[0].querySelector('img')).toBeNull()
    expect(rows()[0].querySelector('.upload-review-thumb-placeholder svg')).not.toBeNull()
    expect(urls.created).not.toHaveBeenCalled()
  })

  it('swaps a photo the browser cannot decode for an icon, and revokes its URL', () => {
    chooseFiles([makeFile('IMG_1.heic', 1024, '')])
    const img = rows()[0].querySelector('img')!
    expect(urls.live.size).toBe(1)
    img.dispatchEvent(new Event('error'))
    expect(rows()[0].querySelector('img')).toBeNull()
    expect(rows()[0].querySelector('.upload-review-thumb-placeholder')).not.toBeNull()
    expect(urls.live.size).toBe(0)
  })

  it('resets the file input, so the same file can be picked again', () => {
    chooseFiles([makeFile()])
    expect((document.getElementById('upload-input') as HTMLInputElement).value).toBe('')
  })

  it('is a labelled modal dialog that takes focus and makes the page behind inert', () => {
    chooseFiles([makeFile()])
    const dialog = sheet().querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Send these photos?'
    )
    expect(document.getElementById('upload-review-summary')?.getAttribute('aria-live')).toBe(
      'polite'
    )
    expect(document.activeElement).toBe(submit())
    expect(document.getElementById('upload-main')?.hasAttribute('inert')).toBe(true)
    expect(document.getElementById('header')?.hasAttribute('inert')).toBe(true)
    expect(removeButtons()[0].getAttribute('aria-label')).toBe('Remove photo.jpg')
  })

  it('opens from a drop on the page, hiding the drop overlay', () => {
    const overlay = document.getElementById('upload-drop') as HTMLElement
    window.dispatchEvent(dragEvent('dragenter'))
    expect(overlay.hidden).toBe(false)
    window.dispatchEvent(dragEvent('drop', [makeFile('dropped.jpg')]))
    expect(overlay.hidden).toBe(true)
    expect(sheet().hidden).toBe(false)
    expect(rows()[0].textContent).toContain('dropped.jpg')
  })
})

describe('in the sheet', () => {
  it('removes a file, revokes its thumbnail, and counts again', () => {
    chooseFiles([makeFile('a.jpg'), makeFile('b.jpg')])
    const [firstUrl] = urls.created.mock.results.map(r => r.value)
    click(removeButtons()[0])
    expect(rows()).toHaveLength(1)
    expect(urls.revoked).toHaveBeenCalledWith(firstUrl)
    expect(submit().textContent).toBe('Upload 1')
    // Focus moves to the next remove button rather than being lost
    expect(document.activeElement).toBe(removeButtons()[0])

    click(removeButtons()[0])
    expect(rows()).toHaveLength(0)
    expect(submit().disabled).toBe(true)
    expect(urls.live.size).toBe(0)
  })

  it('adds more files from the picker while open, skipping a file already listed', () => {
    const a = makeFile('a.jpg')
    chooseFiles([a])
    const pick = vi.spyOn(document.getElementById('upload-input') as HTMLInputElement, 'click')
    click(document.getElementById('upload-review-add'))
    expect(pick).toHaveBeenCalledTimes(1)
    chooseFiles([a, makeFile('b.jpg')])
    expect(rows().map(r => r.querySelector('.upload-review-name')?.textContent)).toEqual([
      'a.jpg',
      'b.jpg'
    ])
    expect(submit().textContent).toBe('Upload 2')
  })

  it('adds dropped files while open', () => {
    chooseFiles([makeFile('a.jpg')])
    window.dispatchEvent(dragEvent('drop', [makeFile('b.jpg')]))
    expect(rows()).toHaveLength(2)
  })

  it('flags a file the server would refuse, and leaves it out of the count', () => {
    chooseFiles([
      makeFile('ok.jpg'),
      makeFile('logo.svg', 10, 'image/svg+xml'),
      makeFile('notes.pdf', 10, 'application/pdf'),
      makeFile('huge.mp4', 11 * 1024 * 1024, 'video/mp4')
    ])
    const refused = rows().filter(r => r.hasAttribute('data-refused'))
    expect(refused.map(r => r.querySelector('.upload-row-error')?.textContent)).toEqual([
      'Only photos and videos can be sent',
      'Only photos and videos can be sent',
      'Larger than the 10.0 MB limit'
    ])
    // A refused SVG is never handed to the browser to render
    expect(urls.created).toHaveBeenCalledTimes(1)
    expect(submit().textContent).toBe('Upload 1')
    expect(document.getElementById('upload-review-summary')?.textContent).toContain(
      '3 cannot be sent'
    )
  })

  it('cannot be submitted when every file would be refused', async () => {
    chooseFiles([makeFile('logo.svg', 10, 'image/svg+xml')])
    expect(submit().disabled).toBe(true)
    submitReview()
    await flush()
    expect(FakeXHR.instances).toHaveLength(0)
  })
})

describe('cancelling', () => {
  it.each([
    ['the Cancel button', () => click(document.getElementById('upload-review-cancel'))],
    ['the close button', () => click(document.getElementById('upload-review-close'))],
    [
      'Escape',
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    ]
  ])('closes with %s, revoking every thumbnail and sending nothing', async (_name, cancel) => {
    chooseFiles([makeFile('a.jpg'), makeFile('b.jpg')])
    expect(urls.live.size).toBe(2)
    cancel()
    expect(sheet().hidden).toBe(true)
    expect(rows()).toHaveLength(0)
    expect(urls.live.size).toBe(0)
    expect(document.getElementById('upload-main')?.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(document.getElementById('upload-choose'))
    await flush()
    expect(FakeXHR.instances).toHaveLength(0)
  })

  it('stops listening for Escape once closed', () => {
    const removed = vi.spyOn(document, 'removeEventListener')
    chooseFiles([makeFile()])
    click(document.getElementById('upload-review-cancel'))
    expect(removed).toHaveBeenCalledWith('keydown', expect.any(Function))
  })

  it('starts empty when opened again', () => {
    chooseFiles([makeFile('a.jpg')])
    click(document.getElementById('upload-review-cancel'))
    chooseFiles([makeFile('b.jpg')])
    expect(rows().map(r => r.querySelector('.upload-review-name')?.textContent)).toEqual(['b.jpg'])
  })
})

describe('submitting', () => {
  it('closes the sheet, revokes the thumbnails and queues the files', async () => {
    chooseFiles([makeFile('a.jpg'), makeFile('b.jpg')])
    submitReview()
    expect(sheet().hidden).toBe(true)
    expect(urls.live.size).toBe(0)
    expect((document.getElementById('upload-panel') as HTMLElement).hidden).toBe(false)
    expect(panelRows().map(r => r.querySelector('.upload-row-name')?.textContent)).toEqual([
      'a.jpg',
      'b.jpg'
    ])
    await vi.waitFor(() => expect(panelRows().every(r => r.dataset.state === 'done')).toBe(true))
    expect(FakeXHR.instances.map(x => x.query.filename)).toEqual(['a.jpg', 'b.jpg'])
    expect(document.getElementById('upload-progress')?.textContent).toBe(
      'Remaining 0 - Processed 2/2'
    )
  })

  it('sends only the files the server would take', async () => {
    chooseFiles([makeFile('ok.jpg'), makeFile('logo.svg', 10, 'image/svg+xml')])
    submitReview()
    await vi.waitFor(() => expect(panelRows()[0]?.dataset.state).toBe('done'))
    expect(FakeXHR.instances).toHaveLength(1)
    expect(panelRows()).toHaveLength(1)
  })

  it('sends two files at a time', async () => {
    FakeXHR.manual = true
    chooseFiles([makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')])
    submitReview()
    await flush()
    expect(FakeXHR.instances).toHaveLength(2)
    FakeXHR.instances[0].respond()
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(3))
  })

  it('types a file the browser left untyped by its extension', async () => {
    chooseFiles([makeFile('IMG_1.HEIC', 1024, '')])
    expect(rows()[0].hasAttribute('data-refused')).toBe(false)
    submitReview()
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    expect(FakeXHR.instances[0].requestHeaders['Content-Type']).toBe('image/heic')
    expect(FakeXHR.instances[0].sent).toBeInstanceOf(File)
  })

  it('keeps the retry button and the error for a failed file', async () => {
    FakeXHR.script = [{ status: 502, body: { error: 'Could not reach Immich' } }]
    chooseFiles([makeFile('a.jpg')])
    submitReview()
    await vi.waitFor(() => expect(panelRows()[0].dataset.state).toBe('error'))
    expect(panelRows()[0].querySelector('.upload-row-error')?.textContent).toBe(
      'Could not reach Immich'
    )
    const action = panelRows()[0].querySelector('.upload-row-action') as HTMLButtonElement
    expect(action.dataset.kind).toBe('retry')
    click(action)
    await vi.waitFor(() => expect(panelRows()[0].dataset.state).toBe('done'))
    expect(FakeXHR.instances).toHaveLength(2)
  })

  it('waits out a rate limit and tries again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    FakeXHR.script = [{ status: 429, body: { error: 'Too many' }, headers: { 'Retry-After': '3' } }]
    chooseFiles([makeFile('a.jpg')])
    submitReview()
    await vi.waitFor(() => expect(panelRows()[0].textContent).toContain('Waiting to retry'))
    expect(FakeXHR.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3000)
    await vi.waitFor(() => expect(panelRows()[0].dataset.state).toBe('done'))
    expect(FakeXHR.instances).toHaveLength(2)
  })

  it('reviews files chosen while others are still sending, and adds them to the batch', async () => {
    FakeXHR.manual = true
    chooseFiles([makeFile('a.jpg')])
    submitReview()
    await flush()
    chooseFiles([makeFile('b.jpg')])
    expect(sheet().hidden).toBe(false)
    expect(rows()).toHaveLength(1)
    submitReview()
    await flush()
    expect(FakeXHR.instances).toHaveLength(2)
    expect(document.getElementById('upload-progress')?.textContent).toBe(
      'Remaining 2 - Processed 0/2'
    )
  })
})
