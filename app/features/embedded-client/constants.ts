/**
 * The loopback address the embedded client server binds to. It is a secure
 * context for Chromium, so getUserMedia, AudioWorklet and OPFS work over plain http.
 */
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * Request header the main process injects into the meeting window's requests to
 * the embedded server. Without the per-launch secret in it the server refuses
 * every request, so no other local program or browser page can use the server.
 */
export const TOKEN_HEADER = 'x-jitsi-embedded-token';

/**
 * IPC channel the meeting window uses to ask for the embedded origin of a Jitsi server.
 */
export const RESOLVE_CHANNEL = 'embedded-client:resolve';

/**
 * The most upstream servers (one listener each) a single app session may open.
 */
export const MAX_SERVERS = 8;

/**
 * A file that must exist in the bundle for the embedded client to be offered.
 */
export const BUNDLE_MARKER = 'libs/app.bundle.min.js';

/**
 * How many upstream ports are remembered between launches (least recently used are pruned).
 */
export const MAX_REMEMBERED_PORTS = 20;
