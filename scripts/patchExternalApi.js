/* eslint-env node */

/**
 * The vendored external_api.js builds the iframe URL as `https://${domain}/...`
 * and derives the postMessage origin from it. The embedded client server speaks
 * plain http on the loopback interface, so for exactly that case (the domain is
 * `http://<16 hex>.localhost:<port>[/path]`) the scheme must be kept. Everything else is
 * untouched, so a normal domain still yields https.
 *
 * The patch is applied while bundling (esbuild.js) instead of editing the
 * vendored file, and refuses to apply unless the pattern occurs exactly once,
 * so an updated external_api.js cannot silently lose it.
 */

const NEEDLE = 'url:`https://${t}/#jitsi_meet_external_api_id=${j}`';
const LOOPBACK_DOMAIN = /^http:\/\/[0-9a-f]{16}\.localhost:\d+(?:\/.*)?$/;
const REPLACEMENT = `url:\`\${${LOOPBACK_DOMAIN}.test(t)?t:"https://"+t}/#jitsi_meet_external_api_id=\${j}\``;

/**
 * Applies the loopback http patch.
 *
 * @param {string} code - The source of external_api.js.
 * @returns {string} The patched source.
 */
function patchExternalApi(code) {
    const count = code.split(NEEDLE).length - 1;

    if (count !== 1) {
        throw new Error(`external_api.js: expected exactly one iframe URL template, found ${count}; `
            + 'update scripts/patchExternalApi.js for the new vendored version.');
    }

    return code.replace(NEEDLE, () => REPLACEMENT);
}

module.exports = { patchExternalApi,
    LOOPBACK_DOMAIN,
    REPLACEMENT };
