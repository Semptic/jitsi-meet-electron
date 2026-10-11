/* eslint-disable no-console */
/* eslint-env node */

/**
 * End-to-end test of the multitrack recording bridge in a real Electron.
 *
 * Usage: node test/multitrack/run.js   (after `node esbuild.js`, which builds
 * build/preload.js, build/app.js and build/meeting.html used by the harness).
 *
 * It bundles harness.js together with the real main-process module, then runs
 * it in Electron. The native folder dialog is replaced by an injected function
 * (test code only; the production main.ts never injects one).
 */

const { spawnSync } = require('child_process');
const electron = require('electron');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-e2e-'));
const outFile = path.join(outDir, 'harness.js');

esbuild.buildSync({
    entryPoints: [ path.join(__dirname, 'harness.js') ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: [ 'electron' ],
    outfile: outFile
});

const result = spawnSync(electron, [ outFile ], {
    stdio: 'inherit',
    env: { ...process.env,
        MULTITRACK_E2E_ROOT: root }
});

fs.rmSync(outDir, { recursive: true,
    force: true });
process.exit(result.status ?? 1);
