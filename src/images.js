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
import { resolveImageMime, isHeicMime } from './mime-detect.js';

function makeCanvas(width, height) {
    return typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
}

async function canvasToBlob(canvas, mime, quality) {
    if (typeof canvas.convertToBlob === 'function') {
        return await canvas.convertToBlob({ type: mime, quality });
    }
    return await new Promise(resolve => canvas.toBlob(resolve, mime, quality));
}

/** SVG is unreliable in createImageBitmap; HTMLImageElement.decode() is the stable path. */
async function decodeSvg(blob) {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    try {
        img.src = url;
        await img.decode();
        return img;
    } catch {
        throw new Error(T('error.notAnImage'));
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function decodeRaster(blob) {
    try {
        return await createImageBitmap(blob);
    } catch {
        throw new Error(T('error.notAnImage'));
    }
}

function scaledSize(srcW, srcH, maxSide) {
    const width = srcW || maxSide;
    const height = srcH || maxSide;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Decodes and measures a blob, rejecting anything the browser refuses to parse. */
export async function probeImage(blob, mime = blob.type) {
    if (mime === 'image/svg+xml') {
        const img = await decodeSvg(blob);
        return { width: img.naturalWidth || 0, height: img.naturalHeight || 0, mime, bytes: blob.size };
    }
    const bitmap = await decodeRaster(blob);
    const result = { width: bitmap.width, height: bitmap.height, mime, bytes: blob.size };
    bitmap.close?.();
    return result;
}

/**
 * Downscales to fit within maxSide, preserving aspect ratio. Images already small enough
 * are re-encoded anyway, so the preview format stays predictable.
 * SVG is rasterised here: crop/object-fit only behave on bitmaps.
 * @returns {Promise<Blob>}
 */
export async function downscale(blob, {
    maxSide = DEFAULTS.previewMaxSide,
    mime = DEFAULTS.previewMime,
    quality = DEFAULTS.previewQuality,
    sourceMime = blob.type,
} = {}) {
    if (sourceMime === 'image/svg+xml') {
        const img = await decodeSvg(blob);
        const size = scaledSize(img.naturalWidth, img.naturalHeight, maxSide);
        const canvas = makeCanvas(size.width, size.height);
        canvas.getContext('2d').drawImage(img, 0, 0, size.width, size.height);
        return await canvasToBlob(canvas, mime, quality);
    }

    const bitmap = await decodeRaster(blob);
    const size = scaledSize(bitmap.width, bitmap.height, maxSide);
    const canvas = makeCanvas(size.width, size.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close?.();
    return await canvasToBlob(canvas, mime, quality);
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
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const mime = resolveImageMime(blob.type, bytes);

    if (isHeicMime(mime)) throw new Error(T('error.heicNotSupported'));
    if (!MIME_EXT[mime]) throw new Error(T('error.unsupportedFormat', { mime: mime || T('error.unknownMime') }));

    const typed = blob.type === mime ? blob : new Blob([buffer], { type: mime });
    const probe = await probeImage(typed, mime);
    const sha256 = await sha256Hex(buffer);
    const previewBlob = await downscale(typed, { ...options, sourceMime: mime });

    const variants = {
        preview: { blob: previewBlob, mime: previewBlob.type || DEFAULTS.previewMime },
    };

    if (keepOriginal && typed.size <= (options.maxOriginalBytes ?? DEFAULTS.maxOriginalBytes)) {
        variants.original = { blob: typed, mime };
    }

    return { sha256, width: probe.width, height: probe.height, bytes: typed.size, mime, variants };
}
