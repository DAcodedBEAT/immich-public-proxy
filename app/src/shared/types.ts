/*
 * Types shared between the server (Preact SSR) and the client (gallery).
 * Only put a type here if it crosses the server/client boundary - i.e. it
 * describes data the server serialises into the gallery's init JSON block.
 */

/**
 * Per-asset EXIF / location metadata shown in the info sidebar. Each field
 * is optional - the server only includes a field when either the group's
 * `enableAll` is true (`ipp.showMetadata.exif.enableAll` /
 * `.location.enableAll`) or the field's own per-field flag is true.
 * Strings are plain text (the client uses `textContent`, not `innerHTML`).
 */

export type GroupByDateMode = 'month' | 'day'

export interface GalleryExif {
  dateTimeOriginal?: string // ISO date string; client formats with Intl.DateTimeFormat
  timeZone?: string
  fileName?: string
  width?: number
  height?: number
  fileSizeInByte?: number // raw bytes; client formats for display
  make?: string
  model?: string
  lensModel?: string
  exposureTime?: string
  iso?: number
  fNumber?: number
  focalLength?: number
  city?: string
  state?: string
  country?: string
  latitude?: number
  longitude?: number
}

export interface GalleryItem {
  id: string
  type: 'IMAGE' | 'VIDEO'
  previewUrl: string
  fullUrl?: string
  thumbnailUrl: string
  downloadUrl?: string
  // Pre-stringified JSON describing the video source (used to build a <video>
  // element for video slides in the PhotoSwipe lightbox)
  videoData?: string
  // Immich uses "description" but this is our caption
  description?: string
  downloadFilename: string
  width?: number
  height?: number
  thumbhash?: string
  fileCreatedAt?: string
  // Photographer's local wall-clock timestamp, used for date grouping. See
  // Asset.localDateTime. Falls back to fileCreatedAt when absent.
  localDateTime?: string
  exif?: GalleryExif
  // True for album "grid" items whose exif / description / real download
  // filename haven't been loaded yet. The client fetches them from the
  // `/meta/` route the first time the item opens in the lightbox.
  needsDetail?: boolean
}

/**
 * Per-asset detail fetched on demand from the `/meta/` route when a lazy
 * (`needsDetail`) album item opens in the lightbox. Mirrors the subset of a
 * full asset the gallery actually renders. All fields respect the share's
 * `showMetadata` toggle and the operator's `ipp.showMetadata.*` config.
 */
export interface AssetMetadata {
  exif?: GalleryExif
  description?: string
  downloadFilename?: string
}

export interface LightboxConfig {
  showArrows: boolean
  showDownload: boolean
  mobileArrows: boolean
  autoPlayVideos: boolean
  options?: Record<string, unknown>
}

/**
 * Metadata-rendering decisions made server-side and forwarded to the client.
 * Whether to render description in each surface, and whether the sidebar
 * has any content the operator wants surfaced (when false, the client skips
 * registering the sidebar + its toolbar toggle entirely).
 */
export interface MetadataConfig {
  descriptionInCaption: boolean
  descriptionInSidebar: boolean
  sidebarHasContent: boolean
  locationWebLink: boolean
}

/**
 * JSON body of every response from `POST /share/:key/upload`. The server
 * builds it in `upload/handler.ts`; the client parses it in
 * `client/upload.ts`. Exactly one of the two shapes is present:
 * success carries `uploaded`/`assetId`/`duplicate`, failure carries `error`
 * (plus `assetId` in the reached-Immich-but-album-add-failed case, so an
 * admin can recover the asset manually).
 */
export interface UploadResponse {
  uploaded?: number
  assetId?: string
  duplicate?: boolean
  error?: string
}

/**
 * Request body of `POST /share/:key/upload-check` - the pre-upload duplicate
 * check. `id` is a client-side correlation value (the file's index in the
 * batch); `checksum` is the hex SHA-1 of the file bytes (Immich's dedup hash).
 */
export interface UploadCheckRequest {
  files: Array<{ id: number; checksum: string }>
}

/**
 * Response body of `POST /share/:key/upload-check`. For `action: 'duplicate'`
 * entries the server has ALREADY added the existing asset to the album - the
 * client just skips the byte transfer and counts it as "already existed".
 */
export interface UploadCheckResponse {
  results?: Array<{ id: number; action: 'upload' | 'duplicate' }>
  error?: string
}

/**
 * Shape of the JSON init block embedded in `gallery.tsx` and consumed by
 * `client/init.ts`. The server writes it via `jsonForInlineScript`; the
 * client reads it via `readInitParams()`.
 */
export interface InitParams {
  items?: GalleryItem[]
  openItem?: number
  lightboxConfig?: LightboxConfig
  metadataConfig?: MetadataConfig
  groupByDate?: GroupByDateMode | false
  metaBase?: string
  showUpload?: boolean
  uploadPath?: string
  // Server-side upload size limit, forwarded so the client can reject
  // oversized files before wasting bandwidth (server still enforces).
  maxFileSizeMb?: number
  // How many parallel upload requests the client should run. Derived
  // server-side from ipp.upload.concurrentUploads so the operator's one
  // knob drives both sides; the server limiter remains the hard cap.
  uploadConcurrency?: number
}
