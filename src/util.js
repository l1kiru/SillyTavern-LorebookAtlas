/** Small helpers with no SillyTavern or DOM dependency, so they stay unit-testable. */

import { T } from './i18n.js';

/**
 * Hex SHA-256 of a binary payload.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<string>}
 */
export async function sha256Hex(data) {
    const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * RFC 4122 v4 identifier. Falls back to a manual construction where randomUUID is unavailable
 * (older Safari, insecure origins).
 * @returns {string}
 */
export function uuid() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Runs an async worker over items with bounded concurrency, never rejecting.
 * Every item yields a result entry so partial failures stay visible to the caller —
 * important during cleanup, where a half-finished run must still report what is left.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<Array<{ item: T, ok: boolean, value?: R, error?: Error }>>}
 */
export async function pool(items, limit, worker, onProgress) {
    const list = [...items];
    const results = new Array(list.length);
    const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
    let cursor = 0;
    let done = 0;

    async function run() {
        for (;;) {
            const index = cursor++;
            if (index >= list.length) return;
            try {
                results[index] = { item: list[index], ok: true, value: await worker(list[index], index) };
            } catch (error) {
                results[index] = { item: list[index], ok: false, error };
            }
            done += 1;
            onProgress?.(done, list.length);
        }
    }

    await Promise.all(Array.from({ length: size }, run));
    return results;
}

/**
 * Trailing-edge debounce that exposes a flush(), so a pending manifest write can be
 * forced out before a teardown path runs.
 * @param {(...args: any[]) => any} fn
 * @param {number} waitMs
 */
export function debounce(fn, waitMs) {
    let timer = null;
    let pendingArgs = null;

    const wrapped = (...args) => {
        pendingArgs = args;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            const call = pendingArgs;
            pendingArgs = null;
            fn(...call);
        }, waitMs);
    };

    wrapped.flush = () => {
        if (!timer) return undefined;
        clearTimeout(timer);
        timer = null;
        const call = pendingArgs;
        pendingArgs = null;
        return fn(...call);
    };

    wrapped.cancel = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        pendingArgs = null;
    };

    return wrapped;
}

/** Human-readable byte size. */
export function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} ${T('unit.b')}`;
    const units = [T('unit.kb'), T('unit.mb'), T('unit.gb'), T('unit.tb')];
    let n = value / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i += 1;
    }
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Date as DD.MM.YYYY without depending on the host locale database. */
export function formatDate(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}
