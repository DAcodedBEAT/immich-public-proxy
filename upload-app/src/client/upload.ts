// The upload page: the placeholder button and dropping files on the page
// open a review sheet, and the files the visitor confirms there join one
// queue. Each file is its own request, so one failure is one file.
// The panel follows Immich's own upload panel: summary lines, then one row
// per file with a status icon, a progress bar while sending, and the error.
//
// Nothing here reads a file's contents; the bytes go straight from the File
// to the request body. The review sheet's thumbnails are object URLs the
// browser decodes itself, each revoked when its file leaves the sheet.

import { createLimiter } from '../shared/limiter.js'
import { fileType, formatSize, isUploadableName, isUploadableType } from '../shared/upload.js'
import type { UploadErrorResponse, UploadPageConfig, UploadResponse } from '../shared/upload.js'
import {
  ICON_ALERT_CIRCLE,
  ICON_CHECK_CIRCLE,
  ICON_CIRCLE_OUTLINE,
  ICON_CLOSE,
  ICON_IMAGE,
  ICON_LOADING,
  ICON_RESTART,
  ICON_VIDEO,
  iconSvg
} from '../shared/icons.js'

// Two at a time: enough to keep a phone's uplink busy without stalling every file behind one big video
const CONCURRENT_UPLOADS = 2
const ATTEMPTS = 3
const RETRY_BASE_MS = 2000
// A Retry-After longer than this is shown as a failure rather than waited out
const MAX_RETRY_WAIT_MS = 60_000

const config = JSON.parse(
  document.getElementById('upload-init')?.textContent || '{}'
) as UploadPageConfig
const run = createLimiter(CONCURRENT_UPLOADS)

const panelEl = document.getElementById('upload-panel') as HTMLElement
const progressEl = document.getElementById('upload-progress') as HTMLElement
const countsEl = document.getElementById('upload-counts') as HTMLElement
const noteEl = document.getElementById('upload-note') as HTMLElement
const listEl = document.getElementById('upload-list') as HTMLElement
const dropEl = document.getElementById('upload-drop') as HTMLElement

const nameEl = document.getElementById('upload-name') as HTMLInputElement | null
const captionEl = document.getElementById('upload-caption') as HTMLTextAreaElement | null

// The visitor's name, remembered for their next visit to any share
const NAME_STORAGE_KEY = 'ipp-upload-name'

/** localStorage can be absent or throw (private mode, blocked storage); the name is only a convenience. */
function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function rememberName(name: string) {
  try {
    if (name) localStorage.setItem(NAME_STORAGE_KEY, name)
    else localStorage.removeItem(NAME_STORAGE_KEY)
  } catch {}
}

/**
 * The name and caption to send with the files being queued now, as query
 * parameters. Empty unless the server enables attribution. Read once per
 * batch, so a retry sends what the file was queued with.
 */
function attributionParams(): Record<string, string> {
  if (!config.attribution) return {}
  const params: Record<string, string> = {}
  const name = nameEl?.value.trim() || ''
  const caption = captionEl?.value.trim() || ''
  rememberName(name)
  if (name) params.uploaderName = name
  if (caption) params.caption = caption
  return params
}

type RowState = 'pending' | 'started' | 'done' | 'duplicate' | 'error'

const STATE_ICONS: Record<RowState, string> = {
  pending: ICON_CIRCLE_OUTLINE,
  started: ICON_LOADING,
  done: ICON_CHECK_CIRCLE,
  duplicate: ICON_ALERT_CIRCLE,
  error: ICON_ALERT_CIRCLE
}

interface UploadRow {
  file: File
  type: string
  /** Extra query parameters: the visitor's name and caption, when given. */
  extra: Record<string, string>
  li: HTMLLIElement
  icon: HTMLElement
  action: HTMLButtonElement
  xhr?: XMLHttpRequest
  // Ends a retry wait early
  wake?: () => void
  cancelled: boolean
}

/*
  Counts for the batch on screen, as Immich shows them. Files added while a
  batch is still sending join it; the first file after a batch has finished
  starts a new one.
*/
const stats = { total: 0, remaining: 0, uploaded: 0, errors: 0, duplicates: 0 }

function updateSummary() {
  progressEl.textContent = `Remaining ${stats.remaining} - Processed ${stats.total - stats.remaining}/${stats.total}`
  countsEl.innerHTML =
    'Uploaded <span class="upload-count-success"></span> - Errors <span class="upload-count-danger"></span> - Duplicates <span class="upload-count-warning"></span>'
  const [uploaded, errors, duplicates] = countsEl.querySelectorAll('span')
  uploaded.textContent = String(stats.uploaded)
  errors.textContent = String(stats.errors)
  duplicates.textContent = String(stats.duplicates)
  noteEl.hidden = stats.remaining > 0 || stats.uploaded === 0
}

function setState(row: UploadRow, state: RowState) {
  row.li.dataset.state = state
  row.icon.innerHTML = iconSvg(STATE_ICONS[state])
}

/** Swap the row's button: cancel while queued or sending, retry or dismiss afterwards. */
function setAction(row: UploadRow, kind: 'cancel' | 'retry' | 'dismiss') {
  const labels = { cancel: 'Cancel', retry: 'Retry', dismiss: 'Dismiss' }
  row.action.dataset.kind = kind
  row.action.setAttribute('aria-label', labels[kind] + ' ' + row.file.name)
  row.action.title = labels[kind]
  row.action.innerHTML = iconSvg(kind === 'retry' ? ICON_RESTART : ICON_CLOSE)
}

/** Remove any progress bar or error line under the row's main line. */
function clearDetail(row: UploadRow) {
  row.li.querySelector('.upload-row-detail')?.remove()
}

function showProgress(row: UploadRow, text: string, percent: number) {
  let bar = row.li.querySelector('.upload-row-detail.upload-bar') as HTMLElement | null
  if (!bar) {
    clearDetail(row)
    bar = document.createElement('div')
    bar.className = 'upload-row-detail upload-bar'
    bar.innerHTML = '<div class="upload-bar-fill"></div><p class="upload-bar-text"></p>'
    row.li.appendChild(bar)
  }
  const fill = bar.firstElementChild as HTMLElement
  const label = bar.lastElementChild as HTMLElement
  fill.style.width = percent + '%'
  label.textContent = text
}

function showError(row: UploadRow, message: string) {
  clearDetail(row)
  const p = document.createElement('p')
  p.className = 'upload-row-detail upload-row-error'
  p.textContent = message
  row.li.appendChild(p)
}

/** Record a finished row: its state, its counter, and the button it keeps. */
function finish(
  row: UploadRow,
  state: 'done' | 'duplicate' | 'error',
  message?: string,
  retryable = false
) {
  setState(row, state)
  clearDetail(row)
  if (state === 'error') {
    stats.errors++
    if (message) showError(row, message)
  } else if (state === 'duplicate') {
    stats.duplicates++
  } else {
    stats.uploaded++
  }
  setAction(row, retryable ? 'retry' : 'dismiss')
}

/** Build the panel row for one file: status icon, name, and its button. */
function addRow(file: File, type: string, extra: Record<string, string>): UploadRow {
  const li = document.createElement('li')
  li.className = 'upload-row'
  const line = document.createElement('div')
  line.className = 'upload-row-line'
  const icon = document.createElement('span')
  icon.className = 'upload-row-icon'
  const name = document.createElement('span')
  name.className = 'upload-row-name'
  name.textContent = file.name
  const action = document.createElement('button')
  action.type = 'button'
  action.className = 'upload-row-action'
  line.append(icon, name, action)
  li.appendChild(line)
  listEl.appendChild(li)

  const row: UploadRow = { file, type, extra, li, icon, action, cancelled: false }
  setState(row, 'pending')
  setAction(row, 'cancel')
  action.addEventListener('click', () => {
    if (action.dataset.kind === 'retry') {
      // A retried file rejoins the batch on screen
      stats.errors--
      queue(row)
      return
    }
    // Cancel and dismiss both take the row away; a cancelled file is not counted
    if (action.dataset.kind === 'cancel') {
      row.cancelled = true
      row.xhr?.abort()
      row.wake?.()
    }
    li.remove()
  })
  return row
}

type Attempt =
  | { outcome: 'sent'; duplicate: boolean }
  | { outcome: 'failed'; message: string; retryable: boolean }
  | { outcome: 'retry'; waitMs: number }
  | { outcome: 'cancelled' }

/** The visitor-facing reason for a refused upload. */
function failureMessage(xhr: XMLHttpRequest): string {
  let reply: Partial<UploadErrorResponse> | undefined
  try {
    reply = JSON.parse(xhr.responseText)
  } catch {}
  if (reply?.error) return reply.error
  // Not our JSON, so a proxy in front of the upload service answered
  if (xhr.status === 413) return 'Too large for this server'
  if (xhr.status === 404) return 'This share no longer accepts photos. Reload the page.'
  return 'Could not be sent'
}

/**
 * A refused upload, with whether another try could succeed: the service or
 * Immich is down, or a limit that lifts with time (the budget sends
 * `Retry-After`). A refused file or a closed share fails the same way every
 * time, so those rows get Dismiss rather than Retry.
 */
function failure(xhr: XMLHttpRequest): Attempt {
  const retryable = xhr.status >= 500 || xhr.getResponseHeader('Retry-After') !== null
  return { outcome: 'failed', message: failureMessage(xhr), retryable }
}

/** One request for one file. XHR rather than fetch, because only XHR reports upload progress. */
function attempt(row: UploadRow, attemptNumber: number): Promise<Attempt> {
  return new Promise(resolve => {
    const timestamp = new Date(row.file.lastModified || Date.now()).toISOString()
    const query = new URLSearchParams({
      filename: row.file.name,
      fileCreatedAt: timestamp,
      fileModifiedAt: timestamp,
      ...row.extra
    })
    const xhr = new XMLHttpRequest()
    row.xhr = xhr
    const started = Date.now()
    xhr.open('POST', config.uploadUrl + '?' + query.toString())
    xhr.setRequestHeader('Content-Type', row.type)
    xhr.upload.addEventListener('progress', e => {
      if (!e.lengthComputable) return
      const percent = Math.round((e.loaded / e.total) * 100)
      const seconds = (Date.now() - started) / 1000
      const speed = seconds > 0 ? e.loaded / seconds : 0
      const eta = speed > 0 ? Math.ceil((e.total - e.loaded) / speed) : 0
      showProgress(row, `${percent}% - ${formatSize(Math.round(speed))}/s - ${eta}s`, percent)
    })

    const backoff = { outcome: 'retry', waitMs: RETRY_BASE_MS * 2 ** (attemptNumber - 1) } as const
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let reply: Partial<UploadResponse> | undefined
        try {
          reply = JSON.parse(xhr.responseText)
        } catch {}
        resolve({ outcome: 'sent', duplicate: reply?.status === 'duplicate' })
      } else if (xhr.status === 429) {
        const seconds = Number(xhr.getResponseHeader('Retry-After'))
        resolve(
          Number.isFinite(seconds) && seconds > 0
            ? { outcome: 'retry', waitMs: seconds * 1000 }
            : backoff
        )
      } else {
        resolve(failure(xhr))
      }
    })
    // A refusal that closes the connection mid-body often arrives as a network error
    xhr.addEventListener('error', () => resolve(backoff))
    xhr.addEventListener('abort', () => resolve({ outcome: 'cancelled' }))
    xhr.send(row.file)
  })
}

/** Wait before a retry; cancelling the row ends the wait. */
function waitToRetry(row: UploadRow, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    row.wake = () => {
      clearTimeout(timer)
      resolve()
    }
  })
}

/** Send one file, retrying a rate limit or a network error, and record the result on its row. */
async function sendFile(row: UploadRow) {
  for (let attemptNumber = 1; !row.cancelled; attemptNumber++) {
    setState(row, 'started')
    showProgress(row, '0%', 0)
    const result = await attempt(row, attemptNumber)
    if (result.outcome === 'cancelled') return
    if (result.outcome === 'sent') {
      finish(row, result.duplicate ? 'duplicate' : 'done')
      return
    }
    if (result.outcome === 'failed') {
      finish(row, 'error', result.message, result.retryable)
      return
    }
    if (attemptNumber >= ATTEMPTS || result.waitMs > MAX_RETRY_WAIT_MS) {
      finish(row, 'error', 'Could not be sent. Try again later.', true)
      return
    }
    setState(row, 'pending')
    showProgress(row, 'Waiting to retry', 0)
    await waitToRetry(row, result.waitMs)
  }
}

/** Start a new batch if the last one has finished. */
function startBatchIfIdle() {
  if (stats.remaining > 0) return
  stats.total = stats.uploaded = stats.errors = stats.duplicates = 0
}

/** Put a row in the send queue and count it as remaining. */
function queue(row: UploadRow) {
  row.cancelled = false
  setState(row, 'pending')
  setAction(row, 'cancel')
  clearDetail(row)
  stats.remaining++
  updateSummary()
  run(() => (row.cancelled ? Promise.resolve() : sendFile(row))).finally(() => {
    stats.remaining--
    // A cancelled file leaves the batch altogether
    if (row.cancelled) stats.total--
    updateSummary()
  })
}

/** Why the server would refuse this file, or undefined when it would take it. */
function refusal(file: File, type: string): string | undefined {
  if (!isUploadableType(type) || !isUploadableName(file.name))
    return 'Only photos and videos can be sent'
  if (file.size > config.maxFileSize)
    return 'Larger than the ' + formatSize(config.maxFileSize) + ' limit'
  return undefined
}

/** Queue files. Anything the server would refuse anyway is refused here, before it costs the visitor's uplink. */
function queueFiles(files: File[], extra: Record<string, string>) {
  if (!files.length) return
  startBatchIfIdle()
  panelEl.hidden = false
  for (const file of files) {
    const type = fileType(file.name, file.type)
    const row = addRow(file, type, extra)
    stats.total++
    const reason = refusal(file, type)
    if (reason) finish(row, 'error', reason)
    else queue(row)
  }
  updateSummary()
}

/*
  The review sheet. Choosing or dropping files lists them here first, with a
  thumbnail, so the visitor can drop a wrong pick or add more before
  anything is sent. Only Upload hands the files to the queue above.
*/

const sheetEl = document.getElementById('upload-review') as HTMLElement
const sheetListEl = document.getElementById('upload-review-list') as HTMLElement
const sheetSummaryEl = document.getElementById('upload-review-summary') as HTMLElement
const submitEl = document.getElementById('upload-review-submit') as HTMLButtonElement
const chooseEl = document.getElementById('upload-choose') as HTMLButtonElement
// The page behind the sheet, made inert while it is open so focus stays in the sheet
const behindSheet = [document.getElementById('header'), document.getElementById('upload-main')]

interface Reviewed {
  file: File
  type: string
  /** Why it will not be sent, shown on its row; such a file is listed but never queued. */
  refusal?: string
  li: HTMLLIElement
  /** Object URL of the thumbnail, revoked when the file leaves the sheet. */
  thumbUrl?: string
}

let reviewed: Reviewed[] = []

function revokeThumb(item: Reviewed) {
  if (!item.thumbUrl) return
  URL.revokeObjectURL(item.thumbUrl)
  item.thumbUrl = undefined
}

function placeholder(icon: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'upload-review-thumb-placeholder'
  span.innerHTML = iconSvg(icon)
  return span
}

/**
 * A thumbnail for a photo the browser can decode; an icon for a video, a
 * refused file, or a photo it cannot (HEIC outside Safari, RAW).
 */
function thumbnail(item: Reviewed): HTMLElement {
  if (item.refusal || !item.type.startsWith('image/'))
    return placeholder(item.type.startsWith('video/') ? ICON_VIDEO : ICON_IMAGE)
  const img = document.createElement('img')
  img.alt = ''
  item.thumbUrl = URL.createObjectURL(item.file)
  img.src = item.thumbUrl
  img.addEventListener('error', () => {
    revokeThumb(item)
    img.replaceWith(placeholder(ICON_IMAGE))
  })
  return img
}

function sendable(): Reviewed[] {
  return reviewed.filter(item => !item.refusal)
}

function updateSheet() {
  const ready = sendable()
  const refused = reviewed.length - ready.length
  const bytes = ready.reduce((sum, item) => sum + item.file.size, 0)
  sheetSummaryEl.textContent =
    `${ready.length} ${ready.length === 1 ? 'file' : 'files'}, ${formatSize(bytes)}` +
    (refused ? ` - ${refused} cannot be sent` : '')
  submitEl.textContent = ready.length ? 'Upload ' + ready.length : 'Upload'
  submitEl.disabled = ready.length === 0
}

function removeFromSheet(item: Reviewed) {
  revokeThumb(item)
  item.li.remove()
  reviewed = reviewed.filter(other => other !== item)
  updateSheet()
  // Keep focus in the sheet once the button that had it is gone
  const next = sheetListEl.querySelector<HTMLButtonElement>('.upload-review-remove')
  ;(next || submitEl).focus()
}

/** List files in the sheet, skipping any already listed. */
function addToSheet(files: File[]) {
  const listed = new Set(reviewed.map(item => fileIdentity(item.file)))
  for (const file of files) {
    if (listed.has(fileIdentity(file))) continue
    listed.add(fileIdentity(file))
    const type = fileType(file.name, file.type)
    const li = document.createElement('li')
    li.className = 'upload-review-row'
    const item: Reviewed = { file, type, refusal: refusal(file, type), li }

    const thumb = document.createElement('span')
    thumb.className = 'upload-review-thumb'
    thumb.appendChild(thumbnail(item))
    const text = document.createElement('span')
    text.className = 'upload-review-text'
    const name = document.createElement('span')
    name.className = 'upload-review-name'
    name.textContent = file.name
    const detail = document.createElement('span')
    detail.className = 'upload-review-detail'
    detail.textContent = formatSize(file.size)
    text.append(name, detail)
    if (item.refusal) {
      li.dataset.refused = ''
      const reason = document.createElement('span')
      reason.className = 'upload-row-error'
      reason.textContent = item.refusal
      text.appendChild(reason)
    }
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'upload-row-action upload-review-remove'
    remove.title = 'Remove'
    remove.setAttribute('aria-label', 'Remove ' + file.name)
    remove.innerHTML = iconSvg(ICON_CLOSE)
    remove.addEventListener('click', () => removeFromSheet(item))

    li.append(thumb, text, remove)
    sheetListEl.appendChild(li)
    reviewed.push(item)
  }
  updateSheet()
}

/** Two picks of the same file are one file. */
function fileIdentity(file: File): string {
  return [file.name, file.size, file.lastModified].join('|')
}

function onSheetKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeSheet()
  }
}

/** Show files for review, opening the sheet or adding to it. */
function review(files: File[]) {
  if (!files.length) return
  const opening = sheetEl.hidden
  if (opening) {
    sheetEl.hidden = false
    document.body.classList.add('upload-review-open')
    for (const el of behindSheet) el?.setAttribute('inert', '')
    document.addEventListener('keydown', onSheetKeydown)
    if (nameEl && !nameEl.value) nameEl.value = rememberedName()
  }
  addToSheet(files)
  if (opening) submitEl.focus()
}

/** Close the sheet, releasing every thumbnail. Its files are forgotten unless they were just queued. */
function closeSheet() {
  for (const item of reviewed) revokeThumb(item)
  reviewed = []
  sheetListEl.replaceChildren()
  sheetEl.hidden = true
  document.body.classList.remove('upload-review-open')
  for (const el of behindSheet) el?.removeAttribute('inert')
  document.removeEventListener('keydown', onSheetKeydown)
  chooseEl.focus()
}

/** Queue the files the sheet can send, with the name and caption, and close it. */
function submitSheet() {
  const files = sendable().map(item => item.file)
  if (!files.length) return
  const extra = attributionParams()
  // The caption belongs to this batch; the name is kept for the next
  if (captionEl) captionEl.value = ''
  closeSheet()
  queueFiles(files, extra)
}

/**
 * Show the drop overlay while a drag carrying files is over the window.
 * `dragenter` and `dragleave` fire per element, so the depth counter stops
 * the overlay flickering as the pointer crosses child nodes.
 */
function setupDragAndDrop() {
  let depth = 0
  const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types?.includes('Files')
  const hide = () => {
    depth = 0
    dropEl.hidden = true
  }
  window.addEventListener('dragenter', e => {
    if (!carriesFiles(e)) return
    depth++
    dropEl.hidden = false
  })
  window.addEventListener('dragover', e => {
    // Without this the browser opens the dropped file instead
    if (carriesFiles(e)) e.preventDefault()
  })
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) hide()
  })
  window.addEventListener('drop', e => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    hide()
    review(Array.from(e.dataTransfer?.files || []))
  })
}

const input = document.getElementById('upload-input') as HTMLInputElement
chooseEl.addEventListener('click', () => input.click())
document.getElementById('upload-review-add')?.addEventListener('click', () => input.click())
document.getElementById('upload-review-cancel')?.addEventListener('click', closeSheet)
document.getElementById('upload-review-close')?.addEventListener('click', closeSheet)
submitEl.addEventListener('click', submitSheet)
input.addEventListener('change', () => {
  review(Array.from(input.files || []))
  // So picking the same file again still fires `change`
  input.value = ''
})
setupDragAndDrop()
