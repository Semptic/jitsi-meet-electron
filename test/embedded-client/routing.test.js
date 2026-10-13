/* eslint-env node */

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
    classifyPath,
    cookiePrefix,
    filterRequestCookies,
    isAllowedHost,
    isAllowedOrigin,
    parseRequestTarget,
    parseUpstream,
    resolveStaticPath,
    rewriteLocation,
    rewriteReferer,
    rewriteSetCookie
} = require('../../app/features/embedded-client/routing');

describe('classifyPath', () => {
    it('serves the same prefixes locally as the jitsi-meet dev server', () => {
        for (const p of [ '/libs/app.bundle.min.js', '/css/all.css', '/lang/main-de.json', '/images/a.png',
            '/sounds/x.mp3', '/fonts/f.woff2', '/static/close3.html', '/doc/x', '/libs/olm.wasm', '/olm.wasm' ]) {
            assert.equal(classifyPath(p).kind, 'static', p);
        }
    });

    it('proxies what belongs to the Jitsi server', () => {
        for (const p of [ '/', '/room', '/tenant/room', '/index.html', '/config.js', '/interface_config.js',
            '/http-bind', '/xmpp-websocket', '/colibri-ws/node/abc', '/conference-request/v1', '/libsx/a.js' ]) {
            assert.equal(classifyPath(p).kind, 'proxy', p);
        }
    });

    it('strips the CDN prefix and the tenant before static paths', () => {
        assert.deepEqual(classifyPath('/v1/_cdn/1234/libs/app.bundle.min.js'),
            { kind: 'static',
                file: '/libs/app.bundle.min.js' });
        assert.deepEqual(classifyPath('/tenant/static/secondScreen.html'),
            { kind: 'static',
                file: '/static/secondScreen.html' });
    });

    it('never lets an encoded traversal reach the proxy decision', () => {
        assert.equal(classifyPath('/libs/..%2f..%2fetc').kind, 'static');
        assert.equal(classifyPath('/%6cibs/a.js').kind, 'proxy');
    });
});

describe('parseRequestTarget', () => {
    it('accepts origin-form targets and splits the query', () => {
        assert.deepEqual(parseRequestTarget('/libs/a.js?v=1'), { pathname: '/libs/a.js',
            search: '?v=1' });
    });

    it('refuses absolute-form, authority-form, protocol-relative and malformed targets', () => {
        for (const t of [ 'http://example.com/x', 'example.com:443', '//example.com/x', 'x', '', undefined,
            '/a b', '/a\\b', '/a\r\nHost: x', '/a\u0000' ]) {
            assert.equal(parseRequestTarget(t), null, String(t));
        }
    });
});

describe('resolveStaticPath', () => {
    const root = path.resolve('/srv/bundle');

    it('maps plain paths below the root', () => {
        assert.equal(resolveStaticPath(root, '/libs/a.js'), path.join(root, 'libs/a.js'));
    });

    it('refuses traversal in every encoding, NUL, backslash and directories', () => {
        for (const f of [ '/libs/../x', '/libs/%2e%2e/x', '/libs/..%2fx', '/libs/%2E%2E%2Fx', '/libs/./a.js',
            '/libs/a%00.js', '/libs/..\\x', '/libs/%5cx', '/libs/', '/libs//', '/libs/%zz', 'libs/a.js' ]) {
            assert.equal(resolveStaticPath(root, f), null, f);
        }
    });
});

describe('host and origin checks', () => {
    it('accepts only the exact loopback host and port', () => {
        assert.equal(isAllowedHost('127.0.0.1:4000', 4000), true);
        for (const h of [ 'localhost:4000', '127.0.0.1:4001', '127.0.0.1', 'evil.example:4000',
            '127.0.0.1:4000.evil.example', undefined, '[::1]:4000' ]) {
            assert.equal(isAllowedHost(h, 4000), false, String(h));
        }
    });

    it('requires the server origin for websockets and tolerates a missing one otherwise', () => {
        const o = 'http://127.0.0.1:4000';

        assert.equal(isAllowedOrigin(o, o, true), true);
        assert.equal(isAllowedOrigin(undefined, o, true), false);
        assert.equal(isAllowedOrigin(undefined, o, false), true);
        assert.equal(isAllowedOrigin('https://evil.example', o, false), false);
        assert.equal(isAllowedOrigin('null', o, false), false);
        assert.equal(isAllowedOrigin('http://127.0.0.1:4001', o, true), false);
    });
});

describe('parseUpstream', () => {
    it('reduces a server URL to its origin', () => {
        assert.equal(parseUpstream('https://meet.example.com/tenant?x=1'), 'https://meet.example.com');
        assert.equal(parseUpstream('https://meet.example.com:8443'), 'https://meet.example.com:8443');
    });

    it('refuses everything that is not an https server on another machine', () => {
        for (const u of [ 'http://meet.example.com', 'ftp://x', `${'java'}script:alert(1)`, 'https://user:pw@x.com',
            'https://localhost', 'https://127.0.0.1', 'https://sub.localhost', 'https://[::1]', 'https://0.0.0.0',
            'not a url', '', 42, null, undefined, `https://${'a'.repeat(3000)}.com` ]) {
            assert.equal(parseUpstream(u), null, String(u).slice(0, 40));
        }
    });

    it('allows loopback only when explicitly enabled', () => {
        assert.equal(parseUpstream('http://127.0.0.1:9000', true), 'http://127.0.0.1:9000');
        assert.equal(parseUpstream('http://meet.example.com', true), null);
    });
});

describe('rewrites', () => {
    const up = 'https://meet.example.com';
    const own = 'http://127.0.0.1:4000';

    it('rewrites redirects to the upstream only', () => {
        assert.equal(rewriteLocation(`${up}/room`, up, own), `${own}/room`);
        assert.equal(rewriteLocation('/room', up, own), '/room');
        assert.equal(rewriteLocation('https://other.example/room', up, own), 'https://other.example/room');
        assert.equal(rewriteLocation(`${up}.evil.example/x`, up, own), `${up}.evil.example/x`);
    });

    it('maps the Referer back to the upstream and drops foreign ones', () => {
        assert.equal(rewriteReferer(`${own}/room?x=1`, up, own), `${up}/room?x=1`);
        assert.equal(rewriteReferer('https://evil.example/', up, own), undefined);
        assert.equal(rewriteReferer(`${own}.evil.example/`, up, own), undefined);
    });

    it('keeps cookies of different upstreams apart', () => {
        const a = cookiePrefix('https://a.example');
        const b = cookiePrefix('https://b.example');

        assert.notEqual(a, b);
        assert.equal(rewriteSetCookie('sid=1; Domain=a.example; Path=/; Secure', a), `${a}sid=1; Path=/; Secure`);
        const jar = `${a}sid=1; ${b}sid=2; unrelated=3`;

        assert.equal(filterRequestCookies(jar, a), 'sid=1');
        assert.equal(filterRequestCookies(jar, b), 'sid=2');
        assert.equal(filterRequestCookies('unrelated=3', a), undefined);
        assert.equal(filterRequestCookies(undefined, a), undefined);
    });
});
