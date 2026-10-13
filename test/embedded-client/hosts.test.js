/* eslint-env node */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
    embeddedHostName,
    isEmbeddedOriginShape,
    isForbiddenUpstreamHost,
    isLoopback,
    isNonPublicIP
} = require('../../app/features/embedded-client/hosts');

describe('isLoopback', () => {
    it('recognises every spelling of this machine', () => {
        for (const h of [ 'localhost', 'LocalHost', 'localhost.', 'a.localhost', 'a.b.LOCALHOST.', '127.0.0.1',
            '127.0.0.2', '127.255.0.1', '0.0.0.0', '[::1]', '::1', '[::]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]' ]) {
            assert.equal(isLoopback(h), true, h);
        }
    });

    it('does not mistake other hosts for loopback', () => {
        for (const h of [ 'localhost.example.com', 'notlocalhost', 'meet.example.com', '128.0.0.1', '126.255.255.255',
            '10.0.0.1', '8.8.8.8', '[2001:db8::1]' ]) {
            assert.equal(isLoopback(h), false, h);
        }
    });
});

describe('isNonPublicIP / isForbiddenUpstreamHost', () => {
    it('flags private, link-local, unique local and unspecified addresses', () => {
        for (const ip of [ '10.1.2.3', '172.16.0.1', '172.31.1.1', '192.168.0.1', '169.254.1.1',
            '100.64.1.1', '0.1.2.3', '127.0.0.1', '224.0.0.1', '::1', '::', 'fc00::1', 'fdff::1', 'fe80::1',
            '::ffff:10.0.0.1',
            '::ffff:a00:1' ]) {
            assert.equal(isNonPublicIP(ip), true, ip);
        }
        for (const ip of [ '8.8.8.8', '172.32.0.1', '172.15.255.255', '192.169.1.1', '1.1.1.1', '2606:4700::1111',
            '::ffff:8.8.8.8' ]) {
            assert.equal(isNonPublicIP(ip), false, ip);
        }
    });

    it('forbids empty and loopback names', () => {
        assert.equal(isForbiddenUpstreamHost(''), true);
        assert.equal(isForbiddenUpstreamHost('meet.example.com'), false);
    });
});

describe('embedded host names', () => {
    it('are stable, per upstream and shaped like <16 hex>.localhost', () => {
        const a = embeddedHostName('https://a.example');
        const b = embeddedHostName('https://b.example');

        assert.match(a, /^[0-9a-f]{16}\.localhost$/);
        assert.equal(a, embeddedHostName('https://a.example'));
        assert.notEqual(a, b);
        assert.equal(isEmbeddedOriginShape(`http://${a}:5000`), true);
        for (const o of [ 'http://127.0.0.1:5000', `https://${a}:5000`, `http://${a}`, 'http://evil.localhost:5000' ]) {
            assert.equal(isEmbeddedOriginShape(o), false, o);
        }
    });
});

describe('DNS guard', () => {
    const { guardedLookup } = require('../../app/features/embedded-client/dnsGuard');

    /**
     * Resolves a name through the guard.
     *
     * @param {string} name - Host name.
     * @returns {Promise<Object>} The error code or the addresses.
     */
    function lookup(name) {
        return new Promise(resolve => guardedLookup(name, {}, (error, address) => resolve({ code: error?.code,
            address })));
    }

    it('refuses names that resolve to loopback', async () => {
        assert.equal((await lookup('localhost')).code, 'EUPSTREAMFORBIDDEN');
        assert.equal((await lookup('127.0.0.1')).code, 'EUPSTREAMFORBIDDEN');
    });

    it('lets public addresses through', async () => {
        assert.equal((await lookup('8.8.8.8')).address, '8.8.8.8');
    });
});
