
import { normalizeServerURL } from '../utils';

import {
    SET_ALWAYS_ON_TOP_WINDOW_ENABLED,
    SET_DISABLE_AGC,
    SET_SERVER_TIMEOUT,
    SET_SERVER_URL,
    SET_USE_EMBEDDED_CLIENT
} from './actionTypes';


/**
 * Set Server URL.
 *
 * @param {string} serverURL - Server URL.
 * @returns {{
 *     type: SET_SERVER_URL,
 *     serverURL: ?string
 * }}
 */
export function setServerURL(serverURL: string) {
    return {
        type: SET_SERVER_URL,
        serverURL: normalizeServerURL(serverURL)
    };
}

/**
 * Set Server Timeout.
 *
 * @param {string} serverTimeout - Server Timeout.
 * @returns {{
 *     type: SET_SERVER_TIMEOUT,
 *     serverTimeout: ?number
 * }}
 */
export function setServerTimeout(serverTimeout?: number) {
    return {
        type: SET_SERVER_TIMEOUT,
        serverTimeout
    };
}

/**
 * Set disable AGC.
 *
 * @param {boolean} disableAGC - Whether to disable AGC.
 * @returns {{
 *     type: SET_DISABLE_AGC,
 *     disableAGC
 * }}
 */
export function setDisableAGC(disableAGC: boolean) {
    return {
        type: SET_DISABLE_AGC,
        disableAGC
    };
}

/**
 * Set window always on top.
 *
 * @param {boolean} alwaysOnTopWindowEnabled - Whether to set AlwaysOnTop Window Enabled.
 * @returns {{
 *     type: SET_ALWAYS_ON_TOP_WINDOW_ENABLED,
 *     alwaysOnTopWindowEnabled
 * }}
 */
export function setWindowAlwaysOnTop(alwaysOnTopWindowEnabled: boolean) {
    return {
        type: SET_ALWAYS_ON_TOP_WINDOW_ENABLED,
        alwaysOnTopWindowEnabled
    };
}

/**
 * Set whether the embedded web client is used.
 *
 * @param {boolean} useEmbeddedClient - Whether to use the embedded client.
 * @returns {{
 *     type: SET_USE_EMBEDDED_CLIENT,
 *     useEmbeddedClient
 * }}
 */
export function setUseEmbeddedClient(useEmbeddedClient: boolean) {
    return {
        type: SET_USE_EMBEDDED_CLIENT,
        useEmbeddedClient
    };
}
