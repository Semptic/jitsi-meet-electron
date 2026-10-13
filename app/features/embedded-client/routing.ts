import * as path from 'node:path';

import { isForbiddenUpstreamHost } from './hosts';

/**
 * Pure routing and validation helpers of the embedded client server. They hold
 * all decisions (what is local, what is proxied, who may talk to the server)
 * and have no side effects, so they can be unit tested without sockets.
 */

export type Route = { file: string; kind: 'static'; } | { kind: 'proxy'; };

/**
 * Path prefixes served from the bundled client. This mirrors the `bypass` of
 * the jitsi-meet webpack dev server, which joined real meetings this way:
 * everything else (the room page with its server side includes, config.js,
 * interface_config.js, /http-bind, /xmpp-websocket, /colibri-ws, ...) belongs
 * to the Jitsi server and is proxied.
 */
const LOCAL_PREFIXES = [ '/css/', '/doc/', '/fonts/', '/images/', '/lang/', '/sounds/', '/static/', '/libs/' ];

/**
 * Splits a request target (origin-form only) into its path and query. Anything
 * else - absolute-form (`http://host/x`, which would make this an open proxy),
 * authority-form, `//host/x` or a missing slash - is refused.
 *
 * @param {string|undefined} rawUrl - The request line target.
 * @returns {{ pathname: string, search: string }|null} The parts, or null if refused.
 */
export function parseRequestTarget(rawUrl: string | undefined): { pathname: string; search: string; } | null {
    if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
        return null;
    }
    // Control characters, spaces and backslashes never occur in a valid target
    // and are classic smuggling/normalisation tricks.
    if (/[\u0000- \u007f\\]/.test(rawUrl)) {
        return null;
    }

    const queryAt = rawUrl.indexOf('?');
    const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
    const search = queryAt === -1 ? '' : rawUrl.slice(queryAt);

    return { pathname,
        search };
}

/**
 * Decides whether a path is served from the bundle or proxied to the Jitsi server.
 * Query strings (cache busting `?v=`) never take part in the decision.
 *
 * @param {string} pathname - The raw (still percent-encoded) path.
 * @returns {Route} The route.
 */
export function classifyPath(pathname: string): Route {
    let local = pathname;

    // A CDN style prefix (/v1/_cdn/<version>/...) is not served by the bundle.
    if (local.startsWith('/v1/_cdn/')) {
        local = local.replace(/\/v1\/_cdn\/[^/]+\//, '/');
    }

    // A tenant meeting URL (/tenant/room) asks for its assets below the tenant.
    local = local.replace(/^\/[^/]+\/static\//, '/static/');

    if (LOCAL_PREFIXES.some(prefix => local.startsWith(prefix)) || local.endsWith('.wasm')) {
        return { kind: 'static',
            file: local };
    }

    return { kind: 'proxy' };
}

/**
 * Maps a classified bundle path to a file path below `root`, refusing anything
 * that could leave it (encoded separators, dot segments, NUL, backslashes).
 *
 * @param {string} root - Absolute bundle directory.
 * @param {string} file - Path as returned by classifyPath.
 * @returns {string|null} Absolute path, or null if the request must be refused.
 */
export function resolveStaticPath(root: string, file: string): string | null {
    let decoded: string;

    try {
        decoded = decodeURIComponent(file);
    } catch {
        return null;
    }

    if (decoded.includes('\0') || decoded.includes('\\') || !decoded.startsWith('/')) {
        return null;
    }

    const segments = decoded.split('/').slice(1);

    // Dot segments and dotfiles (.git, .env, ...) are never served.
    if (segments.some(segment => segment.startsWith('.'))) {
        return null;
    }

    const resolved = path.resolve(root, ...segments);

    // Directories (trailing slash, empty segment) are never served: no listings.
    if (decoded.endsWith('/') || !resolved.startsWith(root + path.sep)) {
        return null;
    }

    return resolved;
}

/**
 * Whether the Host header is exactly this server (DNS rebinding protection):
 * the per-upstream host name and the port, compared case-insensitively.
 *
 * @param {string|undefined} host - The Host header.
 * @param {string} hostname - The embedded host name of this server.
 * @param {number} port - The server port.
 * @returns {boolean}
 */
export function isAllowedHost(host: string | undefined, hostname: string, port: number): boolean {
    return typeof host === 'string' && host.toLowerCase() === `${hostname}:${port}`;
}

/**
 * Whether the Origin header is acceptable. WebSocket handshakes must carry the
 * server's own origin; other requests may omit it (same-origin GETs do).
 *
 * @param {string|string[]|undefined} origin - The Origin header.
 * @param {string} serverOrigin - The origin of this server.
 * @param {boolean} required - Whether a missing header is a failure.
 * @returns {boolean}
 */
export function isAllowedOrigin(origin: string | string[] | undefined, serverOrigin: string, required: boolean): boolean {
    if (typeof origin === 'undefined') {
        return !required;
    }

    return origin === serverOrigin;
}

/**
 * Parses a user supplied Jitsi server URL into the single origin the server may
 * forward to. Only https servers on public addresses qualify: loopback, private,
 * link-local and unspecified hosts are refused so the server can never be pointed at
 * itself or at local services. The only exception is a test hook.
 *
 * @param {unknown} serverURL - The URL (https://host[:port][/tenant]).
 * @param {boolean} unsafeAllowLoopbackForTests - Allow http(s) loopback upstreams (tests only).
 * @returns {string|null} The origin, or null if not acceptable.
 */
export function parseUpstream(serverURL: unknown, unsafeAllowLoopbackForTests = false): string | null {
    if (typeof serverURL !== 'string' || serverURL.length > 2048) {
        return null;
    }

    let url: URL;

    try {
        url = new URL(serverURL);
    } catch {
        return null;
    }

    if (url.username || url.password) {
        return null;
    }

    const forbidden = isForbiddenUpstreamHost(url.hostname);

    if (forbidden && !unsafeAllowLoopbackForTests) {
        return null;
    }
    if (url.protocol !== 'https:' && !(unsafeAllowLoopbackForTests && forbidden && url.protocol === 'http:')) {
        return null;
    }

    // A trailing dot names the same host but would be a different origin.
    return url.origin.replace(/\.+(:\d+)?$/, '$1');
}

/**
 * Rewrites a redirect target that points at the upstream origin so the browser
 * stays on the embedded origin. Other targets are left alone.
 *
 * @param {string|undefined} location - The Location header.
 * @param {string} upstreamOrigin - The upstream origin.
 * @param {string} serverOrigin - The embedded origin.
 * @returns {string|undefined} The (possibly rewritten) Location.
 */
export function rewriteLocation(
        location: string | undefined, upstreamOrigin: string, serverOrigin: string): string | undefined {
    if (typeof location !== 'string') {
        return location;
    }
    if (location === upstreamOrigin || location.startsWith(`${upstreamOrigin}/`)
            || location.startsWith(`${upstreamOrigin}?`) || location.startsWith(`${upstreamOrigin}#`)) {
        return serverOrigin + location.slice(upstreamOrigin.length);
    }

    return location;
}

/**
 * Rewrites a Referer sent by the page so the upstream sees its own origin.
 *
 * @param {string|undefined} referer - The Referer header.
 * @param {string} upstreamOrigin - The upstream origin.
 * @param {string} serverOrigin - The embedded origin.
 * @returns {string|undefined} The rewritten Referer, or undefined to drop it.
 */
export function rewriteReferer(
        referer: string | undefined, upstreamOrigin: string, serverOrigin: string): string | undefined {
    if (typeof referer !== 'string') {
        return undefined;
    }
    if (referer === serverOrigin || referer.startsWith(`${serverOrigin}/`)) {
        return upstreamOrigin + referer.slice(serverOrigin.length);
    }

    return undefined;
}

/**
 * Turns an upstream Set-Cookie into one that the embedded origin accepts: the Domain
 * attribute (it names the upstream, never the embedded host) is dropped, which makes
 * the cookie host-only. Cookies are scoped by host, and every upstream has its own host,
 * so no further isolation is needed. Names, so `__Host-` and `__Secure-` prefixes, stay.
 *
 * @param {string} setCookie - The upstream Set-Cookie value.
 * @returns {string} The rewritten value.
 */
export function rewriteSetCookie(setCookie: string): string {
    return setCookie.split(';').filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part))
        .join(';');
}
