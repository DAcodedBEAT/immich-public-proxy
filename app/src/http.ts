import { NextFunction, Request, Response } from 'express-serve-static-core'
import { getConfigOption } from './config/access'
import { respondToInvalidRequest } from './invalidRequestHandler'
import { log } from './utils/log'

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

/**
 * Terminal Express error middleware. Logs the error server-side, then applies the
 * same privacy policy as any other invalid request.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  log.error(
    'Error handling ' +
      req.method +
      ' ' +
      req.path +
      ' - ' +
      (err instanceof Error ? err.stack || err.message : String(err))
  )
  if (res.headersSent) {
    res.end()
    return
  }
  respondToInvalidRequest(res, 404, 'Unhandled error for ' + req.path)
}
