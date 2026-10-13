/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { LOOPBACK_DOMAIN, patchExternalApi, REPLACEMENT } = require('../../scripts/patchExternalApi');

const vendored = path.join(process.env.EMBEDDED_TEST_ROOT, 'app/features/conference/external_api.js');

/**
 * The URL the patched template yields for a domain, computed the way the template does.
 *
 * @param {string} domain - The domain argument of JitsiMeetExternalAPI.
 * @returns {string} The URL the iframe would get.
 */
function urlFor(domain) {
    return `${LOOPBACK_DOMAIN.test(domain) ? domain : `https://${domain}`}/#jitsi_meet_external_api_id=ID`;
}

describe('external_api.js patch', () => {
    it('applies to the vendored file exactly once and changes nothing else', () => {
        const original = fs.readFileSync(vendored, 'utf8');
        const patched = patchExternalApi(original);

        assert.notEqual(patched, original);
        assert.equal(patched.split(REPLACEMENT).length - 1, 1);
        assert.equal(patched.length - original.length,
            REPLACEMENT.length - 'url:`https://${t}/#jitsi_meet_external_api_id=${j}`'.length);
    });

    it('fails loudly when the pattern is missing or duplicated', () => {
        assert.throws(() => patchExternalApi('nothing'), /found 0/);
        const needle = 'url:`https://${t}/#jitsi_meet_external_api_id=${j}`';

        assert.throws(() => patchExternalApi(needle + needle), /found 2/);
    });

    it('embeds the same pattern the tests below check', () => {
        assert.ok(REPLACEMENT.includes(String(LOOPBACK_DOMAIN)));
    });

    it('keeps http only for the loopback embedded server', () => {
        assert.equal(urlFor('meet.jit.si'), 'https://meet.jit.si/#jitsi_meet_external_api_id=ID');
        assert.equal(urlFor('meet.example.com/tenant'),
            'https://meet.example.com/tenant/#jitsi_meet_external_api_id=ID');
        assert.equal(urlFor('http://127.0.0.1:5123'), 'http://127.0.0.1:5123/#jitsi_meet_external_api_id=ID');
        assert.equal(urlFor('http://127.0.0.1:5123/tenant'),
            'http://127.0.0.1:5123/tenant/#jitsi_meet_external_api_id=ID');
        for (const evil of [ 'http://127.0.0.1.evil.example:80', 'http://evil.example', 'http://localhost:5123',
            'http://127.0.0.1', 'http://127.0.0.1:5123@evil.example' ]) {
            assert.ok(urlFor(evil).startsWith('https://'), evil);
        }
    });
});
