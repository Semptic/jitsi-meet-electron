/* eslint-env node */

/**
 * electron-builder configuration of the local "Jitsi Meet Multitrack" build
 * (see docs/embedded-client.md). It lives next to the regular configuration in
 * package.json instead of replacing it, so `npm start` and `npm run dist` keep
 * their identity (and their profile directory).
 *
 * It differs from the regular build in exactly these ways:
 *  - own product name, app id and custom URL scheme, so it installs next to the
 *    regular app and never takes over its jitsi-meet:// links or its profile;
 *  - no publish target and no update files: it must never update itself from
 *    upstream releases;
 *  - the patched web client (client-bundle/) ships in Resources/client;
 *  - one macOS arm64 .app (target dir), no dmg/zip, no notarization.
 */

const pkg = require('./package.json');

const productName = 'Jitsi Meet Multitrack';
const scheme = 'jitsi-meet-multitrack';

module.exports = {
    ...pkg.build,
    appId: 'org.jitsi.jitsi-meet.multitrack',
    productName,
    publish: null,
    generateUpdatesFilesForAllChannels: false,
    extraMetadata: {
        productName,
        desktopName: 'org.jitsi.jitsi-meet.multitrack'
    },
    extraResources: [
        {
            from: 'client-bundle',
            to: 'client'
        }
    ],
    directories: {
        ...pkg.build.directories,
        output: 'dist-multitrack'
    },
    mac: {
        ...pkg.build.mac,
        artifactName: 'jitsi-meet-multitrack.${ext}',
        target: [
            {
                arch: 'arm64',
                target: 'dir'
            }
        ],
        // No Developer ID: sign ad hoc ("-"), which Apple Silicon requires to run a modified bundle.
        identity: '-',
        // Hardened runtime would make ad-hoc signed frameworks fail library validation at launch.
        hardenedRuntime: false,
        notarize: false,
        extendInfo: {
            ...pkg.build.mac.extendInfo,
            NSCameraUsageDescription:
                'Jitsi Meet Multitrack requires access to your camera in order to make video-calls.',
            NSMicrophoneUsageDescription:
                'Jitsi Meet Multitrack requires access to your microphone in order to make calls (audio/video).',
            NSAudioCaptureUsageDescription:
                'Jitsi Meet Multitrack can share your system audio via screensharing if you enable it.'
        }
    },
    protocols: [
        {
            name: 'jitsi-protocol-multitrack',
            role: 'Viewer',
            schemes: [ scheme ]
        }
    ],
    mas: undefined,
    linux: undefined,
    win: undefined
};
