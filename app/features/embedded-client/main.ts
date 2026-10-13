import { BrowserWindow, IpcMainInvokeEvent, ipcMain } from 'electron';
import log from 'electron-log';
import * as path from 'node:path';

import { LOOPBACK_HOST, RESOLVE_CHANNEL, TOKEN_HEADER } from './constants';
import { EmbeddedClientManager } from './manager';

export interface IEmbeddedClientMain {

    /**
     * Adds the per-launch token to a request of the meeting window to an embedded server.
     * Returns the headers to send, or undefined when the request is not for an embedded server.
     */
    addToken: (details: {
        requestHeaders: Record<string, string>;
        url: string;
        webContentsId?: number;
    }) => Record<string, string> | undefined;

    /**
     * Stops the servers.
     */
    close: () => Promise<void>;

    /**
     * Whether a permission request from the given page may be granted.
     * Pages on the loopback interface are only trusted when they are an embedded
     * origin loaded by the meeting window; everything else is not decided here.
     */
    decidesLoopbackPermission: (requestingUrl: string, webContentsId: number) => boolean | undefined;

    manager: EmbeddedClientManager;
}

/**
 * Wires the embedded client server into the main process.
 *
 * @param {Object} options - Options.
 * @param {string} options.bundleDir - Directory of the bundled client.
 * @param {Function} options.getMeetingWindow - Returns the meeting window, if open.
 * @param {string} options.userDataPath - The app's user data directory.
 * @returns {IEmbeddedClientMain}
 */
export function setupEmbeddedClientMain(options: {
    bundleDir: string;
    getMeetingWindow: () => BrowserWindow | null;
    userDataPath: string;
}): IEmbeddedClientMain {
    const { bundleDir, getMeetingWindow, userDataPath } = options;

    // Only the lifecycle goes to the log file; request lines never leave memory.
    const manager = new EmbeddedClientManager({
        bundleDir,
        portStorePath: path.join(userDataPath, 'embedded-client-ports.json'),
        onLog: line => {
            if (line.startsWith('proxy error')) {
                log.warn(`[embedded-client] ${line}`);
            }
        }
    });

    ipcMain.handle(RESOLVE_CHANNEL, async (event: IpcMainInvokeEvent, serverURL: unknown) => {
        const meetingWindow = getMeetingWindow();

        // Only the app's own page in the meeting window (never a frame of the
        // Jitsi iframe, which has no preload anyway) may open a server.
        if (!meetingWindow || event.sender !== meetingWindow.webContents || !event.senderFrame
                || event.senderFrame.parent !== null || !event.senderFrame.url.startsWith('file://')) {
            throw new Error('Rejected IPC from an untrusted sender');
        }

        try {
            return await manager.resolve(serverURL);
        } catch (error) {
            log.warn(`[embedded-client] could not start a server: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);

            return null;
        }
    });

    return {
        manager,
        close: () => manager.close(),
        addToken({ requestHeaders, url, webContentsId }) {
            const meetingWindow = getMeetingWindow();

            if (!meetingWindow || webContentsId !== meetingWindow.webContents.id) {
                return undefined;
            }

            let parsed: URL;

            try {
                parsed = new URL(url);
            } catch {
                return undefined;
            }

            if ((parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') || parsed.hostname !== LOOPBACK_HOST
                    || !manager.isEmbeddedOrigin(`http://${parsed.host}`)) {
                return undefined;
            }

            return { ...requestHeaders,
                [TOKEN_HEADER]: manager.token };
        },
        decidesLoopbackPermission(requestingUrl, webContentsId) {
            let parsed: URL;

            try {
                parsed = new URL(requestingUrl);
            } catch {
                return undefined;
            }

            if (parsed.hostname !== LOOPBACK_HOST && parsed.hostname !== 'localhost' && parsed.hostname !== '[::1]') {
                return undefined;
            }

            const meetingWindow = getMeetingWindow();

            return Boolean(meetingWindow) && webContentsId === meetingWindow!.webContents.id
                && parsed.hostname === LOOPBACK_HOST && manager.isEmbeddedOrigin(parsed.origin);
        }
    };
}
