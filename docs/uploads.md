# Uploads

IPP can optionally let visitors upload photos and videos to an album you've shared - a guest-upload flow for
collecting event photos, without giving anyone access to your Immich instance.

The feature is **off by default** and requires two deliberate steps to enable (one in IPP, one per share in
Immich), so a stock IPP install remains strictly read-only.

## Contents

- [Minimum Immich version](#minimum-immich-version)
- [How to enable](#how-to-enable)
  - [How this compares to Immich's own "Allow public user to upload"](#how-this-compares-to-immichs-own-allow-public-user-to-upload)
  - [Limiting the API key's reach](#limiting-the-api-keys-reach)
- [How it works for visitors](#how-it-works-for-visitors)
- [Configuration options](#configuration-options)
- [Knowing who uploaded](#knowing-who-uploaded)
- [Security notes](#security-notes)
- [Blocking abusive visitors (fail2ban and CrowdSec)](#blocking-abusive-visitors-fail2ban-and-crowdsec)
- [Testing without a running Immich](#testing-without-a-running-immich)
- [Failure modes](#failure-modes)

## Minimum Immich version

The whole upload feature needs **Immich v1.140.0** or later - that's when Immich added the `metadata` field
to its upload endpoint, which is what the [audit metadata](#knowing-who-uploaded) feature relies on. Everything
else it uses shipped earlier, so on an older Immich most sub-features still work; only the audit trail is lost.

| Sub-feature | Minimum version | On an older Immich |
|---|---|---|
| Core upload + `allowUpload` permission | v1.43.0 | N/A - this is the floor for the feature existing at all |
| Adding uploads to the album | v1.43.0 | N/A |
| MIME-type validation via `GET /server/media-types` | v1.68.0 | IPP falls back to a broad `image/*`/`video/*` check (same fallback used when Immich is merely unreachable) |
| SHA-1 pre-upload dedup check | v1.58.0 | The endpoint 502s once, IPP logs it and every file just uploads normally; Immich still dedups by checksum server-side |
| `uploaded-by/<name>` tag | v1.113.0 | Self-disables on the first failed request - see the permission-memo behavior in [Knowing who uploaded](#knowing-who-uploaded) |
| Caption / "Uploaded by" description | v1.43.0 | Same self-disabling behavior on failure |
| `ipp-upload` audit metadata (uploader, IP, share, album) | **v1.140.0** | The extra form field is silently dropped by Immich's own request validation (`whitelist: true` without `forbidNonWhitelisted`, confirmed all the way back to v1.68) - the upload still succeeds, it just carries no audit trail |

In short: point IPP at anything from the last couple of years and uploads work; anything from mid-2025 onward
gets the full audit trail too. None of these gaps are hard failures - each one was deliberately built to degrade
rather than break the upload when the corresponding Immich feature isn't available.

This is in addition to the base proxy's own floor - see [Requirements](../README.md#requirements) in the main
README, notably that password-protected shares need Immich v2.6.0+ regardless of whether uploads are enabled.

## How to enable

### 1. Create an API key in Immich

Unlike the read-only proxy flow, uploading requires IPP to authenticate to Immich. Create the key under
**Account Settings → API Keys** in Immich, granting only these permissions:

- `asset.upload` - to receive the files *(required)*
- `albumAsset.create` - to add them to the shared album *(required)*
- `asset.update` - to write visitor captions and "Uploaded by" attribution into the asset description *(optional)*
- `tag.create` + `tag.asset` - to tag each upload `uploaded-by/<name>` so you can filter one visitor's
  uploads in the Immich UI *(optional)*

Only the first two are required. Each optional permission enables one feature and degrades cleanly when
missing: on the first `403` IPP logs a single warning naming the missing permission and disables that
feature for the rest of the process - uploads themselves are never affected.

### How this compares to Immich's own "Allow public user to upload"

Immich's own web app already has an equivalent capability: open a shared album link directly (not through IPP)
with `allowUpload` on, and Immich shows an upload button right there - no account needed. It authenticates that
anonymous visitor using the **share key itself** as a credential (`POST /assets` accepts `sharedLink: true`
auth), scoped to exactly that one share. No API key is involved anywhere.

IPP can't use that mechanism, because IPP's entire premise is that visitors never talk to Immich directly - the
share key never leaves IPP's server. That's the same tradeoff IPP already makes for every read operation,
extended here to writes: instead of the visitor's share key authenticating the upload, IPP's own
`IMMICH_API_KEY` does it on their behalf, after independently re-checking the same `allowUpload` flag Immich
would have checked itself.

The cost of that indirection: a `PUT /albums/{id}/assets` permission grant on an API key is not scoped to one
album - by default it can add assets to *any* album the key's owning Immich user can edit. Immich's native
mechanism, by contrast, is inherently confined to the one share. **The next section closes most of that gap.**

### Limiting the API key's reach

The `albumAsset.create` permission alone doesn't decide which albums an upload can land in - Immich additionally
checks whether the key's *owning user* is an Editor collaborator on that specific album (confirmed against
Immich's own access-control code: `AlbumAssetCreate` resolves through `checkSharedAlbumAccess(..., Editor)`,
not just the permission grant). That check is real and enforced independently of the key's permissions.

So, to contain the key to only the albums you intend:

1. **Create a dedicated Immich user** for the API key - not your main account.
2. **Set a storage quota** on that user (Admin → Users). The hard backstop on total disk consumption.
3. **Only add that user as an Editor to the specific albums you want guest-uploadable.** Do not make it a
   member of every album, and do not make it an admin. `PUT /albums/{id}/assets` will fail for any album that
   user isn't a collaborator on, regardless of the key's `albumAsset.create` grant - Immich enforces this at
   the album level, not just the key level.

With all three in place, a compromised or misconfigured key's blast radius is: uploads land in a disposable
user's library, capped by quota, addable only to the handful of albums you deliberately shared with that user -
not "every album you own."

> [!IMPORTANT]
> See [Limiting the API key's reach](#limiting-the-api-keys-reach) above before creating this key - a
> dedicated user, storage quota, and restricted album access all meaningfully contain what it can do.

Provide the key to IPP as an environment variable:

```yaml
    environment:
      - IMMICH_API_KEY=your-key-here
```

Without this variable, all upload functionality is disabled and IPP behaves exactly as before.

### 2. Enable uploads on a share

In Immich, when creating or editing a shared link, turn on **"Allow public user to upload"**. IPP reads this
flag from the share and only offers uploads where the share owner has enabled it.

Uploads only work for **album** shares - IPP needs an album to add the uploaded files to. Individual-asset
shares never show the upload UI.

## How it works for visitors

When a share is upload-enabled, the gallery header shows an upload button and an optional **name field**.
Visitors can:

- Click the upload button to pick files, or drag-and-drop them anywhere on the page
- Optionally type their name so you know who sent the photos (remembered in their browser for next time)

Picking or dropping files opens a **review sheet** before anything is sent: thumbnails of the selected
files, a caption box that applies to the whole batch, an optional per-file caption that overrides it, and
the ability to remove files. Dropping more files while the sheet is open adds them to the batch.

Captions and the visitor's name end up in the asset **description**, visible in Immich's info panel - e.g.
`cake cutting! - Uploaded by Alice`. Descriptions are only written on newly-created assets; if a file turns
out to be a duplicate of something already in your library, its existing description is never touched.

Before any bytes are sent, files are checksummed in the browser (SHA-1, files up to 64 MB) and checked
against Immich - files it already has skip the transfer entirely and are simply added to the album, reported
as "already existed". This makes re-sharing existing photos nearly instant, even on slow connections.

The rest upload a few at a time in parallel, with a live progress percentage and a **Cancel** button in the
status toast. Cancelling stops all in-flight transfers; files that already completed stay in the album.
Oversized files are rejected in the browser before any bandwidth is spent. When the batch finishes, the page
reloads so the new photos appear in the gallery.

The file's original timestamp is sent along so photos without EXIF data still sort correctly; for photos with
EXIF, Immich uses the EXIF capture time as usual.

## Configuration options

Configured under `ipp.upload`. See [configuration](configuration.md) for how to supply config overrides.

| Option              | Type   | Description                                                                                                                                                                                                                     |
|---------------------|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `requirePassword`   | `bool` | When `true`, only password-protected shares accept uploads, and only after the visitor has entered the password. Defaults to `false`.                                                                                            |
| `maxFileSizeMb`     | `int`  | Per-file size limit in megabytes. Enforced in the browser (before upload starts) and again on the server (mid-stream, in case a client bypasses the check). Defaults to `20000` (20 GB) - sized for a few minutes of 4K ProRes video; see [Sizing `maxFileSizeMb`](#sizing-maxfilesizemb-for-an-event-with-long-recorded-videos) below if you want it smaller. |
| `concurrentUploads` | `int`  | Maximum simultaneous upload streams from IPP to Immich, across all visitors. Also drives how many parallel uploads each visitor's browser runs (one less, capped at 3). Lower it on weak hardware; raise it for events with both a lot of guests and large videos in the mix - a small pool lets a few giant files head-of-line-block everyone else's quick photo uploads (see [Scaling for a large event](#scaling-for-a-large-event-eg-a-wedding)). Defaults to `4`.              |
| `concurrentChecks`  | `int`  | Maximum simultaneous duplicate-check requests (the pre-upload SHA-1 lookup). Deliberately a separate, larger pool from `concurrentUploads` - it's a cheap JSON round trip, not a file transfer, so it shouldn't compete with real uploads for the same slots. Defaults to `20`.  |
| `responseTimeoutSec` | `int` | How long IPP waits for Immich to respond after a file has fully transferred (hashing/processing time), before aborting. Scale this with `maxFileSizeMb` - a 20 GB file legitimately needs longer than a 5 MB photo. Defaults to `180`. |
| `maxPendingUploads` | `int` | Maximum uploads that may be received at once across all visitors, whether actively streaming or still queued behind `concurrentUploads`. A held-open connection that never finishes sending its file has no idle timeout while queued (that's deliberate - see [Scaling for a large event](#scaling-for-a-large-event-eg-a-wedding)), so this bounds how many such connections can pile up rather than how long any one of them may wait. Once at the cap, new upload attempts get an immediate error instead of joining the queue. Raise it for very large events with many simultaneous guests; there's no reason to lower it below `concurrentUploads`. Defaults to `50`. |

Accepted file types are fetched from your Immich server's own supported-media-types list, so anything Immich
can ingest can be uploaded - no separate allowlist to maintain.

### Large files

Files above `maxFileSizeMb` (20 GB by default) are rejected. Large videos are handled without any buffering
regardless of size: the browser streams the file from disk, IPP pipes it straight through to Immich, and
memory use stays constant. There is no time limit on the transfer itself - only the 30-second *idle*
timeout, so slow-but-steady transfers run as long as they need.

Two caveats for multi-gigabyte files: the duplicate pre-check is skipped above 64 MB (the browser can't hash
larger files without loading them fully into memory), so a re-sent video uploads fully before Immich detects
the duplicate; and a failed transfer retries **from zero** - there is no resumable upload, because the Immich
API doesn't offer one.

> [!WARNING]
> If you put another reverse proxy in front of IPP, check its request-body limit - nginx's
> `client_max_body_size` defaults to **1 MB** and Cloudflare's proxy caps uploads at 100 MB on most plans.
> Those limits bite before IPP ever sees the file. Tailscale Funnel has no documented body-size limit.

### Sizing `maxFileSizeMb` for an event with long recorded videos

Size it as `duration_minutes × bitrate_MB_per_minute`, with headroom:

- 1080p phone video (H.264/HEVC): roughly 75-100 MB/min
- 4K phone video (H.264/HEVC): roughly 150-300 MB/min
- Apple ProRes recording (not to be confused with Cinematic mode, a different, much smaller HEVC-based
  feature): roughly **6 GB/min at 4K30**, **1.7-2 GB/min at 1080p30** - about 20-30x the bitrate of ordinary
  phone video. A single continuous 2-minute 4K ProRes clip is already ~12 GB.

The default of `20000` (20 GB) is sized for a few minutes of 4K ProRes - comfortably covers ordinary phone
video at any length, and realistic ProRes clip lengths (guests deliberately shooting ProRes tend to capture
short, curated clips rather than a full song, if only because a 7-minute 4K ProRes recording is ~42 GB and
would fill most phones' own free storage before it fills yours). If you don't expect ProRes and want the
smaller original default back, set it to `500`.

If you raise `maxFileSizeMb` significantly, also raise `responseTimeoutSec` - Immich needs proportionally
longer to hash and process a bigger file after it's fully received.

### Scaling for a large event (e.g. a wedding)

A few things to check *before* the event, roughly in order of how likely each is to actually be the
bottleneck:

1. **Your own upload bandwidth**, if self-hosting Immich at home - residential uplink speed, not downlink,
   caps how fast guests can send data regardless of anything below. Test with a real upload from the venue's
   network beforehand if possible.
2. **Immich's own processing queue** - IPP accepting a file isn't the same as Immich having thumbnailed and
   indexed it. Expect a visible backlog after a burst of uploads; this is normal, not a fault.
3. **`concurrentUploads` and `concurrentChecks`** - raise both above their small defaults, but size them to
   what your Immich instance and disk can actually sustain concurrently, not to your guest count. Pushing
   them too high just moves the bottleneck into Immich's own job queue.
4. **Storage quota** on the dedicated upload user (see [Limiting the API key's reach](#limiting-the-api-keys-reach))
   - size it for the event's realistic total volume, not the small-scale defaults appropriate for casual
   family sharing.
5. **Large files monopolizing the small `concurrentUploads` pool** - `concurrentUploads` defaults to 4, and
   `maxFileSizeMb` now defaults to 20 GB. A single giant video (long transfer time, plus up to
   `responseTimeoutSec` of Immich processing after) can occupy one of only 4 slots for a long time. During
   a burst where most guests are uploading quick photos and a few are uploading full-length ProRes clips,
   those few large files can head-of-line-block everyone else's fast uploads behind them. There's no separate
   pool for large vs. small files (a real fix, but adds a config axis that isn't built) - the practical
   mitigation is simply raising `concurrentUploads` further than you would for a photos-only event, so a
   slow giant file has less relative impact on the remaining slots.
6. **File descriptor limit on the container/host.** Each visitor's browser opens several parallel
   connections (up to `uploadConcurrency`, derived from `concurrentUploads`); at 300 guests that's
   potentially several hundred simultaneously open sockets, each backpressured and stalled until they reach
   a limiter slot but still holding a file descriptor in the meantime. Memory-wise this is trivial (each
   parked connection buffers only a few KB), but many Docker defaults cap open file descriptors around 1024
   - get close to that under a big burst and you'll see connection failures unrelated to anything above. Set
   a generous `ulimits.nofile` on the container (see `docker-compose.yml`) before an event this size.

If you need more throughput than one process can provide, running multiple IPP replicas behind a load
balancer is architecturally sound - all of IPP's in-memory caches are harmlessly per-process (each replica
just does a little redundant work, never anything incorrect) with one exception: the session-cookie secret
is randomly generated at startup by default, so a password-unlock session set by one replica can't be read
by another without sticky sessions. Set `IPP_SESSION_SECRET` to the same value on every replica to fix this;
leave it unset for a single instance and nothing changes.

**Deliberately not built for this, reconsidered and still not built**: chunked/resumable upload. Revisited
specifically for ProRes-scale files (a dropped connection on a 12+ GB clip is a much bigger loss than on a
500 MB video), but the conclusion is unchanged - a resumable-upload subsystem (disk staging on the proxy,
session state, cleanup jobs; see `UPLOAD_IMPROVEMENTS.md`) is complexity worth carrying for a service with
sustained large-file traffic, not for a single event. What did change as a direct result of that
reconsideration: the client now retries a failed upload up to 5 times (was 3) - cheap, proportionate, and
covers most transient venue-wifi drops without touching any of that complexity. If a guest's video still
can't get through after that, the practical fix is a better connection, not more proxy code.

## Knowing who uploaded

Attribution is layered (all of it honor-system - visitors type their own name):

- Description (needs `asset.update`): "cake cutting! - Uploaded by Alice" in the Immich info panel.
- Tag (needs `tag.create` + `tag.asset`): every upload is tagged `uploaded-by/<name>`, so clicking the
  tag in Immich shows everything that visitor ever sent, across all albums. Tags and descriptions are only
  written on newly-created assets - duplicates of photos already in your library are never modified.
- Audit metadata (no extra permission): every uploaded asset gets a record attached as Immich asset
  metadata under the key `ipp-upload`:

| Field          | Meaning                                                                                                    |
|----------------|------------------------------------------------------------------------------------------------------------|
| `uploadedAt`   | Server-side timestamp of the upload                                                                          |
| `uploaderName` | The name the visitor typed, if any (sanitized, max 100 chars)                                                 |
| `uploaderIp`   | The connecting socket's IP address - the one value a client cannot forge                                      |
| `forwardedFor` | The raw `X-Forwarded-For` header. Behind a reverse proxy or Tailscale Funnel this holds the real client IP, but it is client-settable - treat it as unverified |
| `shareKey`     | First 8 characters of the share key used (enough to identify the share, useless as a credential)              |
| `albumId`      | The album the file was destined for - so an asset that failed the album-add step is self-describing           |

This metadata is not shown in the Immich web UI. Read it with the API key (requires the `asset.read`
permission if you want to query it):

```bash
curl -H "x-api-key: $IMMICH_API_KEY" \
  https://your-immich/api/assets/ASSET_ID/metadata
```

## Security notes

- The API key never leaves the server - visitors' browsers only ever talk to IPP.
- Permission is layered: no `IMMICH_API_KEY` → no uploads at all; share's "Allow public user to upload" off →
  no uploads for that share; `requirePassword` on → visitor must also have unlocked the share.
- Turning "Allow public user to upload" off in Immich takes effect within IPP's share-cache TTL (up to
  2 minutes) - an upload started just before revocation may still complete.
- There is **no rate limiting** in IPP itself. Anyone holding an upload-enabled share URL can upload until the
  API-key user's storage quota is reached - which is why setting that quota matters. For sensitive setups,
  combine `requirePassword` with a share password. See [Blocking abusive visitors](#blocking-abusive-visitors-fail2ban-and-crowdsec)
  for hooking rejected requests into an external rate-limiter/banner like fail2ban.
- Size limits are enforced server-side with early connection abort, so a malicious client can't make the
  server drain an oversized body. Once an upload is actively transferring, a 30-second idle timeout cuts off
  stalled or trickling connections so they can't pin an upload slot forever. A file still queued behind
  `concurrentUploads` has no idle timeout of its own (a busy event can legitimately mean a long wait) - instead,
  `maxPendingUploads` bounds how many uploads (queued or active) can be held open at once, rejecting new
  attempts once at the cap.
- A request containing more than one file part is rejected outright (`400 One file per request`) - the bundled
  web client always sends one file per request.
- The duplicate pre-check accepts only checksums, never asset IDs, so a visitor can't leak an arbitrary asset
  into the album by ID. It's still an existence oracle over the API-key user's whole library: knowing a file's
  exact SHA-1 (e.g. a photo published elsewhere, or one the visitor previously sent the owner) is enough to
  learn whether the owner has that exact file, and a hit adds it - with its EXIF and description - to the
  public album. IPP can't narrow what Immich's own bulk-upload-check endpoint checks against, so this is a
  property of enabling uploads at all, not a bug to fix; if it matters for your setup, combine `requirePassword`
  with a share password so only invited visitors can call it.

## Blocking abusive visitors (fail2ban and CrowdSec)

IPP doesn't rate-limit or ban anyone itself - see the note above - but it gives an external tool like
[fail2ban](https://github.com/fail2ban/fail2ban) or [CrowdSec](https://www.crowdsec.net/) what it needs to do
that job: a stable log format for rejected requests, a reliable client IP, and an enforcement point it can
drive. Both tools split into the same two halves - something that reads logs and decides who's abusive, and
something ("action" in fail2ban, "bouncer" in CrowdSec) that actually blocks them - and IPP is agnostic to
which one you use.

### 1. Get a real client IP

By default `req.ip` is the raw TCP socket address. That's correct and safe when IPP is directly reachable,
but wrong if something sits in front of it (a reverse proxy, or [Tailscale Funnel](./securing-immich-with-tailscale.md))
- in that case the socket address is the proxy's, not the visitor's, and `X-Forwarded-For` (which any client can
set) is the only place the real IP shows up.

If you have **exactly one** trusted hop in front of IPP, set:

```yaml
environment:
  IPP_TRUST_PROXY: "1"
```

This tells Express to trust the *last* `X-Forwarded-For` entry as the real client IP (the standard, well-tested
`trust proxy` mechanism - not hand-rolled header parsing). Only set this if you know how many hops actually sit
in front of IPP: trusting a hop that doesn't exist lets a visitor set their own `X-Forwarded-For` and frame an
innocent IP for their abuse. Leave it unset (the default) if IPP is directly exposed.

This is a property of the app, not of the port it listens on - `trust proxy` doesn't care whether a request
actually came through your proxy, only how many `X-Forwarded-For` entries to trust if present. So once this is
set, make sure IPP's own port genuinely isn't reachable except through that one trusted hop (see the note above
`ports:` in `docker-compose.yml`). A client who can reach IPP's port directly - bypassing the proxy entirely -
can set `X-Forwarded-For` to anything and IPP will believe it, defeating `IPP_BANLIST_PATH` and any
fail2ban/CrowdSec rule below.

### 2. Watch the log for abuse events

Rejected requests that look like abuse (oversize files, disallowed file types, malformed requests, uploads to a
share that doesn't permit them, wrong share passwords) are logged in a stable, greppable format:

```
2026-08-14T12:00:00.123Z WARN ABUSE event=upload-oversize ip=203.0.113.5 label=video.mp4
2026-08-14T12:00:05.456Z WARN ABUSE event=invalid-password ip=203.0.113.5 key=ffSw63qn
```

`event` is one of: `upload-oversize`, `upload-mime-rejected`, `upload-multi-file`, `upload-check-malformed`,
`upload-forbidden`, `invalid-password`.

IPP logs to stdout/stderr, not a file - both tools need a file to tail. Either point Docker's logging driver
at a file (e.g. `--log-driver json-file` plus `docker logs -f <container> >> /path/to/ipp.log &`, or configure
your compose file's `logging:` block accordingly), or run IPP outside Docker under something like `systemd`
with `StandardOutput=append:/path/to/ipp.log`.

### 3. Point your detector at the log

**fail2ban** - a filter (`/etc/fail2ban/filter.d/ipp.conf`):

```ini
[Definition]
failregex = ABUSE event=\S+ ip=<HOST>
ignoreregex =
```

**CrowdSec** - an acquisition config (`/etc/crowdsec/acquis.yaml`) pointing at the log file:

```yaml
filenames:
  - /path/to/ipp.log
labels:
  type: ipp
```

...a parser (`/etc/crowdsec/parsers/s01-parse/ipp-logs.yaml`):

```yaml
onsuccess: next_stage
filter: "evt.Line.Labels.type == 'ipp'"
name: local/ipp-logs
description: "Parse IPP ABUSE log lines"
grok:
  pattern: '%{TIMESTAMP_ISO8601:timestamp} WARN ABUSE event=%{NOTSPACE:event} ip=%{IP:ip}'
  apply_on: message
statics:
  # Required for the scenario below to accept the event at all - CrowdSec's
  # leaky bucket silently drops any event without evt.StrTime set ("Trying
  # to process event without evt.StrTime" in the logs), and its bundled
  # dateparse-enrich stage only *parses* evt.StrTime, it doesn't populate it
  # from evt.Parsed - that's on the parser.
  - target: evt.StrTime
    expression: evt.Parsed.timestamp
  - meta: log_type
    value: ipp_abuse
  - meta: source_ip
    expression: evt.Parsed.ip
```

...and a scenario (`/etc/crowdsec/scenarios/ipp-abuse.yaml`) defining the threshold:

```yaml
type: leaky
name: local/ipp-abuse
description: "Ban IPs repeatedly triggering IPP abuse events"
filter: "evt.Meta.log_type == 'ipp_abuse'"
groupby: evt.Meta.source_ip
capacity: 10
leakspeed: "60s"
blackhole: 10m
labels:
  service: ipp
  type: ipp-abuse
  # Required - CrowdSec's default profile (/etc/crowdsec/profiles.yaml) only
  # turns an alert into a ban decision when the scenario opts in with this.
  # Without it the alert is created but nothing ever gets banned.
  remediation: true
```

### 4. Enforce the ban

**Directly exposed / behind your own reverse proxy:** `req.ip` is already the real attacker IP, so the standard
`iptables`/`nftables` enforcement both tools ship works exactly as it would for any other web app.

fail2ban jail (`/etc/fail2ban/jail.local`):

```ini
[ipp]
enabled  = true
filter   = ipp
logpath  = /path/to/ipp/logs/*.log
action   = iptables-multiport[name=ipp, port="80,443"]
maxretry = 10
findtime = 600
bantime  = 3600
```

CrowdSec needs nothing extra beyond the parser/scenario above plus its official
[firewall bouncer](https://docs.crowdsec.net/u/bouncers/firewall/) (`cs-firewall-bouncer`) installed on the
box - it consumes decisions from the local API and manages the `iptables`/`nftables` rules itself.

**Behind Tailscale Funnel (or anything else where traffic is relayed, not a direct connection):** an iptables
ban on your box can't block the attacker - there's no direct connection from their IP to filter, since Funnel
traffic arrives over the tailnet from Tailscale's own infrastructure. Banning has to happen in the application
instead. IPP will reject any request from an IP listed in a plain-text file (one IP per line, blank lines and
`#` comments ignored) if you point it at one:

```yaml
environment:
  IPP_BANLIST_PATH: /data/banned-ips.txt
volumes:
  - ./banned-ips.txt:/data/banned-ips.txt
```

The file is re-read whenever it changes (cheap mtime check per request, no restart needed), and IPP never
writes to it - something else has to.

fail2ban can write to it directly via a custom action (`/etc/fail2ban/action.d/ipp-banlist.conf`):

```ini
[Definition]
actionban = echo "<ip>" >> /data/banned-ips.txt
actionunban = sed -i "/^<ip>$/d" /data/banned-ips.txt
```

...used in the jail instead of `iptables-multiport`:

```ini
[ipp]
enabled  = true
filter   = ipp
logpath  = /path/to/ipp/logs/*.log
action   = ipp-banlist
maxretry = 10
findtime = 600
bantime  = 3600
```

CrowdSec has no built-in "write to a flat file" bouncer, since its bouncers are normally network/proxy-level.
The simplest option is a small custom bouncer that polls its Local API decision stream and syncs matching IPs
into the file. Register a bouncer and get an API key first:

```bash
cscli bouncers add ipp-banlist-bouncer
```

Then a short polling script (run under `systemd` or cron, adjust `CROWDSEC_URL` if the LAPI isn't local):

```bash
#!/bin/bash
# sync-crowdsec-banlist.sh - mirrors CrowdSec's active "ban" decisions for
# the ipp-abuse scenario into IPP_BANLIST_PATH.
API_KEY="<the key from cscli bouncers add>"
CROWDSEC_URL="http://localhost:8080"
OUT="/data/banned-ips.txt"

curl -s -H "X-Api-Key: $API_KEY" \
  "$CROWDSEC_URL/v1/decisions?type=ban&scenario=local/ipp-abuse" \
  | jq -r '.[]?.value' > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
```

Poll it on whatever interval matches your `bantime`/`leakspeed` tolerance (e.g. every 30-60s via a `systemd`
timer or cron); the atomic `mv` avoids IPP ever reading a half-written file mid-update.

Either way, the detector still owns all the actual policy (how many failures in what window, how long the ban
lasts) - IPP just enforces whatever list results from it.

## Testing without a running Immich

Three tiers, none needing a real Immich instance:

1. **Unit tests** (`app/tests/upload.*.test.ts`) - pure logic with `fetch` mocked. Fast, but blind
   to wire-level bugs: a mock returns success without exercising real HTTP/stream serialization.
2. **Fake-Immich integration test** (`app/tests/upload.fakeImmich.test.ts`) - spins up a real local
   HTTP server that implements just enough of the Immich API contract (status codes, response shapes)
   to drive the actual `uploadAsset` / `addAssetsToAlbum` / `bulkUploadCheck` functions over a real
   socket: real fetch, real multipart serialization, real stream conversion. This tier exists because
   it is the only one that would have caught a `Readable.toWeb(form)` incompatibility once found
   during development - every mocked test passed while every real upload would have failed, since
   the mock never executed the real serialization code path.
3. **Manual smoke test** - point `IMMICH_URL` at any small local HTTP server that returns the right
   shapes and hit `POST /share/:key/upload` with curl to exercise the full route (share resolution,
   busboy parsing, the gallery wiring) that the fake-Immich suite doesn't cover on its own.

Run all three with `npm test` from `app/` - no Docker, no network access, no real API key required
(the fake server accepts any key value).

## Failure modes

- File reaches Immich but can't be added to the album: IPP retries the album-add 3 times with backoff. If
  all attempts fail, the visitor sees an error and the response includes the Immich asset ID so you can add it
  to the album manually. The file is safe in the API-key user's library either way.
- Immich unreachable when checking file types: IPP falls back to accepting any `image/*` or `video/*` type
  for that request and retries the media-types lookup on the next upload. (The actual upload would fail anyway
  if Immich is down.)
- Duplicate file: caught at one of two layers. The pre-upload check (browser-side SHA-1 against Immich's
  `bulk-upload-check`) skips the transfer entirely; if that check is unavailable or the file is over 64 MB, the
  file uploads normally and Immich detects the duplicate by checksum without storing a second copy. Either way
  the existing asset is added to the album and the visitor sees "already existed" rather than an error, since
  their goal - that photo in this album - is met.
- Immich hangs mid-request: bounded on every path. Inbound stalls are cut by a 30-second idle timeout; a
  hung response after the file is fully received is aborted after `responseTimeoutSec` (default 180s, and
  should scale with `maxFileSizeMb`); the album-add and duplicate-check calls time out at 15 seconds per
  attempt. A hung Immich can never permanently pin an upload slot.
