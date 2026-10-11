import * as path from 'path';

import { ALLOWED_EXTENSIONS } from './constants';

// Anything that is a separator, reserved on Windows or a control character.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[/\\:*?"<>|\u0000-\u001f]/;

/**
 * Validates a bare file name that is going to be created in a user chosen
 * directory.
 *
 * @param {unknown} name - The candidate name.
 * @returns {string} The name, when valid.
 * @throws {Error} When the name is not a safe, bare, allowed file name.
 */
export function validateFileName(name: unknown): string {
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
        throw new Error('Invalid file name');
    }

    if (FORBIDDEN_CHARS.test(name) || name.startsWith('.') || name.endsWith('.') || name.endsWith(' ')) {
        throw new Error('Invalid file name');
    }

    if (!ALLOWED_EXTENSIONS.includes(path.extname(name).toLowerCase())) {
        throw new Error('File extension not allowed');
    }

    return name;
}
