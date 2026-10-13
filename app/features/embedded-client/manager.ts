import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BUNDLE_MARKER, MAX_REMEMBERED_PORTS, MAX_SERVERS } from './constants';
import { embeddedHostName } from './hosts';
import { parseUpstream } from './routing';
import { IEmbeddedServer, createEmbeddedServer } from './server';

/**
 * No Electron imports: shared by the main process and the node tests.
 */

export interface IEmbeddedClientManagerOptions {

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
     * File remembering the port of the most recent upstreams (by the hash in their embedded
     * host name, no server names), so the web origin and the client's storage survive restarts.
     */
    portStorePath?: string;

    /**
     * Permit loopback upstreams and skip the DNS guard (tests only; the app never sets it).
     */
    unsafeAllowLoopbackForTests?: boolean;
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
    private readonly runningPorts = new Set<number>();
    private ports: Record<string, { port: number; used: number; }> | undefined;

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
        const upstream = parseUpstream(serverURL, this.options.unsafeAllowLoopbackForTests);

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
        this.runningPorts.clear();
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
        const key = embeddedHostName(upstreamOrigin).replace('.localhost', '');
        const remembered = ports[key]?.port;
        const taken = [ ...this.runningPorts ];

        // A remembered port that another running server holds is never contested.
        const server = await createEmbeddedServer({
            bundleDir: this.options.bundleDir,
            onLog: this.options.onLog,
            preferredPort: remembered && !taken.includes(remembered) ? remembered : undefined,
            token: this.token,
            unsafeAllowLoopbackForTests: this.options.unsafeAllowLoopbackForTests,
            upstreamOrigin
        });

        this.origins.add(server.origin);
        this.runningPorts.add(server.port);
        ports[key] = { port: server.port,
            used: Date.now() };
        this.writePorts(ports);

        return server;
    }

    /**
     * Reads the remembered ports (best effort).
     *
     * @returns {Record<string, { port: number, used: number }>}
     */
    private readPorts(): Record<string, { port: number; used: number; }> {
        if (!this.ports) {
            this.ports = {};
            try {
                const parsed = JSON.parse(fs.readFileSync(this.options.portStorePath ?? '', 'utf8'));

                for (const [ key, value ] of Object.entries<{ port?: unknown; used?: unknown; }>(parsed)) {
                    const { port, used } = value ?? {};

                    if (/^[0-9a-f]{16}$/.test(key) && Number.isInteger(port) && (port as number) > 1023
                            && (port as number) < 65536) {
                        this.ports[key] = { port: port as number,
                            used: typeof used === 'number' ? used : 0 };
                    }
                }
            } catch {
                // No store yet, or unreadable: start from scratch.
            }
        }

        return this.ports;
    }

    /**
     * Persists the ports, keeping only the most recently used ones (best effort).
     *
     * @param {Record<string, { port: number, used: number }>} ports - The ports by upstream hash.
     * @returns {void}
     */
    private writePorts(ports: Record<string, { port: number; used: number; }>) {
        const newest = Object.entries(ports).sort(([ , a ], [ , b ]) => b.used - a.used)
            .slice(0, MAX_REMEMBERED_PORTS);

        this.ports = Object.fromEntries(newest);
        if (!this.options.portStorePath) {
            return;
        }
        try {
            fs.writeFileSync(this.options.portStorePath, JSON.stringify(this.ports), { mode: 0o600 });
        } catch {
            // Not fatal: the origin merely changes next launch.
        }
    }
}
