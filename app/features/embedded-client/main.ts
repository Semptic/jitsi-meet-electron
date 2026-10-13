import { BrowserWindow, IpcMainInvokeEvent, ipcMain } from 'electron';
import log from 'electron-log';
import * as path from 'node:path';

import { RESOLVE_CHANNEL, TOKEN_HEADER } from './constants';
import { EmbeddedClientManager } from './manager';
import { decideLoopbackPermission, isTrustedAppSender, shouldAddToken } from './trust';

export interface IEmbeddedClientMain {

    /**
     * Adds the per-launch token to a request of the meeting window to an embedded server.
     * Returns the headers to send, or undefined when the request does not qualify.
     */
    addToken: (details: Electron.OnBeforeSendHeadersListenerDetails) => Record<string, string> | undefined;

    /**
     * Stops the servers.
     */
    close: () => Promise<void>;

    /**
     * Permission verdict for pages on this machine (undefined: not decided here).
     */
    decidesLoopbackPermission: (requestingUrl: string, webContentsId: number | undefined) => boolean | undefined;

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
        if (!meetingWindow || !isTrustedAppSender({
            isExpectedWebContents: event.sender === meetingWindow.webContents,
            hasFrame: Boolean(event.senderFrame),
            parentIsNull: event.senderFrame?.parent === null,
            frameUrl: event.senderFrame?.url
        })) {
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
        addToken(details) {
            const frame = details.frame;
            let frameUrl: string | undefined;
            let frameIsTop = false;

            try {
                frameUrl = frame?.url;
                frameIsTop = frame?.parent === null;
            } catch {
                // The frame is already gone: treat as unknown (no token).
            }

            const allowed = shouldAddToken({
                url: details.url,
                webContentsId: details.webContentsId,
                meetingWebContentsId: getMeetingWindow()?.webContents.id,
                resourceType: details.resourceType,
                frameUrl,
                frameIsTop,
                headers: details.requestHeaders,
                isEmbeddedOrigin: origin => manager.isEmbeddedOrigin(origin)
            });

            return allowed ? { ...details.requestHeaders,
                [TOKEN_HEADER]: manager.token } : undefined;
        },
        decidesLoopbackPermission: (requestingUrl, webContentsId) => decideLoopbackPermission(
            requestingUrl, webContentsId, getMeetingWindow()?.webContents.id,
            origin => manager.isEmbeddedOrigin(origin))
    };
}
