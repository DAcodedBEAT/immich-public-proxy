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
// Loads the config as it is imported, so it comes after the .env above
import { app } from './app'

process.on('uncaughtException', err => {
  console.error('There was an uncaught error', err)
  server.close()
  process.exit(1)
})
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
  console.log(localTimestamp() + ' Upload service started on port ' + port)
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
  enforceMinimumImmichVersion().catch(() => {})
  startImmichHealthMonitor()
})
/*
  A large video on a phone uplink outlasts any whole-request limit; the body
  has an idle timeout instead, and the connection rules in app.ts cover
  every other route
*/
server.requestTimeout = 0
