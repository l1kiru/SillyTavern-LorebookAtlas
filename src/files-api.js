/**
 * Thin wrapper over SillyTavern's built-in per-user file store.
 *
 *   POST /api/files/upload  { name, data(base64) } -> { path }
 *   POST /api/files/delete  { path }
 *   POST /api/files/verify  { urls[] }             -> { url: bool }
 *
 * Files land in data/<handle>/user/files, which gives per-user isolation for free and is
 * included in SillyTavern's own user backup. Note there is deliberately no list()
 * — the API has no listing endpoint, which is why the manifest is the sole index.
 *
 * Dependencies are injected so tests can drive the whole thing against a mock.
 */

import { FILES_ROUTE } from './constants.js';

/**
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {() => object} deps.getHeaders Supplies SillyTavern's CSRF headers.
 */
export function createFilesApi({ fetch: fetchImpl, getHeaders }) {
    const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
    const headers = getHeaders ?? (() => ({ 'Content-Type': 'application/json' }));

    async function post(url, body, { keepalive = false } = {}) {
        const response = await doFetch(url, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(body),
            keepalive,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            const error = new Error(`${url} -> ${response.status} ${text}`.trim());
            error.status = response.status;
            throw error;
        }
        return response;
    }

    return {
        /**
         * @param {string} name Bare file name; must satisfy validateAssetFileName.
         * @param {string} base64 Payload without the data: prefix.
         * @returns {Promise<string>} Client-relative path of the stored file.
         */
        async upload(name, base64) {
            const response = await post('/api/files/upload', { name, data: base64 });
            const data = await response.json();
            return data?.path || `${FILES_ROUTE}/${name}`;
        },

        /**
         * @param {string} path Client-relative path as returned by upload().
         * @param {{ keepalive?: boolean }} [options] keepalive lets the request outlive a
         *        page unload, which is what makes teardown from the delete hook viable.
         */
        async remove(path, options = {}) {
            try {
                await post('/api/files/delete', { path }, options);
                return true;
            } catch (error) {
                // A missing file is a success from the caller's point of view: the goal is
                // "not there any more", and cleanup resumes are expected to re-request.
                if (error.status === 404) return true;
                throw error;
            }
        },

        /**
         * @param {string[]} urls
         * @returns {Promise<Record<string, boolean>>}
         */
        async verify(urls) {
            if (!urls.length) return {};
            const response = await post('/api/files/verify', { urls });
            return await response.json();
        },

        /** Raw bytes of a stored file, used when assembling an archive. */
        async readBytes(path) {
            try {
                const response = await doFetch(`/${String(path).replace(/^\/+/, '')}`, { cache: 'no-store' });
                if (!response.ok) return null;
                return new Uint8Array(await response.arrayBuffer());
            } catch {
                return null;
            }
        },

        /** Reads one of our own JSON files back. Returns null when absent or corrupt. */
        async readJson(path) {
            try {
                const response = await doFetch(`/${String(path).replace(/^\/+/, '')}`, { cache: 'no-store' });
                if (!response.ok) return null;
                return await response.json();
            } catch {
                return null;
            }
        },

        async writeJson(name, value) {
            const json = JSON.stringify(value, null, 2);
            const base64 = bytesToBase64(new TextEncoder().encode(json));
            return await this.upload(name, base64);
        },
    };
}

/** Chunked base64 encoder — avoids blowing the argument limit on large buffers. */
export function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < view.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, view.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}
