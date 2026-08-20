/**
 * Browser-side image work: validation, downscaling, encoding.
 *
 * The old architecture had the client ship three ready-made data URLs to a server plugin.
 * Here the same work happens in the page, but the result goes straight into the user's
 * file store as binary-derived base64, and only two variants are produced.
 */

import { DEFAULTS, MIME_EXT } from './constants.js';
import { sha256Hex } from './util.js';
import { T } from './i18n.js';

/** Decodes and measures a blob, rejecting anything the browser refuses to parse. */
export async function probeImage(blob) {
    let bitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch (error) {
        throw new Error(T('error.notAnImage'));
    }
    const result = { width: bitmap.width, height: bitmap.height, mime: blob.type, bytes: blob.size };
    bitmap.close?.();
    return result;
}

/**
 * Downscales to fit within maxSide, preserving aspect ratio. Images already small enough
 * are re-encoded anyway, so the preview format stays predictable.
 * @returns {Promise<Blob>}
 */
export async function downscale(blob, { maxSide = DEFAULTS.previewMaxSide, mime = DEFAULTS.previewMime, quality = DEFAULTS.previewQuality } = {}) {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });

    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    if (typeof canvas.convertToBlob === 'function') {
        return await canvas.convertToBlob({ type: mime, quality });
    }
    return await new Promise(resolve => canvas.toBlob(resolve, mime, quality));
}

/** Blob -> base64 without the data: prefix. */
export async function blobToBase64(blob) {
    const buffer = new Uint8Array(await blob.arrayBuffer());
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < buffer.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, buffer.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * Prepares everything needed to store one image: hash, dimensions and both variants.
 * The hash is taken over the *original* bytes so deduplication is stable regardless of
 * the preview encoder's output.
 */
export async function prepareVariants(blob, options = {}) {
    const keepOriginal = options.keepOriginal ?? DEFAULTS.keepOriginal;
    const probe = await probeImage(blob);

    if (!MIME_EXT[blob.type]) {
        throw new Error(T('error.unsupportedFormat', { mime: blob.type || T('error.unknownMime') }));
    }

    const sha256 = await sha256Hex(await blob.arrayBuffer());
    const previewBlob = await downscale(blob, options);

    const variants = {
        preview: { blob: previewBlob, mime: previewBlob.type || DEFAULTS.previewMime },
    };

    if (keepOriginal && blob.size <= (options.maxOriginalBytes ?? DEFAULTS.maxOriginalBytes)) {
        variants.original = { blob, mime: blob.type };
    }

    return { sha256, width: probe.width, height: probe.height, bytes: blob.size, variants };
}
