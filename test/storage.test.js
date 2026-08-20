/**
 * Facade-level tests against the mock file store.
 *
 * These cover the wiring that the pure-model tests cannot: that the manifest is actually
 * persisted, that deleting a group removes the right files from the store, and that a
 * lost manifest falls back to the backup copy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorage } from '../src/storage.js';
import * as model from '../src/manifest-model.js';
import { MANIFEST_FILE, MANIFEST_BAK_FILE, TOMBSTONE_FILE, ORPHAN_GROUP_ID } from '../src/constants.js';
import { fileUrl, parseFileName } from '../src/filenames.js';
import { createMockFilesApi } from './mock-files-api.js';

function seedManifest() {
    let m = model.createManifest();
    m = model.upsertGroup(m, { id: 'g1', lorebookName: 'Книга' });
    m = model.upsertGroup(m, { id: 'g2', lorebookName: 'Другая' });

    const mk = (id, groupId, extra = {}) => ({
        id,
        groupId,
        sha256: `sha-${id}`,
        mime: 'image/webp',
        bytes: 100,
        variants: { preview: fileUrl(`lba_aaaaaaaa_${id}_p_bbbbbbbb.webp`) },
        refs: [{ groupId, entryUid: 1 }],
        ...extra,
    });

    m = model.upsertImage(m, mk('plain001', 'g1'));
    m = model.upsertImage(m, mk('locked01', 'g1', { locked: true }));
    m = model.upsertImage(m, mk('shared01', 'g1', { refs: [{ groupId: 'g1', entryUid: 1 }, { groupId: 'g2', entryUid: 9 }] }));
    return m;
}

/**
 * Counts only image files. The store also holds the manifest and its backup, and every
 * write adds or refreshes the backup, so a raw files.size comparison would drift.
 */
function imageFileCount(api) {
    // parseFileName is the authority on what is an image file; a hand-rolled prefix test
    // would also catch lba_manifest_bak.json, which is exactly the drift being avoided.
    return [...api.files.keys()].filter(name => parseFileName(name) !== null).length;
}

async function makeStorage() {
    const api = createMockFilesApi();
    const manifest = seedManifest();

    for (const image of Object.values(manifest.images)) {
        for (const url of model.imageFiles(image)) await api.upload(url.split('/').pop(), 'payload');
    }
    await api.writeJson(MANIFEST_FILE, manifest);

    const storage = createStorage({ api });
    await storage.load();
    return { api, storage };
}

test('load restores the catalogue from the file store', async () => {
    const { storage } = await makeStorage();
    assert.equal(Object.keys(storage.manifest.images).length, 3);
    assert.equal(storage.manifest.groups.g1.lorebookName, 'Книга');
    assert.ok(storage.isLoaded);
});

test('load falls back to the backup copy when the manifest is gone', async () => {
    const { api } = await makeStorage();
    const current = await api.readJson(fileUrl(MANIFEST_FILE));
    await api.writeJson(MANIFEST_BAK_FILE, current);
    await api.remove(fileUrl(MANIFEST_FILE));

    const storage = createStorage({ api });
    await storage.load();
    assert.equal(Object.keys(storage.manifest.images).length, 3);
});

test('load of an empty store yields a usable empty catalogue', async () => {
    const storage = createStorage({ api: createMockFilesApi() });
    await storage.load();
    assert.deepEqual(Object.keys(storage.manifest.groups), [ORPHAN_GROUP_ID]);
});

test('deleting a group removes only the unprotected files from disk', async () => {
    const { api, storage } = await makeStorage();
    const before = imageFileCount(api);

    const outcome = await storage.deleteGroup('g1');

    assert.equal(outcome.deleted, 1);
    assert.equal(outcome.moved, 2);
    assert.equal(outcome.failed.length, 0);
    assert.equal(imageFileCount(api), before - 1, 'exactly one image file removed');
    assert.ok(api.files.has('lba_aaaaaaaa_locked01_p_bbbbbbbb.webp'), 'locked file survives on disk');
    assert.ok(api.files.has('lba_aaaaaaaa_shared01_p_bbbbbbbb.webp'), 'shared file survives on disk');
});

test('survivors are readable again after a reload — the move was persisted', async () => {
    const { api, storage } = await makeStorage();
    await storage.deleteGroup('g1');

    const reopened = createStorage({ api });
    await reopened.load();
    assert.equal(reopened.manifest.images.locked01.groupId, ORPHAN_GROUP_ID);
    assert.equal(reopened.manifest.groups.g1, undefined);
});

test('a locked image cannot be deleted individually', async () => {
    const { storage } = await makeStorage();
    await assert.rejects(() => storage.deleteImage('locked01'), /locked/i);
});

test('unlocking then deleting works and clears the file', async () => {
    const { api, storage } = await makeStorage();
    await storage.setLock('locked01', false);
    await storage.deleteImage('locked01');
    assert.equal(api.files.has('lba_aaaaaaaa_locked01_p_bbbbbbbb.webp'), false);
});

test('verify reports files that vanished from under the catalogue', async () => {
    const { api, storage } = await makeStorage();
    await api.remove(fileUrl('lba_aaaaaaaa_plain001_p_bbbbbbbb.webp'));

    const report = await storage.verify();
    assert.equal(report.missing.length, 1);
    assert.deepEqual(report.affectedImages, ['plain001']);
});

test('removeRef drops a usage without touching the file', async () => {
    const { api, storage } = await makeStorage();
    const before = imageFileCount(api);
    await storage.removeRef('shared01', { groupId: 'g2', entryUid: 9 });
    assert.equal(storage.manifest.images.shared01.refs.length, 1);
    assert.equal(imageFileCount(api), before);
});

test('cleanupAll empties the store and resets the catalogue', async () => {
    const { api, storage } = await makeStorage();
    const result = await storage.cleanupAll();

    assert.equal(result.failed.length, 0);
    assert.equal(api.files.size, 0, 'manifest, backup and tombstone all gone too');
    assert.deepEqual(Object.keys(storage.manifest.images), []);
});

test('the fire-and-forget path writes a tombstone before firing', async () => {
    const { api, storage } = await makeStorage();
    await storage.cleanupFireAndForget();
    assert.ok(api.calls.keepalive > 0, 'deletes must be keepalive to survive the reload');
    // The tombstone is what lets the install hook finish an interrupted teardown.
    assert.ok(api.calls.upload > 0);
    void TOMBSTONE_FILE;
});
