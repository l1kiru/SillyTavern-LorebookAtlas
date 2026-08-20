/**
 * Teardown.
 *
 * The requirement is that deleting the extension takes every stored image with it.
 * SillyTavern's own machinery constrains how far that can be honoured:
 *
 *   deleteExtension(name, shouldClean)
 *     -> clean hook (only if the user ticks "Also clean up extension data")
 *     -> delete hook (always)
 *     -> POST /api/extensions/delete
 *     -> reload after 1s
 *
 * and callExtensionHook races every hook against HOOK_TIMEOUT = 5000ms, after which it
 * logs a warning and carries on. /api/files/delete takes one path per request with no
 * batch mode, so a large library cannot be torn down inside that budget.
 *
 * Hence three mechanisms:
 *   - runCleanup()      full, awaited, with progress. Used by the broom button, where
 *                       nothing reloads the page and the 5s timeout is only a log line.
 *   - runFireAndForget() keepalive burst from the delete hook; survives the reload.
 *   - the tombstone      written first, deleted last, so an interrupted teardown can be
 *                       finished by the install hook next time round.
 */

import { MANIFEST_FILE, MANIFEST_BAK_FILE, TOMBSTONE_FILE, DEFAULTS } from './constants.js';
import { fileUrl, isOwnFile } from './filenames.js';
import { imageFiles } from './manifest-model.js';
import { pool } from './util.js';

/**
 * Every file the extension owns, ordered so the manifest dies last: while it survives,
 * the remaining images are still findable.
 * @returns {{ createdAt: string, files: string[] }}
 */
export function buildTombstone(manifest, now = new Date()) {
    const files = [];
    for (const image of Object.values(manifest?.images || {})) {
        files.push(...imageFiles(image));
    }
    files.push(fileUrl(MANIFEST_BAK_FILE));
    files.push(fileUrl(MANIFEST_FILE));
    return {
        createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
        files: [...new Set(files.filter(Boolean))],
    };
}

/** Union of an existing tombstone with a fresh one, for a resumed run. */
export function mergeTombstone(previous, next) {
    const files = [...(previous?.files || []), ...(next?.files || [])];
    return {
        createdAt: previous?.createdAt || next?.createdAt || new Date().toISOString(),
        files: [...new Set(files.filter(Boolean))],
    };
}

/** Guards against ever issuing a delete for a file that is not ours. */
export function filterOwnFiles(files) {
    return (files || []).filter(isOwnFile);
}

/**
 * Full teardown with bounded concurrency and progress reporting.
 *
 * @param {object} api createFilesApi() instance
 * @param {object} tombstone
 * @param {object} [options]
 * @param {number} [options.concurrency]
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<{ total: number, deleted: number, failed: string[] }>}
 */
export async function runCleanup(api, tombstone, options = {}) {
    const files = filterOwnFiles(tombstone?.files);
    const concurrency = options.concurrency ?? DEFAULTS.cleanupConcurrency;

    // The tombstone itself is written before this runs and removed at the very end.
    const targets = files.filter(f => f !== fileUrl(TOMBSTONE_FILE));

    const results = await pool(targets, concurrency, path => api.remove(path), options.onProgress);
    const failed = results.filter(r => !r.ok).map(r => r.item);

    if (!failed.length) {
        await api.remove(fileUrl(TOMBSTONE_FILE)).catch(() => {});
    }

    return { total: targets.length, deleted: targets.length - failed.length, failed };
}

/**
 * Best-effort teardown from the delete hook.
 *
 * Requests go out with keepalive so they outlive the page reload that follows. Browsers
 * cap the aggregate keepalive body size at roughly 64 KB; the bodies here are tiny JSON
 * objects, but a very large library can still exceed it, which is precisely what the
 * tombstone is there to catch.
 *
 * Only the tombstone write is awaited — waiting on the rest would burn the 5s budget for
 * no benefit, since the requests continue regardless.
 */
export function runFireAndForget(api, tombstone) {
    const files = filterOwnFiles(tombstone?.files).filter(f => f !== fileUrl(TOMBSTONE_FILE));
    for (const path of files) {
        void api.remove(path, { keepalive: true }).catch(() => {});
    }
    return files.length;
}

/**
 * Called from the install hook. If a tombstone is sitting in the file store, a previous
 * teardown did not finish; complete it before doing anything else.
 * @returns {Promise<null | { total: number, deleted: number, failed: string[] }>}
 */
export async function resumePendingCleanup(api) {
    const tombstone = await api.readJson(fileUrl(TOMBSTONE_FILE));
    if (!tombstone || !Array.isArray(tombstone.files) || !tombstone.files.length) return null;
    return await runCleanup(api, tombstone);
}
