import { IRouter, Request, Response } from 'express-serve-static-core'
import { resolve } from 'path'
import { getConfigOption } from './config/access'
import { accessible } from './immich/client'

/** Static assets both apps serve from core: pico, the Inter font, the favicon and theme.css. */
export const CORE_PUBLIC_DIR = resolve(__dirname, '../public')

/**
 * Apply the response headers configured under `ipp.responseHeaders` to the
 * given Response. Used by route handlers to attach the default Cache-Control
 * and CORS values from `config.json`.
 */
export function addResponseHeaders(res: Response): void {
  Object.entries(getConfigOption('ipp.responseHeaders', {}) as { [key: string]: string }).forEach(
    ([header, value]) => {
      res.set(header, value)
    }
  )
}

/** Stop browsers and shared caches storing a response: a password-protected share, or an error. */
export function addNoStoreHeaders(res: Response): void {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
}

/**
 * A signal that aborts when the visitor's connection closes before the
 * response has finished, so the request to Immich stops with it.
 */
export function abortOnClose(res: Response): AbortSignal {
  const controller = new AbortController()
  const onClose = () => {
    if (!res.writableFinished) controller.abort()
  }
  res.once('close', onClose)
  if (res.closed) onClose()
  return controller.signal
}

/**
 * A `GET /healthcheck` handler: `body` while Immich answers, else 503. Never
 * cached, so a browser or CDN can't answer for a service that has gone.
 */
export function healthcheckHandler(body: string) {
  return async (_req: Request, res: Response): Promise<void> => {
    addNoStoreHeaders(res)
    if (await accessible()) {
      res.send(body)
    } else {
      res.status(503).send()
    }
  }
}

/** IPP's `GET /healthcheck`: `ok` while Immich answers, else 503. */
export const healthcheck = healthcheckHandler('ok')

/** The URL segments that open a share: `share` for a key, `s` for a slug. */
export const SHARE_TYPES = ['share', 's'] as const

/**
 * Restrict a route param to a fixed set of lower-case values, matched
 * case-insensitively like the rest of the path (and like the Express 4 inline
 * regex this replaces, `/:shareType(share|s)`). A mismatch skips the route,
 * falling through to later routes and the 404 handler; handlers lower-case
 * the param before using it. Params are local to the app or Router they are
 * registered on.
 */
export function constrainParam(
  router: Pick<IRouter, 'param'>,
  name: string,
  allowed: readonly string[]
): void {
  router.param(name, (_req, _res, next, value) =>
    next(allowed.includes(String(value).toLowerCase()) ? undefined : 'route')
  )
}
