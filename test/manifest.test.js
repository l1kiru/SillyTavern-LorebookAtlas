import test from 'node:test';
import assert from 'node:assert/strict';

import * as model from '../src/manifest-model.js';
import { ORPHAN_GROUP_ID, SCHEMA_VERSION } from '../src/constants.js';

test('a fresh manifest carries the system group and nothing else', () => {
    const m = model.createManifest();
    assert.equal(m.schema, SCHEMA_VERSION);
    assert.deepEqual(Object.keys(m.groups), [ORPHAN_GROUP_ID]);
    assert.deepEqual(m.images, {});
});

test('every mutation bumps rev, so divergence between tabs is detectable', () => {
    let m = model.createManifest();
    const start = m.rev;
    m = model.upsertGroup(m, { id: 'g1', lorebookName: 'Книга' });
    m = model.upsertImage(m, { id: 'i1', groupId: 'g1', sha256: 's', variants: {} });
    m = model.setLock(m, 'i1', true);
    assert.equal(m.rev, start + 3);
});

test('garbage on disk is repaired rather than rejected', () => {
    const m = model.normalizeManifest({
        rev: 'not a number',
        groups: { g1: { displayName: 'Книга' }, bad: null },
        images: {
            good: { groupId: 'g1', variants: { preview: 'user/files/x.webp' }, refs: [{ groupId: 'g1', entryUid: 3 }] },
            homeless: { groupId: 'vanished', variants: {} },
            junk: 'not an object',
        },
    });

    assert.equal(m.rev, 0);
    assert.equal(m.schema, SCHEMA_VERSION);
    assert.ok(m.groups[ORPHAN_GROUP_ID].system, 'system group is always restored');
    assert.equal(m.images.homeless.groupId, ORPHAN_GROUP_ID, 'images of unknown groups are rehomed, not dropped');
    assert.equal(m.images.junk, undefined);
    assert.equal(m.images.good.refs.length, 1);
});

test('normalizing null yields a usable empty manifest', () => {
    assert.deepEqual(model.normalizeManifest(null).images, {});
    assert.deepEqual(model.normalizeManifest(undefined).images, {});
});

test('deduplication lookup finds an existing image by content hash', () => {
    let m = model.createManifest();
    m = model.upsertGroup(m, { id: 'g1', lorebookName: 'Книга' });
    m = model.upsertImage(m, { id: 'i1', groupId: 'g1', sha256: 'abc', variants: {} });
    assert.equal(model.findImageBySha(m, 'abc').id, 'i1');
    assert.equal(model.findImageBySha(m, 'nope'), null);
    assert.equal(model.findImageBySha(m, ''), null);
});

test('references are added without duplicates and removed cleanly', () => {
    let m = model.createManifest();
    m = model.upsertGroup(m, { id: 'g1', lorebookName: 'Книга' });
    m = model.upsertImage(m, { id: 'i1', groupId: 'g1', sha256: 'abc', variants: {} });

    m = model.addRef(m, 'i1', { groupId: 'g1', entryUid: 5 });
    m = model.addRef(m, 'i1', { groupId: 'g1', entryUid: 5 });
    assert.equal(m.images.i1.refs.length, 1);

    m = model.removeRef(m, 'i1', { groupId: 'g1', entryUid: 5 });
    assert.equal(m.images.i1.refs.length, 0);
});

test('moving an image records where it came from', () => {
    let m = model.createManifest();
    m = model.upsertGroup(m, { id: 'g1', lorebookName: 'Книга' });
    m = model.upsertImage(m, { id: 'i1', groupId: 'g1', sha256: 'abc', variants: {} });
    m = model.moveImage(m, 'i1', ORPHAN_GROUP_ID);
    assert.equal(m.images.i1.groupId, ORPHAN_GROUP_ID);
    assert.equal(m.images.i1.movedFrom, 'Книга');
});

test('totals count files, not just images', () => {
    let m = model.createManifest();
    m = model.upsertGroup(m, { id: 'g1', lorebookName: 'Книга' });
    m = model.upsertImage(m, { id: 'i1', groupId: 'g1', sha256: 'a', bytes: 10, variants: { preview: 'p', original: 'o' } });
    m = model.upsertImage(m, { id: 'i2', groupId: 'g1', sha256: 'b', bytes: 5, locked: true, variants: { preview: 'p2' } });

    const t = model.totals(m);
    assert.equal(t.images, 2);
    assert.equal(t.files, 3);
    assert.equal(t.bytes, 15);
    assert.equal(t.locked, 1);
});

test('adding an image to an unknown group is refused', () => {
    assert.throws(() => model.upsertImage(model.createManifest(), { id: 'x', groupId: 'ghost', variants: {} }), /Unknown group/);
});
