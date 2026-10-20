// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  chooseAndSubmit,
  chooseFiles,
  FakeXHR,
  loadClient,
  makeFile,
  renderUploadPage,
  stubObjectUrls,
  submitReview
} from './clientDom'

/*
  The page client's half of the caption layer: the caption box in the review
  sheet, sent with each file of a batch as the `caption` query parameter.
  Without the layer the page sends exactly what upstream sends.
*/

let urls: ReturnType<typeof stubObjectUrls>

beforeEach(() => {
  FakeXHR.reset()
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  localStorage.clear()
  urls = stubObjectUrls()
})

afterEach(() => {
  urls.restore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const captionField = () => document.getElementById('upload-caption') as HTMLTextAreaElement
const nameField = () => document.getElementById('upload-name') as HTMLInputElement

describe('without captions', () => {
  it('has no caption box and sends only the upstream parameters', async () => {
    renderUploadPage({ captions: false })
    await loadClient()
    expect(captionField()).toBeNull()

    chooseFiles([makeFile('a.jpg')])
    nameField().value = 'Jane Smith'
    submitReview()
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    expect(Object.keys(FakeXHR.instances[0].query).sort()).toEqual([
      'fileCreatedAt',
      'fileModifiedAt',
      'filename',
      'uploader'
    ])
  })
})

describe('with captions', () => {
  it('has a labelled caption box in the sheet, within the server limit, beside the name', async () => {
    renderUploadPage({ captions: true })
    await loadClient()
    expect(captionField().closest('#upload-review')).not.toBeNull()
    expect(captionField().closest('label')?.textContent).toContain('Caption')
    expect(captionField().maxLength).toBe(500)
    expect(nameField().closest('#upload-review')).not.toBeNull()
  })

  it('has the caption box without the name field when askName is off', async () => {
    renderUploadPage({ captions: true, askName: false })
    await loadClient()
    expect(captionField()).not.toBeNull()
    expect(nameField()).toBeNull()
  })

  it('sends the caption with every file of the batch, then clears it for the next', async () => {
    renderUploadPage({ captions: true })
    await loadClient()
    chooseFiles([makeFile('a.jpg'), makeFile('b.jpg')])
    nameField().value = 'Jane Smith'
    captionField().value = '  Cake cutting '
    submitReview()

    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(2))
    for (const xhr of FakeXHR.instances) {
      expect(xhr.query.caption).toBe('Cake cutting')
      expect(xhr.query.uploader).toBe('Jane Smith')
    }
    chooseFiles([makeFile('c.jpg')])
    expect(captionField().value).toBe('')
    expect(nameField().value).toBe('Jane Smith')
  })

  it('leaves out an empty caption', async () => {
    renderUploadPage({ captions: true })
    await loadClient()
    chooseFiles([makeFile('a.jpg')])
    captionField().value = '   '
    submitReview()
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    expect(FakeXHR.instances[0].query).not.toHaveProperty('caption')
  })

  it('keeps the caption when the sheet is cancelled', async () => {
    renderUploadPage({ captions: true })
    await loadClient()
    chooseFiles([makeFile('a.jpg')])
    captionField().value = 'Cake'
    document.getElementById('upload-review-cancel')!.click()
    chooseAndSubmit([makeFile('a.jpg')])
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    expect(FakeXHR.instances[0].query.caption).toBe('Cake')
  })

  it('sends a retried file with the caption it was first queued with', async () => {
    FakeXHR.script = [{ status: 502, body: { error: 'Could not reach Immich' } }]
    renderUploadPage({ captions: true })
    await loadClient()
    chooseFiles([makeFile('a.jpg')])
    captionField().value = 'First'
    submitReview()
    await vi.waitFor(() =>
      expect(document.querySelector('.upload-row')?.getAttribute('data-state')).toBe('error')
    )
    captionField().value = 'Changed since'
    document.querySelector<HTMLButtonElement>('#upload-list .upload-row-action')!.click()
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(2))
    expect(FakeXHR.instances[1].query.caption).toBe('First')
  })
})
