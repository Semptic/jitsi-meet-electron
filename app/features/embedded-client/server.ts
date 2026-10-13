import { createProxyServer } from 'http-proxy-3';
import { timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import * as path from 'node:path';


import { LOOPBACK_HOST, TOKEN_HEADER } from './constants';
import {
    classifyPath,
    cookiePrefix,
    filterRequestCookies,
    isAllowedHost,
    isAllowedOrigin,
    parseRequestTarget,
    resolveStaticPath,
    rewriteLocation,
    rewriteReferer,
    rewriteSetCookie
} from './routing';

/**
 * No Electron imports in this module: it runs under plain node in the tests.
 */

export interface IEmbeddedServerOptions {

    /**
     * Absolute path of the bundled client (libs/, lang/, ...).
     */
    bundleDir: string;

    /**
     * Receives one short line per request: route class and status code only.
     * Never paths, queries, hosts or headers (they carry room names and JWTs).
     */
    onLog?: (line: string) => void;

    /**
     * Port to try first (the one used for this upstream last time, so the web
     * origin and its storage stay stable). Falls back to an ephemeral port.
     */
    preferredPort?: number;

    /**
     * Per-launch secret that every request must carry in the TOKEN_HEADER.
     */
    token: string;

    /**
     * The one origin (scheme://host[:port]) this server forwards to.
     */
    upstreamOrigin: string;
}

export interface IEmbeddedServer {
    close: () => Promise<void>;
    origin: string;
    port: number;
}

type Verdict = { pathname: string; refused: false; } | { refused: true; status: number; };

const CONTENT_TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.map': 'application/json'
};

// Headers a client could send to make the upstream believe something about
// the request's origin; the proxy sets its own view of the world.
const STRIPPED_REQUEST_HEADERS = [
    TOKEN_HEADER,
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-proto',
    'x-forwarded-server',
    'x-real-ip'
];

/**
 * Constant time comparison of the presented token.
 *
 * @param {string|string[]|undefined} presented - The header value.
 * @param {string} expected - The per-launch token.
 * @returns {boolean}
 */
function tokenMatches(presented: string | string[] | undefined, expected: string): boolean {
    if (typeof presented !== 'string') {
        return false;
    }

    const a = Buffer.from(presented);
    const b = Buffer.from(expected);

    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Starts the embedded client server for one upstream Jitsi server.
 *
 * @param {IEmbeddedServerOptions} options - Options.
 * @returns {Promise<IEmbeddedServer>} The running server.
 */
export async function createEmbeddedServer(options: IEmbeddedServerOptions): Promise<IEmbeddedServer> {
    const { bundleDir, onLog = () => undefined, preferredPort, token, upstreamOrigin } = options;
    const root = fs.realpathSync(path.resolve(bundleDir));
    const prefix = cookiePrefix(upstreamOrigin);
    const sockets = new Set<Socket>();
    let port = 0;
    let serverOrigin = '';

    const proxy = createProxyServer({
        target: upstreamOrigin,
        changeOrigin: true,
        secure: true,
        followRedirects: false,
        xfwd: false,
        ws: true
    });

    proxy.on('proxyRes', proxyRes => {
        const location = proxyRes.headers.location;

        if (location) {
            proxyRes.headers.location = rewriteLocation(location, upstreamOrigin, serverOrigin);
        }

        const cookies = proxyRes.headers['set-cookie'];

        if (cookies) {
            proxyRes.headers['set-cookie'] = cookies.map(cookie => rewriteSetCookie(cookie, prefix));
        }
    });

    proxy.on('error', (error, _req, res) => {
        onLog(`proxy error ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
        if (res instanceof http.ServerResponse) {
            if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'text/plain' });
            }
            res.end('Bad gateway');
        } else {
            res.destroy();
        }
    });

    /**
     * Applies the checks every request and WebSocket handshake must pass.
     *
     * @param {http.IncomingMessage} req - The request.
     * @param {boolean} isWebSocket - Whether it is a WebSocket handshake.
     * @returns {{ status: number }|{ pathname: string }} A refusal or the parsed path.
     */
    const guard = (req: http.IncomingMessage, isWebSocket: boolean): Verdict => {
        const target = parseRequestTarget(req.url);

        if (!target) {
            return { refused: true,
                status: 400 };
        }
        if (!isAllowedHost(req.headers.host, port)) {
            return { refused: true,
                status: 403 };
        }
        if (!tokenMatches(req.headers[TOKEN_HEADER], token)) {
            return { refused: true,
                status: 403 };
        }
        if (!isAllowedOrigin(req.headers.origin, serverOrigin, isWebSocket)) {
            return { refused: true,
                status: 403 };
        }

        return { refused: false,
            pathname: target.pathname };
    };

    /**
     * Prepares the headers of a request that is forwarded to the upstream.
     *
     * @param {http.IncomingMessage} req - The request, modified in place.
     * @returns {void}
     */
    const prepareForUpstream = (req: http.IncomingMessage) => {
        const { origin, referer, cookie } = req.headers;

        for (const name of STRIPPED_REQUEST_HEADERS) {
            delete req.headers[name];
        }

        if (typeof origin === 'string') {
            req.headers.origin = upstreamOrigin;
        }

        const newReferer = rewriteReferer(referer, upstreamOrigin, serverOrigin);

        if (newReferer) {
            req.headers.referer = newReferer;
        } else {
            delete req.headers.referer;
        }

        const newCookie = filterRequestCookies(cookie, prefix);

        if (newCookie) {
            req.headers.cookie = newCookie;
        } else {
            delete req.headers.cookie;
        }
    };

    /**
     * Serves one file of the bundle (GET/HEAD only, regular files only).
     *
     * @param {http.IncomingMessage} req - The request.
     * @param {http.ServerResponse} res - The response.
     * @param {string} file - The classified bundle path.
     * @returns {Promise<void>}
     */
    const serveStatic = async (req: http.IncomingMessage, res: http.ServerResponse, file: string) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' }).end();
            onLog('static 405');

            return;
        }

        const candidate = resolveStaticPath(root, file);

        if (!candidate) {
            res.writeHead(400).end();
            onLog('static 400');

            return;
        }

        try {
            // realpath: a symlink inside the bundle must not lead out of it.
            const real = await fs.promises.realpath(candidate);
            const stat = await fs.promises.stat(real);

            if (!real.startsWith(root + path.sep) || !stat.isFile()) {
                throw new Error('not a bundle file');
            }

            const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
            const headers = {
                'content-type': CONTENT_TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
                'cache-control': 'no-cache',
                'x-content-type-options': 'nosniff',
                etag
            };

            if (req.headers['if-none-match'] === etag) {
                res.writeHead(304, headers).end();
                onLog('static 304');

                return;
            }

            res.writeHead(200, { ...headers,
                'content-length': stat.size });
            onLog('static 200');
            if (req.method === 'HEAD') {
                res.end();

                return;
            }
            fs.createReadStream(real).on('error', () => res.destroy())
                .pipe(res);
        } catch {
            res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
            onLog('static 404');
        }
    };

    const server = http.createServer((req, res) => {
        const verdict = guard(req, false);

        if (verdict.refused) {
            res.writeHead(verdict.status, { 'content-type': 'text/plain' }).end('Forbidden');
            onLog(`rejected ${verdict.status}`);

            return;
        }

        const route = classifyPath(verdict.pathname);

        if (route.kind === 'static') {
            serveStatic(req, res, route.file).catch(() => res.destroy());

            return;
        }

        prepareForUpstream(req);
        res.on('finish', () => onLog(`proxy ${res.statusCode}`));
        proxy.web(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
        const verdict = guard(req, true);
        const route = verdict.refused ? undefined : classifyPath(verdict.pathname);

        if (verdict.refused || route?.kind !== 'proxy') {
            const status = verdict.refused ? verdict.status : 404;

            socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            onLog(`websocket rejected ${status}`);

            return;
        }

        prepareForUpstream(req);
        sockets.add(socket as Socket);
        socket.on('close', () => sockets.delete(socket as Socket));
        onLog('websocket proxied');
        proxy.ws(req, socket, head);
    });

    // CONNECT would turn the server into a tunnel to arbitrary hosts.
    server.on('connect', (_req, socket) => {
        socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        onLog('connect rejected');
    });

    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    /**
     * Listens on the loopback interface only.
     *
     * @param {number} wanted - The port; 0 for an ephemeral one.
     * @returns {Promise<void>}
     */
    const listen = (wanted: number) => new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);

        server.once('error', onError);
        server.listen({ host: LOOPBACK_HOST,
            port: wanted }, () => {
            server.off('error', onError);
            resolve();
        });
    });

    try {
        await listen(preferredPort ?? 0);
    } catch (error) {
        if (!preferredPort || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
            throw error;
        }
        await listen(0);
    }

    port = (server.address() as AddressInfo).port;
    serverOrigin = `http://${LOOPBACK_HOST}:${port}`;

    return {
        origin: serverOrigin,
        port,
        close: () => new Promise<void>(resolve => {
            proxy.close();
            sockets.forEach(socket => socket.destroy());
            server.close(() => resolve());
        })
    };
}
