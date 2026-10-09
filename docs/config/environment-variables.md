# Environment variables

Connection and runtime settings are passed as environment variables, typically in the `environment` section of your
`docker-compose.yml`. Only `IMMICH_URL` is required. Everything that controls how shares look and behave is JSON
config instead; see the [Configuration overview](/config/).

## `IMMICH_URL`

**Required**

The URL of your Immich server as reached from inside the IPP container, for example `http://immich_server:2283`.
Use the local address, not your public one: IPP is the only thing that needs to be public. A trailing slash is
ignored.

From inside a container, `localhost` does not reach Immich. If IPP logs "Unable to reach Immich" at startup, see
[Troubleshooting](/troubleshooting).

## `PUBLIC_BASE_URL`

**Optional** · **Default:** derived from each request

The public base URL of IPP without a trailing slash, for example `https://photos.example.com`. The gallery uses
relative URLs everywhere except the `og:image` tag that messaging apps read for link previews, which must be fully
qualified. When unset, IPP builds it from the incoming request's protocol and `Host` header, and sends the page with
`Vary: Host`.

Set it if link previews show `http://` or a private address. Leave it unset if you serve IPP from several domains,
and make sure your reverse proxy forwards the original `Host` header.

## `IPP_PORT`

**Optional** · **Default:** `3000`

The port the web server listens on inside the container. If you change it, update the `ports` mapping and the
`healthcheck` in your compose file to match.

## `IPP_CONFIG`

**Optional** · **Default:** `/app/config.json`

Path to the JSON config file, either absolute or relative to the working directory. Use it to keep the config
somewhere other than the default path. The usual approach is to mount your file over the default path instead, as
described in the [Configuration overview](/config/#mount-a-file).

## `CONFIG`

**Optional**

The JSON config as an inline string. When set, no config file is read at all. See
[Inline via env var](/config/#inline-via-env-var) for an example.

## `IPP_TRUST_PROXY`

**Optional** · **Default:** `0`

The number of reverse proxies in front of IPP, for example `1` for a single Caddy or nginx. With it set, IPP takes
the visitor's address from the `X-Forwarded-For` header those proxies add, instead of the address of the connection,
which behind a proxy is the proxy's own. The address is what [`IPP_BANLIST_PATH`](#ipp-banlist-path) and the
`ABUSE` log lines use.

> [!WARNING]
> Set it to the exact number of proxies. One too many lets a visitor write their own `X-Forwarded-For` and appear as
> any address they like. It also only holds if nothing can reach IPP except through those proxies: publish its port
> on `127.0.0.1` when the proxy runs on the same host.

## `IPP_BANLIST_PATH`

**Optional**

Path inside the container to a plain-text file of banned IP addresses, one per line. A line can also be a CIDR range,
such as `203.0.113.0/24` or `2001:db8::/48`. Blank lines and `#` comments are ignored. Addresses are compared in
canonical form, and an IPv4-mapped IPv6 address such as `::ffff:203.0.113.7` counts as the IPv4 address, so an IPv4
entry still matches on a server that listens on IPv6. A request from a listed address gets an empty 403, and its
connection is closed, before anything else happens. The file is read again whenever it changes, so no restart is
needed, and a missing or unreadable file bans no one.

IPP never writes to the file. Keep it up to date with a tool such as fail2ban or CrowdSec, which can watch IPP's log
for lines like this one, logged for each wrong share password:

```
2026-01-01T12:00:00+00:00 WARN ABUSE event=invalid-password ip=203.0.113.7 key=abcd1234
```

Behind a reverse proxy, also set [`IPP_TRUST_PROXY`](#ipp-trust-proxy), or every visitor has the proxy's address.

## `IPP_SESSION_SECRET`

**Optional** · **Default:** random at each start

The secret that signs the cookie holding a visitor's unlocked share passwords. By default each start of IPP picks a
new one, which signs every visitor out. Set the same long random value on every copy of IPP if you run several
behind a load balancer, so a visitor stays unlocked whichever copy answers.

`APP_VERSION` and `NODE_ENV` are set by the Docker image and are not meant to be changed.

The optional upload service reads the same variables, with the same meanings, so the `environment` block can be
copied across. `PUBLIC_BASE_URL` stays IPP's public URL, which gives the upload page a back button to the gallery.
See [Add the upload service](/visitor-uploads#add-the-upload-service).
