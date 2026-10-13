/* eslint-disable no-console */

/**
 * Packages the local "Jitsi Meet Multitrack" app for this Mac (arm64):
 *
 *   npm run dist:multitrack          builds the client bundle, the app and packages it
 *   npm run package:multitrack       the same without rebuilding the client bundle
 *
 * Result: dist-multitrack/mac-arm64/Jitsi Meet Multitrack.app
 *
 * The identity and defaults below are compiled into the bundles by esbuild.js
 * (they are read at build time only) and into the package by
 * electron-builder.multitrack.cjs.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
    ...process.env,
    JITSI_BUILD_APP_NAME: 'Jitsi Meet Multitrack',
    JITSI_BUILD_APP_ID: 'org.jitsi.jitsi-meet.multitrack',
    JITSI_BUILD_PROTOCOL: 'jitsi-meet-multitrack',
    JITSI_BUILD_DEFAULT_SERVER_URL: process.env.JITSI_BUILD_DEFAULT_SERVER_URL || 'https://meet.spurious-security.com',
    JITSI_BUILD_DISABLE_UPDATES: 'true'
};

/**
 * Runs a command in the repository root, failing the script if it fails.
 *
 * @param {string} cmd - Command.
 * @param {string[]} args - Arguments.
 * @returns {void}
 */
function run(cmd, args) {
    console.log(`$ ${cmd} ${args.join(' ')}`);
    const result = spawnSync(cmd, args, { cwd: root,
        env,
        stdio: 'inherit' });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

if (!fs.existsSync(path.join(root, 'client-bundle/libs/multitrack-worklet.min.js'))) {
    console.error('client-bundle/ is missing or has no multitrack worklet: run `npm run build:client` first.');
    process.exit(1);
}

run('npm', [ 'run', 'build' ]);
run('npx', [ 'electron-builder', '--mac', '--dir', '--arm64', '--config', 'electron-builder.multitrack.cjs' ]);
