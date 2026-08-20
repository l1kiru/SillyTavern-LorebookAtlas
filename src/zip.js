/**
 * Minimal store-only (uncompressed) ZIP reader and writer.
 *
 * Store-only is the right trade here: the payload is overwhelmingly already-compressed
 * images, so deflate would buy nothing while dragging in a dependency.
 *
 * Names are validated on both write and read. Reading is where it matters: an archive may
 * come from anywhere, and `../` in an entry name is the classic path-traversal vector.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const ZIP_VERSION = 20;

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) {
        crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

export function assertZipName(name) {
    const value = String(name || '').replace(/\\/g, '/');
    if (!value || value.startsWith('/') || value.includes('../') || value.includes('/..') || value.includes('\0')) {
        throw new Error(`Unsafe ZIP entry name: ${name}`);
    }
    if (!/^[a-zA-Z0-9._\-/]+$/.test(value)) {
        throw new Error(`Unsupported ZIP entry name: ${name}`);
    }
    return value;
}

function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * @param {Array<{ name: string, data: Uint8Array|string }>} files
 * @returns {Uint8Array}
 */
export function buildStoreZip(files, now = new Date()) {
    const stamp = dosDateTime(now);
    const normalized = files.map(file => ({
        name: assertZipName(file.name),
        data: typeof file.data === 'string' ? encoder.encode(file.data) : (file.data ?? new Uint8Array(0)),
    }));

    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of normalized) {
        const nameBytes = encoder.encode(file.name);
        const crc = crc32(file.data);

        const local = new Uint8Array(30);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, SIG_LOCAL, true);
        lv.setUint16(4, ZIP_VERSION, true);
        lv.setUint16(10, stamp.time, true);
        lv.setUint16(12, stamp.date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, file.data.length, true);
        lv.setUint32(22, file.data.length, true);
        lv.setUint16(26, nameBytes.length, true);
        localParts.push(local, nameBytes, file.data);

        const central = new Uint8Array(46);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, SIG_CENTRAL, true);
        cv.setUint16(4, ZIP_VERSION, true);
        cv.setUint16(6, ZIP_VERSION, true);
        cv.setUint16(12, stamp.time, true);
        cv.setUint16(14, stamp.date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, file.data.length, true);
        cv.setUint32(24, file.data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint32(42, offset, true);
        centralParts.push(central, nameBytes);

        offset += local.length + nameBytes.length + file.data.length;
    }

    const centralBuffer = concat(centralParts);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(8, normalized.length, true);
    ev.setUint16(10, normalized.length, true);
    ev.setUint32(12, centralBuffer.length, true);
    ev.setUint32(16, offset, true);

    return concat([...localParts, centralBuffer, eocd]);
}

/**
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array>}
 */
export function parseStoreZip(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 22) {
        throw new Error('ZIP payload is empty or invalid');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i -= 1) {
        if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP end-of-central-directory was not found');

    const total = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (centralOffset + centralSize > bytes.length) throw new Error('ZIP central directory is out of range');

    const files = new Map();
    let ptr = centralOffset;

    for (let i = 0; i < total; i += 1) {
        if (view.getUint32(ptr, true) !== SIG_CENTRAL) throw new Error('ZIP central directory is damaged');

        const method = view.getUint16(ptr + 10, true);
        if (method !== 0) throw new Error('Only uncompressed ZIP archives are supported');

        const crc = view.getUint32(ptr + 16, true);
        const size = view.getUint32(ptr + 24, true);
        const nameLen = view.getUint16(ptr + 28, true);
        const extraLen = view.getUint16(ptr + 30, true);
        const commentLen = view.getUint16(ptr + 32, true);
        const localOffset = view.getUint32(ptr + 42, true);
        const name = assertZipName(decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen)));
        ptr += 46 + nameLen + extraLen + commentLen;

        if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error(`ZIP local header is damaged for ${name}`);
        const localNameLen = view.getUint16(localOffset + 26, true);
        const localExtraLen = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localNameLen + localExtraLen;
        const end = start + size;
        if (end > bytes.length) throw new Error(`ZIP file data is out of range for ${name}`);

        const data = bytes.slice(start, end);
        if (crc32(data) !== crc) throw new Error(`ZIP CRC mismatch for ${name}`);
        files.set(name, data);
    }

    return files;
}

export function textFile(name, value) {
    return { name, data: encoder.encode(value) };
}

export function jsonFile(name, value) {
    return textFile(name, JSON.stringify(value, null, 2));
}

export function readJsonFile(files, name, fallback = null) {
    const bytes = files.get(name);
    if (!bytes) return fallback;
    try {
        return JSON.parse(decoder.decode(bytes));
    } catch {
        return fallback;
    }
}

export function readTextFile(files, name, fallback = '') {
    const bytes = files.get(name);
    return bytes ? decoder.decode(bytes) : fallback;
}
