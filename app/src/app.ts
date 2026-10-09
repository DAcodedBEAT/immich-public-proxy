import express from 'express'
import { resolve } from 'path'
import {
  addNoStoreHeaders,
  addResponseHeaders,
  Asset,
  AssetType,
  banlistMiddleware,
  constrainParam,
  CORE_PUBLIC_DIR,
  decodeCookie,
  errorHandler,
  getConfigOption,
  getKeyTypeFromShare,
  healthcheck,
  KeyType,
  loadConfig,
  renderPage,
  respondToInvalidRequest,
  sessionMiddleware,
  setInvalidRequestHandler,
  SHARE_TYPES,
  slugLinksDisabled,
  trustProxyHops,
  unlockHandler
} from '@ipp/core'
import { fetchAssetDetail, handleShareRequest } from './immich'
import { resolveShare, resolveSharedAsset } from './resolveShare'
import { buildAssetMetadata } from './gallery/metadata'
import { assetBuffer } from './stream/asset'
import { downloadAssets } from './stream/download'
import { ImageSize } from './types'
import { canDownload, uploadHealthcheck } from './share'
import { respondToInvalidRequest as ippInvalidRequestHandler } from './invalidRequestHandler'
import { ASSET_VERSION } from './version'
import { h } from 'preact'
import { Home } from './view/home'

/*
  Loaded here, as the app is built, because route setup below reads it (and
  must run before any other code that calls getConfigOption). The bundled
  config.json sits one level above this file (src/ in dev, dist/ in the
  image), which is /app/config.json in the image.
*/
loadConfig({ defaultPath: resolve(__dirname, '../config.json') })

/*
  Route every invalid response, including core's, through IPP's handler file,
  so an operator's mounted replacement applies everywhere.
*/
setInvalidRequestHandler(ippInvalidRequestHandler)

export const app = express()

/*
  Trust the client IP forwarded by exactly IPP_TRUST_PROXY proxy hops, so
  req.ip is the visitor rather than the proxy, then reject banned IPs before
  anything else runs. Both are no-ops unless their env var is set.
*/
const proxyHops = trustProxyHops()
if (proxyHops > 0) app.set('trust proxy', proxyHops)
app.use(banlistMiddleware)
app.use(sessionMiddleware({ name: 'session' }))
// For parsing the password unlock form and POSTed JSON payloads
app.use(express.json())
// For parsing the selective-download form POST (form-encoded body)
app.use(express.urlencoded({ extended: false, limit: '1mb' }))

/** Serve IPP's own `public` folder, then core's, at `path`. */
function serveStatic(path: string, options: Parameters<typeof express.static>[1] = {}) {
  for (const dir of ['public', CORE_PUBLIC_DIR]) {
    app.use(path, express.static(dir, { ...options, setHeaders: addResponseHeaders }))
  }
}

// Cache-busted, immutable static assets under a per-release version segment.
const inProduction = process.env.NODE_ENV === 'production'
serveStatic('/share/static/' + ASSET_VERSION, {
  immutable: inProduction,
  maxAge: inProduction ? '365d' : 0
})
serveStatic('/share/static')
// The same assets on /, to allow for /robots.txt and /favicon.ico
serveStatic('/')
app.disable('x-powered-by')

/*
  Express 5 dropped inline regex in route params, so they are constrained
  here: a mismatch skips the route, falling through to the 404 handler.
*/
constrainParam(app, 'shareType', SHARE_TYPES)
constrainParam(app, 'mode', ['download'])
constrainParam(app, 'type', ['photo', 'video'])

/*
  [ROUTE] Healthcheck, on /share/healthcheck and the legacy /healthcheck
*/
app.get(/^(|\/share)\/healthcheck$/, healthcheck)

/*
  [ROUTE] The upload service's healthcheck path, when the service is assumed
  to be at a path on this hostname. The gallery page probes it before showing
  the "Add photos" button. With the upload service routed in front of IPP the
  probe never gets here; without it, this answers "nothing here" as a 204
  rather than a 404, so the probe is neither a console error in the browser
  nor a hit on the 404 policy.
*/
const uploadProbe = uploadHealthcheck()
if (uploadProbe) {
  // Escaped, so an operator's path is matched literally, not as route syntax
  app.get(uploadProbe.replace(/[{}()[\]+?!:*\\]/g, '\\$&'), (_req, res) => {
    addNoStoreHeaders(res)
    res.status(204).end()
  })
}

/*
  [ROUTE] The main URL a visitor opens from a shared link
*/
app.get('/:shareType/:key{/:mode}', decodeCookie, async (req, res) => {
  const keyType = getKeyTypeFromShare(req.params.shareType)

  if (slugLinksDisabled(keyType)) {
    respondToInvalidRequest(res, 404, 'Slug links are disabled in config.json')
  } else {
    await handleShareRequest(
      {
        req,
        key: req.params.key,
        keyType,
        mode: req.params.mode?.toLowerCase(),
        password: req.password
      },
      res
    )
  }
})

/*
  [ROUTE] Password unlock from the password page
*/
app.post('/share/unlock', unlockHandler)

/*
  [ROUTE] Selective download - POST a list of asset IDs, get a zip of just those.
  The list arrives as a single "assets" form field containing a JSON array.
  Validates each ID against share.assets so the request can't pull anything
  outside the share.
*/
app.post('/:shareType/:key/download', decodeCookie, async (req, res) => {
  const keyType = getKeyTypeFromShare(req.params.shareType)
  let requestedIds: unknown
  try {
    requestedIds = JSON.parse(String(req.body?.assets ?? '[]'))
  } catch (e) {
    respondToInvalidRequest(res, 400, 'Malformed assets list')
    return
  }
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
    respondToInvalidRequest(res, 400, 'No assets selected')
    return
  }

  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok) {
    respondToInvalidRequest(res, resolved.status, resolved.reason)
    return
  }
  if (!canDownload(resolved.link)) {
    respondToInvalidRequest(res, 403, 'Downloads disabled for this share')
    return
  }

  const requested = new Set(requestedIds.map(String))
  const validAssets = resolved.link.assets.filter(a => requested.has(a.id))
  if (validAssets.length === 0) {
    respondToInvalidRequest(res, 400, 'No valid assets in selection')
    return
  }

  await downloadAssets(res, resolved.link, validAssets)
})

/*
  [ROUTE] Catch accidental POST requests to share URLs (e.g. from browser history
  state issues) and force a clean GET redirect.
  See https://github.com/alangrainger/immich-public-proxy/pull/205
*/
app.post('/:shareType/:key{/:mode}', (req, res) => {
  res.redirect(303, req.originalUrl)
})

/*
  [ROUTE] Direct link to a photo or video asset
*/
app.get('/share/:type/:key/:id{/:size}', decodeCookie, async (req, res) => {
  addResponseHeaders(res)

  if (req.params.size && !Object.values(ImageSize).includes(req.params.size as ImageSize)) {
    respondToInvalidRequest(res, 404, 'Invalid size parameter ' + req.path)
    return
  }

  const isVideo = req.params.type.toLowerCase() === 'video'
  // Always key auth: this route has no slug form
  const resolved = await resolveSharedAsset(req, KeyType.key, isVideo)
  if (!resolved.ok) {
    // Password-protected: redirect to the share page so the visitor gets the
    // unlock prompt, rather than returning an error.
    // isKey already limits the key to [\w-]+; encoding is a second guard
    // in case that validation is ever loosened.
    if (resolved.passwordRequired) {
      // Not cached, or the visitor would keep being sent here after unlocking
      addNoStoreHeaders(res)
      res.redirect('/share/' + encodeURIComponent(req.params.key))
      return
    }
    respondToInvalidRequest(res, resolved.status, resolved.reason)
    return
  }
  if (resolved.link.password) addNoStoreHeaders(res)
  const asset: Asset = {
    ...resolved.asset,
    type: isVideo ? AssetType.video : resolved.asset.type
  }

  const request = {
    req,
    key: req.params.key,
    range: req.headers.range || ''
  }
  await assetBuffer(request, res, asset, req.params.size, resolved.link, isVideo)
})

/*
  [ROUTE] On-demand per-asset metadata for lazy album items.

  Album shares enumerate their assets from the timeline API, which yields
  grid-only data (no exif / filename / description). When such an item opens
  in the lightbox, the client fetches its detail from here. The id is
  validated against the share's asset set (defence in depth - Immich also
  enforces this via the share key) before we fetch `GET /assets/:id`.
*/
app.get('/:shareType/meta/:key/:id', decodeCookie, async (req, res) => {
  addResponseHeaders(res)

  const resolved = await resolveSharedAsset(req, getKeyTypeFromShare(req.params.shareType))
  if (!resolved.ok) {
    if (resolved.passwordRequired) addNoStoreHeaders(res)
    respondToInvalidRequest(res, resolved.status, resolved.reason)
    return
  }

  if (resolved.link.password) addNoStoreHeaders(res)

  const detail = await fetchAssetDetail(resolved.asset)
  if (!detail) {
    respondToInvalidRequest(res, 404, 'Asset detail unavailable for ' + req.params.id)
    return
  }

  res.json(buildAssetMetadata(detail, resolved.link))
})

/*
  [ROUTE] Home page, so the root shows *something*, as requested in
  https://github.com/alangrainger/immich-public-proxy/discussions/19.
  Turned off by https://docs.ipp.nz/config/ipp-options#showhomepage
*/
if (getConfigOption('ipp.showHomePage', true)) {
  app.get(/^\/(|share)\/*$/, (_req, res) => {
    addResponseHeaders(res)
    res.send(renderPage(h(Home, {})))
  })
}

/*
  [ROUTE] Send a 404 for all other routes and methods. `all`, so a POST or DELETE to an
  unknown path gets the same policy instead of Express's own HTML error page.
*/
app.all('/{*splat}', (req, res) => {
  respondToInvalidRequest(res, 404, 'Invalid route ' + req.path)
})

app.use(errorHandler)
