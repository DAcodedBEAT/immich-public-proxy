# Upload Feature - Remaining Improvements

Status: feature complete. Done to date: streaming uploads with audit metadata,
Immich-native `allowUpload` permission model, 82 unit tests, module extraction
(`src/upload/`), multi-file rejection, duplicate feedback, in-flight guard,
partial-success reload, client worker-pool parallelism driven by
`ipp.upload.concurrentUploads`, MIME-cache pre-warm at startup, explicit
timeouts on all Immich calls (120s response-wait on upload, 15s on
album-add/dedup-check), XHR-based progress percentage + cancel button, and
SHA-1 pre-upload dedup via `POST /share/:key/upload-check` (server-side
album-add for duplicates; checksums only, never client-supplied asset IDs).
User docs: `docs/uploads.md`.

What remains, in priority order.

## Hardening

### Per-IP rate limiting
Config `ipp.upload.maxUploadsPerIpPerHour` (default `0` = disabled, matching
the project's opt-in philosophy). In-memory sliding window keyed on socket
address, pruned lazily. No dependency needed. The Immich-side storage quota
remains the primary defense.

## Identity

### Verified attribution for tailnet visitors (Tailscale identity headers)
Evaluated 2026-07. Visitors who are members of the tailnet (family with
Tailscale installed) can be identified cryptographically with zero UI:
`tailscale serve` injects `Tailscale-User-Login` / `Tailscale-User-Name` /
`Tailscale-User-Profile-Pic` headers on in-tailnet requests, backed by the
WireGuard tunnel. Funnel (public) visitors have no Tailscale identity and
stay on the current honor-system name field.

Design:
- When the identity headers are present and trusted, auto-fill the uploader
  name server-side and record `verifiedIdentity: <login>` in the `ipp-upload`
  audit metadata alongside the self-declared name; description/tag use the
  verified name.
- Prefill (and lock) the name field in the gallery via init params for
  tailnet visitors.

**Trust caveat - must be resolved before building:**
- Only trust `Tailscale-*` headers when the connection provably arrives from
  the local tailscaled proxy (check the peer socket address), never on
  direct LAN or arbitrary reverse-proxy connections where a client can set
  those headers itself.
- Verify (don't assume) that Funnel ingress strips client-sent `Tailscale-*`
  headers on the deployed Tailscale version.
- Full OIDC via tsidp is the heavyweight alternative if header trust can't
  be established; not worth it before trying headers.

Rejected in the same evaluation: browser/hardware fingerprinting for public
guests (spoofable, privacy-hostile, can't distinguish identical devices) and
encoding uploader identity as Immich faces (faces mean "appears in the
photo", and fake bounding boxes would poison face recognition).

## Resilience (do when justified)

### Persistent orphan-retry queue
If album-add fails after 3 retries, the asset sits in the library outside the
album. Append `{ assetId, albumId, failedAt }` to a JSON file under the
existing staging-dir pattern (`tmpdir()`); retry on startup + every 5 min;
drop on success or after 7 days. **Check logs for actual orphans before
building this.**

### Build the file-picker accept list from Immich's media types
`accept="image/*,video/*"` mismatches the server-side exact-type check.
Cosmetic - the server check is authoritative.

### Chunked upload with resume (for multi-GB files on flaky links)
Evaluated 2026-07. Immich has no resumable/chunked API - `POST /assets` is
single-shot - so chunking must terminate at the proxy:

- Client: `Blob.slice()` into ~32 MB chunks (free, no memory cost), upload
  sequentially with per-chunk retry; a network blip costs one chunk instead
  of the whole file.
- Server: stage chunks to disk under `tmpdir()` (same pattern as the
  zip-download staging + `sweepStaleStagingDirs`), then stream the assembled
  file to Immich on the final chunk.
- Costs: disk usage equal to file size on the proxy, upload-session state
  (id + abandoned-session sweep), several new endpoints, per-chunk auth.
  Breaks the current "uploads never touch proxy disk" property.

Build only if large uploads over unreliable connections become a real,
recurring use case. If Immich ever ships native resumable uploads, proxy
those instead - delete this design.

**Reconsidered 2026-07** specifically for Apple ProRes recording (~6 GB/min
at 4K - a dropped connection on a clip that size is a much bigger loss than
on an ordinary phone video). Conclusion unchanged: still not worth the
disk-staging/session-state complexity for a single event. Did raise the
client's `MAX_ATTEMPTS` from 3 to 5 (`src/client/upload.ts`) as the
proportionate response instead - cheap, and covers most transient
venue-wifi drops without any of this design's complexity. `maxFileSizeMb`
default raised to 20000 (20 GB) and `responseTimeoutSec` (default 180,
newly configurable - was a hardcoded 120s) added to accommodate ProRes
file sizes; see `docs/uploads.md`.

## Non-goals (deliberate)

- No client framework / react-query - the gallery is vanilla TS with SSR
  init JSON by design; post-upload reload is the architecture-consistent choice.
- No database - the proxy is stateless; the orphan queue's JSON file is
  the ceiling.
- No queue service - the in-process limiter + TCP backpressure already
  bound concurrency correctly for a single-instance deployment.
- No adaptive client concurrency - TCP congestion control handles
  bandwidth sharing; the server limiter enforces capacity; the Network
  Information API isn't available on iOS Safari.
- No fetch-streaming upload progress - unsupported in Firefox, requires
  HTTP/2 in Chromium; XHR's `upload.onprogress` is the reliable path.
- No streaming SHA-1 for >64 MB files - WebCrypto has no streaming digest;
  a JS implementation isn't worth the dependency. Large files fall back to
  Immich's server-side dedup, which is correct anyway.
