// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chooseFiles, FakeXHR, loadClient, makeFile, renderUploadPage } from './clientDom'

/*
  The page client's half of the caption layer: the caption box, sent with
  each file of a batch as the `caption` query parameter. Without the layer
  the page sends exactly what upstream sends.
*/

beforeEach(() => {
  FakeXHR.reset()
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  localStorage.clear()
})

afterEach(() => {
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
    nameField().value = 'Jane Smith'

    chooseFiles([makeFile('a.jpg')])
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
  it('has a labelled caption box within the server limit, next to the name field', async () => {
    renderUploadPage({ captions: true })
    await loadClient()
    expect(captionField().closest('label')?.textContent).toContain('Caption')
    expect(captionField().maxLength).toBe(500)
    expect(nameField()).not.toBeNull()
  })

  it('has the caption box without the name field when askName is off', async () => {
    renderUploadPage({ captions: true, askName: false })
    await loadClient()
    expect(captionField()).not.toBeNull()
    expect(nameField()).toBeNull()
  })

  it('sends the caption with every file of the batch, beside the name', async () => {
    renderUploadPage({ captions: true })
    await loadClient()
    nameField().value = 'Jane Smith'
    captionField().value = '  Cake cutting '
    chooseFiles([makeFile('a.jpg'), makeFile('b.jpg')])

    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(2))
    for (const xhr of FakeXHR.instances) {
      expect(xhr.query.caption).toBe('Cake cutting')
      expect(xhr.query.uploader).toBe('Jane Smith')
    }
  })

  it('leaves out an empty caption', async () => {
    renderUploadPage({ captions: true })
    await loadClient()
    captionField().value = '   '
    chooseFiles([makeFile('a.jpg')])
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1))
    expect(FakeXHR.instances[0].query).not.toHaveProperty('caption')
  })

  it('sends a retried file with the caption it was first queued with', async () => {
    FakeXHR.script = [{ status: 502, body: { error: 'Could not reach Immich' } }]
    renderUploadPage({ captions: true })
    await loadClient()
    captionField().value = 'First'
    chooseFiles([makeFile('a.jpg')])
    await vi.waitFor(() =>
      expect(document.querySelector('.upload-row')?.getAttribute('data-state')).toBe('error')
    )
    captionField().value = 'Changed since'
    document.querySelector<HTMLButtonElement>('.upload-row-action')!.click()
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(2))
    expect(FakeXHR.instances[1].query.caption).toBe('First')
  })
})
