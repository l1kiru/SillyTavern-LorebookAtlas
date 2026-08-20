/**
 * In-memory stand-in for SillyTavern's /api/files endpoints.
 *
 * Mirrors the real semantics that matter: a flat namespace, one delete per request, no
 * listing endpoint, and validateAssetFileName's character restriction.
 */

import { SAFE_FILENAME_RE, FILES_ROUTE } from '../src/constants.js';

export function createMockFilesApi({ failOn = () => false } = {}) {
    /** @type {Map<string, string>} name -> base64 payload */
    const files = new Map();
    const calls = { upload: 0, remove: 0, verify: 0, keepalive: 0 };

    const nameOf = path => String(path).split('/').pop();

    return {
        files,
        calls,

        async upload(name, base64) {
            if (!SAFE_FILENAME_RE.test(name)) {
                throw new Error(`Illegal character in filename: ${name}`);
            }
            calls.upload += 1;
            files.set(name, base64);
            return `${FILES_ROUTE}/${name}`;
        },

        async remove(path, options = {}) {
            calls.remove += 1;
            if (options.keepalive) calls.keepalive += 1;
            if (failOn(path)) {
                const error = new Error(`mock failure for ${path}`);
                error.status = 500;
                throw error;
            }
            files.delete(nameOf(path));
            return true;
        },

        async verify(urls) {
            calls.verify += 1;
            return Object.fromEntries(urls.map(url => [url, files.has(nameOf(url))]));
        },

        async readJson(path) {
            const raw = files.get(nameOf(path));
            if (!raw) return null;
            try {
                return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
            } catch {
                return null;
            }
        },

        async writeJson(name, value) {
            const base64 = Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64');
            return await this.upload(name, base64);
        },
    };
}
