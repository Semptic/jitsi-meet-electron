
// Values injected at build time by esbuild (see esbuild.js); empty means "use the default".
// They let a fork build (scripts/package-multitrack.mjs) change its identity and
// defaults without touching the upstream defaults below.
const buildAppName = process.env.JITSI_BUILD_APP_NAME;
const buildAppId = process.env.JITSI_BUILD_APP_ID;
const buildProtocol = process.env.JITSI_BUILD_PROTOCOL;
const buildServerURL = process.env.JITSI_BUILD_DEFAULT_SERVER_URL;
const buildDisableUpdates = process.env.JITSI_BUILD_DISABLE_UPDATES;

export default {
    /**
     * The URL with extra information about the app / service.
     */
    aboutURL: 'https://jitsi.org/what-is-jitsi/',

    /**
     * The URL to the source code repository.
     */
    sourceURL: 'https://github.com/jitsi/jitsi-meet-electron',

    /**
     * Application name.
     */
    appName: buildAppName || 'Jitsi Meet',

    /**
     * Application id (also used by the screen sharing permission handling).
     */
    appId: buildAppId || 'org.jitsi.jitsi-meet',

    /**
     * Whether the app checks for updates (off in local fork builds).
     */
    updatesEnabled: buildDisableUpdates !== 'true',

    /**
    * The prefix for application protocol.
    * You will also need to replace this in package.json.
    */
    appProtocolPrefix: buildProtocol || 'jitsi-meet',

    /**
     * The default server URL of Jitsi Meet Deployment that will be used.
     */
    defaultServerURL: buildServerURL || 'https://meet.jit.si',

    /**
     * The default server Timeout in seconds.
     */
    defaultServerTimeout: 30,

    /**
     * URL to send feedback.
     */
    feedbackURL: 'https://github.com/jitsi/jitsi-meet-electron/issues',

    /**
     * The URL of Privacy Policy Page.
     */
    privacyPolicyURL: 'https://jitsi.org/meet/privacy',

    /**
     * The URL of Terms and Conditions Page.
     */
    termsAndConditionsURL: 'https://jitsi.org/meet/terms'
};
