/**
 * Formats the settings that decide whether IP-based abuse blocking works.
 * Every way of getting them wrong (a wrong trust-proxy hop count, a forgotten
 * env var) fails silently - nothing breaks visibly, the app just can't do
 * what the docs say. One line at startup gives the operator something to
 * check against their intended deployment.
 */
export function formatStartupSummary(opts: {
  trustProxyHops: number
  banlistPath: string | undefined
  publicBaseUrl: string | undefined
}): string {
  return [
    'Config:',
    'trustProxy=' + (opts.trustProxyHops > 0 ? opts.trustProxyHops + ' hop(s)' : 'off'),
    'banlist=' + (opts.banlistPath || 'off'),
    'publicBaseUrl=' + (opts.publicBaseUrl || 'unset')
  ].join(' ')
}

/**
 * The reminder logged once at startup while `IPP_TRUST_PROXY` is set: the
 * forwarded address is then believed, so a hop count higher than the real
 * number of proxies lets a visitor pick their own address. Undefined when off.
 */
export function trustProxyWarning(trustProxyHops: number): string | undefined {
  if (trustProxyHops <= 0) return undefined
  return (
    'IPP_TRUST_PROXY=' +
    trustProxyHops +
    ': X-Forwarded-For is trusted for the visitor address. It must equal the real number of proxy hops, ' +
    'or visitors can spoof their address.'
  )
}
