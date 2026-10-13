/* eslint-env node */
/* eslint-disable max-lines */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const zlib = require('node:zlib');
const { WebSocket, WebSocketServer } = require('ws');

const { TOKEN_HEADER } = require('../../app/features/embedded-client/constants');
const { EmbeddedClientManager } = require('../../app/features/embedded-client/manager');
const { createEmbeddedServer } = require('../../app/features/embedded-client/server');

const TOKEN = 'test-token-0123456789';
let currentHost = '';

/**
 * Starts a fake Jitsi server: records every request it sees and answers a few routes.
 *
 * @param {string} name - A label put into responses.
 * @returns {Promise<Object>} The server, its origin and the recorded requests.
 */
async function startFakeUpstream(name) {
    const seen = [];
    const sockets = new Set();
    const wsSeen = [];
    const server = http.createServer((req, res) => {
        seen.push({ method: req.method,
            url: req.url,
            headers: req.headers });
        const chunks = [];

        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const origin = `http://127.0.0.1:${server.address().port}`;

            switch (req.url.split('?')[0]) {
            case '/config.js':
                res.writeHead(200, { 'content-type': 'text/javascript' });
                res.end(`var config = ${JSON.stringify({ name,
                    headers: req.headers })};`);
                break;
            case '/redirect':
                res.writeHead(302, { location: `${origin}/landing?x=1` });
                res.end();
                break;
            case '/redirect-away':
                res.writeHead(302, { location: 'https://elsewhere.example/page' });
                res.end();
                break;
            case '/cookie':
                res.writeHead(200, { 'set-cookie': [ 'sid=abc; Domain=meet.example; Path=/; HttpOnly',
                    'other=1; Path=/x' ] });
                res.end('ok');
                break;
            case '/gzip':
                res.writeHead(200, { 'content-encoding': 'gzip',
                    'content-type': 'text/plain' });
                res.end(zlib.gzipSync('compressed hello'));
                break;
            case '/http-bind':
                res.writeHead(200, { 'content-type': 'text/xml' });
                res.end(`<body echo="${Buffer.concat(chunks).toString()}"/>`);
                break;
            default:
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end(`upstream ${name} ${req.url}`);
            }
        });
    });
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        wsSeen.push({ url: req.url,
            headers: req.headers });
        wss.handleUpgrade(req, socket, head, ws => {
            ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    return {
        seen,
        wsSeen,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(resolve => {
            wss.clients.forEach(client => client.terminate());
            sockets.forEach(socket => socket.destroy());
            server.close(resolve);
        })
    };
}

/**
 * Makes a request with full control over headers.
 *
 * @param {Object} options - Request options.
 * @returns {Promise<Object>} Status, headers and body.
 */
function request({ port, path: reqPath = '/', method = 'GET', headers = {}, body, token = TOKEN, host }) {
    return new Promise((resolve, reject) => {
        const allHeaders = { host: host ?? `${currentHost}:${port}`,
            ...token ? { [TOKEN_HEADER]: token } : {},
            ...headers };
        const req = http.request({ host: '127.0.0.1',
            port,
            path: reqPath,
            method,
            headers: allHeaders }, res => {
            const chunks = [];

            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks) }));
        });

        req.on('error', reject);
        req.end(body);
    });
}

/**
 * Sends raw bytes and returns what the server answers (for requests Node's client refuses to build).
 *
 * @param {number} port - Server port.
 * @param {string} raw - The raw request.
 * @returns {Promise<string>} The raw response (or '' if the connection was just closed).
 */
function rawRequest(port, raw) {
    return new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(raw));
        let data = '';

        socket.on('data', chunk => {
            data += chunk;
        });
        socket.on('close', () => resolve(data));
        socket.on('error', () => resolve(data));
        setTimeout(() => socket.destroy(), 1500);
    });
}

/**
 * Opens a WebSocket and resolves with its outcome.
 *
 * @param {string} url - ws:// url.
 * @param {Object} headers - Extra headers.
 * @returns {Promise<Object>} The open socket or the failure status.
 */
function openWs(url, headers) {
    return new Promise(resolve => {
        const ws = new WebSocket(url, { headers: { host: `${currentHost}:${new URL(url).port}`,
            ...headers } });

        ws.on('open', () => resolve({ ws }));
        ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
        ws.on('error', () => resolve({ status: 0 }));
    });
}

describe('embedded client server', () => {
    let tmp;
    let bundle;
    let upstream;
    let other;
    let server;
    let port;
    let origin;

    before(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-server-'));
        bundle = path.join(tmp, 'bundle');
        fs.mkdirSync(path.join(bundle, 'libs'), { recursive: true });
        fs.mkdirSync(path.join(bundle, 'lang'), { recursive: true });
        fs.writeFileSync(path.join(bundle, 'libs/app.bundle.min.js'), 'console.log("patched client");');
        fs.writeFileSync(path.join(bundle, 'libs/multitrack-worklet.min.js'), 'registerProcessor("x",class{});');
        fs.writeFileSync(path.join(bundle, 'libs/tflite.wasm'), Buffer.from([ 0, 0x61, 0x73, 0x6d ]));
        fs.writeFileSync(path.join(bundle, 'lang/main.json'), '{"a":1}');

        // Not deployable content: must never be served from the bundle.
        fs.writeFileSync(path.join(bundle, 'index.html'), '<!--#include virtual="/base.html" -->');
        fs.writeFileSync(path.join(tmp, 'secret.txt'), 'top secret');
        fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(bundle, 'libs/link.txt'));

        upstream = await startFakeUpstream('A');
        other = await startFakeUpstream('B');
        server = await createEmbeddedServer({ bundleDir: bundle,
            token: TOKEN,
            unsafeAllowLoopbackForTests: true,
            upstreamOrigin: upstream.origin });
        port = server.port;
        origin = server.origin;
        currentHost = server.host;
    });

    after(async () => {
        await server.close();
        await upstream.close();
        await other.close();
        fs.rmSync(tmp, { recursive: true,
            force: true });
    });

    it('binds to the loopback interface only, on an ephemeral port', () => {
        assert.equal(origin, `http://${server.host}:${port}`);
        assert.match(server.host, /^[0-9a-f]{16}\.localhost$/);
        assert.ok(port > 1023);
    });

    describe('static files', () => {
        it('serves the bundle with content type and ignores the query string', async () => {
            const res = await request({ port,
                path: '/libs/app.bundle.min.js?v=1234' });

            assert.equal(res.status, 200);
            assert.match(res.headers['content-type'], /javascript/);
            assert.equal(res.body.toString(), 'console.log("patched client");');
            assert.equal(upstream.seen.length, 0);
        });

        it('serves the multitrack worklet, wasm with its type, and CDN prefixed paths', async () => {
            assert.equal((await request({ port,
                path: '/libs/multitrack-worklet.min.js' })).status, 200);
            assert.equal((await request({ port,
                path: '/libs/tflite.wasm' })).headers['content-type'], 'application/wasm');
            assert.equal((await request({ port,
                path: '/v1/_cdn/99/libs/app.bundle.min.js' })).status, 200);
            assert.equal((await request({ port,
                path: '/lang/main.json' })).body.toString(), '{"a":1}');
        });

        it('answers HEAD and conditional requests', async () => {
            const first = await request({ port,
                path: '/lang/main.json' });
            const head = await request({ port,
                path: '/lang/main.json',
                method: 'HEAD' });
            const cond = await request({ port,
                path: '/lang/main.json',
                headers: { 'if-none-match': first.headers.etag } });

            assert.equal(head.status, 200);
            assert.equal(head.body.length, 0);
            assert.equal(cond.status, 304);
        });

        it('refuses methods other than GET and HEAD', async () => {
            assert.equal((await request({ port,
                path: '/libs/app.bundle.min.js',
                method: 'POST',
                body: 'x' })).status, 405);
        });

        it('does not serve files outside the deployable directories (the room page comes from upstream)', async () => {
            const res = await request({ port,
                path: '/index.html' });

            assert.equal(res.body.toString(), 'upstream A /index.html');
        });

        it('does not follow encoded or plain traversal out of the bundle', async () => {
            const attempts = [
                '/libs/..%2f..%2fsecret.txt',
                '/libs/%2e%2e/%2e%2e/secret.txt',
                '/libs/%2E%2E%2Fsecret.txt',
                '/libs/../../secret.txt',
                '/libs/..%5c..%5csecret.txt',
                '/static/..%2f..%2f..%2fetc/passwd',
                '/libs/%00',
                '/lang/main.json%00.png'
            ];

            for (const attempt of attempts) {
                const answer = await rawRequest(port,
                    `GET ${attempt} HTTP/1.1\r\nHost: ${currentHost}:${port}\r\n${TOKEN_HEADER}: ${TOKEN}\r\n`
                    + 'Connection: close\r\n\r\n');

                assert.doesNotMatch(answer, /top secret/, attempt);
                assert.match(answer, /^HTTP\/1\.1 (400|404)/, attempt);
            }
        });

        it('does not follow a symlink that leaves the bundle, and never lists directories', async () => {
            assert.equal((await request({ port,
                path: '/libs/link.txt' })).status, 404);
            assert.equal((await request({ port,
                path: '/libs/' })).status, 400);
            assert.equal((await request({ port,
                path: '/libs' })).body.toString(), 'upstream A /libs');
            assert.equal((await request({ port,
                path: '/libs/missing.js' })).status, 404);
        });
    });

    describe('proxying', () => {
        it('proxies config.js to the upstream with a rewritten Host, Origin and Referer', async () => {
            upstream.seen.length = 0;
            const res = await request({ port,
                path: '/config.js?x=1',
                headers: { origin,
                    referer: `${origin}/room?jwt=SECRET`,
                    'x-forwarded-for': '6.6.6.6',
                    'x-forwarded-proto': 'http',
                    forwarded: 'for=6.6.6.6' } });
            const seen = upstream.seen[0];

            assert.equal(res.status, 200);
            assert.match(res.body.toString(), /"name":"A"/);
            assert.equal(seen.url, '/config.js?x=1');
            assert.equal(seen.headers.host, new URL(upstream.origin).host);
            assert.equal(seen.headers.origin, upstream.origin);
            assert.equal(seen.headers.referer, `${upstream.origin}/room?jwt=SECRET`);
            assert.equal(seen.headers[TOKEN_HEADER], undefined, 'the token must not leak upstream');
            assert.equal(seen.headers['x-forwarded-for'], undefined);
            assert.equal(seen.headers['x-forwarded-proto'], undefined);
            assert.equal(seen.headers.forwarded, undefined);
        });

        it('streams POST bodies (BOSH style)', async () => {
            const res = await request({ port,
                path: '/http-bind',
                method: 'POST',
                headers: { origin },
                body: 'payload' });

            assert.equal(res.body.toString(), '<body echo="payload"/>');
        });

        it('rewrites redirects to the upstream and leaves foreign ones alone', async () => {
            const same = await request({ port,
                path: '/redirect' });
            const away = await request({ port,
                path: '/redirect-away' });

            assert.equal(same.status, 302);
            assert.equal(same.headers.location, `${origin}/landing?x=1`);
            assert.equal(away.headers.location, 'https://elsewhere.example/page');
        });

        it('passes compressed responses through untouched', async () => {
            const res = await request({ port,
                path: '/gzip',
                headers: { 'accept-encoding': 'gzip' } });

            assert.equal(res.headers['content-encoding'], 'gzip');
            assert.equal(zlib.gunzipSync(res.body).toString(), 'compressed hello');
        });

        it('drops the cookie Domain (host-only on the per-upstream host) and passes cookies on', async () => {
            const res = await request({ port,
                path: '/cookie' });
            const cookies = res.headers['set-cookie'];

            assert.deepEqual(cookies, [ 'sid=abc; Path=/; HttpOnly', 'other=1; Path=/x' ]);
            await request({ port,
                path: '/config.js',
                headers: { cookie: 'sid=abc; plain=1' } });
            assert.equal(upstream.seen.at(-1).headers.cookie, 'sid=abc; plain=1');
        });
    });

    describe('request validation', () => {
        it('rejects a foreign Host header (DNS rebinding)', async () => {
            const count = upstream.seen.length;

            assert.equal((await request({ port,
                host: 'evil.example' })).status, 403);
            assert.equal((await request({ port,
                host: `localhost:${port}` })).status, 403);
            assert.equal((await request({ port,
                host: `127.0.0.1:${port}` })).status, 403);
            assert.equal((await request({ port,
                host: '127.0.0.1' })).status, 403);
            assert.equal((await request({ port,
                host: `${currentHost}:${port + 1}` })).status, 403);
            assert.equal((await request({ port,
                host: `${currentHost}` })).status, 403);
            assert.equal(upstream.seen.length, count);
            assert.equal((await request({ port,
                host: `${currentHost.toUpperCase()}:${port}`,
                path: '/libs/app.bundle.min.js' })).status, 200);
            assert.equal(upstream.seen.length, count);
        });

        it('rejects requests without or with a wrong token, including static ones', async () => {
            assert.equal((await request({ port,
                token: null })).status, 403);
            assert.equal((await request({ port,
                token: 'wrong',
                path: '/libs/app.bundle.min.js' })).status, 403);
            assert.equal((await request({ port,
                token: `${TOKEN}x` })).status, 403);
        });

        it('rejects duplicated or malformed token headers', async () => {
            const dup = await rawRequest(port,
                `GET /libs/app.bundle.min.js HTTP/1.1\r\nHost: ${currentHost}:${port}\r\n${TOKEN_HEADER}: ${TOKEN}\r\n`
                + `${TOKEN_HEADER}: ${TOKEN}\r\nConnection: close\r\n\r\n`);
            const empty = await rawRequest(port,
                `GET /libs/app.bundle.min.js HTTP/1.1\r\nHost: ${currentHost}:${port}\r\n${TOKEN_HEADER}:\r\n`
                + 'Connection: close\r\n\r\n');

            assert.match(dup, /^HTTP\/1\.1 403/);
            assert.match(empty, /^HTTP\/1\.1 403/);
            assert.equal((await request({ port,
                token: TOKEN.toUpperCase() })).status, 403);
        });

        it('refuses request smuggling with both Content-Length and Transfer-Encoding', async () => {
            const count = upstream.seen.length;
            const answer = await rawRequest(port,
                `POST /http-bind HTTP/1.1\r\nHost: ${currentHost}:${port}\r\n${TOKEN_HEADER}: ${TOKEN}\r\n`
                + 'Content-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n'
                + '0\r\n\r\nGET /smuggled HTTP/1.1\r\nHost: x\r\n\r\n');

            assert.match(answer, /^HTTP\/1\.1 400/);
            assert.equal(upstream.seen.length, count);
            assert.ok(!upstream.seen.some(r => r.url === '/smuggled'));
        });

        it('rejects a foreign Origin', async () => {
            assert.equal((await request({ port,
                headers: { origin: 'https://evil.example' } })).status, 403);
            assert.equal((await request({ port,
                headers: { origin: 'null' } })).status, 403);
        });

        it('is not an open proxy: absolute-form targets and CONNECT are refused', async () => {
            const count = other.seen.length;
            const otherHost = new URL(other.origin).host;
            const absolute = await rawRequest(port,
                `GET ${other.origin}/config.js HTTP/1.1\r\nHost: ${otherHost}\r\n${TOKEN_HEADER}: ${TOKEN}\r\n`
                + 'Connection: close\r\n\r\n');
            const protocolRelative = await rawRequest(port,
                `GET //${otherHost}/config.js HTTP/1.1\r\nHost: ${currentHost}:${port}\r\n${TOKEN_HEADER}: ${TOKEN}\r\n`
                + 'Connection: close\r\n\r\n');
            const connect = await rawRequest(port,
                `CONNECT ${otherHost} HTTP/1.1\r\nHost: ${otherHost}\r\n\r\n`);

            assert.match(absolute, /^HTTP\/1\.1 400 /);
            assert.match(protocolRelative, /^HTTP\/1\.1 400/);
            assert.match(connect, /^HTTP\/1\.1 405/);
            assert.equal(other.seen.length, count, 'a non-allow-listed upstream must never be contacted');
        });

        it('only ever forwards to its own upstream', async () => {
            const count = other.seen.length;

            await request({ port,
                path: '/config.js',
                headers: { 'x-forwarded-host': new URL(other.origin).host,
                    'x-original-url': other.origin } });
            assert.equal(other.seen.length, count);
        });
    });

    describe('websockets', () => {
        it('proxies a websocket, sending the upstream its own Origin', async () => {
            const { ws, status } = await openWs(`ws://127.0.0.1:${port}/xmpp-websocket?room=probe`,
                { origin,
                    [TOKEN_HEADER]: TOKEN });

            assert.ok(ws, `handshake failed with ${status}`);
            const echoed = await new Promise(resolve => {
                ws.on('message', data => resolve(data.toString()));
                ws.send('hello jitsi');
            });

            assert.equal(echoed, 'hello jitsi');
            ws.close();
            const seen = upstream.wsSeen.at(-1);

            assert.equal(seen.url, '/xmpp-websocket?room=probe');
            assert.equal(seen.headers.origin, upstream.origin);
            assert.equal(seen.headers.host, new URL(upstream.origin).host);
            assert.equal(seen.headers[TOKEN_HEADER], undefined);
        });

        it('refuses a foreign or missing Origin, a missing token and a foreign Host', async () => {
            const count = upstream.wsSeen.length;
            const attempts = [
                { origin: 'https://evil.example',
                    [TOKEN_HEADER]: TOKEN },
                { [TOKEN_HEADER]: TOKEN },
                { origin },
                { origin,
                    [TOKEN_HEADER]: 'nope' },
                { origin,
                    [TOKEN_HEADER]: TOKEN,
                    host: 'evil.example' }
            ];

            for (const headers of attempts) {
                const { ws, status } = await openWs(`ws://127.0.0.1:${port}/xmpp-websocket`, headers);

                assert.equal(ws, undefined);
                assert.ok(status === 403 || status === 0, JSON.stringify(headers));
            }
            assert.equal(upstream.wsSeen.length, count);
        });

        it('does not upgrade static paths', async () => {
            const { ws, status } = await openWs(`ws://127.0.0.1:${port}/libs/app.bundle.min.js`,
                { origin,
                    [TOKEN_HEADER]: TOKEN });

            assert.equal(ws, undefined);
            assert.equal(status, 404);
        });
    });

    it('refuses dotfiles in the bundle', async () => {
        fs.writeFileSync(path.join(bundle, 'libs/.env'), 'SECRET=1');
        fs.mkdirSync(path.join(bundle, 'static/.git'), { recursive: true });
        fs.writeFileSync(path.join(bundle, 'static/.git/config'), 'x');
        assert.equal((await request({ port,
            path: '/libs/.env' })).status, 400);
        assert.equal((await request({ port,
            path: '/static/.git/config' })).status, 400);
    });

    it('can be restarted on its remembered port and falls back when it is taken', async () => {
        const first = await createEmbeddedServer({ bundleDir: bundle,
            token: TOKEN,
            unsafeAllowLoopbackForTests: true,
            upstreamOrigin: upstream.origin });
        const rememberedPort = first.port;

        await first.close();

        const again = await createEmbeddedServer({ bundleDir: bundle,
            token: TOKEN,
            unsafeAllowLoopbackForTests: true,
            upstreamOrigin: upstream.origin,
            preferredPort: rememberedPort });
        const taken = await createEmbeddedServer({ bundleDir: bundle,
            token: TOKEN,
            unsafeAllowLoopbackForTests: true,
            upstreamOrigin: upstream.origin,
            preferredPort: rememberedPort });

        assert.equal(again.port, rememberedPort);
        assert.notEqual(taken.port, rememberedPort);
        await again.close();
        await taken.close();
    });
});

describe('EmbeddedClientManager', () => {
    let tmp;
    let bundle;

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-manager-'));
        bundle = path.join(tmp, 'bundle');
        fs.mkdirSync(path.join(bundle, 'libs'), { recursive: true });
        fs.writeFileSync(path.join(bundle, 'libs/app.bundle.min.js'), '//');
    });

    after(() => fs.rmSync(tmp, { recursive: true,
        force: true }));

    it('refuses upstreams it must not forward to', async () => {
        const manager = new EmbeddedClientManager({ bundleDir: bundle });

        for (const url of [ 'http://meet.example.com', 'https://127.0.0.1:9', 'https://localhost', 'nonsense',
            undefined ]) {
            assert.equal(await manager.resolve(url), null, String(url));
        }
        await manager.close();
    });

    it('answers null when the bundle is missing', async () => {
        const manager = new EmbeddedClientManager({ bundleDir: path.join(tmp, 'absent') });

        assert.equal(await manager.resolve('https://meet.example.com'), null);
    });

    it('gives each upstream its own origin, reuses it, and remembers ports across restarts', async () => {
        const portStorePath = path.join(tmp, 'ports.json');
        const options = { bundleDir: bundle,
            unsafeAllowLoopbackForTests: true,
            portStorePath };
        const manager = new EmbeddedClientManager(options);
        const a = await manager.resolve('http://127.0.0.1:41001/tenant');
        const aAgain = await manager.resolve('http://127.0.0.1:41001/other-room');
        const b = await manager.resolve('http://127.0.0.1:41002');

        assert.equal(a.origin, aAgain.origin);
        assert.notEqual(a.origin, b.origin);
        assert.equal(manager.isEmbeddedOrigin(a.origin), true);
        assert.equal(manager.isEmbeddedOrigin('http://127.0.0.1:1'), false);
        await manager.close();
        assert.equal(manager.isEmbeddedOrigin(a.origin), false);

        const restarted = new EmbeddedClientManager(options);
        const a2 = await restarted.resolve('http://127.0.0.1:41001');

        assert.equal(a2.origin, a.origin, 'the web origin (and its storage) stays stable');
        await restarted.close();
    });

    it('caps the number of servers', async () => {
        const manager = new EmbeddedClientManager({ bundleDir: bundle,
            unsafeAllowLoopbackForTests: true,
            maxServers: 2 });

        assert.ok(await manager.resolve('http://127.0.0.1:41011'));
        assert.ok(await manager.resolve('http://127.0.0.1:41012'));
        assert.equal(await manager.resolve('http://127.0.0.1:41013'), null);
        await manager.close();
    });

    it('puts every upstream on its own host, so cookies and storage are per upstream', async () => {
        const manager = new EmbeddedClientManager({ bundleDir: bundle,
            unsafeAllowLoopbackForTests: true });
        const a = await manager.resolve('http://127.0.0.1:41021');
        const b = await manager.resolve('http://127.0.0.1:41022');
        const hostA = new URL(a.origin).hostname;
        const hostB = new URL(b.origin).hostname;

        assert.notEqual(hostA, hostB);
        assert.match(hostA, /^[0-9a-f]{16}\.localhost$/);

        // B's server refuses a request addressed to A's host, even on B's own port.
        const res = await request({ port: Number(new URL(b.origin).port),
            host: `${hostA}:${new URL(b.origin).port}`,
            token: manager.token });

        assert.equal(res.status, 403);
        await manager.close();
    });

    it('never lets upstream B take over the origin A used, whatever ports are remembered', async () => {
        const portStorePath = path.join(tmp, 'ports-swap.json');
        const options = { bundleDir: bundle,
            unsafeAllowLoopbackForTests: true,
            portStorePath };
        const first = new EmbeddedClientManager(options);
        const a = await first.resolve('http://127.0.0.1:41031');

        await first.close();

        // Pretend B was last seen on the port A used (it is free again).
        const store = JSON.parse(fs.readFileSync(portStorePath, 'utf8'));
        const bKey = require('node:crypto').createHash('sha256')
.update('http://127.0.0.1:41032')
            .digest('hex')
            .slice(0, 16);

        store[bKey] = { port: Number(new URL(a.origin).port),
            used: Date.now() };
        fs.writeFileSync(portStorePath, JSON.stringify(store));

        const second = new EmbeddedClientManager(options);
        const b = await second.resolve('http://127.0.0.1:41032');
        const aAgain = await second.resolve('http://127.0.0.1:41031');

        assert.notEqual(new URL(b.origin).hostname, new URL(a.origin).hostname, 'B never gets A\'s host');
        assert.notEqual(b.origin, a.origin);
        assert.notEqual(b.origin, aAgain.origin);
        assert.equal(new URL(aAgain.origin).hostname, new URL(a.origin).hostname);
        await second.close();
    });

    it('does not hand out a remembered port another running upstream holds', async () => {
        const portStorePath = path.join(tmp, 'ports-conflict.json');
        const manager = new EmbeddedClientManager({ bundleDir: bundle,
            unsafeAllowLoopbackForTests: true,
            portStorePath });
        const a = await manager.resolve('http://127.0.0.1:41041');
        const store = JSON.parse(fs.readFileSync(portStorePath, 'utf8'));

        // B's remembered port is the one A is running on right now.
        const bKey = require('node:crypto').createHash('sha256')
.update('http://127.0.0.1:41042')
            .digest('hex')
            .slice(0, 16);

        store[bKey] = { port: Number(new URL(a.origin).port),
            used: Date.now() };
        fs.writeFileSync(portStorePath, JSON.stringify(store));

        const fresh = new EmbeddedClientManager({ bundleDir: bundle,
            unsafeAllowLoopbackForTests: true,
            portStorePath });
        const a2 = await fresh.resolve('http://127.0.0.1:41041');
        const b = await fresh.resolve('http://127.0.0.1:41042');

        assert.notEqual(new URL(b.origin).port, new URL(a2.origin).port);
        await fresh.close();
        await manager.close();
    });

    it('keeps at most 20 remembered ports and stores no host names', async () => {
        const portStorePath = path.join(tmp, 'ports-cap.json');
        const manager = new EmbeddedClientManager({ bundleDir: bundle,
            unsafeAllowLoopbackForTests: true,
            maxServers: 40,
            portStorePath });

        for (let i = 0; i < 24; i++) {
            await manager.resolve(`http://127.0.0.1:${42000 + i}`);
        }
        await manager.close();
        const raw = fs.readFileSync(portStorePath, 'utf8');
        const store = JSON.parse(raw);

        assert.equal(Object.keys(store).length, 20);
        assert.ok(Object.keys(store).every(key => /^[0-9a-f]{16}$/.test(key)));
        assert.doesNotMatch(raw, /127\.0\.0\.1|localhost|http/);
    });
});
