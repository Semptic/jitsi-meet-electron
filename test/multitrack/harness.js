/* eslint-disable no-console */
/* eslint-env node */

const crypto = require('crypto');
const { BrowserWindow, app, net, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { setupMultitrackRecordingMain } = require('../../app/features/multitrack-recording/main');

const root = process.env.MULTITRACK_E2E_ROOT;
const SCOPE = 'jitsi-multitrack-recording';
const GOOD_ORIGIN = 'https://jitsi.test';
const OTHER_ORIGIN = 'https://evil.test';

// The page the conference iframe loads. Provides a promise based client.
const PAGE = `<!doctype html><title>t</title><script>
let nextId = 0;
window.mt = (method, params, transfer = []) => new Promise(resolve => {
    const id = ++nextId;
    const onMessage = e => {
        const d = e.data;
        if (d && d.scope === '${SCOPE}' && d.type === 'response' && d.id === id) {
            removeEventListener('message', onMessage);
            clearTimeout(timer);
            resolve(d);
        }
    };
    const timer = setTimeout(() => { removeEventListener('message', onMessage); resolve({ timeout: true }); }, 1500);
    addEventListener('message', onMessage);
    parent.postMessage({ scope: '${SCOPE}', type: 'request', id, method, params }, '*', transfer);
});
window.events = [];
addEventListener('message', e => { if (e.data && e.data.type === 'event') window.events.push(e.data); });
window.bytes = (n, seed) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = ((i * 31) + seed) % 256;
    return b;
};
</script>`;

let failures = 0;

/**
 * Records one assertion.
 *
 * @param {boolean} ok - Outcome.
 * @param {string} name - Description.
 * @returns {void}
 */
function check(ok, name) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) {
        failures++;
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Waits for the frame with the given origin to exist.
 *
 * @param {BrowserWindow} win - The meeting window.
 * @param {string} origin - The origin.
 * @returns {Promise<Electron.WebFrameMain>}
 */
async function waitForFrame(win, origin) {
    for (let i = 0; i < 100; i++) {
        const frame = win.webContents.mainFrame.framesInSubtree.find(f => f.url.startsWith(origin));

        if (frame) {
            await sleep(500);

            return frame;
        }
        await sleep(200);
    }
    throw new Error('iframe never loaded');
}

app.whenReady().then(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-out-'));
    const realDir = fs.realpathSync(dir);
    const outside = path.join(path.dirname(realDir), `${path.basename(realDir)}-outside.wav`);

    session.defaultSession.protocol.handle('https', req => {
        const { origin } = new URL(req.url);

        if (origin === GOOD_ORIGIN || origin === OTHER_ORIGIN) {
            return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
        }

        return net.fetch(req, { bypassCustomProtocolHandlers: true });
    });

    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(root, 'build/preload.js'),
            sandbox: true
        }
    });

    setupMultitrackRecordingMain(win, { chooseDirectory: () => Promise.resolve(dir) });
    await win.loadFile(path.join(root, 'build/meeting.html'));
    win.webContents.send('navigate-to-conference', { room: 'probe',
        serverURL: GOOD_ORIGIN });

    const frame = await waitForFrame(win, GOOD_ORIGIN);
    const run = code => frame.executeJavaScript(code);

    // hello / announce
    check(await run('events.length') >= 1 && await run('events[0].name') === 'supported', 'host announces support');
    let r = await run('mt("hello")');

    check(r.result && r.result.supported === true && r.result.version === 1, 'hello answered');

    // choose directory returns a token + name, never a path
    r = await run('mt("chooseDirectory")');
    check(r.result && typeof r.result.token === 'string' && !JSON.stringify(r).includes(realDir),
        'chooseDirectory returns opaque token');
    const { token } = r.result;

    // multi-chunk write with a header patch at position 0
    r = await run(`mt("openFile", { token: ${JSON.stringify(token)}, name: "alice.wav" })`);
    check(Boolean(r.result && r.result.fileId), 'openFile');
    const { fileId } = r.result;
    const chunk = 4 * 1024 * 1024;
    const expected = [];

    for (let i = 0; i < 4; i++) {
        const w = await run(`(async () => {
            const b = bytes(${chunk}, ${i});

            return mt("write", { fileId: ${JSON.stringify(fileId)}, data: b.buffer }, [ b.buffer ]);
        })()`);

        check(w.result && w.result.size === (i + 1) * chunk, `write chunk ${i} (size ${w.result && w.result.size})`);
        expected.push(await run(`Array.from(bytes(${chunk}, ${i}).subarray(0, 8))`));
    }
    r = await run(`(async () => {
        const b = new Uint8Array([ 82, 73, 70, 70 ]);

        return mt("write", { fileId: ${JSON.stringify(fileId)}, data: b.buffer, position: 0 }, [ b.buffer ]);
    })()`);
    check(r.result && r.result.size === 4 * chunk, 'header patch at position 0 keeps size');
    r = await run(`mt("close", { fileId: ${JSON.stringify(fileId)} })`);
    check(r.result === null, 'close');

    const onDisk = fs.readFileSync(path.join(dir, 'alice.wav'));
    const want = Buffer.alloc(4 * chunk);

    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < chunk; j++) {
            want[(i * chunk) + j] = ((j * 31) + i) % 256;
        }
    }
    want.set([ 82, 73, 70, 70 ], 0);
    check(onDisk.length === want.length && crypto.createHash('sha256').update(onDisk)
.digest('hex')
        === crypto.createHash('sha256').update(want)
.digest('hex'), 'bytes on disk match (16 MiB, 4 chunks + patch)');

    // rejections
    const bad = async (label, method, params) => {
        const res = await run(`mt(${JSON.stringify(method)}, ${JSON.stringify(params)})`);

        check(Boolean(res.error), `rejected: ${label}`);
    };
    const t = { token };

    const badNames = [ '../escape.wav', 'a/b.wav', '..\\x.wav', '.hidden.wav', 'x.sh', 'x.command', '', '..',
        'x.wav\u0000.sh', 'alice.wav' ];

    for (const name of badNames) {
        await bad(`openFile ${JSON.stringify(name)}`, 'openFile', { ...t,
            name });
    }
    await bad('unknown token', 'openFile', { token: 'nope',
        name: 'b.wav' });
    await bad('write to unknown file', 'write', { fileId: 'nope',
        data: new ArrayBuffer(1) });
    r = await run(`mt("openFile", { token: ${JSON.stringify(token)}, name: "bob.wav" })`);
    const bob = r.result.fileId;

    await bad('position beyond end', 'write', { fileId: bob,
        data: new ArrayBuffer(1),
        position: 10 });
    await bad('chunk over 16 MiB', 'write', { fileId: bob,
        data: new ArrayBuffer((16 * 1024 * 1024) + 1) });
    await bad('data not an ArrayBuffer', 'write', { fileId: bob,
        data: 'abc' });
    await bad('unknown method', 'rm -rf', {});
    r = await run(`mt("abort", { fileId: ${JSON.stringify(bob)} })`);
    check(r.result === null && !fs.existsSync(path.join(dir, 'bob.wav')), 'abort removes partial file');
    check(!fs.existsSync(outside) && fs.readdirSync(dir).join() === 'alice.wav',
        'nothing written outside / only alice.wav exists');
    fs.symlinkSync('/etc/hosts', path.join(dir, 'link.wav'));
    await bad('existing symlink not followed', 'openFile', { ...t,
        name: 'link.wav' });

    // origin checks: the iframe navigates itself to another origin
    await run(`location.href = ${JSON.stringify(OTHER_ORIGIN)}`);
    const evil = await waitForFrame(win, OTHER_ORIGIN);

    r = await evil.executeJavaScript('mt("hello")');
    check(r.timeout === true, 'request from a different origin is ignored');

    // a request from the meeting window itself (not the iframe) is ignored
    r = await win.webContents.executeJavaScript(`new Promise(res => {
        addEventListener('message', e => { if (e.data && e.data.type === 'response') res('answered'); });
        postMessage({ scope: '${SCOPE}', type: 'request', id: 1, method: 'hello' }, '*');
        setTimeout(() => res('ignored'), 1000);
    })`);
    check(r === 'ignored', 'request not coming from the iframe is ignored');

    // main process rejects other senders
    const other = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true,
            preload: path.join(root, 'build/preload.js'),
            sandbox: true }
    });

    await other.loadURL('data:text/html,x');
    r = await other.webContents.executeJavaScript(
        'window.jitsiElectronApp.multitrack.chooseDirectory().then(() => "accepted", e => String(e))'
    );
    check(/untrusted sender/.test(r), `IPC from another window rejected (${r.slice(-40)})`);

    fs.rmSync(dir, { recursive: true,
        force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    app.exit(failures ? 1 : 0);
})
.catch(error => {
    console.error(error);
    app.exit(2);
});
