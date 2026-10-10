// fallow-ignore-file unused-class-member -- FakeXHR's members are called by the client under test, through the XMLHttpRequest global
import { vi } from 'vitest'
import { h } from 'preact'
import { renderPage } from '@ipp/core'
import type { UploadPageConfig } from '../src/shared/upload'
import { UploadPage } from '../src/view/upload'

/*
  Helpers for the page client's tests, which run under jsdom. The document is
  the page the server renders, so the client is tested against the real
  markup; its module script is not run by jsdom, and `loadClient` imports a
  fresh copy of the client instead.
*/

const UPLOAD_URL = '/share/testkey/upload'

/** Render the upload page with `config` into the jsdom document. */
export function renderUploadPage(config: Partial<UploadPageConfig> = {}) {
  const html = renderPage(
    h(UploadPage, {
      config: {
        uploadUrl: UPLOAD_URL,
        maxFileSize: 10 * 1024 * 1024,
        title: 'Holiday',
        attribution: false,
        ...config
      },
      basePath: ''
    })
  )
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  document.replaceChild(document.importNode(parsed.documentElement, true), document.documentElement)
}

/** Import a fresh copy of the client, which wires itself to the current document. */
export async function loadClient() {
  vi.resetModules()
  await import('../src/client/upload')
}

export function makeFile(name = 'photo.jpg', size = 1024, type = 'image/jpeg'): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: Date.UTC(2025, 5, 1) })
}

/** Pick files through the page's file input, as the native picker would. */
export function chooseFiles(files: File[]) {
  const input = document.getElementById('upload-input') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change'))
}

/** Confirm the review sheet, which hands its files to the upload queue. */
export function submitReview() {
  click(document.getElementById('upload-review-submit'))
}

/** Pick files and confirm them in the review sheet at once. */
export function chooseAndSubmit(files: File[]) {
  chooseFiles(files)
  submitReview()
}

/** A drag event carrying files, as a browser dispatches it on the window. */
export function dragEvent(type: string, files: File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files } })
  return event
}

export function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/**
 * jsdom has no object URLs. Stand-ins that hand out numbered `blob:` URLs and
 * record which are still live, so a test can check every one is revoked.
 */
export function stubObjectUrls() {
  const live = new Set<string>()
  let next = 0
  const created = vi.fn((_blob: Blob) => {
    const url = 'blob:test/' + ++next
    live.add(url)
    return url
  })
  const revoked = vi.fn((url: string) => {
    live.delete(url)
  })
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  URL.createObjectURL = created
  URL.revokeObjectURL = revoked
  return {
    created,
    revoked,
    live,
    restore() {
      URL.createObjectURL = saved.create
      URL.revokeObjectURL = saved.revoke
    }
  }
}

type Outcome = { status: number; body?: unknown; headers?: Record<string, string> }

/**
 * Stands in for XMLHttpRequest. Each request takes the next outcome from
 * `script` (201 `created` once it is empty) and answers on a microtask, or
 * waits for `respond()` when `manual` is set.
 */
export class FakeXHR {
  static instances: FakeXHR[] = []
  static script: Outcome[] = []
  static manual = false

  method = ''
  url = ''
  status = 0
  responseText = ''
  requestHeaders: Record<string, string> = {}
  sent: unknown
  aborted = false
  upload = { addEventListener: () => {} }
  private responseHeaders: Record<string, string> = {}
  private listeners: Record<string, Array<() => void>> = {}

  static reset() {
    FakeXHR.instances = []
    FakeXHR.script = []
    FakeXHR.manual = false
  }

  constructor() {
    FakeXHR.instances.push(this)
  }

  /** The query parameters the request was sent with. */
  get query(): Record<string, string> {
    return Object.fromEntries(new URL(this.url, 'http://x').searchParams)
  }

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null
  }

  addEventListener(event: string, cb: () => void) {
    ;(this.listeners[event] ||= []).push(cb)
  }

  abort() {
    this.aborted = true
    this.listeners.abort?.forEach(cb => cb())
  }

  send(body: unknown) {
    this.sent = body
    if (!FakeXHR.manual) queueMicrotask(() => this.respond())
  }

  respond(
    outcome: Outcome = FakeXHR.script.shift() || { status: 201, body: { status: 'created' } }
  ) {
    this.status = outcome.status
    this.responseText = JSON.stringify(outcome.body ?? {})
    this.responseHeaders = Object.fromEntries(
      Object.entries(outcome.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    )
    this.listeners.load?.forEach(cb => cb())
  }
}
