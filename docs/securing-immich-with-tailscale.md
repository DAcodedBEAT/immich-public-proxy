# Securing Immich with Tailscale Funnel

This is an alternative to the [mTLS setup](./securing-immich-with-mtls.md) if you're already using
[Tailscale](https://tailscale.com/). Instead of running your own reverse proxy and managing certificates,
Tailscale's [Funnel](https://tailscale.com/kb/1223/funnel) feature exposes just the IPP container to the
public internet - with HTTPS handled for you - while Immich itself never leaves your tailnet.

This keeps IPP's core security model intact: only the proxy is public, and Immich stays reachable solely
over your private network.

## How it fits together

- **Immich** runs on a machine in your tailnet and is *not* funneled. It's reachable only via its tailnet
  address, e.g. `http://immich.your-tailnet.ts.net:2283` or its `100.x.x.x` IP.
- **IPP** runs on a tailnet machine (the same one or a different one) with `IMMICH_URL` pointing at that
  private tailnet address.
- `tailscale funnel` exposes IPP's port to the public internet. Tailscale issues and renews the HTTPS
  certificate automatically - no Caddy/Traefik/cert management needed.

## Setup

1. Make sure [HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) are enabled for your tailnet
   (Tailscale admin console → DNS → HTTPS Certificates).

2. Run IPP as normal (see the main [Installation](../README.md#installation) instructions), but bind its port
   to localhost only rather than every host interface - `tailscaled` runs on this same host and forwards to it
   over loopback, so nothing is lost:

   ```yaml
   ports:
     - "127.0.0.1:3000:3000"
   ```

3. Point IPP at Immich's private tailnet address in your `docker-compose.yml`:

   ```yaml
   environment:
     IMMICH_URL: http://immich.your-tailnet.ts.net:2283
   ```

4. On the machine running IPP, enable Funnel for IPP's port. Funnel only supports ports `443`, `8443`, and
   `10000`, so map IPP's internal port to one of those:

   ```bash
   tailscale funnel --bg 3000
   ```

   (Replace `3000` with whatever port you exposed IPP on, or use `--https=443` syntax if you're mapping to a
   different funnel port - see `tailscale funnel --help`.)

   This prints the public HTTPS URL, e.g. `https://your-machine.your-tailnet.ts.net`.

5. Set `PUBLIC_BASE_URL` in IPP's environment to that funnel URL:

   ```yaml
   environment:
     PUBLIC_BASE_URL: https://your-machine.your-tailnet.ts.net
   ```

6. Set the **External domain** in Immich's **Server Settings** to the same funnel URL, so share links Immich
   generates point at the right place.

7. Set `IPP_TRUST_PROXY` to `1`:

   ```yaml
   environment:
     IPP_TRUST_PROXY: "1"
   ```

   Tailscale's local Funnel forwarder sits exactly one hop in front of IPP and correctly sets
   `X-Forwarded-For` to the real public visitor's IP for every request - Tailscale replaces any
   value a visitor tries to set themselves, so it can't be spoofed. Without this setting, IPP has
   no way to know a proxy is even there, and falls back to the forwarder's own local address for
   every visitor. That address is what ends up in `req.ip` - the value abuse logging and
   [`IPP_BANLIST_PATH`](./uploads.md#blocking-abusive-visitors-fail2ban-and-crowdsec) both key off - so without this
   setting, banning visitors by IP silently does nothing at all (every visitor looks the same,
   and it isn't even a real attacker's address). See [Blocking abusive visitors](./uploads.md#blocking-abusive-visitors-fail2ban-and-crowdsec)
   if you plan on wiring up fail2ban/CrowdSec or the banlist file behind Funnel - both work
   normally once this is set.

## Notes

- Funnel exposes exactly one node/port to the public internet - Immich itself is never reachable outside
  your tailnet, matching the same "proxy is public, Immich is private" model as the mTLS setup.
- The free Tailscale tier has bandwidth limits on Funnel traffic, which is worth keeping in mind if you're
  serving large videos or "download all" zips publicly.
- If you also enable [guest uploads](./uploads.md), the same funneled URL is what visitors will upload
  through - the `IMMICH_API_KEY` and Immich instance itself still never leave the tailnet.
