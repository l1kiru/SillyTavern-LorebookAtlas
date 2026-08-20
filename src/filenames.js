/**
 * File naming.
 *
 * /api/files has a flat namespace — no subdirectories — and SillyTavern's
 * validateAssetFileName() rejects anything outside /^[a-zA-Z0-9_\-.]+$/, which rules out
 * Cyrillic and spaces. So every piece of structure is encoded into the name itself, and
 * the user's original filename lives only in the manifest as metadata.
 *
 *   lba_<group8>_<image8>_<variantCode>_<sha8>.<ext>
 *
 * The sha8 suffix makes the URL content-addressed. Replacing an image changes its name,
 * which sidesteps the stale-cache trap of serving a fixed icon.png under a one-year
 * immutable cache header.
 */

import { FILE_PREFIX, SAFE_FILENAME_RE, VARIANT_CODE, CODE_VARIANT, MIME_EXT, FILES_ROUTE } from './constants.js';

const SHORT = 8;

function shortId(value) {
    return String(value || '').replace(/-/g, '').slice(0, SHORT).toLowerCase();
}

/**
 * @param {object} spec
 * @param {string} spec.groupId
 * @param {string} spec.imageId
 * @param {string} spec.variant One of VARIANT.*
 * @param {string} spec.sha256
 * @param {string} spec.mime
 * @returns {string}
 */
export function buildFileName({ groupId, imageId, variant, sha256, mime }) {
    const code = VARIANT_CODE[variant];
    if (!code) throw new Error(`Unknown variant: ${variant}`);

    const ext = MIME_EXT[mime];
    if (!ext) throw new Error(`Unsupported mime: ${mime}`);

    const group = shortId(groupId);
    const image = shortId(imageId);
    const sha = shortId(sha256);
    if (!group || !image || !sha) throw new Error('groupId, imageId and sha256 are all required');

    const name = `${FILE_PREFIX}_${group}_${image}_${code}_${sha}.${ext}`;
    if (!SAFE_FILENAME_RE.test(name)) throw new Error(`Generated name rejected by the safe pattern: ${name}`);
    return name;
}

/**
 * Inverse of buildFileName. Returns null for anything that is not ours, which is how the
 * resume-after-interrupted-cleanup path tells our leftovers from unrelated user files.
 * @param {string} input File name or a full client-relative path
 * @returns {{ groupId8: string, imageId8: string, variant: string, sha8: string, ext: string } | null}
 */
export function parseFileName(input) {
    const name = String(input || '').split('/').pop();
    if (!name || !SAFE_FILENAME_RE.test(name)) return null;

    const match = /^lba_([a-z0-9]{8})_([a-z0-9]{8})_([a-z])_([a-z0-9]{8})\.([a-z]+)$/.exec(name);
    if (!match) return null;

    const variant = CODE_VARIANT[match[3]];
    if (!variant) return null;

    return { groupId8: match[1], imageId8: match[2], variant, sha8: match[4], ext: match[5] };
}

/** True if the name belongs to this extension (image, manifest, backup or tombstone). */
export function isOwnFile(input) {
    const name = String(input || '').split('/').pop();
    return Boolean(name) && name.startsWith(`${FILE_PREFIX}_`);
}

/** Client-relative URL for a stored file name, as returned by /api/files/upload. */
export function fileUrl(name) {
    return `${FILES_ROUTE}/${name}`;
}

/** Strips the route prefix back down to a bare file name. */
export function fileNameFromUrl(url) {
    return String(url || '').split('/').pop() || '';
}
