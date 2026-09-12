// @vitest-environment jsdom
/**
 * DOM-level tests for src/client/upload.ts - the parts client.upload.test.ts
 * deliberately skips because they need a real document (initUpload, the
 * review sheet, drag-and-drop, button wiring).
 *
 * Each test rebuilds the exact DOM skeleton gallery.tsx renders (#upload-btn,
 * #upload-name, #upload-dropzone, #upload-status, the #ipp-init JSON script)
 * and re-imports the module fresh (vi.resetModules) so initUpload's
 * `document.body.appendChild(fileInput)` / event listeners attach against
 * that DOM, and its module-level `sheet`/`uploading` state doesn't leak
 * between tests. XMLHttpRequest is faked (same shape as client.upload.test.ts)
 * so the "submit" test never touches the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { InitParams } from '../src/shared/types'

function setupDom(params: Partial<InitParams> = {}) {
  document.body.innerHTML = ''

  const controls = document.createElement('div')
  controls.id = 'upload-controls'
  const nameInput = document.createElement('input')
  nameInput.id = 'upload-name'
  const btn = document.createElement('button')
  btn.id = 'upload-btn'
  controls.appendChild(nameInput)
  controls.appendChild(btn)
  document.body.appendChild(controls)

  const dropzone = document.createElement('div')
  dropzone.id = 'upload-dropzone'
  dropzone.hidden = true
  document.body.appendChild(dropzone)

  const status = document.createElement('div')
  status.id = 'upload-status'
  status.hidden = true
  document.body.appendChild(status)

  const init = document.createElement('script')
  init.type = 'application/json'
  init.id = 'ipp-init'
  const merged: InitParams = {
    showUpload: true,
    uploadPath: '/share/testkey/upload',
    maxFileSizeMb: 500,
    uploadConcurrency: 3,
    ...params
  }
  init.textContent = JSON.stringify(merged)
  document.body.appendChild(init)
}

async function loadModule() {
  vi.resetModules()
  await import('../src/client/upload')
}

function makeFile(name = 'photo.jpg', size = 1024, type = 'image/jpeg'): File {
  return new File([new Uint8Array(size)], name, { type })
}

function getFileInput(): HTMLInputElement {
  const el = document.querySelector('input[type=file]')
  if (!el) throw new Error('file input was not created by initUpload')
  return el as HTMLInputElement
}

function selectFiles(files: File[]) {
  const input = getFileInput()
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change'))
}

function dragEventWithFiles(type: string, files: File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files },
    configurable: true
  })
  return event
}

class FakeXHR {
  static instances: FakeXHR[] = []
  static script: Array<{ status: number; body?: unknown }> = []
  responseType = ''
  status = 0
  response: unknown = undefined
  sentBody: FormData | undefined
  upload = { addEventListener: () => {} }
  private listeners: Record<string, Array<() => void>> = {}

  constructor() {
    FakeXHR.instances.push(this)
  }

  open() {}

  addEventListener(event: string, cb: () => void) {
    ;(this.listeners[event] ||= []).push(cb)
  }

  abort() {
    this.listeners.abort?.forEach(cb => cb())
  }

  send(body: FormData) {
    this.sentBody = body
    const outcome = FakeXHR.script.shift() || { status: 201, body: { uploaded: 1 } }
    queueMicrotask(() => {
      this.status = outcome.status
      this.response = outcome.body ?? {}
      this.listeners.load?.forEach(cb => cb())
    })
  }
}

beforeEach(() => {
  FakeXHR.instances = []
  FakeXHR.script = []
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ results: [] }) })
  )
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('initUpload wiring', () => {
  it('does nothing when the share does not allow uploads', async () => {
    setupDom({ showUpload: false })
    await loadModule()
    expect(document.querySelector('input[type=file]')).toBeNull()
    document.getElementById('upload-btn')?.dispatchEvent(new Event('click', { bubbles: true }))
    expect(document.getElementById('upload-review')).toBeNull()
  })

  it('clicking the upload button opens the native file picker', async () => {
    setupDom()
    await loadModule()
    const input = getFileInput()
    expect(input.multiple).toBe(true)
    expect(input.accept).toBe('image/*,video/*')
    const clickSpy = vi.spyOn(input, 'click')
    document.getElementById('upload-btn')!.dispatchEvent(new Event('click', { bubbles: true }))
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })
})

describe('review sheet', () => {
  it('selecting files opens a review sheet with one row per file', async () => {
    setupDom()
    await loadModule()
    selectFiles([makeFile('a.jpg', 1024), makeFile('b.mp4', 2048, 'video/mp4')])

    const sheet = document.getElementById('upload-review')
    expect(sheet).not.toBeNull()
    const rows = sheet!.querySelectorAll('.upload-review-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.upload-review-meta')?.textContent).toContain('a.jpg')
    expect(rows[1].querySelector('.upload-review-meta')?.textContent).toContain('b.mp4')
    expect(sheet!.querySelector('.upload-review-submit')?.textContent).toBe('Upload 2')
  })

  it('the file input is reset after selection, so picking the same file twice fires change again', async () => {
    setupDom()
    await loadModule()
    selectFiles([makeFile()])
    expect(getFileInput().value).toBe('')
  })

  it('removing a row updates the count and disables submit once empty', async () => {
    setupDom()
    await loadModule()
    selectFiles([makeFile('a.jpg'), makeFile('b.jpg')])

    const sheet = document.getElementById('upload-review')!
    sheet
      .querySelectorAll('.upload-review-remove')[0]
      .dispatchEvent(new Event('click', { bubbles: true }))
    expect(sheet.querySelectorAll('.upload-review-row')).toHaveLength(1)
    expect(sheet.querySelector('.upload-review-submit')?.textContent).toBe('Upload 1')

    sheet
      .querySelectorAll('.upload-review-remove')[0]
      .dispatchEvent(new Event('click', { bubbles: true }))
    expect(sheet.querySelectorAll('.upload-review-row')).toHaveLength(0)
    expect((sheet.querySelector('.upload-review-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('dropping files over the window shows the dropzone, then opens the sheet on drop', async () => {
    setupDom()
    await loadModule()
    const dropzone = document.getElementById('upload-dropzone')!
    expect(dropzone.hidden).toBe(true)

    document.dispatchEvent(dragEventWithFiles('dragenter'))
    expect(dropzone.hidden).toBe(false)

    document.dispatchEvent(dragEventWithFiles('drop', [makeFile('dropped.jpg')]))
    expect(dropzone.hidden).toBe(true)
    expect(document.getElementById('upload-review')).not.toBeNull()
    expect(document.querySelector('.upload-review-meta')?.textContent).toContain('dropped.jpg')
  })
})

describe('submitting the review sheet', () => {
  // Real timers here (not vi.useFakeTimers): sha1Hex's crypto.subtle.digest
  // and File.arrayBuffer() complete via real native async completions, which
  // fake timers don't reliably flush in one jump. vi.waitFor polls with real
  // timers until the async chain (checkDuplicates -> upload workers) settles,
  // well before the 2s post-success reload timer - jsdom has no real
  // navigation, but that timer never fires within the test's lifetime.

  it('uploads each file with the right form fields, prefers the per-file caption, and shows success', async () => {
    setupDom()
    await loadModule()

    const nameInput = document.getElementById('upload-name') as HTMLInputElement
    nameInput.value = 'Alice'

    selectFiles([makeFile('a.jpg'), makeFile('b.jpg')])
    const sheet = document.getElementById('upload-review')!
    const batchCaption = sheet.querySelector('.upload-review-batch-caption') as HTMLInputElement
    batchCaption.value = 'Party photos'
    const captionInputs = sheet.querySelectorAll('.upload-review-row input')
    ;(captionInputs[0] as HTMLInputElement).value = 'Cake cutting'
    // Row 1 gets no per-file caption, so it should fall back to the batch caption.

    sheet
      .querySelector('.upload-review-submit')!
      .dispatchEvent(new Event('click', { bubbles: true }))
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(2))

    const firstBody = FakeXHR.instances[0].sentBody as unknown as FormData
    expect(firstBody.get('uploaderName')).toBe('Alice')
    expect(firstBody.get('caption')).toBe('Cake cutting')
    const secondBody = FakeXHR.instances[1].sentBody as unknown as FormData
    expect(secondBody.get('caption')).toBe('Party photos')

    // Sheet closes immediately on submit, before the requests settle.
    expect(document.getElementById('upload-review')).toBeNull()
    await vi.waitFor(() =>
      expect(document.getElementById('upload-status')?.textContent).toContain('uploaded')
    )
    // The name is remembered for next time.
    expect(localStorage.getItem('ipp-uploader-name')).toBe('Alice')
  })

  it('leaves an error visible when every upload fails', async () => {
    setupDom()
    await loadModule()
    FakeXHR.script = [{ status: 400, body: { error: 'file type not allowed' } }]

    selectFiles([makeFile('bad.exe', 1024, 'application/octet-stream')])
    document
      .querySelector('.upload-review-submit')!
      .dispatchEvent(new Event('click', { bubbles: true }))

    await vi.waitFor(() =>
      expect(document.getElementById('upload-status')?.textContent).toContain(
        'file type not allowed'
      )
    )
    expect(document.getElementById('upload-status')?.className).toContain('upload-status--error')
  })
})
