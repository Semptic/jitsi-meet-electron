import type JitsiMeetExternalAPI from '../conference/external_api';

import {
    MULTITRACK_METHODS,
    MULTITRACK_PROTOCOL_VERSION,
    MULTITRACK_SCOPE,
    MultitrackMethod
} from './constants';

interface IRequest {
    id: number;
    method: MultitrackMethod;
    params?: Record<string, unknown>;
    scope: string;
    type: 'request';
}

/**
 * Executes one request against the preload bridge.
 *
 * @param {MultitrackMethod} method - The method.
 * @param {Object} params - The request params.
 * @returns {Promise<unknown>} The result.
 */
async function execute(method: MultitrackMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    const bridge = window.jitsiElectronApp.multitrack;

    switch (method) {
    case 'hello':
        return {
            supported: true,
            version: MULTITRACK_PROTOCOL_VERSION
        };
    case 'chooseDirectory':
        return bridge.chooseDirectory();
    case 'openFile':
        return bridge.openFile(params.token as string, params.name as string);
    case 'write':
        if (!(params.data instanceof ArrayBuffer)) {
            throw new Error('data must be an ArrayBuffer');
        }

        return bridge.write(params.fileId as string, params.data, params.position as number | undefined);
    case 'close':
        return bridge.close(params.fileId as string);
    case 'abort':
        return bridge.abort(params.fileId as string);
    }
}

/**
 * Relays multitrack recording requests from the Jitsi Meet iframe to the main
 * process. The iframe cannot reach IPC itself (it is cross-origin and has no
 * preload), so it talks to this window with postMessage. Only messages that
 * come from the iframe's own window AND from the origin it was loaded from are
 * honoured; everything else is ignored.
 *
 * When the meeting loads from the embedded client server, `trustedOrigin` is that
 * server's origin and the iframe must be on exactly that origin; the bridge is
 * otherwise inert. Without it the origin of the iframe URL is used as before.
 *
 * @param {JitsiMeetExternalAPI} api - The iframe API object.
 * @param {string} trustedOrigin - The only origin allowed to use the bridge, if known.
 * @returns {void}
 */
export function setupMultitrackRecordingRender(api: JitsiMeetExternalAPI, trustedOrigin?: string) {
    const iframe: HTMLIFrameElement = api.getIFrame();

    /**
     * The origin of the iframe's page that may use the bridge (null: nobody).
     *
     * @returns {string|null}
     */
    const getIframeOrigin = (): string | null => {
        try {
            const origin = new URL(iframe.src).origin;

            return trustedOrigin && origin !== trustedOrigin ? null : origin;
        } catch {
            return null;
        }
    };

    const onMessage = async (event: MessageEvent) => {
        const data = event.data as IRequest | null;

        if (!data || typeof data !== 'object' || data.scope !== MULTITRACK_SCOPE || data.type !== 'request'
                || event.source !== iframe.contentWindow || !event.source) {
            return;
        }

        if (event.origin !== getIframeOrigin()) {
            return;
        }

        const reply = (body: Record<string, unknown>) => (event.source as Window).postMessage(
            { scope: MULTITRACK_SCOPE,
                type: 'response',
                id: data.id,
                ...body },
            event.origin
        );

        if (!MULTITRACK_METHODS.includes(data.method)) {
            reply({ error: { message: 'Unknown method' } });

            return;
        }

        try {
            reply({ result: await execute(data.method, data.params) ?? null });
        } catch (error) {
            reply({ error: { message: String((error as Error)?.message ?? error) } });
        }
    };

    window.addEventListener('message', onMessage);

    const announce = () => {
        const origin = getIframeOrigin();

        if (!origin) {
            return;
        }

        iframe.contentWindow?.postMessage(
            { scope: MULTITRACK_SCOPE,
                type: 'event',
                name: 'supported',
                version: MULTITRACK_PROTOCOL_VERSION },
            origin
        );
    };

    iframe.addEventListener('load', announce);

    const dispose = () => {
        window.removeEventListener('message', onMessage);
        iframe.removeEventListener('load', announce);
    };

    api.on('_willDispose', dispose);
    api.on('readyToClose', dispose);
}
