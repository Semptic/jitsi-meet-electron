/**
 * The value of the {@code scope} field on every postMessage exchanged between
 * the Jitsi Meet iframe and the meeting window for multitrack recording.
 */
export const MULTITRACK_SCOPE = 'jitsi-multitrack-recording';

/**
 * The version of the iframe protocol; bump on incompatible changes.
 */
export const MULTITRACK_PROTOCOL_VERSION = 1;

/**
 * The iframe -> meeting window request methods.
 */
export const MULTITRACK_METHODS = [
    'hello',
    'chooseDirectory',
    'openFile',
    'write',
    'close',
    'abort'
] as const;

export type MultitrackMethod = typeof MULTITRACK_METHODS[number];

/**
 * The IPC channels (meeting window -> main process, {@code ipcRenderer.invoke}).
 */
export const MULTITRACK_CHANNELS = {
    chooseDirectory: 'multitrack:choose-directory',
    openFile: 'multitrack:open-file',
    write: 'multitrack:write',
    close: 'multitrack:close',
    abort: 'multitrack:abort'
} as const;

/**
 * Only these extensions may be written, so a compromised page cannot drop
 * something executable (.command, .app, .sh, ...) into the chosen folder.
 */
export const ALLOWED_EXTENSIONS = [ '.wav', '.json', '.txt' ];

/**
 * The largest single chunk accepted by a write call.
 */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * The largest file that can be written (WAV is limited to 4 GiB anyway).
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Upper bounds on simultaneously open resources per window.
 */
export const MAX_OPEN_FILES = 64;
export const MAX_DIRECTORIES = 8;
