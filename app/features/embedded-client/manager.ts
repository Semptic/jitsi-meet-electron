import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BUNDLE_MARKER, MAX_SERVERS } from './constants';
import { parseUpstream } from './routing';
import { IEmbeddedServer, createEmbeddedServer } from './server';

/**
 * No Electron imports: shared by the main process and the node tests.
 */

export interface IEmbeddedClientManagerOptions {

    /**
     * Permit loopback upstreams (tests only).
     */
    allowLoopbackUpstream?: boolean;

    /**
     * Absolute path of the bundled client.
     */
    bundleDir: string;

    /**
     * Maximum number of upstream servers.
     */
    maxServers?: number;

    onLog?: (line: string) => void;

    /**
     * File remembering the port of every upstream, so its web origin (and the
     * localStorage / OPFS data of the client below it) survives restarts.
     */
    portStorePath?: string;
}

/**
 * Owns one embedded server per upstream origin and the per-launch token.
 *
 * One listener per upstream keeps the Host/Origin checks and the forwarding
 * allow list exact, and gives each Jitsi server its own web origin, so servers
 * cannot read each other's storage.
 */
export class EmbeddedClientManager {
    readonly token = randomBytes(32).toString('hex');

    private readonly servers = new Map<string, Promise<IEmbeddedServer>>();
    private readonly origins = new Set<string>();
    private ports: Record<string, number> | undefined;

    /**
     * Creates the manager.
     *
     * @param {IEmbeddedClientManagerOptions} options - Options.
     */
    constructor(private readonly options: IEmbeddedClientManagerOptions) {}

    /**
     * Whether the client bundle is present, i.e. the embedded client can be offered.
     *
     * @returns {boolean}
     */
    isAvailable(): boolean {
        return fs.existsSync(path.join(this.options.bundleDir, BUNDLE_MARKER));
    }

    /**
     * Whether the origin is one of this manager's servers.
     *
     * @param {string} origin - An origin such as http://127.0.0.1:1234.
     * @returns {boolean}
     */
    isEmbeddedOrigin(origin: string): boolean {
        return this.origins.has(origin);
    }

    /**
     * Returns the embedded origin that serves the given Jitsi server, starting
     * its listener on first use.
     *
     * @param {unknown} serverURL - The Jitsi server URL from the settings or a deep link.
     * @returns {Promise<{ origin: string }|null>} Null when the embedded client cannot be used.
     */
    async resolve(serverURL: unknown): Promise<{ origin: string; } | null> {
        const upstream = parseUpstream(serverURL, this.options.allowLoopbackUpstream);

        if (!upstream || !this.isAvailable()) {
            return null;
        }

        let pending = this.servers.get(upstream);

        if (!pending) {
            if (this.servers.size >= (this.options.maxServers ?? MAX_SERVERS)) {
                return null;
            }
            pending = this.start(upstream);
            this.servers.set(upstream, pending);
            pending.catch(() => this.servers.delete(upstream));
        }

        const server = await pending;

        return { origin: server.origin };
    }

    /**
     * Stops every server.
     *
     * @returns {Promise<void>}
     */
    async close(): Promise<void> {
        const running = [ ...this.servers.values() ];

        this.servers.clear();
        this.origins.clear();
        await Promise.all(running.map(async pending => (await pending.catch(() => undefined))?.close()));
    }

    /**
     * Starts the server of one upstream.
     *
     * @param {string} upstreamOrigin - The upstream origin.
     * @returns {Promise<IEmbeddedServer>}
     */
    private async start(upstreamOrigin: string): Promise<IEmbeddedServer> {
        const ports = this.readPorts();
        const server = await createEmbeddedServer({
            bundleDir: this.options.bundleDir,
            onLog: this.options.onLog,
            preferredPort: ports[upstreamOrigin],
            token: this.token,
            upstreamOrigin
        });

        this.origins.add(server.origin);
        if (ports[upstreamOrigin] !== server.port) {
            ports[upstreamOrigin] = server.port;
            this.writePorts(ports);
        }

        return server;
    }

    /**
     * Reads the remembered ports (best effort).
     *
     * @returns {Record<string, number>}
     */
    private readPorts(): Record<string, number> {
        if (!this.ports) {
            this.ports = {};
            try {
                const parsed = JSON.parse(fs.readFileSync(this.options.portStorePath ?? '', 'utf8'));

                for (const [ key, value ] of Object.entries(parsed)) {
                    if (Number.isInteger(value) && (value as number) > 1023 && (value as number) < 65536) {
                        this.ports[key] = value as number;
                    }
                }
            } catch {
                // No store yet, or unreadable: start from scratch.
            }
        }

        return this.ports;
    }

    /**
     * Persists the ports (best effort).
     *
     * @param {Record<string, number>} ports - The ports by upstream origin.
     * @returns {void}
     */
    private writePorts(ports: Record<string, number>) {
        if (!this.options.portStorePath) {
            return;
        }
        try {
            fs.writeFileSync(this.options.portStorePath, JSON.stringify(ports));
        } catch {
            // Not fatal: the origin merely changes next launch.
        }
    }
}
