import { createHash } from 'node:crypto';
import * as net from 'node:net';

/**
 * Host classification shared by the upstream validation, the DNS guard and the
 * permission rule. Pure, no Electron imports.
 */

/**
 * Normalizes a hostname: lower case, no brackets, no trailing dots.
 *
 * @param {string} hostname - A URL hostname (IPv6 literals in brackets).
 * @returns {string}
 */
export function normalizeHostname(hostname: string): string {
    return hostname.toLowerCase().replace(/^\[|\]$/g, '')
        .replace(/\.+$/, '');
}

/**
 * Decodes the IPv4 address embedded in an IPv4-mapped / compatible IPv6 address.
 *
 * @param {string} ip - A normalized IPv6 literal.
 * @returns {string|null} Dotted IPv4, or null.
 */
function mappedIPv4(ip: string): string | null {
    const dotted = /^(?:0{0,4}:){0,5}(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(ip);

    if (dotted) {
        return dotted[1];
    }

    // URL normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1.
    const hex = /^(?:0{0,4}:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);

    if (hex) {
        const hi = parseInt(hex[1], 16);
        const lo = parseInt(hex[2], 16);

        // eslint-disable-next-line no-bitwise
        return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }

    return null;
}

/**
 * Whether an IP literal is loopback, private, link-local, unspecified or otherwise
 * not a public address.
 *
 * @param {string} ip - A normalized IP literal.
 * @returns {boolean}
 */
export function isNonPublicIP(ip: string): boolean {
    const family = net.isIP(ip);

    if (family === 4) {
        const [ a, b ] = ip.split('.').map(Number);

        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    if (family === 6) {
        const mapped = mappedIPv4(ip);

        if (mapped) {
            return isNonPublicIP(mapped);
        }

        const first = parseInt(ip.split(':')[0] || '0', 16);

        return ip === '::' || ip === '::1' || (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf);
    }

    return false;
}

/**
 * Whether a hostname refers to this machine: localhost, *.localhost, 127/8, ::1, 0.0.0.0, ::.
 *
 * @param {string} hostname - A URL hostname.
 * @returns {boolean}
 */
export function isLoopback(hostname: string): boolean {
    const host = normalizeHostname(hostname);

    if (host === 'localhost' || host.endsWith('.localhost')) {
        return true;
    }

    const ip = net.isIP(host) === 6 ? (mappedIPv4(host) ?? host) : host;

    return ip === '::1' || ip === '::' || ip === '0.0.0.0' || (net.isIP(ip) === 4 && ip.startsWith('127.'));
}

/**
 * Whether a hostname must never be an upstream (loopback by name, or a non-public IP literal).
 *
 * @param {string} hostname - A URL hostname.
 * @returns {boolean}
 */
export function isForbiddenUpstreamHost(hostname: string): boolean {
    const host = normalizeHostname(hostname);

    return host === '' || isLoopback(host) || isNonPublicIP(host);
}

/**
 * The per-upstream host name of the embedded origin (`<hash>.localhost`). Every upstream
 * gets its own web origin, so cookies and storage cannot be shared between upstreams.
 *
 * @param {string} upstreamOrigin - The upstream origin.
 * @returns {string}
 */
export function embeddedHostName(upstreamOrigin: string): string {
    return `${createHash('sha256').update(upstreamOrigin)
        .digest('hex')
        .slice(0, 16)}.localhost`;
}

/**
 * Whether an origin looks like an embedded origin (`http://<16 hex>.localhost:<port>`).
 *
 * @param {string} origin - Origin.
 * @returns {boolean}
 */
export function isEmbeddedOriginShape(origin: string): boolean {
    return /^http:\/\/[0-9a-f]{16}\.localhost:\d{1,5}$/.test(origin);
}
