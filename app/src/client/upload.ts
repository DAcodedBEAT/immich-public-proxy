// Client-side upload handler. Loaded only when the server marks the share as
// upload-enabled (showUpload=true in the init JSON).
//
// - Picking or dropping files opens a WhatsApp-style review sheet: thumbnails,
//   a batch caption, per-file overrides, remove-before-send.
// - Each file streams in its own request (a worker pool runs a few in
//   parallel, sized by uploadConcurrency) so the server can pipe straight to
//   Immich with no buffering.
// - Files small enough to hash in memory get a SHA-1 pre-check first - ones
//   Immich already has are added to the album server-side, skipping the
//   byte transfer.
// - Uploads use XMLHttpRequest, not fetch: fetch can't report upload
//   progress reliably across browsers, while xhr.upload.onprogress and
//   xhr.abort() just work.

import type {
  InitParams,
  UploadCheckRequest,
  UploadCheckResponse,
  UploadResponse
} from '../shared/types.js'

// A failed attempt on a multi-gigabyte file (e.g. a ProRes clip) restarts
// from zero - there's no resumable upload - so a dropped connection is far
// costlier to retry than for a small photo. More attempts is a cheap way to
// give large transfers more chances before giving up, short of building a
// full chunked/resumable-upload subsystem (deliberately not done - see
// docs/uploads.md's "Scaling for a large event" section for why).
// Exported so tests assert against the real constant, not a copy-pasted
// literal that could silently drift out of sync with it.
export const MAX_ATTEMPTS = 5

// WebCrypto's digest needs the whole file in memory (no streaming), so only
// pre-check files up to this size. Larger files upload normally - Immich
// still dedups them server-side by checksum.
const CHECKSUM_MAX_BYTES = 64 * 1024 * 1024

const NAME_KEY = 'ipp-uploader-name'

function readInitParams(): InitParams {
  const el = document.getElementById('ipp-init')
  if (!el) return {}
  try {
    return JSON.parse(el.textContent || '{}')
  } catch {
    return {}
  }
}

// Track the hide timer so a stale timeout from a previous toast can't hide a
// newer one (e.g. an error toast's 6s timer firing during the next batch's
// progress display).
let hideTimer: number | undefined

function showStatus(
  message: string,
  kind: 'progress' | 'success' | 'error',
  durationMs = 6000,
  onCancel?: () => void
) {
  const el = document.getElementById('upload-status')
  if (!el) return
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer)
    hideTimer = undefined
  }
  el.textContent = ''
  const text = document.createElement('span')
  text.textContent = message
  el.appendChild(text)
  if (onCancel) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = 'Cancel'
    btn.addEventListener('click', onCancel)
    el.appendChild(btn)
  }
  el.className = 'upload-status upload-status--' + kind
  el.hidden = false
  if (kind !== 'progress') {
    hideTimer = window.setTimeout(() => {
      el.hidden = true
    }, durationMs)
  }
}

function setDropZone(visible: boolean) {
  const el = document.getElementById('upload-dropzone')
  if (el) el.hidden = !visible
}

/** Shared cancellation + in-flight tracking for one batch. */
export interface BatchState {
  cancelled: boolean
  xhrs: Set<XMLHttpRequest>
}

/** One file queued in the review sheet, with its per-file caption input. */
export interface UploadEntry {
  file: File
  caption: string
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
}

/** Hex SHA-1 of the file bytes, or null if hashing isn't possible. */
export async function sha1Hex(file: File): Promise<string | null> {
  try {
    if (!crypto?.subtle) return null // requires a secure context
    const digest = await crypto.subtle.digest('SHA-1', await file.arrayBuffer())
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return null
  }
}

/**
 * Ask the server which files Immich already has. Returns the set of indexes
 * (into `files`) that are duplicates - the server has already added those to
 * the album. Any failure returns an empty set: files then upload normally and
 * Immich dedups them server-side, so this check is purely an optimisation.
 */
export async function checkDuplicates(
  files: File[],
  checkPath: string,
  state: BatchState
): Promise<Set<number>> {
  const none = new Set<number>()
  try {
    const items: UploadCheckRequest['files'] = []
    for (let i = 0; i < files.length; i++) {
      if (state.cancelled) return none
      if (files[i].size > CHECKSUM_MAX_BYTES) continue
      const checksum = await sha1Hex(files[i])
      if (checksum) items.push({ id: i, checksum })
    }
    if (items.length === 0 || state.cancelled) return none
    const body: UploadCheckRequest = { files: items }
    const res = await fetch(checkPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) return none
    const json = (await res.json()) as UploadCheckResponse
    const dup = new Set<number>()
    for (const r of json.results || []) {
      if (r.action === 'duplicate') dup.add(r.id)
    }
    return dup
  } catch {
    return none
  }
}

type XhrOutcome = { status: number; body: UploadResponse } | 'aborted' | 'network-error'

function xhrSend(
  entry: UploadEntry,
  uploadPath: string,
  uploaderName: string,
  state: BatchState,
  onProgress: (loadedBytes: number) => void
): Promise<XhrOutcome> {
  return new Promise(resolve => {
    if (state.cancelled) {
      resolve('aborted')
      return
    }
    const xhr = new XMLHttpRequest()
    state.xhrs.add(xhr)
    const settle = (outcome: XhrOutcome) => {
      state.xhrs.delete(xhr)
      resolve(outcome)
    }
    xhr.open('POST', uploadPath)
    xhr.responseType = 'json'
    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) onProgress(e.loaded)
    })
    xhr.addEventListener('load', () =>
      settle({ status: xhr.status, body: (xhr.response || {}) as UploadResponse })
    )
    xhr.addEventListener('error', () => settle('network-error'))
    xhr.addEventListener('abort', () => settle('aborted'))

    const form = new FormData()
    // Text fields must come before the binary so the server captures them from
    // busboy field events before the file stream fires.
    form.append('fileCreatedAt', new Date(entry.file.lastModified).toISOString())
    if (uploaderName) form.append('uploaderName', uploaderName)
    if (entry.caption) form.append('caption', entry.caption)
    form.append('file', entry.file)
    xhr.send(form)
  })
}

type UploadResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; error: string; cancelled?: boolean }

/**
 * Upload a single file, retrying up to MAX_ATTEMPTS times on network failures
 * or 5xx responses. Cancellation is never retried.
 */
export async function uploadFile(
  entry: UploadEntry,
  uploadPath: string,
  uploaderName: string,
  state: BatchState,
  onProgress: (loadedBytes: number) => void,
  attempt = 1
): Promise<UploadResult> {
  const outcome = await xhrSend(entry, uploadPath, uploaderName, state, onProgress)

  if (outcome === 'aborted') {
    return { ok: false, error: 'cancelled', cancelled: true }
  }
  if (outcome === 'network-error') {
    if (attempt < MAX_ATTEMPTS && !state.cancelled) {
      await delay(1000 * attempt)
      return uploadFile(entry, uploadPath, uploaderName, state, onProgress, attempt + 1)
    }
    return { ok: false, error: `Network error after ${MAX_ATTEMPTS} attempts` }
  }

  const { status, body } = outcome
  if (status >= 200 && status < 300 && !body.error) {
    return { ok: true, duplicate: !!body.duplicate }
  }
  // 4xx errors won't resolve with a retry
  if (status >= 400 && status < 500) {
    return { ok: false, error: body.error || `HTTP ${status}` }
  }
  // 5xx: retry if we have attempts left
  if (attempt < MAX_ATTEMPTS && !state.cancelled) {
    await delay(1000 * attempt)
    return uploadFile(entry, uploadPath, uploaderName, state, onProgress, attempt + 1)
  }
  return { ok: false, error: body.error || `HTTP ${status} after ${MAX_ATTEMPTS} attempts` }
}

// Guards against a second batch starting while one is in flight - concurrent
// runs would interleave status toasts and double-book the server limiter.
let uploading = false

async function uploadFiles(
  allEntries: UploadEntry[],
  uploadPath: string,
  uploaderName: string,
  params: InitParams
) {
  if (uploading) {
    showStatus('An upload is already in progress', 'error')
    return
  }
  uploading = true

  const state: BatchState = { cancelled: false, xhrs: new Set() }
  const onCancel = () => {
    state.cancelled = true
    state.xhrs.forEach(xhr => xhr.abort())
  }

  let uploaded = 0
  let duplicates = 0
  const errors: string[] = []

  try {
    // Reject oversized files before uploading a single byte - the server
    // enforces the same limit but can only detect it mid-stream.
    const maxFileSizeMb = params.maxFileSizeMb
    const entries: UploadEntry[] = []
    for (const entry of allEntries) {
      if (maxFileSizeMb && entry.file.size > maxFileSizeMb * 1024 * 1024) {
        errors.push(`${entry.file.name}: exceeds ${maxFileSizeMb}MB limit`)
      } else {
        entries.push(entry)
      }
    }

    // Duplicate pre-check: skip the transfer for files Immich already has.
    let toUpload = entries
    if (entries.some(e => e.file.size <= CHECKSUM_MAX_BYTES)) {
      showStatus('Checking for duplicates…', 'progress', 6000, onCancel)
      const dupIndexes = await checkDuplicates(
        entries.map(e => e.file),
        uploadPath + '-check',
        state
      )
      duplicates += dupIndexes.size
      toUpload = entries.filter((_, i) => !dupIndexes.has(i))
    }

    if (toUpload.length > 0 && !state.cancelled) {
      // Byte-weighted overall progress across the parallel workers.
      const totalBytes = toUpload.reduce((sum, e) => sum + e.file.size, 0)
      let completedBytes = 0
      let done = 0
      const inflight = new Map<number, number>()
      // XHR progress events fire dozens of times per second across the
      // workers; rebuilding the toast (and its Cancel button) each time is
      // wasteful DOM churn. Only re-render when the visible text changes -
      // the percentage moves in whole steps, so this bounds updates to ~100
      // per batch.
      let lastMessage = ''
      const renderProgress = () => {
        if (state.cancelled) return
        let sent = completedBytes
        inflight.forEach(loaded => {
          sent += loaded
        })
        const pct = totalBytes > 0 ? Math.min(100, Math.round((sent / totalBytes) * 100)) : 0
        const message =
          toUpload.length === 1
            ? `Uploading "${toUpload[0].file.name}"… ${pct}%`
            : `Uploading… ${done} of ${toUpload.length} done · ${pct}%`
        if (message === lastMessage) return
        lastMessage = message
        showStatus(message, 'progress', 6000, onCancel)
      }
      renderProgress()

      // A few uploads in parallel keeps the pipe full: with strictly
      // sequential requests, each file pays dead air (RTT + Immich hashing +
      // album-add) before the next byte is sent. The value is derived
      // server-side from ipp.upload.concurrentUploads; TCP handles bandwidth
      // sharing between the parallel streams.
      const concurrency = Math.max(1, params.uploadConcurrency || 3)
      let nextIndex = 0
      const worker = async () => {
        while (!state.cancelled) {
          const i = nextIndex++
          if (i >= toUpload.length) return
          const entry = toUpload[i]
          const result = await uploadFile(entry, uploadPath, uploaderName, state, loaded => {
            inflight.set(i, loaded)
            renderProgress()
          })
          inflight.delete(i)
          if (result.ok) {
            completedBytes += entry.file.size
            if (result.duplicate) duplicates++
            else uploaded++
          } else if (!result.cancelled) {
            completedBytes += entry.file.size
            errors.push(`${entry.file.name}: ${result.error}`)
          }
          done++
          renderProgress()
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, toUpload.length) }, worker))
    }
  } finally {
    uploading = false
  }

  // "uploaded" = new assets; "duplicates" = files Immich already had (still
  // added to the album, so the user's intent is fulfilled either way).
  const summary: string[] = []
  if (uploaded > 0) summary.push(`${uploaded} uploaded`)
  if (duplicates > 0) summary.push(`${duplicates} already existed`)

  if (state.cancelled) {
    showStatus(`Upload cancelled${summary.length ? ' - ' + summary.join(', ') : ''}`, 'error')
    // Anything that landed before the cancel is in the album - show it.
    if (uploaded + duplicates > 0) setTimeout(() => window.location.reload(), 2500)
  } else if (errors.length === 0) {
    showStatus(summary.join(', ') || 'Nothing to upload', 'success')
    // Reload so the gallery reflects the new assets. The server cache was
    // already invalidated - a fresh load picks up the uploaded files.
    setTimeout(() => window.location.reload(), 2000)
  } else if (uploaded + duplicates > 0) {
    // Partial success: leave the errors visible long enough to read, then
    // reload so the files that did land become visible in the gallery.
    showStatus(
      `${summary.join(', ')}, ${errors.length} failed - ${errors.join('; ')}`,
      'error',
      8000
    )
    setTimeout(() => window.location.reload(), 8000)
  } else {
    showStatus(`Upload failed - ${errors.join('; ')}`, 'error')
  }
}

// ----- review sheet ---------------------------------------------------------
// WhatsApp-style pre-upload review: thumbnails, one batch caption, optional
// per-file caption overrides, remove-before-send. Built entirely in JS since
// rows are dynamic; only the toast/dropzone live in the SSR template.

interface SheetRow {
  file: File
  rowEl: HTMLElement
  captionInput: HTMLInputElement
  thumbUrl?: string
}

interface Sheet {
  overlay: HTMLElement
  listEl: HTMLElement
  batchInput: HTMLInputElement
  uploadBtn: HTMLButtonElement
  titleEl: HTMLElement
  rows: SheetRow[]
  // Kept so closeSheet can detach it - every close path (×, backdrop,
  // Escape, upload) must remove the document-level listener.
  onKeydown: (e: KeyboardEvent) => void
}

let sheet: Sheet | null = null

function makeThumb(file: File): { el: HTMLElement; url?: string } {
  if (file.type.startsWith('image/')) {
    const img = document.createElement('img')
    const url = URL.createObjectURL(file)
    img.src = url
    img.alt = ''
    // Formats the browser can't decode (HEIC outside Safari) would show a
    // broken-image icon; swap in the plain placeholder instead.
    img.addEventListener('error', () => {
      const ph = document.createElement('div')
      ph.className = 'upload-review-thumb-video'
      img.replaceWith(ph)
    })
    return { el: img, url }
  }
  // Videos (and anything undecodable) get a play-icon placeholder - decoding
  // a video frame for a thumbnail isn't worth the complexity here.
  const div = document.createElement('div')
  div.className = 'upload-review-thumb-video'
  div.textContent = '▶'
  return { el: div }
}

function refreshSheetCounts() {
  if (!sheet) return
  const n = sheet.rows.length
  sheet.titleEl.textContent = `Upload ${n} ${n === 1 ? 'file' : 'files'}`
  sheet.uploadBtn.textContent = `Upload ${n}`
  sheet.uploadBtn.disabled = n === 0
}

function addRowsToSheet(files: File[]) {
  if (!sheet) return
  for (const file of files) {
    const rowEl = document.createElement('div')
    rowEl.className = 'upload-review-row'

    const thumbWrap = document.createElement('div')
    thumbWrap.className = 'upload-review-thumb'
    const { el: thumbEl, url } = makeThumb(file)
    thumbWrap.appendChild(thumbEl)

    const main = document.createElement('div')
    main.className = 'upload-review-main'
    const meta = document.createElement('div')
    meta.className = 'upload-review-meta'
    meta.textContent = `${file.name} · ${formatBytes(file.size)}`
    const captionInput = document.createElement('input')
    captionInput.type = 'text'
    captionInput.maxLength = 1000
    captionInput.placeholder = 'Caption (optional, overrides the caption above)'
    main.appendChild(meta)
    main.appendChild(captionInput)

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'upload-review-remove'
    removeBtn.setAttribute('aria-label', `Remove ${file.name}`)
    removeBtn.textContent = '×'

    rowEl.appendChild(thumbWrap)
    rowEl.appendChild(main)
    rowEl.appendChild(removeBtn)
    sheet.listEl.appendChild(rowEl)

    const row: SheetRow = { file, rowEl, captionInput, thumbUrl: url }
    sheet.rows.push(row)

    removeBtn.addEventListener('click', () => {
      if (!sheet) return
      if (row.thumbUrl) URL.revokeObjectURL(row.thumbUrl)
      rowEl.remove()
      sheet.rows = sheet.rows.filter(r => r !== row)
      refreshSheetCounts()
    })
  }
  refreshSheetCounts()
}

function closeSheet() {
  if (!sheet) return
  document.removeEventListener('keydown', sheet.onKeydown)
  for (const row of sheet.rows) {
    if (row.thumbUrl) URL.revokeObjectURL(row.thumbUrl)
  }
  sheet.overlay.remove()
  sheet = null
}

function openReviewSheet(
  files: File[],
  uploadPath: string,
  params: InitParams,
  getUploaderName: () => string
) {
  if (uploading) {
    showStatus('An upload is already in progress', 'error')
    return
  }
  // Dropping more files while the sheet is open appends them to the batch.
  if (sheet) {
    addRowsToSheet(files)
    return
  }

  const overlay = document.createElement('div')
  overlay.id = 'upload-review'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')

  const panel = document.createElement('div')
  panel.className = 'upload-review-panel'

  const header = document.createElement('div')
  header.className = 'upload-review-header'
  const titleEl = document.createElement('h2')
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'upload-review-close'
  closeBtn.setAttribute('aria-label', 'Cancel upload')
  closeBtn.textContent = '×'
  header.appendChild(titleEl)
  header.appendChild(closeBtn)

  const batchInput = document.createElement('input')
  batchInput.type = 'text'
  batchInput.maxLength = 1000
  batchInput.className = 'upload-review-batch-caption'
  batchInput.placeholder = 'Caption for all files (optional)'

  const listEl = document.createElement('div')
  listEl.className = 'upload-review-list'

  const footer = document.createElement('div')
  footer.className = 'upload-review-footer'
  const uploadBtn = document.createElement('button')
  uploadBtn.type = 'button'
  uploadBtn.className = 'upload-review-submit'
  footer.appendChild(uploadBtn)

  panel.appendChild(header)
  panel.appendChild(batchInput)
  panel.appendChild(listEl)
  panel.appendChild(footer)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && sheet) closeSheet()
  }
  sheet = { overlay, listEl, batchInput, uploadBtn, titleEl, rows: [], onKeydown }
  addRowsToSheet(files)

  closeBtn.addEventListener('click', closeSheet)
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeSheet()
  })
  document.addEventListener('keydown', onKeydown)

  uploadBtn.addEventListener('click', () => {
    if (!sheet || sheet.rows.length === 0) return
    const batchCaption = sheet.batchInput.value.trim()
    // Per-file caption wins; empty falls back to the batch caption.
    const entries: UploadEntry[] = sheet.rows.map(row => ({
      file: row.file,
      caption: row.captionInput.value.trim() || batchCaption
    }))
    closeSheet() // also removes the keydown listener
    uploadFiles(entries, uploadPath, getUploaderName(), params).catch(() =>
      showStatus('Upload failed', 'error')
    )
  })
}

// ----- init -----------------------------------------------------------------

function initUpload() {
  const params = readInitParams()
  if (!params.showUpload || !params.uploadPath) return

  const uploadPath = params.uploadPath

  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.multiple = true
  fileInput.accept = 'image/*,video/*'
  fileInput.style.display = 'none'
  document.body.appendChild(fileInput)

  const nameInput = document.getElementById('upload-name') as HTMLInputElement | null

  if (nameInput) {
    const saved = localStorage.getItem(NAME_KEY)
    if (saved) nameInput.value = saved
  }

  const getUploaderName = () => {
    const name = nameInput?.value.trim() ?? ''
    if (name) localStorage.setItem(NAME_KEY, name)
    return name
  }

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || [])
    fileInput.value = ''
    if (files.length > 0) {
      openReviewSheet(files, uploadPath, params, getUploaderName)
    }
  })

  const uploadBtn = document.getElementById('upload-btn')
  if (uploadBtn) {
    uploadBtn.addEventListener('click', () => fileInput.click())
  }

  // Drag-and-drop: show the drop zone overlay while dragging files over the window
  let dragCounter = 0
  document.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types.includes('Files')) return
    dragCounter++
    setDropZone(true)
  })
  document.addEventListener('dragleave', () => {
    dragCounter = Math.max(0, dragCounter - 1)
    if (dragCounter === 0) setDropZone(false)
  })
  document.addEventListener('dragover', e => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  })
  document.addEventListener('drop', e => {
    dragCounter = 0
    setDropZone(false)
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      openReviewSheet(files, uploadPath, params, getUploaderName)
    }
  })
}

// Guarded so this module can be imported in a plain Node test environment
// (no `document`) to unit-test the pure/network functions above
// (uploadFile, sha1Hex, checkDuplicates, formatBytes) without needing a DOM.
if (typeof document !== 'undefined') initUpload()
