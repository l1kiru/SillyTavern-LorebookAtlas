import test from 'node:test';
import assert from 'node:assert/strict';

import { detectMimeFromBytes, resolveImageMime, isHeicMime } from '../src/mime-detect.js';

function bytesFrom(parts) {
    const chunks = parts.map(part => {
        if (typeof part === 'string') return Uint8Array.from(part, ch => ch.charCodeAt(0));
        return part instanceof Uint8Array ? part : Uint8Array.from(part);
    });
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

test('detectMimeFromBytes recognises raster signatures', () => {
    assert.equal(detectMimeFromBytes(bytesFrom([[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]])), 'image/png');
    assert.equal(detectMimeFromBytes(bytesFrom([[0xff, 0xd8, 0xff, 0xe0], 'xxxx', [0, 0, 0, 0]])), 'image/jpeg');
    assert.equal(detectMimeFromBytes(bytesFrom(['GIF89a......'])), 'image/gif');
    assert.equal(detectMimeFromBytes(bytesFrom(['RIFF', [0, 0, 0, 0], 'WEBP'])), 'image/webp');
    assert.equal(detectMimeFromBytes(bytesFrom(['BM', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]])), 'image/bmp');
    assert.equal(detectMimeFromBytes(bytesFrom([[0x49, 0x49, 0x2a, 0x00], [0, 0, 0, 0, 0, 0, 0, 0]])), 'image/tiff');
    assert.equal(detectMimeFromBytes(bytesFrom([[0x00, 0x00, 0x01, 0x00], [0, 0, 0, 0, 0, 0, 0, 0]])), 'image/x-icon');
});

test('detectMimeFromBytes recognises AVIF and HEIC brands', () => {
    assert.equal(detectMimeFromBytes(bytesFrom([[0, 0, 0, 0x1c], 'ftypavif', 'mif1'])), 'image/avif');
    assert.equal(detectMimeFromBytes(bytesFrom([[0, 0, 0, 0x1c], 'ftypheic', 'mif1'])), 'image/heic');
    assert.equal(detectMimeFromBytes(bytesFrom([[0, 0, 0, 0x1c], 'ftypmif1', 'heic'])), 'image/heic');
});

test('detectMimeFromBytes recognises SVG in the first 256 bytes', () => {
    assert.equal(detectMimeFromBytes(bytesFrom(['<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">'])), 'image/svg+xml');
    assert.equal(detectMimeFromBytes(new Uint8Array(8)), '');
});

test('resolveImageMime prefers sniffed bytes over an empty or unknown declared type', () => {
    const jpeg = bytesFrom([[0xff, 0xd8, 0xff, 0xdb], [0, 0, 0, 0, 0, 0, 0, 0]]);
    assert.equal(resolveImageMime('', jpeg), 'image/jpeg');
    assert.equal(resolveImageMime('application/octet-stream', jpeg), 'image/jpeg');
    assert.equal(isHeicMime(resolveImageMime('', bytesFrom([[0, 0, 0, 0x18], 'ftypheic']))), true);
});
