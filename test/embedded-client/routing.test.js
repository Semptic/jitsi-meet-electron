/* eslint-env node */

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
    classifyPath,
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
        for (const f of [ '/libs/.git/config', '/libs/.env', '/.hidden/a.js', '/libs/a/.DS_Store',
            '/libs/../x', '/libs/%2e%2e/x', '/libs/..%2fx', '/libs/%2E%2E%2Fx', '/libs/./a.js',
            '/libs/a%00.js', '/libs/..\\x', '/libs/%5cx', '/libs/', '/libs//', '/libs/%zz', 'libs/a.js' ]) {
            assert.equal(resolveStaticPath(root, f), null, f);
        }
    });
});

describe('host and origin checks', () => {
    const host = 'abcdef0123456789.localhost';

    it('accepts only the exact per-upstream host and port, case-insensitively', () => {
        assert.equal(isAllowedHost(`${host}:4000`, host, 4000), true);
        assert.equal(isAllowedHost(`${host.toUpperCase()}:4000`, host, 4000), true);
        for (const h of [ 'localhost:4000', '127.0.0.1:4000', `${host}`, `${host}:4001`, `${host}.evil.example:4000`,
            'evil.example:4000', `x.${host}:4000`, `${host}:4000, evil.example`, `${host}:04000`, ` ${host}:4000`,
            'abcdef0123456780.localhost:4000', undefined, '[::1]:4000', '' ]) {
            assert.equal(isAllowedHost(h, host, 4000), false, String(h));
        }
    });

    it('requires the server origin for websockets and tolerates a missing one otherwise', () => {
        const o = 'http://abcdef0123456789.localhost:4000';

        assert.equal(isAllowedOrigin(o, o, true), true);
        assert.equal(isAllowedOrigin(undefined, o, true), false);
        assert.equal(isAllowedOrigin(undefined, o, false), true);
        assert.equal(isAllowedOrigin('https://evil.example', o, false), false);
        assert.equal(isAllowedOrigin('null', o, false), false);
        assert.equal(isAllowedOrigin('http://abcdef0123456789.localhost:4001', o, true), false);
        assert.equal(isAllowedOrigin([ o, o ], o, true), false);
    });
});

describe('parseUpstream', () => {
    it('reduces a server URL to its origin', () => {
        assert.equal(parseUpstream('https://meet.example.com/tenant?x=1'), 'https://meet.example.com');
        assert.equal(parseUpstream('https://meet.example.com:8443'), 'https://meet.example.com:8443');
        assert.equal(parseUpstream('https://Meet.Example.com./room'), 'https://meet.example.com');
        assert.equal(parseUpstream('https://meet.example.com.:8443/x'), 'https://meet.example.com:8443');
    });

    it('refuses everything that is not an https server on a public address', () => {
        for (const u of [ 'http://meet.example.com', 'ftp://x', `${'java'}script:alert(1)`, 'https://user:pw@x.com',

            // loopback, by name and address, with trailing dots and odd spellings
            'https://localhost', 'https://localhost.', 'https://LOCALHOST', 'https://sub.localhost',
            'https://a.b.localhost.', 'https://127.0.0.1', 'https://127.0.0.2', 'https://127.255.255.254',
            'https://2130706433', 'https://0x7f.1', 'https://0.0.0.0', 'https://[::1]', 'https://[::]',

            // IPv4-mapped IPv6
            'https://[::ffff:127.0.0.1]', 'https://[::ffff:7f00:1]', 'https://[::ffff:10.0.0.1]',
            'https://[::ffff:c0a8:1]', 'https://[0:0:0:0:0:ffff:a9fe:a9fe]',

            // private, link-local, unique local
            'https://10.0.0.1', 'https://10.255.255.255', 'https://172.16.0.1', 'https://172.31.255.255',
            'https://192.168.1.1', 'https://169.254.169.254', 'https://100.64.0.1', 'https://[fc00::1]',
            'https://[fd12:3456::1]', 'https://[fe80::1]', 'https://[febf::1]',
            'not a url', '', 42, null, undefined, `https://${'a'.repeat(3000)}.com` ]) {
            assert.equal(parseUpstream(u), null, String(u).slice(0, 40));
        }
    });

    it('accepts public addresses next to the private ranges', () => {
        for (const u of [ 'https://172.15.0.1', 'https://172.32.0.1', 'https://192.169.0.1', 'https://8.8.8.8',
            'https://[2001:4860:4860::8888]' ]) {
            assert.ok(parseUpstream(u), u);
        }
    });

    it('allows loopback only through the test hook', () => {
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

    it('drops the cookie Domain and keeps names (so __Host- / __Secure- stay meaningful)', () => {
        assert.equal(rewriteSetCookie('sid=1; Domain=a.example; Path=/; Secure'), 'sid=1; Path=/; Secure');
        assert.equal(rewriteSetCookie('__Host-sid=1; Path=/; Secure; SameSite=None'),
            '__Host-sid=1; Path=/; Secure; SameSite=None');
    });
});
