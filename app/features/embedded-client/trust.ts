import { isLoopback } from './hosts';

/**
 * The trust decisions of the Electron glue as pure functions (no Electron imports),
 * so they can be unit tested.
 */

export interface ITokenRequest {

    /** Whether the initiating frame is the top frame of the meeting window. */
    frameIsTop?: boolean;

    /** URL of the frame that initiated the request, if known. */
    frameUrl?: string;

    /** Request headers (any case). */
    headers: Record<string, string>;

    /** The origin of the embedded server the request goes to must be one of ours. */
    isEmbeddedOrigin: (origin: string) => boolean;

    meetingWebContentsId?: number;

    /** Electron's resource type (`subFrame`, `script`, `webSocket`, ...). */
    resourceType?: string;

    url: string;

    webContentsId?: number;
}

/**
 * Safe origin of a URL, or '' when it has none.
 *
 * @param {string|undefined} url - A URL.
 * @returns {string}
 */
function originOf(url: string | undefined): string {
    try {
        const { origin } = new URL(url ?? '');

        return origin === 'null' ? '' : origin;
    } catch {
        return '';
    }
}

/**
 * Whether the per-launch token may be added to a request. Only requests of the meeting
 * window to one of our embedded origins qualify, and only if they come from the app page
 * (loading the iframe) or from the embedded origin itself (its scripts, workers, sockets):
 * a third-party frame inside the page does not get it.
 *
 * @param {ITokenRequest} request - The request.
 * @returns {boolean}
 */
export function shouldAddToken(request: ITokenRequest): boolean {
    if (typeof request.meetingWebContentsId !== 'number' || request.webContentsId !== request.meetingWebContentsId) {
        return false;
    }

    let target: URL;

    try {
        target = new URL(request.url);
    } catch {
        return false;
    }
    if ((target.protocol !== 'http:' && target.protocol !== 'ws:') || !target.hostname.endsWith('.localhost')
            || !request.isEmbeddedOrigin(`http://${target.host}`)) {
        return false;
    }

    const origin = `http://${target.host}`;
    const headers = Object.fromEntries(Object.entries(request.headers).map(([ k, v ]) => [ k.toLowerCase(), v ]));

    // The iframe load itself: Electron reports no initiating frame for navigations, so it is
    // recognised by what the app page's iframe request looks like (an iframe navigation that
    // carries no Referer, since a file:// page sends none). A frame with a Referer from any
    // other origin is a third party and gets nothing.
    const isIframeNavigation = request.resourceType === 'subFrame' && headers['sec-fetch-dest'] === 'iframe'
        && headers['sec-fetch-mode'] === 'navigate' && !headers.referer && !headers.origin;

    if (isIframeNavigation || (request.resourceType === 'subFrame' && request.frameIsTop
            && request.frameUrl?.startsWith('file://'))) {
        return true;
    }

    return originOf(request.frameUrl) === origin || headers.origin === origin
        || originOf(headers.referer) === origin;
}

/**
 * The permission verdict for a page on this machine. Loopback pages are only trusted when
 * they are an embedded origin loaded by the meeting window.
 *
 * @param {string} requestingUrl - The URL asking for the permission.
 * @param {number|undefined} webContentsId - The asking web contents.
 * @param {number|undefined} meetingWebContentsId - The meeting window's web contents.
 * @param {Function} isEmbeddedOrigin - Whether an origin is one of our embedded origins.
 * @returns {boolean|undefined} A verdict, or undefined if the page is not on this machine.
 */
export function decideLoopbackPermission(
        requestingUrl: string,
        webContentsId: number | undefined,
        meetingWebContentsId: number | undefined,
        isEmbeddedOrigin: (origin: string) => boolean
): boolean | undefined {
    let parsed: URL;

    try {
        parsed = new URL(requestingUrl);
    } catch {
        return undefined;
    }
    if (!isLoopback(parsed.hostname)) {
        return undefined;
    }

    return typeof meetingWebContentsId === 'number' && webContentsId === meetingWebContentsId
        && isEmbeddedOrigin(parsed.origin);
}

/**
 * Whether an IPC call comes from the app's own page: the main frame of the expected
 * window, loaded from the packaged app (file://), never from a frame of the Jitsi page.
 *
 * @param {Object} sender - What Electron tells about the sender.
 * @param {boolean} sender.isExpectedWebContents - Whether `event.sender` is the window's web contents.
 * @param {boolean} sender.hasFrame - Whether `event.senderFrame` exists.
 * @param {boolean} sender.parentIsNull - Whether that frame is the main frame.
 * @param {string|undefined} sender.frameUrl - The frame's URL.
 * @returns {boolean}
 */
export function isTrustedAppSender(sender: {
    frameUrl?: string;
    hasFrame: boolean;
    isExpectedWebContents: boolean;
    parentIsNull: boolean;
}): boolean {
    return sender.isExpectedWebContents && sender.hasFrame && sender.parentIsNull
        && Boolean(sender.frameUrl?.startsWith('file://'));
}
