# Multitrack recording bridge (iframe <-> Electron)

Lets the Jitsi Meet web client, running inside the conference iframe of this
app, write per-participant files (WAV) to a folder the user picks natively.

## Why a bridge

Measured in Electron 43.5 (Chromium 150) with the cross-origin conference iframe:

| Probe (inside the iframe)                     | Result |
|-----------------------------------------------|--------|
| `typeof showDirectoryPicker`                  | `function`, but calling it (with user activation) throws `SecurityError: Cross origin sub frames aren't allowed to show a file picker.` |
| OPFS `navigator.storage.getDirectory()` + `createWritable` (1 MiB) | works |
| OPFS in a Worker via `createSyncAccessHandle` | works |
| `AudioContext.audioWorklet.addModule(blobUrl)` + `AudioWorkletNode` | works |
| `MediaRecorder`, `isTypeSupported('audio/webm;codecs=opus')` | works / true |
| `<a download>` of an OPFS-backed Blob            | saved silently to `~/Downloads/<name>` (no dialog, no folder choice) |
| `window.jitsiElectronApp` / `jitsiElectronSDK` in the iframe | `undefined` (preload does not run in the iframe) |

So the web client's recording pipeline (OPFS + AudioWorklet) works unchanged;
only the final "write to a folder" step needs the bridge below.

## Detecting Electron mode

The iframe's `navigator.userAgent` contains `Electron/`. Then confirm with the
handshake: post a `hello` request (see below). A reply with
`result.supported === true` means the bridge exists. Also, the host posts an
`event` named `supported` to the iframe whenever the iframe finishes loading
(it may arrive before your listener exists, so rely on `hello`). Time out the
`hello` after ~1s and treat that as "no bridge" (plain browser).

When the bridge is present, `showDirectoryPicker` and the
`!isEmbedded() || isEmbeddedFromSameDomain()` gate in `supportsMultitrackRecording`
must be bypassed: use the bridge instead of `showDirectoryPicker`.

## Protocol

Plain `postMessage` (structured clone, so `ArrayBuffer`s can be *transferred*;
this is why postis/JSON is not used here). All messages carry
`scope: 'jitsi-multitrack-recording'`.

Iframe -> host (`window.parent.postMessage(msg, '*', transferList)`):

```ts
{ scope, type: 'request', id: number, method: string, params?: object }
```

Host -> iframe (`window` `message` event, `event.data`):

```ts
{ scope, type: 'response', id, result: any }            // success (result is null for void)
{ scope, type: 'response', id, error: { message } }     // failure
{ scope, type: 'event', name: 'supported', version: 1 } // on iframe load
```

The host only answers messages whose `event.source` is the conference iframe
window and whose `event.origin` equals the origin of the iframe URL. Requests
from anything else are silently ignored (no response), so always use a timeout.

### Methods

| method            | params                                         | result |
|-------------------|------------------------------------------------|--------|
| `hello`           | none                                           | `{ supported: true, version: 1 }` |
| `chooseDirectory` | none (call from a user gesture; opens a native folder dialog with "New Folder") | `{ token, name } \| null` (null = cancelled). `token` is opaque; the real path is never revealed. Valid until the meeting window closes. |
| `openFile`        | `{ token, name }`                              | `{ fileId }` |
| `write`           | `{ fileId, data: ArrayBuffer, position?: number }` | `{ size }` (bytes in file) |
| `close`           | `{ fileId }`                                   | `null` |
| `abort`           | `{ fileId }`                                   | `null` (closes and deletes the partial file) |

Rules enforced by the main process:

- `name`: bare file name, <= 200 chars, no `/ \ : * ? " < > |` or control chars, must not start with `.` or end with `.`/space, extension must be `.wav`, `.json` or `.txt`.
- Files are created exclusively (`wx`): an existing file or symlink of that name makes `openFile` fail with `EEXIST`. Pick unique names (for example create a per-recording subfolder name into the names, or add a timestamp), do not rely on overwrite.
- `write` without `position` appends. `position` may be `<=` current size (used to patch the WAV header after streaming). Max chunk 16 MiB, max file 8 GiB, max 64 open files, max 8 directories per window.
- Operations on one file must be awaited one at a time (await each response before the next `write`).

### Streaming a large WAV without loading it into memory

```ts
const chunk = 4 * 1024 * 1024;
const { result: { fileId } } = await call('openFile', { token, name: 'alice.wav' });
await call('write', { fileId, data: placeholderHeader44 }, [ placeholderHeader44 ]);   // 44-byte header, sizes 0
const file = await opfsFileHandle.getFile();                                            // OPFS lane
for (let o = 0; o < file.size; o += chunk) {
    const buf = await file.slice(o, o + chunk).arrayBuffer();                           // one chunk in memory
    await call('write', { fileId, data: buf }, [ buf ]);                                // transferred, not copied
}
const header = realHeader44(file.size);                                                 // now sizes are known
await call('write', { fileId, data: header, position: 0 }, [ header ]);
await call('close', { fileId });
```

Memory stays at about one chunk (plus the host's copy across the context
bridge). On failure call `abort`.

### Minimal client helper

```ts
const SCOPE = 'jitsi-multitrack-recording';
let nextId = 0;

function call(method: string, params?: object, transfer: Transferable[] = [], timeoutMs = 0) {
    return new Promise<any>((resolve, reject) => {
        const id = ++nextId;
        const onMessage = (e: MessageEvent) => {
            const d = e.data;
            if (e.source === window.parent && d?.scope === SCOPE && d.type === 'response' && d.id === id) {
                window.removeEventListener('message', onMessage);
                timer && clearTimeout(timer);
                d.error ? reject(new Error(d.error.message)) : resolve(d.result);
            }
        };
        const timer = timeoutMs && setTimeout(() => { window.removeEventListener('message', onMessage); reject(new Error('timeout')); }, timeoutMs);
        window.addEventListener('message', onMessage);
        window.parent.postMessage({ scope: SCOPE, type: 'request', id, method, params }, '*', transfer);
    });
}
// detection: navigator.userAgent.includes('Electron/') && await call('hello', undefined, [], 1000).then(r => r.supported, () => false)
```

(`'*'` as target origin is fine: the parent is `file://` and only answers
after verifying the sender.) Only `chooseDirectory`, `write`, etc. results are
trusted from `e.source === window.parent`.

## Implementation (this repo)

- `app/features/multitrack-recording/renderer.ts` - relays iframe requests (origin + source checked) to the preload bridge; wired in `Conference.tsx`.
- `app/preload/preload.ts` - `window.jitsiElectronApp.multitrack.*` (`ipcRenderer.invoke`).
- `app/features/multitrack-recording/main.ts` - IPC handlers; only the main frame of the meeting window may call them (`event.sender` + `event.senderFrame.parent === null`).
- `app/features/multitrack-recording/fileNames.ts`, `constants.ts`.
- Test: `npm run test:multitrack` (real preload and renderer in Electron, folder dialog injected by the test harness only).

## Running against a local dev client

`main.ts` accepts invalid certificates only when the app is not packaged
(`electron-is-dev`), so use the dev start, not a packaged build:

```
JITSI_DEFAULT_SERVER=https://localhost:8080 npm start
```

(or set the server URL in the app settings). Then join a room; the client must
use the bridge as described above.

With the embedded client (see [embedded-client.md](embedded-client.md)) the iframe is served
from `http://127.0.0.1:<port>` of the app's own loopback server instead of the Jitsi server, and the
renderer then only trusts exactly that origin for the bridge.
