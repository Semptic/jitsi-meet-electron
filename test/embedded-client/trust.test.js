/* eslint-env node */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
    decideLoopbackPermission,
    isTrustedAppSender,
    shouldAddToken
} = require('../../app/features/embedded-client/trust');

const ORIGIN = 'http://abcdef0123456789.localhost:5000';
const OTHER = 'http://0123456789abcdef.localhost:5001';
const isEmbedded = origin => origin === ORIGIN;
const base = {
    url: `${ORIGIN}/libs/app.bundle.min.js`,
    webContentsId: 7,
    meetingWebContentsId: 7,
    isEmbeddedOrigin: isEmbedded,
    headers: {},
    resourceType: 'script'
};

describe('shouldAddToken', () => {
    it('adds the token for the meeting page loading the iframe', () => {
        assert.equal(shouldAddToken({ ...base,
            resourceType: 'subFrame',
            frameIsTop: true,
            frameUrl: 'file:///Applications/App/meeting.html' }), true);
    });

    it('adds it for the iframe navigation of the app page (no initiating frame is reported)', () => {
        assert.equal(shouldAddToken({ ...base,
            resourceType: 'subFrame',
            headers: { 'Sec-Fetch-Dest': 'iframe',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'cross-site' } }), true);
    });

    it('adds it for subresources, workers and sockets that come from the embedded origin', () => {
        assert.equal(shouldAddToken({ ...base,
            frameUrl: `${ORIGIN}/room` }), true);
        assert.equal(shouldAddToken({ ...base,
            headers: { Referer: `${ORIGIN}/room` } }), true);
        assert.equal(shouldAddToken({ ...base,
            url: 'ws://abcdef0123456789.localhost:5000/xmpp-websocket',
            resourceType: 'webSocket',
            headers: { Origin: ORIGIN } }), true);
    });

    it('does not add it for third-party frames, other windows or other servers', () => {
        // a third-party iframe inside the embedded page
        assert.equal(shouldAddToken({ ...base,
            resourceType: 'subFrame',
            frameIsTop: false,
            frameUrl: 'https://ads.example/frame' }), false);
        assert.equal(shouldAddToken({ ...base,
            headers: { Referer: 'https://ads.example/' } }), false);
        assert.equal(shouldAddToken({ ...base,
            resourceType: 'subFrame',
            headers: { 'Sec-Fetch-Dest': 'iframe',
                'Sec-Fetch-Mode': 'navigate',
                Referer: 'https://ads.example/' } }), false);
        assert.equal(shouldAddToken({ ...base,
            resourceType: 'subFrame',
            headers: {} }), false);
        assert.equal(shouldAddToken({ ...base,
            resourceType: 'script',
            headers: { 'Sec-Fetch-Dest': 'iframe',
                'Sec-Fetch-Mode': 'navigate' } }), false);
        assert.equal(shouldAddToken({ ...base }), false);

        // the launcher window, an unknown meeting window, a file:// page that is not the top frame
        assert.equal(shouldAddToken({ ...base,
            webContentsId: 3,
            frameUrl: `${ORIGIN}/` }), false);
        assert.equal(shouldAddToken({ ...base,
            meetingWebContentsId: undefined,
            frameUrl: `${ORIGIN}/` }), false);
        assert.equal(shouldAddToken({ ...base,
            resourceType: 'subFrame',
            frameIsTop: false,
            frameUrl: 'file:///x/meeting.html' }), false);

        // an origin that is not ours, even if it looks like one
        assert.equal(shouldAddToken({ ...base,
            url: `${OTHER}/x`,
            frameUrl: `${OTHER}/` }), false);
        assert.equal(shouldAddToken({ ...base,
            url: 'https://meet.example.com/x',
            frameUrl: `${ORIGIN}/` }), false);
        assert.equal(shouldAddToken({ ...base,
            url: 'not a url' }), false);
    });
});

describe('decideLoopbackPermission', () => {
    it('grants only the meeting window\'s embedded origin', () => {
        assert.equal(decideLoopbackPermission(`${ORIGIN}/room`, 7, 7, isEmbedded), true);
    });

    it('denies every other page on this machine', () => {
        for (const url of [ `${OTHER}/`, 'http://127.0.0.1:8080/', 'http://127.0.0.2/', 'http://localhost:3000/',
            'http://foo.localhost:5000/', 'http://0.0.0.0/', 'http://[::1]:5000/' ]) {
            assert.equal(decideLoopbackPermission(url, 7, 7, isEmbedded), false, url);
        }
        assert.equal(decideLoopbackPermission(`${ORIGIN}/`, 8, 7, isEmbedded), false);
        assert.equal(decideLoopbackPermission(`${ORIGIN}/`, 7, undefined, isEmbedded), false);
    });

    it('leaves remote and unparsable pages to the caller', () => {
        assert.equal(decideLoopbackPermission('https://meet.example.com/', 7, 7, isEmbedded), undefined);
        assert.equal(decideLoopbackPermission('file:///a/b.html', 7, 7, isEmbedded), undefined);
        assert.equal(decideLoopbackPermission('', 7, 7, isEmbedded), undefined);
    });
});

describe('isTrustedAppSender', () => {
    const ok = { isExpectedWebContents: true,
        hasFrame: true,
        parentIsNull: true,
        frameUrl: 'file:///app/meeting.html' };

    it('accepts the main frame of the expected window loaded from file://', () => {
        assert.equal(isTrustedAppSender(ok), true);
    });

    it('rejects other windows, missing or child frames and web pages', () => {
        assert.equal(isTrustedAppSender({ ...ok,
            isExpectedWebContents: false }), false);
        assert.equal(isTrustedAppSender({ ...ok,
            hasFrame: false }), false);
        assert.equal(isTrustedAppSender({ ...ok,
            parentIsNull: false }), false);
        assert.equal(isTrustedAppSender({ ...ok,
            frameUrl: ORIGIN }), false);
        assert.equal(isTrustedAppSender({ ...ok,
            frameUrl: undefined }), false);
    });
});
