/**
 * Recovering from a catalogue that is damaged in a believable way.
 *
 * The existing tests feed normalizeManifest outright rubbish, which is the easy case. The
 * states that actually occur are structurally valid but internally inconsistent: a record
 * whose file never finished uploading, an image pointing at a group that was removed
 * between two writes, a backup newer than the file it backs up. Losing the catalogue is
 * the one unrecoverable failure here — with no listing endpoint, it is the only map to
 * our own files — so it has to survive every one of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorage } from '../src/storage.js';
import * as model from '../src/manifest-model.js';
import { MANIFEST_FILE, MANIFEST_BAK_FILE, ORPHAN_GROUP_ID } from '../src/constants.js';
import { fileUrl } from '../src/filenames.js';
import { createMockFilesApi } from './mock-files-api.js';

const NOW = new Date('2026-08-20T12:00:00Z');
const preview = id => fileUrl(`lba_g1000000_${id}_p_abcdef01.webp`);

function healthy() {
    let manifest = model.createManifest(NOW);
    manifest = model.upsertGroup(manifest, { id: 'g1', lorebookName: 'Book' }, NOW);
    manifest = model.upsertImage(manifest, {
        id: 'img00001',
        groupId: 'g1',
        sha256: 'abcdef01',
        mime: 'image/webp',
        bytes: 5,
        variants: { preview: preview('img00001') },
        refs: [{ groupId: 'g1', entryUid: 0 }],
    }, NOW);
    return manifest;
}

async function open(manifestOnDisk, { backup = null, files = [] } = {}) {
    const api = createMockFilesApi();
    if (manifestOnDisk !== undefined) await api.writeJson(MANIFEST_FILE, manifestOnDisk);
    if (backup) await api.writeJson(MANIFEST_BAK_FILE, backup);
    for (const url of files) await api.upload(url.split('/').pop(), 'payload');

    const storage = createStorage({ api });
    await storage.load();
    return { api, storage };
}

test('a record whose file never landed is reported, not hidden', async () => {
    // The state a crashed upload leaves behind. verify() is the repair path, so this has to
    // be visible rather than quietly pruned on load.
    const { storage } = await open(healthy(), { files: [] });

    const report = await storage.verify();
    assert.equal(report.missing.length, 1);
    assert.deepEqual(report.affectedImages, ['img00001']);
    assert.ok(storage.manifest.images.img00001, 'the record stays so the user can act on it');
});

test('an image pointing at a group that no longer exists is rehomed, not dropped', async () => {
    const broken = healthy();
    delete broken.groups.g1;

    const { storage } = await open(broken);

    // Dropping it would orphan the file with no way to find it again.
    assert.ok(storage.manifest.images.img00001);
    assert.equal(storage.manifest.images.img00001.groupId, ORPHAN_GROUP_ID);
});

test('a lorebook group surviving without its images is still usable', async () => {
    const broken = healthy();
    broken.images = {};

    const { storage } = await open(broken);
    assert.ok(storage.manifest.groups.g1);
    assert.deepEqual(Object.keys(storage.manifest.images), []);
});

test('an unreadable manifest falls back to the backup', async () => {
    const api = createMockFilesApi();
    await api.upload(MANIFEST_FILE, Buffer.from('{ not json', 'utf8').toString('base64'));
    await api.writeJson(MANIFEST_BAK_FILE, healthy());

    const storage = createStorage({ api });
    await storage.load();

    assert.ok(storage.manifest.images.img00001, 'the backup is the whole point of keeping one');
});

test('both copies gone leaves a usable empty catalogue, not a crash', async () => {
    const { storage } = await open(undefined);

    assert.deepEqual(Object.keys(storage.manifest.images), []);
    assert.ok(storage.manifest.groups[ORPHAN_GROUP_ID], 'the system group is always rebuilt');
});

test('a half-written manifest with no images key still loads', async () => {
    const { storage } = await open({ schema: 2, rev: 3, groups: { g1: { displayName: 'Book' } } });

    assert.ok(storage.manifest.groups.g1);
    assert.deepEqual(Object.keys(storage.manifest.images), []);
});

test('the catalogue stays writable after being repaired on load', async () => {
    const broken = healthy();
    delete broken.groups.g1;

    const { api, storage } = await open(broken);
    await storage.ensureGroup('g2', 'Second');

    const reopened = createStorage({ api });
    await reopened.load();
    assert.ok(reopened.manifest.groups.g2, 'the repair has to be persisted, not just in memory');
});

// ---------------------------------------------------------------- concurrent writers

test('a write over someone else\'s newer catalogue is reported', async () => {
    const api = createMockFilesApi();
    await api.writeJson(MANIFEST_FILE, healthy());

    const conflicts = [];
    const storage = createStorage({ api, onConflict: info => conflicts.push(info) });
    await storage.load();

    // Another tab writes while this one is open.
    const theirs = { ...healthy(), rev: 999 };
    await api.writeJson(MANIFEST_FILE, theirs);

    await storage.ensureGroup('g2', 'Second');

    assert.equal(conflicts.length, 1, 'losing another tab\'s work silently is the part to avoid');
    assert.equal(conflicts[0].theirs, 999);
});

test('ordinary consecutive saves are not mistaken for a conflict', async () => {
    const api = createMockFilesApi();
    await api.writeJson(MANIFEST_FILE, healthy());

    const conflicts = [];
    const storage = createStorage({ api, onConflict: info => conflicts.push(info) });
    await storage.load();

    await storage.ensureGroup('g2', 'Second');
    await storage.ensureGroup('g3', 'Third');
    await storage.setLock('img00001', true);

    // Our own writes advance the revision too; a naive check would fire on every save.
    assert.deepEqual(conflicts, []);
});

test('a conflict does not block the write', async () => {
    const api = createMockFilesApi();
    await api.writeJson(MANIFEST_FILE, healthy());

    const storage = createStorage({ api, onConflict: () => {} });
    await storage.load();
    await api.writeJson(MANIFEST_FILE, { ...healthy(), rev: 999 });

    await storage.ensureGroup('g2', 'Second');

    // Refusing would strand the edit the user just made; last write wins, loudly.
    const reopened = createStorage({ api });
    await reopened.load();
    assert.ok(reopened.manifest.groups.g2);
});
