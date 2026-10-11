import { randomUUID } from 'crypto';
import { BrowserWindow, IpcMainInvokeEvent, dialog, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';

import {
    MAX_CHUNK_BYTES,
    MAX_DIRECTORIES,
    MAX_FILE_BYTES,
    MAX_OPEN_FILES,
    MULTITRACK_CHANNELS
} from './constants';
import { validateFileName } from './fileNames';

export interface IMultitrackMainOptions {

    /**
     * Shows the folder chooser; resolves to the chosen folder or undefined when
     * cancelled. Defaults to a native dialog. Injectable for tests only.
     */
    chooseDirectory?: (window: BrowserWindow) => Promise<string | undefined>;
}

interface IOpenFile {
    handle: fs.FileHandle;
    path: string;
    size: number;
}

/**
 * Registers the multitrack recording IPC handlers for the window that hosts
 * the conference iframe. Returns a function that removes them again.
 *
 * Trust model: the handlers accept calls only from the main frame of the given
 * window (the app's own renderer; the Jitsi iframe has no preload and cannot
 * reach IPC). The renderer relays iframe requests only after checking the
 * iframe's origin. Even so, the main process never exposes a path: all writes
 * go to a bare allow-listed file name, exclusively created inside a folder the
 * user picked in a native dialog.
 *
 * @param {BrowserWindow} window - The meeting window.
 * @param {IMultitrackMainOptions} options - Options.
 * @returns {Function} Teardown.
 */
export function setupMultitrackRecordingMain(window: BrowserWindow, options: IMultitrackMainOptions = {}) {
    const { webContents } = window;
    const directories = new Map<string, string>();
    const files = new Map<string, IOpenFile>();

    const chooseDirectory = options.chooseDirectory ?? (async win => {
        const result = await dialog.showOpenDialog(win, {
            properties: [ 'openDirectory', 'createDirectory' ]
        });

        return result.canceled ? undefined : result.filePaths[0];
    });

    const assertTrusted = (event: IpcMainInvokeEvent) => {
        if (event.sender !== webContents || !event.senderFrame || event.senderFrame.parent !== null) {
            throw new Error('Rejected IPC from an untrusted sender');
        }
    };

    const getFile = (id: unknown) => {
        const file = typeof id === 'string' ? files.get(id) : undefined;

        if (!file) {
            throw new Error('Unknown file');
        }

        return file;
    };

    const closeFile = async (id: string, remove: boolean) => {
        const file = getFile(id);

        files.delete(id);
        try {
            await file.handle.close();
        } finally {
            if (remove) {
                await fs.unlink(file.path).catch(() => undefined);
            }
        }
    };

    ipcMain.handle(MULTITRACK_CHANNELS.chooseDirectory, async event => {
        assertTrusted(event);

        const chosen = await chooseDirectory(window);

        if (!chosen) {
            return null;
        }
        if (directories.size >= MAX_DIRECTORIES) {
            throw new Error('Too many directories');
        }

        // Resolve symlinks once, so later writes cannot be redirected.
        const real = await fs.realpath(chosen);

        if (!(await fs.stat(real)).isDirectory()) {
            throw new Error('Not a directory');
        }

        const token = randomUUID();

        directories.set(token, real);

        return { token, name: path.basename(real) };
    });

    ipcMain.handle(MULTITRACK_CHANNELS.openFile, async (event, token: unknown, name: unknown) => {
        assertTrusted(event);

        const dir = typeof token === 'string' ? directories.get(token) : undefined;

        if (!dir) {
            throw new Error('Unknown directory token');
        }
        if (files.size >= MAX_OPEN_FILES) {
            throw new Error('Too many open files');
        }

        const filePath = path.join(dir, validateFileName(name));

        if (path.dirname(filePath) !== dir) {
            throw new Error('Invalid file name');
        }

        // 'wx': create exclusively, never overwrite, never follow a symlink.
        const handle = await fs.open(filePath, 'wx', 0o644);
        const id = randomUUID();

        files.set(id, { handle,
            path: filePath,
            size: 0 });

        return { fileId: id };
    });

    ipcMain.handle(MULTITRACK_CHANNELS.write,
        async (event, id: unknown, data: unknown, position?: unknown) => {
            assertTrusted(event);

            const file = getFile(id);

            if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) {
                throw new Error('Invalid data');
            }

            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            const at = position === undefined ? file.size : position;

            if (bytes.byteLength > MAX_CHUNK_BYTES) {
                throw new Error('Chunk too large');
            }
            if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at > file.size
                    || at + bytes.byteLength > MAX_FILE_BYTES) {
                throw new Error('Invalid position');
            }

            const { bytesWritten } = await file.handle.write(bytes, 0, bytes.byteLength, at);

            file.size = Math.max(file.size, at + bytesWritten);

            return { size: file.size };
        });

    ipcMain.handle(MULTITRACK_CHANNELS.close, async (event, id: unknown) => {
        assertTrusted(event);
        await closeFile(id as string, false);
    });

    ipcMain.handle(MULTITRACK_CHANNELS.abort, async (event, id: unknown) => {
        assertTrusted(event);
        await closeFile(id as string, true);
    });

    const teardown = () => {
        Object.values(MULTITRACK_CHANNELS).forEach(channel => ipcMain.removeHandler(channel));
        files.forEach(file => file.handle.close().catch(() => undefined));
        files.clear();
        directories.clear();
    };

    window.once('closed', teardown);

    return teardown;
}
