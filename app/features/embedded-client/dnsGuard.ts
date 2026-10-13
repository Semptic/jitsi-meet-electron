import * as dns from 'node:dns';
import * as https from 'node:https';

import { isNonPublicIP } from './hosts';

/**
 * A `lookup` for outgoing connections that refuses hosts resolving to loopback,
 * private, link-local or unspecified addresses (DNS rebinding / SSRF into the local
 * network), whatever name the upstream has. All returned addresses must be public.
 *
 * @param {string} hostname - Host to resolve.
 * @param {Object} options - dns.lookup options.
 * @param {Function} callback - Node's lookup callback.
 * @returns {void}
 */
export function guardedLookup(
        hostname: string,
        options: dns.LookupOptions,
        callback: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void
): void {
    dns.lookup(hostname, { ...options,
        all: true }, (error, addresses) => {
        if (error) {
            callback(error);

            return;
        }

        const list = addresses as dns.LookupAddress[];

        if (!list.length || list.some(({ address }) => isNonPublicIP(address.toLowerCase()))) {
            const refused: NodeJS.ErrnoException = new Error('upstream resolves to a non-public address');

            refused.code = 'EUPSTREAMFORBIDDEN';
            callback(refused);

            return;
        }

        if (options.all) {
            callback(null, list);
        } else {
            callback(null, list[0].address, list[0].family);
        }
    });
}

/**
 * Creates the https agent of an upstream, with the DNS guard.
 *
 * @returns {https.Agent}
 */
export function createGuardedAgent(): https.Agent {
    return new https.Agent({ keepAlive: true,
        lookup: guardedLookup as AgentLookup });
}

type AgentLookup = NonNullable<https.AgentOptions['lookup']>;
