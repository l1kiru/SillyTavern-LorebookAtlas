/**
 * Per-entry thumbnail crop. Display-only: it must not mint files or change the
 * image hash, so two entries can share one stored image and still frame it differently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CROP_DEFAULT, normalizeCrop, cropIsDefault, readEntryCrop, writeEntryCrop,
    writeEntryImage, applyCropStyle,
} from '../src/lorebook-binding.js';

test('normalizeCrop clamps and fills', () => {
    assert.deepEqual(normalizeCrop(null), CROP_DEFAULT);
    assert.deepEqual(normalizeCrop({ x: -1, y: 9, zoom: 99 }), { x: 0, y: 1, zoom: 4 });
    assert.deepEqual(normalizeCrop({ x: '0.25', y: '0.75', zoom: '2' }), { x: 0.25, y: 0.75, zoom: 2 });
});

test('default crop is not persisted', () => {
    const entry = { uid: 1, extensions: {} };
    writeEntryCrop(entry, { x: 0.5, y: 0.5, zoom: 1 });
    assert.equal(entry.extensions.lorebookAtlas, undefined);
    writeEntryCrop(entry, { x: 0.2, y: 0.8, zoom: 2 });
    assert.deepEqual(readEntryCrop(entry), { x: 0.2, y: 0.8, zoom: 2 });
    writeEntryCrop(entry, CROP_DEFAULT);
    assert.equal(entry.extensions.lorebookAtlas, undefined);
});

test('replacing with a different image clears the crop; the same file keeps it', () => {
    const entry = { uid: 1, extensions: {} };
    writeEntryImage(entry, { id: 'a', sha256: 'aaa', variants: { preview: 'p1' } });
    writeEntryCrop(entry, { x: 0.1, y: 0.9, zoom: 3 });
    writeEntryImage(entry, { id: 'a', sha256: 'aaa', variants: { preview: 'p1' } });
    assert.deepEqual(readEntryCrop(entry), { x: 0.1, y: 0.9, zoom: 3 });
    writeEntryImage(entry, { id: 'b', sha256: 'bbb', variants: { preview: 'p2' } });
    assert.ok(cropIsDefault(readEntryCrop(entry)));
});

test('applyCropStyle writes cover-compatible CSS', () => {
    const style = {};
    applyCropStyle({ style }, { x: 0, y: 1, zoom: 2 });
    assert.equal(style.objectPosition, '0.00% 100.00%');
    assert.equal(style.transformOrigin, '0.00% 100.00%');
    assert.equal(style.transform, 'scale(2)');
    applyCropStyle({ style }, CROP_DEFAULT);
    assert.equal(style.transform, '');
});
