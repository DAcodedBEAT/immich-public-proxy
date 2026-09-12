/**
 * Formats the settings that determine whether IP-based abuse blocking and
 * share-password enforcement actually work. Every failure mode we've hit
 * with them (wrong trust-proxy hop count, a forgotten env var, a port
 * reachable around the intended proxy) fails completely silently otherwise -
 * nothing breaks visibly, IPP just quietly can't do what the docs say it
 * does. This is a visibility aid for the operator to check against their own
 * intended deployment, not a linter - it deliberately doesn't judge whether
 * a given combination is safe (trustProxy off + uploads on is a perfectly
 * normal direct-exposure setup).
 */
export function formatStartupSummary(opts: {
  trustProxyHops: number
  banlistPath: string | undefined
  publicBaseUrl: string | undefined
  uploadsEnabled: boolean
  uploadRequirePassword: boolean
}): string {
  return [
    'Config:',
    'trustProxy=' + (opts.trustProxyHops > 0 ? opts.trustProxyHops + ' hop(s)' : 'off'),
    'banlist=' + (opts.banlistPath || 'off'),
    'publicBaseUrl=' + (opts.publicBaseUrl || 'unset (derived from request Host header)'),
    'uploads=' + (opts.uploadsEnabled ? 'enabled' : 'disabled'),
    'uploadRequirePassword=' + (opts.uploadsEnabled ? opts.uploadRequirePassword : 'n/a')
  ].join(' ')
}
