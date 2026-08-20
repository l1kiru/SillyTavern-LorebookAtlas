/**
 * Sniff an image type from magic bytes. `blob.type` is often empty or wrong for
 * AVIF/HEIC and for files picked without an extension.
 */

import { MIME_EXT } from './constants.js';

const HEIC_MIMES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

function ascii(bytes, start, end) {
    let out = '';
    const last = Math.min(end, bytes.length);
    for (let i = start; i < last; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
}

export function isHeicMime(mime) {
    return HEIC_MIMES.has(mime);
}

export function detectMimeFromBytes(bytes) {
    if (!bytes || bytes.length < 12) return '';

    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    const head6 = ascii(bytes, 0, 6);
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
    if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
        || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)) {
        return 'image/tiff';
    }
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && (bytes[2] === 0x01 || bytes[2] === 0x02) && bytes[3] === 0x00) {
        return 'image/x-icon';
    }
    if (ascii(bytes, 4, 8) === 'ftyp') {
        const brands = ascii(bytes, 8, Math.min(bytes.length, 32));
        if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
        if (/heic|heix|heif|heim|mif1|msf1/.test(brands)) return 'image/heic';
    }

    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(256, bytes.length)));
    if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
    return '';
}

/** Prefer sniffed bytes over a missing or unknown declared type. */
export function resolveImageMime(declaredType, bytes) {
    const sniffed = detectMimeFromBytes(bytes);
    if (isHeicMime(sniffed) || isHeicMime(declaredType)) return sniffed || declaredType;
    if (MIME_EXT[sniffed]) return sniffed;
    if (MIME_EXT[declaredType]) return declaredType;
    return sniffed || declaredType || '';
}
