# Securing Immich with Tailscale Funnel

This is an alternative to the [mTLS setup](/securing-immich-with-mtls) if you already use
[Tailscale](https://tailscale.com/). Instead of running your own reverse proxy and managing certificates, Tailscale's
[Funnel](https://tailscale.com/kb/1223/funnel) exposes just the IPP container to the public internet, with HTTPS
handled for you, while Immich itself never leaves your tailnet.

This keeps the model described in [Why not expose Immich directly?](/introduction#why-not-expose-immich-directly):
only IPP is public, and Immich is reachable solely over your private network.

## How it fits together

- **Immich** runs on a machine in your tailnet and is *not* funnelled. It is reachable only at its tailnet address,
  for example `http://immich.your-tailnet.ts.net:2283` or its `100.x.x.x` IP.
- **IPP** runs on a tailnet machine (the same one or another) with `IMMICH_URL` pointing at that private address.
- `tailscale funnel` exposes IPP's port to the public internet. Tailscale issues and renews the HTTPS certificate,
  so there is no Caddy, Traefik or certificate management to do.

## Setup

1. Turn on [HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) for your tailnet (Tailscale admin
   console, DNS, HTTPS Certificates).

2. Run IPP as described in [Installation](/installation), but publish its port on localhost only rather than on
   every interface. `tailscaled` runs on the same host and forwards to it over loopback, so nothing is lost:

   ```yaml
   ports:
     - '127.0.0.1:3000:3000'
   ```

3. Point IPP at Immich's private tailnet address:

   ```yaml
   environment:
     IMMICH_URL: http://immich.your-tailnet.ts.net:2283
   ```

4. On the machine running IPP, turn on Funnel for IPP's port:

   ```bash
   tailscale funnel --bg 3000
   ```

   Funnel serves the public side on port `443`, `8443` or `10000` only; replace `3000` with the port you published
   IPP on, and see `tailscale funnel --help` to use a public port other than `443`. The command prints the public
   HTTPS URL, for example `https://your-machine.your-tailnet.ts.net`.

5. Set [`PUBLIC_BASE_URL`](/config/environment-variables#public-base-url) to that URL:

   ```yaml
   environment:
     PUBLIC_BASE_URL: https://your-machine.your-tailnet.ts.net
   ```

6. Set **External domain** in Immich's **Server Settings** to the same URL, so the share links Immich generates
   point at IPP.

7. Set [`IPP_TRUST_PROXY`](/config/environment-variables#ipp-trust-proxy) to `1`:

   ```yaml
   environment:
     IPP_TRUST_PROXY: '1'
   ```

   Tailscale's local Funnel forwarder sits exactly one hop in front of IPP and sets `X-Forwarded-For` to the real
   visitor's address, replacing any value the visitor sent. Without this setting IPP sees every visitor as the
   forwarder's local address, so the `ABUSE` log lines and a ban list cannot tell visitors apart.

## Notes

- Funnel exposes one node and port to the public internet. Immich is never reachable outside your tailnet.
- The free Tailscale plan limits Funnel bandwidth, which matters if you serve large videos or "download all" zips.
- A firewall ban does not work behind Funnel: traffic arrives over the tailnet from Tailscale's infrastructure, so
  there is no direct connection from the visitor to block. Point
  [`IPP_BANLIST_PATH`](/config/environment-variables#ipp-banlist-path) at a file of banned addresses instead, and
  let a tool such as fail2ban or CrowdSec maintain it from IPP's log.
