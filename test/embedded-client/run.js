/* eslint-disable no-console */
/* eslint-env node */

/**
 * Runs the embedded client tests under plain node (no Electron needed): the
 * server modules have no Electron imports. Every *.test.js is bundled with esbuild
 * (the modules under test are TypeScript) and executed with `node --test`.
 */

const { spawnSync } = require('child_process');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-client-test-'));
const entries = fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js'));

esbuild.buildSync({
    entryPoints: entries.map(name => path.join(__dirname, name)),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outdir: outDir
});

const result = spawnSync(process.execPath, [ '--test', ...entries.map(name => path.join(outDir, name)) ], {
    stdio: 'inherit',
    env: { ...process.env,
        EMBEDDED_TEST_ROOT: root }
});

fs.rmSync(outDir, { recursive: true,
    force: true });
process.exit(result.status ?? 1);
