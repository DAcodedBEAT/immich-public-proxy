#!/usr/bin/env node

// Load .env into process.env, same as `dotenv/config` did - but env vars are
// normally supplied by docker-compose, not a file, so a missing .env (the
// common case) must stay a silent no-op rather than a startup crash.
try {
  process.loadEnvFile()
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
}

import {
  enforceMinimumImmichVersion,
  formatStartupSummary,
  localTimestamp,
  log,
  startImmichHealthMonitor,
  trustProxyHops,
  trustProxyWarning
} from '@ipp/core'
import { removedMetadataSwitches } from './gallery/exif'
// Loads the config as it is imported, so it comes after the .env above
import { app } from './app'

const removedSwitches = removedMetadataSwitches()
if (removedSwitches.length) {
  console.error(
    localTimestamp() +
      ' FATAL: The config has ' +
      removedSwitches.join(' and ') +
      ', which IPP no longer reads. Every per-field flag set to true in that group would now be shown to visitors. ' +
      'Remove the key, and set to true only the fields you want visitors to see. ' +
      'See https://docs.ipp.nz/config/upgrading'
  )
  process.exit(1)
}

// Exit non-zero on an uncaught exception, so Docker restarts the container
process.on('uncaughtException', err => {
  console.error('There was an uncaught error', err)
  server.close()
  process.exit(1)
})
/*
  Log only: with Express 5 routing request errors into errorHandler, a
  stray rejection from a background task (the version check, etc.) is not
  worth killing every in-flight request for.
*/
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Gracefully shutting down...')
  server.close()
  process.exit(0)
})

const port = Number(process.env.IPP_PORT) || 3000
const server = app.listen(port, () => {
  console.log(localTimestamp() + ' Server started on port ' + port)
  console.log(
    localTimestamp() +
      ' ' +
      formatStartupSummary({
        trustProxyHops: trustProxyHops(),
        banlistPath: process.env.IPP_BANLIST_PATH,
        publicBaseUrl: process.env.PUBLIC_BASE_URL
      })
  )
  const proxyWarning = trustProxyWarning(trustProxyHops())
  if (proxyWarning) log.warn(proxyWarning)
  enforceMinimumImmichVersion().catch(e => console.error('Immich version check failed:', e))
  // The check above runs once; this keeps watching, and only ever logs
  startImmichHealthMonitor()
})
