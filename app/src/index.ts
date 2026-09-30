#!/usr/bin/env node

// Load .env into process.env, same as `dotenv/config` did - but env vars are
// normally supplied by docker-compose, not a file, so a missing .env (the
// common case) must stay a silent no-op rather than a startup crash.
try {
  process.loadEnvFile()
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
}

import { enforceMinimumImmichVersion, startImmichHealthMonitor } from './immich'
import { loadConfig } from './config/loader'
import { formatStartupSummary } from './utils/startupSummary'
import { app, trustProxyHops } from './app'

// Read config.json (or the inline CONFIG env var) and apply backward-compat
// migrations. Must run before any code that calls getConfigOption.
loadConfig()

// Send the correct process error code for any uncaught exceptions
// so that Docker can gracefully restart the container
process.on('uncaughtException', err => {
  console.error('There was an uncaught error', err)
  server.close()
  process.exit(1)
})
// Log-only: with Express routing request errors into errorHandler, a
// stray rejection from a background task (the version check, etc.) is not
// worth killing every in-flight request for.
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Gracefully shutting down...')
  server.close()
  process.exit(0)
})

// Start the ExpressJS server
const port = Number(process.env.IPP_PORT) || 3000
const server = app.listen(port, () => {
  console.log(new Date().toISOString() + ' Server started on port ' + port)
  console.log(
    new Date().toISOString() +
      ' ' +
      formatStartupSummary({
        trustProxyHops,
        banlistPath: process.env.IPP_BANLIST_PATH,
        publicBaseUrl: process.env.PUBLIC_BASE_URL
      })
  )
  // Bail out early if the Immich server is older than IPP supports, rather
  // than silently serving broken album shares. Unknown/unreachable is
  // tolerated (logs a warning and continues) - see enforceMinimumImmichVersion.
  enforceMinimumImmichVersion().catch(e => console.error('Immich version check failed:', e))
  // Ongoing awareness for the rest of the process's life - the check above
  // only ever runs once, at startup. Advisory only (see its own doc-comment
  // for why this never exits the process the way the startup check can).
  startImmichHealthMonitor()
})
