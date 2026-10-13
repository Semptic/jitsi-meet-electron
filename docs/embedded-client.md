# Embedded client ("Jitsi Meet Multitrack")

The regular app loads the Jitsi Meet web client from the Jitsi server (iframe via
`JitsiMeetExternalAPI`), so a patched client - for example the one with
per-participant audio recording - never runs against an ordinary server. This
branch bundles a patched client into the app and serves it from a small
server inside the Electron main process.

It also defines a separate local app, **Jitsi Meet Multitrack**, that installs next
to the regular **Jitsi Meet** and leaves it untouched.

## Architecture

```
meeting window (file://, preload)        main process
  Conference.tsx
    1. embeddedClient.resolve(serverURL) ──► EmbeddedClientManager
    2. iframe src = http://<hash>.localhost:<port>/<room>      │  one listener per upstream origin
                                                         ▼
  iframe  ── GET /libs/app.bundle.min.js ──►  bundled client (Resources/client)   [static]
          ── GET /<room>, /config.js, ...  ──►  proxy ──► https://<jitsi server>   [proxied]
          ── ws /xmpp-websocket, /colibri-ws ► proxy ──► wss://<jitsi server>
```

Routing mirrors the `devServer` of the jitsi-meet webpack config, which joined real
meetings the same way (`bypass` in `webpack.config.js`):

| Request path | Served by |
|--------------|-----------|
| `/css/ /doc/ /fonts/ /images/ /lang/ /sounds/ /static/ /libs/` and anything ending in `.wasm` | the bundled client |
| `/v1/_cdn/<version>/...` and `/<tenant>/static/...` | same, after stripping the prefix (as the dev server does) |
| everything else: the room page, `config.js`, `interface_config.js`, `/http-bind`, `/xmpp-websocket`, `/colibri-ws`, ... | proxied to the Jitsi server |

The room page (`index.html` with the server side includes) deliberately comes from the
server, never from the bundle, so branding and `config.js` stay the server's own.

Code (`app/features/embedded-client/`):

- `routing.ts` - pure decisions: path classification, request target / Host / Origin
  validation, traversal-safe path mapping, upstream URL validation, redirect / Referer /
  cookie rewriting. No I/O.
- `server.ts` - the node http server (`http-proxy-3` for the proxying). No Electron imports.
- `manager.ts` - one server per upstream origin, the per-launch token, remembered ports.
- `main.ts` - Electron glue: the IPC handler, token injection, permission rule.
- `app/features/conference/components/Conference.tsx` - asks for the embedded origin and
  loads the iframe from it (setting `useEmbeddedClient`, default on).
- `scripts/patchExternalApi.js` - the vendored `external_api.js` hard codes
  `https://<domain>`; for exactly `http://127.0.0.1:<port>[/path]` the scheme is kept. Applied
  at bundle time by `esbuild.js`, which fails unless the pattern occurs exactly once.

The displayed server URL, the settings and the recent list keep the **real** server
URL. With several servers in one session (a deep link to another server) each distinct
upstream origin gets its own listener, hence its own web origin: their storage and cookies
cannot reach each other. The port of an upstream is remembered in
`<userData>/embedded-client-ports.json` and reused on the next launch (falling back to
an ephemeral port if taken), so the web origin and the client's `localStorage` (display
name, device choice, ...) survive restarts.

If the bundle is missing, the setting is off, or the server URL is not eligible, the
meeting loads the server's own client exactly as before.

### Direct connections

`config.js` of many deployments (including the target server) contains absolute
`bosh` / `websocket` URLs. The client then connects to the Jitsi server directly, not
through the proxy; this works because such servers accept the loopback origin (checked
against the target server: WebSocket upgrade with `Origin: http://127.0.0.1:<port>` gives
101, CORS reflects the origin). A server that rejects foreign origins for its websocket
would need its `config.js` to use relative URLs. Bodies are never rewritten.

## Security model

The server is not a general proxy. It enforces, for every request and WebSocket handshake:

1. **Loopback only, one host per upstream.** It listens on `127.0.0.1` (never `0.0.0.0`/`::`), plain
   http, on an ephemeral port. The web origin is `http://<hash>.localhost:<port>` where `<hash>` is the
   first 16 hex digits of SHA-256 of the upstream origin. Chromium resolves `*.localhost` to loopback
   and treats it as a secure context (verified in the built app: `getUserMedia`, OPFS, `localStorage`,
   AudioWorklet and Workers work). Cookies, `localStorage`, IndexedDB and OPFS are scoped per host, so an
   upstream can never see another upstream's cookies or storage, and an origin that one upstream used can
   never be taken over by another upstream when ports are reused (the host differs; tested).
2. **Fixed forwarding target.** Each server forwards to exactly one origin, the one it was
   created for. The request target must be origin-form (`/path`): absolute-form
   (`GET http://other/`), `//host/path`, and `CONNECT` are refused, so the `Host` or target
   of a request never selects where it goes. The upstream must be `https` on a public address:
   loopback (`localhost`, `*.localhost`, 127/8, `::1`, `0.0.0.0`), private (10/8, 172.16/12, 192.168/16),
   link-local (169.254/16, fe80::/10), CGNAT, unique local (fc00::/7) and IPv4-mapped forms of these are
   refused, with or without trailing dots, and the proxy's outgoing connections go through a DNS guard
   that rejects any name resolving to such an address. There is no exception or flag in the app.
   TLS is verified (`secure: true`); redirects are not followed by the proxy.
3. **Host check** (DNS rebinding): the `Host` header must be exactly `<hash>.localhost:<port>` (case-insensitive); `127.0.0.1`, `localhost`, a missing port and any other name are refused.
4. **Origin check:** WebSocket handshakes must carry the server's own `Origin`; other
   requests may omit it but a present `Origin` must match. Upstream always sees its own
   `Origin`/`Referer`/`Host`.
5. **Per-launch secret.** Every request, static ones included, must carry the header
   `x-jitsi-embedded-token` (32 random bytes, regenerated each launch, compared in constant
   time; duplicated headers never match). The main process adds it in the single
   `webRequest.onBeforeSendHeaders` listener of the session, only for requests of the **meeting
   window's webContents** to the embedded origins (http and ws), and only when they come from the
   embedded origin itself (Origin/Referer/initiator) or are the app page's iframe navigation (an iframe
   navigation without Referer; Electron reports no initiating frame for navigations). A third-party frame
   inside the page gets none. Residual: a third-party frame with `Referrer-Policy: no-referrer` navigating
   to the embedded origin would have its document request authorised; it still cannot read the token or
   the cross-origin content. Page JavaScript cannot read it; other local programs and
   browser pages cannot use the server. It is removed before forwarding upstream.
6. **No forwarded identity.** Incoming `Forwarded` / `X-Forwarded-*` / `X-Real-IP` are
   dropped and none are added (an upstream trusting `X-Forwarded-Proto: http` would
   redirect to https in a loop).
7. **Static serving:** only GET/HEAD; the path is percent-decoded once and refused if it
   contains `..`/`.` segments, NUL, backslashes or ends in `/`; the resolved real path
   (symlinks resolved) must stay inside the bundle; only regular files; no directory listing;
   `X-Content-Type-Options: nosniff`.
8. **Cookies:** the `Domain` attribute is dropped (it names the upstream, never the embedded
   host), so cookies are host-only on the per-upstream host; names, hence `__Host-` / `__Secure-`
   semantics, are unchanged.
9. **Timeouts and limits:** HTTP header / request timeouts of 30 s / 120 s on the server and a
   120 s upstream response timeout (long polling answers within about a minute); WebSockets are not
   subject to them. Static serving also refuses any path segment starting with `.`. Remembered ports
   (`embedded-client-ports.json`, mode 600) hold only the host hash and the port, the 20 most recently
   used upstreams.
10. **Logging:** only lifecycle and `proxy error <code>` lines are written to the log file.
   Request paths, queries (room names, JWTs), hosts and headers are never logged.

Places that trust the iframe origin, all restricted to the embedded origin of the meeting:

- `multitrack-recording/renderer.ts`: with an embedded origin, the iframe `src` origin
  must equal it exactly; otherwise the bridge ignores the iframe. (The main-process side
  never trusted the iframe origin: IPC is accepted only from the meeting window's main
  frame, and file names/folders are validated there.)
- `main.ts` permission request and check handlers: a request from a loopback page (one shared
  `isLoopback`: localhost, `*.localhost`, 127/8, `::1`, `0.0.0.0`, ...) is granted only if it is an embedded
  origin loaded by the meeting window; other loopback pages are denied. (Non-loopback behaviour is
  unchanged.) The decisions are pure functions in `trust.ts`, unit tested, as is the IPC sender check
  (main frame of the expected window, loaded from `file://`) used by the resolve channel and the bridge.
- `embedded-client:resolve` IPC: only the app page (`file://`, main frame) of the meeting window.
- `main.ts` `onBeforeSendHeaders` / `onHeadersReceived` are single listeners (Electron keeps
  only the last per session): file URL blocking, token injection, and the X-Frame-Options /
  `frame-ancestors` stripping that lets the iframe embed.

Tests: `npm run test:embedded` (routing/allow-list units, plus an integration test with a
fake http + WebSocket upstream: static files, proxied headers, WebSocket, rejected
Host/Origin/token, no access to a second upstream, no traversal, absolute-form and CONNECT),
`npm run test:multitrack` (the bridge, unchanged guarantees).

## Separate identity

| | regular app | Multitrack build |
|-|-------------|------------------|
| product name | Jitsi Meet | **Jitsi Meet Multitrack** |
| app id | `org.jitsi.jitsi-meet` | `org.jitsi.jitsi-meet.multitrack` |
| user data | `~/Library/Application Support/Jitsi Meet` | `~/Library/Application Support/Jitsi Meet Multitrack` |
| URL scheme | `jitsi-meet://` | `jitsi-meet-multitrack://` (never takes over `jitsi-meet://`) |
| default server (first launch) | `https://meet.jit.si` | `https://meet.spurious-security.com` (changeable in the settings) |
| updates | electron-updater | none: no publish target, no `app-update.yml`, update check disabled |

The identity lives in `electron-builder.multitrack.cjs` plus build-time constants
(`JITSI_BUILD_*`, set by `scripts/package-multitrack.mjs`, compiled in by `esbuild.js`).
`npm start` and `npm run dist` are unchanged. The app is ad-hoc signed (`identity: '-'`,
hardened runtime off because ad-hoc signed frameworks cannot pass library validation);
it is not notarized. Electron fuses are flipped by electron-builder before signing:
`RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` off,
`OnlyLoadAppFromAsar` and `EnableEmbeddedAsarIntegrityValidation` on (the app starts and the signature
verifies; `npx @electron/fuses read --app <app>` shows them). No entitlement weakening library validation
is added (hardened runtime is off instead, see above). Remaining risk: an ad-hoc signature has no
team identity, so macOS cannot tell this build from a tampered one, and without the hardened runtime
`DYLD_INSERT_LIBRARIES` can still inject code into the app process; anything that can do that already
runs as you. It ships the camera / microphone usage strings, so macOS asks for
permission on first use (it is a new app to macOS).

## Build, install, update

```sh
# 1. Build the patched web client (isolated copy of the committed HEAD of JITSI_MEET_DIR,
#    so a running dev server is not disturbed) and bundle it into ./client-bundle (~60 MiB).
JITSI_MEET_DIR=/path/to/jitsi-meet npm run build:client
# 2. Build the app and package it for this Mac:
npm run package:multitrack            # -> dist-multitrack/mac-arm64/Jitsi Meet Multitrack.app
# (or both:  npm run dist:multitrack)

# 3. Install next to the regular app (replace an older copy of this app only):
mkdir -p ~/Applications
rm -rf "$HOME/Applications/Jitsi Meet Multitrack.app"
ditto "dist-multitrack/mac-arm64/Jitsi Meet Multitrack.app" "$HOME/Applications/Jitsi Meet Multitrack.app"
```

After a change of the web client: commit it there, then repeat steps 1-3. There is no
auto update by design. `JITSI_MEET_DIR` defaults to the author's checkout; the script
refuses a directory that is not an installed jitsi-meet checkout. `--in-place` builds inside
`JITSI_MEET_DIR` (it deletes and recreates that tree's `libs/` and `build/`).

The jitsi-meet production build enforces a 3.5 MiB budget for `app.bundle.min.js` as a
webpack error; the patched client is slightly over it. The files are still emitted and
`build-client.mjs` sets `ANALYZE_BUNDLE`, which turns the budget check off for this local
build (no change to the client sources).

Uninstall: delete `Jitsi Meet Multitrack.app` and
`~/Library/Application Support/Jitsi Meet Multitrack`.

In development (`npm start`) the bundle is read from `./client-bundle`; settings of that
instance follow the regular app's identity.
