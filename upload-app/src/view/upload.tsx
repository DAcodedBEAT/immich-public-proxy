import { jsonForInlineScript, ThemeScript } from '@ipp/core'
import { ICON_ARROW_LEFT, ICON_CLOSE, ICON_CLOUD_UPLOAD, ICON_PLUS } from '../shared/icons'
import { CAPTION_MAX_LENGTH, UPLOAD_ACCEPT, UploadPageConfig } from '../shared/upload'
import { ASSET_VERSION } from '../version'

export interface UploadPageProps {
  config: UploadPageConfig
  /** Path prefix the app is mounted under, without a trailing slash. Empty at the root. */
  basePath: string
  /** This share's gallery on IPP, when `PUBLIC_BASE_URL` is set. */
  galleryLink?: string
  /** Plain text shown under the placeholder. Empty hides it. */
  notice: string
}

/** The visitor's optional name, from `ipp.upload.askName`, stored in each filename. */
function NameField() {
  return (
    <label class='upload-name'>
      <span class='upload-name-label'>Your name</span>
      <input
        id='upload-name'
        type='text'
        maxLength={64}
        autocomplete='name'
        placeholder='Optional'
      />
    </label>
  )
}

/**
 * A caption for the files in the review sheet, written as each new photo's
 * description. Only rendered with the caption layer on; see `caption.ts`.
 */
function CaptionField() {
  return (
    <label class='upload-caption'>
      <span class='upload-caption-label'>Caption</span>
      <textarea
        id='upload-caption'
        rows={2}
        maxLength={CAPTION_MAX_LENGTH}
        placeholder='Optional. Shown with each of these photos.'
      />
    </label>
  )
}

/**
 * The review sheet: files chosen or dropped are listed here, with a
 * thumbnail and a remove button, and only sent once the visitor confirms.
 * The name field and the caption box, when the page has them, are part of
 * it. The client fills the list.
 */
function ReviewSheet({ config }: { config: UploadPageConfig }) {
  return (
    <div id='upload-review' class='upload-review' hidden>
      <div
        class='upload-review-panel'
        role='dialog'
        aria-modal='true'
        aria-labelledby='upload-review-title'
      >
        <div class='upload-review-header'>
          <h2 id='upload-review-title'>Send these photos?</h2>
          <button
            id='upload-review-close'
            type='button'
            class='upload-row-action'
            title='Cancel'
            aria-label='Cancel'
          >
            <Icon path={ICON_CLOSE} />
          </button>
        </div>
        <p id='upload-review-summary' aria-live='polite'></p>
        <ul id='upload-review-list' aria-label='Chosen files'></ul>
        {(config.askName || config.captions) && (
          <div class='upload-review-fields'>
            {config.askName && <NameField />}
            {config.captions && <CaptionField />}
          </div>
        )}
        <div class='upload-review-footer'>
          <button id='upload-review-add' type='button' class='upload-button'>
            <Icon path={ICON_PLUS} />
            Add more
          </button>
          <span class='upload-review-spacer'></span>
          <button id='upload-review-cancel' type='button' class='upload-button'>
            Cancel
          </button>
          <button
            id='upload-review-submit'
            type='button'
            class='upload-button upload-button-primary'
          >
            Upload
          </button>
        </div>
      </div>
    </div>
  )
}

function Icon({ path, class: className }: { path: string; class?: string }) {
  return (
    <svg viewBox='0 0 24 24' aria-hidden='true' class={className}>
      <path fill='currentColor' d={path} />
    </svg>
  )
}

/**
 * The upload page for one share, in the look of Immich's own upload UI: the
 * gallery's header, a placeholder to click or drop on, and an upload panel
 * the client fills.
 */
export function UploadPage({ config, basePath, galleryLink, notice }: UploadPageProps) {
  const staticPath = `${basePath}/share/static/${ASSET_VERSION}`
  return (
    <html lang='en'>
      <head>
        <ThemeScript />
        <meta name='viewport' content='width=device-width, initial-scale=1.0' />
        <meta name='robots' content='noindex' />
        <title>{'Add photos to ' + config.title}</title>
        <link rel='icon' href={basePath + '/share/static/favicon.ico'} type='image/x-icon' />
        <link type='text/css' rel='stylesheet' href={staticPath + '/theme.css'} />
        <link type='text/css' rel='stylesheet' href={staticPath + '/style.css'} />
      </head>
      <body>
        <header id='header'>
          {galleryLink && (
            <a
              id='upload-back'
              class='header-action'
              href={galleryLink}
              title='Back to gallery'
              aria-label='Back to gallery'
            >
              <Icon path={ICON_ARROW_LEFT} />
            </a>
          )}
          <div class='header-text'>
            <h1>{config.title}</h1>
            <p class='subtitle'>Add photos and videos</p>
          </div>
        </header>
        <main id='upload-main'>
          <button id='upload-choose' type='button' class='upload-placeholder'>
            <Icon path={ICON_CLOUD_UPLOAD} class='upload-placeholder-icon' />
            <span class='upload-placeholder-title'>Add photos</span>
            <span class='upload-placeholder-text'>
              Choose photos and videos<span class='upload-drop-hint'>, or drop them here</span>
            </span>
          </button>
          {notice && <p class='upload-notice'>{notice}</p>}
          <input id='upload-input' type='file' multiple accept={UPLOAD_ACCEPT} hidden />
          <section id='upload-panel' hidden aria-live='polite' aria-label='Uploads'>
            <p id='upload-progress'></p>
            <p id='upload-counts'></p>
            <ul id='upload-list'></ul>
          </section>
        </main>
        <ReviewSheet config={config} />
        <div id='upload-drop' hidden>
          <Icon path={ICON_CLOUD_UPLOAD} class='upload-drop-icon' />
          <p>Drop files to upload</p>
        </div>
        <script
          type='application/json'
          id='upload-init'
          dangerouslySetInnerHTML={{ __html: jsonForInlineScript(config) }}
        />
        <script type='module' src={staticPath + '/js/client/upload.js'}></script>
      </body>
    </html>
  )
}
