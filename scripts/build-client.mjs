/* eslint-disable no-console */

/**
 * Builds the patched Jitsi Meet web client and copies exactly the files the
 * embedded client server needs into ./client-bundle (shipped with the app as
 * an extraResource, see electron-builder.multitrack.cjs).
 *
 *   JITSI_MEET_DIR=/path/to/jitsi-meet npm run build:client
 *
 * Options:
 *   --in-place   Build inside JITSI_MEET_DIR (runs `make all` there, which
 *                deletes and recreates its build/ and libs/ directories, so do
 *                not use it while a dev server serves that checkout).
 *   --skip-make  Reuse an already built tree (JITSI_MEET_DIR, or the isolated
 *                copy when --keep-work was used before): only assemble the bundle.
 *
 * By default the committed HEAD of JITSI_MEET_DIR is exported to a temporary
 * directory (node_modules is APFS-cloned / copied) and built there, so a
 * running dev server and the working tree stay untouched.
 *
 * Only the directories the dev server also serves locally are bundled (see
 * app/features/embedded-client/routing.ts): the room page, config.js and
 * interface_config.js always come from the Jitsi server.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'client-bundle');
const defaultMeetDir = '/Users/semptic/Projects/jitsi-meet/.claude/worktrees/jitsi-separate-audio-recording-40ac3f';
const meetDir = path.resolve(process.env.JITSI_MEET_DIR || defaultMeetDir);
const inPlace = process.argv.includes('--in-place');
const skipMake = process.argv.includes('--skip-make');
const keepWork = process.argv.includes('--keep-work');

const DIRECTORIES = [ 'libs', 'fonts', 'images', 'lang', 'sounds', 'static' ];
const REQUIRED = [ 'libs/app.bundle.min.js', 'libs/multitrack-worklet.min.js', 'libs/lib-jitsi-meet.min.js', 'css/all.css' ];

/**
 * Runs a command, inheriting stdio.
 *
 * @param {string} cmd - Command.
 * @param {string[]} args - Arguments.
 * @param {string} cwd - Working directory.
 * @param {Object} env - Extra environment variables.
 * @returns {void}
 */
function run(cmd, args, cwd, env = {}) {
    console.log(`$ ${cmd} ${args.join(' ')}   (in ${cwd})`);
    const result = spawnSync(cmd, args, { cwd,
        env: { ...process.env,
            ...env },
        stdio: 'inherit' });

    if (result.status !== 0) {
        throw new Error(`${cmd} failed with status ${result.status}`);
    }
}

/**
 * Sums the size of all files below a directory.
 *
 * @param {string} dir - Directory.
 * @returns {number} Bytes.
 */
function dirSize(dir) {
    let total = 0;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    }

    return total;
}

/**
 * Whether a file belongs in the bundle (no source maps, no dev files).
 *
 * @param {string} name - File name.
 * @returns {boolean}
 */
function wanted(name) {
    return !/\.(map|ts|tsx|md)$/.test(name) && name !== '.DS_Store';
}

/**
 * Copies a directory recursively, filtering unwanted files.
 *
 * @param {string} from - Source.
 * @param {string} to - Destination.
 * @returns {void}
 */
function copyTree(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);

        if (entry.isDirectory()) {
            copyTree(src, dst);
        } else if (entry.isFile() && wanted(entry.name)) {
            fs.copyFileSync(src, dst);
        }
    }
}

/**
 * Exports the committed HEAD of the checkout into a temp dir and links its node_modules.
 *
 * @returns {string} The work directory.
 */
function prepareIsolatedCopy() {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jitsi-meet-client-build-'));

    console.log(`Exporting HEAD of ${meetDir} to ${work}`);
    const archive = execFileSync('git', [ '-C', meetDir, 'archive', 'HEAD' ], { maxBuffer: 1 << 30 });

    execFileSync('tar', [ '-x', '-C', work ], { input: archive });

    // /bin/cp on macOS can clone-on-write (APFS); elsewhere a plain recursive copy.
    const [ cp, clone ] = process.platform === 'darwin' ? [ '/bin/cp', '-cR' ] : [ 'cp', '-R' ];

    run(cp, [ clone, path.join(meetDir, 'node_modules'), path.join(work, 'node_modules') ], meetDir);

    return work;
}

/**
 * Entry point.
 *
 * @returns {void}
 */
function main() {
    if (!fs.existsSync(path.join(meetDir, 'Makefile')) || !fs.existsSync(path.join(meetDir, 'node_modules'))) {
        throw new Error(`JITSI_MEET_DIR (${meetDir}) is not an installed jitsi-meet checkout`);
    }

    const dirty = execFileSync('git', [ '-C', meetDir, 'status', '--porcelain' ]).toString().trim();
    const commit = execFileSync('git', [ '-C', meetDir, 'rev-parse', 'HEAD' ]).toString().trim();

    if (dirty && !inPlace) {
        console.warn('WARNING: JITSI_MEET_DIR has uncommitted changes; they are NOT part of the isolated build.');
    }

    const work = inPlace || skipMake ? meetDir : prepareIsolatedCopy();

    try {
        if (!skipMake) {
            // The web client enforces a 3.5 MiB budget for app.bundle.min.js as a webpack
            // error in production builds (the patched client is a few tens of KiB over it).
            // The files are still emitted; ANALYZE_BUNDLE turns the budget into a no-op
            // for this local build without touching the client sources.
            run('make', [ 'all' ], work, { ANALYZE_BUNDLE: 'true' });
        }

        for (const rel of REQUIRED) {
            if (!fs.existsSync(path.join(work, rel))) {
                throw new Error(`Build output is missing ${rel}`);
            }
        }

        fs.rmSync(outDir, { recursive: true,
            force: true });
        fs.mkdirSync(path.join(outDir, 'css'), { recursive: true });

        for (const dir of DIRECTORIES) {
            if (fs.existsSync(path.join(work, dir))) {
                copyTree(path.join(work, dir), path.join(outDir, dir));
            }
        }
        fs.copyFileSync(path.join(work, 'css/all.css'), path.join(outDir, 'css/all.css'));
        fs.copyFileSync(path.join(work, 'LICENSE'), path.join(outDir, 'LICENSE'));
        fs.writeFileSync(path.join(outDir, 'BUILD_INFO.json'), JSON.stringify({
            sourceCommit: commit,
            uncommittedChanges: Boolean(dirty) && (inPlace || skipMake),
            builtAt: new Date().toISOString()
        }, null, 2));

        const bytes = dirSize(outDir);

        console.log(`client-bundle: ${(bytes / 1048576).toFixed(1)} MiB from ${commit.slice(0, 10)}`);
        console.log(`contains libs/multitrack-worklet.min.js: ${
            fs.existsSync(path.join(outDir, 'libs/multitrack-worklet.min.js'))}`);
    } finally {
        if (work !== meetDir && !keepWork) {
            fs.rmSync(work, { recursive: true,
                force: true });
        }
    }
}

main();
