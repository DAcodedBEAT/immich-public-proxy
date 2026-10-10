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
  The page client's half of the attribution layer: the name and caption
  fields in the review sheet, sent as query parameters, and the remembered
  name.
*/

let urls: ReturnType<typeof stubObjectUrls>

const NAME_KEY = 'ipp-upload-name'

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

const nameField = () => document.getElementById('upload-name') as HTMLInputElement
const captionField = () => document.getElementById('upload-caption') as HTMLTextAreaElement

describe('without attribution', () => {
  it('has no fields and sends only the upstream parameters', async () => {
    renderUploadPage({ attribution: false })
    await loadClient()
    expect(nameField()).toBeNull()
    expect(captionField()).toBeNull()

    chooseAndSubmit([makeFile('a.jpg')])
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    expect(Object.keys(FakeXHR.instances[0].query).sort()).toEqual([
      'fileCreatedAt',
      'fileModifiedAt',
      'filename'
    ])
  })

  it('never reads or writes the remembered name', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
    renderUploadPage({ attribution: false })
    await loadClient()
    chooseAndSubmit([makeFile('a.jpg')])
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })
})

describe('with attribution', () => {
  it('has a labelled name field and caption box in the sheet, within the server limits', async () => {
    renderUploadPage({ attribution: true })
    await loadClient()
    expect(nameField().closest('#upload-review')).not.toBeNull()
    expect(captionField().closest('#upload-review')).not.toBeNull()
    expect(nameField().closest('label')?.textContent).toContain('Your name')
    expect(captionField().closest('label')?.textContent).toContain('Caption')
    expect(nameField().maxLength).toBe(100)
    expect(captionField().maxLength).toBe(500)
  })

  it('sends the name and caption with every file, and remembers the name', async () => {
    renderUploadPage({ attribution: true })
    await loadClient()
    chooseFiles([makeFile('a.jpg'), makeFile('b.jpg')])
    nameField().value = '  Alice '
    captionField().value = 'Cake cutting'
    submitReview()

    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(2))
    for (const xhr of FakeXHR.instances) {
      expect(xhr.query.uploaderName).toBe('Alice')
      expect(xhr.query.caption).toBe('Cake cutting')
      expect(xhr.query.filename).toMatch(/^[ab]\.jpg$/)
    }
    expect(localStorage.getItem(NAME_KEY)).toBe('Alice')
    // The caption was for that batch; the name stays for the next
    chooseFiles([makeFile('c.jpg')])
    expect(captionField().value).toBe('')
    expect(nameField().value).toBe('  Alice ')
  })

  it('leaves out an empty field, and forgets a cleared name', async () => {
    localStorage.setItem(NAME_KEY, 'Alice')
    renderUploadPage({ attribution: true })
    await loadClient()
    chooseFiles([makeFile('a.jpg')])
    nameField().value = ''
    submitReview()
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    expect(FakeXHR.instances[0].query).not.toHaveProperty('uploaderName')
    expect(FakeXHR.instances[0].query).not.toHaveProperty('caption')
    expect(localStorage.getItem(NAME_KEY)).toBeNull()
  })

  it('fills in the name remembered from the last visit', async () => {
    localStorage.setItem(NAME_KEY, 'Alice')
    renderUploadPage({ attribution: true })
    await loadClient()
    chooseFiles([makeFile('a.jpg')])
    expect(nameField().value).toBe('Alice')
  })

  it('still uploads when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    renderUploadPage({ attribution: true })
    await loadClient()
    chooseFiles([makeFile('a.jpg')])
    expect(nameField().value).toBe('')
    nameField().value = 'Alice'
    submitReview()
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    expect(FakeXHR.instances[0].query.uploaderName).toBe('Alice')
  })

  it('sends a retried file with what it was first queued with', async () => {
    FakeXHR.script = [{ status: 502, body: { error: 'Could not reach Immich' } }]
    renderUploadPage({ attribution: true })
    await loadClient()
    chooseFiles([makeFile('a.jpg')])
    nameField().value = 'Alice'
    captionField().value = 'First'
    submitReview()
    await vi.waitFor(() =>
      expect(document.querySelector('.upload-row')?.getAttribute('data-state')).toBe('error')
    )
    captionField().value = 'Changed since'
    document.querySelector<HTMLButtonElement>('.upload-row-action')!.click()
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(2))
    expect(FakeXHR.instances[1].query.caption).toBe('First')
  })
})
