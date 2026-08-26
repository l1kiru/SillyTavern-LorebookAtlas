/**
 * Deduplication as a lifecycle, not a lookup.
 *
 * One file can back entries in several lorebooks. That is the point of hashing, and it is
 * also the way a picture disappears silently: delete one of those lorebooks and, if the
 * shared file is not recognised as shared, it goes with it — the other lorebook keeps a
 * record pointing at nothing, and nobody finds out until they look.
 *
 * The protection lives in planGroupDeletion, which spares anything referenced from another
 * group. It can only work if the references are actually recorded, so these tests follow
 * the whole path rather than the rule in isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorage } from '../src/storage.js';
import * as model from '../src/manifest-model.js';
import { MANIFEST_FILE, ORPHAN_GROUP_ID } from '../src/constants.js';
import { parseFileName } from '../src/filenames.js';
import { createMockFilesApi } from './mock-files-api.js';

const SHA = 'sha-shared-bytes';
const bytes = () => new Uint8Array([9, 9, 9]);
const imageFiles = api => [...api.files.keys()].filter(name => parseFileName(name) !== null);

async function twoLorebooks() {
    const api = createMockFilesApi();

    let manifest = model.createManifest();
    manifest = model.upsertGroup(manifest, { id: 'g1', lorebookName: 'First' });
    manifest = model.upsertGroup(manifest, { id: 'g2', lorebookName: 'Second' });
    await api.writeJson(MANIFEST_FILE, manifest);

    const storage = createStorage({ api });
    await storage.load();
    return { api, storage };
}

/** Restores the same bytes into both lorebooks, as an archive carrying a shared image would. */
async function restoreShared(storage) {
    const base = { sha256: SHA, mime: 'image/png', bytes: 3, locked: false };

    await storage.putImageFromArchive(
        { ...base, id: 'img1', groupId: 'g1', refs: [{ groupId: 'g1', entryUid: 1 }] },
        { preview: bytes() },
    );
    return storage.putImageFromArchive(
        { ...base, id: 'img2', groupId: 'g2', refs: [{ groupId: 'g2', entryUid: 7 }] },
        { preview: bytes() },
    );
}

test('identical bytes are stored once', async () => {
    const { api, storage } = await twoLorebooks();
    const second = await restoreShared(storage);

    assert.equal(second.deduplicated, true);
    assert.equal(imageFiles(api).length, 1, 'the second copy must not be uploaded again');
    assert.equal(Object.keys(storage.manifest.images).length, 1);
});

test('the second lorebook is recorded as a user of the shared image', async () => {
    const { storage } = await twoLorebooks();
    await restoreShared(storage);

    // Without this reference the image looks like it belongs to one lorebook only, and
    // deleting that lorebook takes the picture away from the other one.
    const image = Object.values(storage.manifest.images)[0];
    const groups = new Set(image.refs.map(ref => ref.groupId));
    assert.deepEqual([...groups].sort(), ['g1', 'g2']);
});

test('deleting one lorebook leaves the shared image for the other', async () => {
    const { api, storage } = await twoLorebooks();
    await restoreShared(storage);

    const outcome = await storage.deleteGroup('g1');

    assert.equal(outcome.deleted, 0, 'a shared image is not an ordinary deletion');
    assert.equal(outcome.moved, 1);
    assert.equal(imageFiles(api).length, 1, 'the file itself must survive');

    const image = Object.values(storage.manifest.images)[0];
    assert.equal(image.groupId, ORPHAN_GROUP_ID);
    assert.deepEqual(image.refs, [{ groupId: 'g2', entryUid: 7 }], 'only the dead reference is dropped');
});

test('once the last user is gone the image really is deleted', async () => {
    const { api, storage } = await twoLorebooks();
    await restoreShared(storage);
    await storage.deleteGroup('g1');

    // g2 is now the only holder; removing its reference leaves nothing protecting the file.
    const image = Object.values(storage.manifest.images)[0];
    await storage.removeRef(image.id, { groupId: 'g2', entryUid: 7 });
    await storage.deleteImage(image.id);

    assert.deepEqual(imageFiles(api), []);
    assert.deepEqual(Object.keys(storage.manifest.images), []);
});

test('a lock outranks having no references at all', async () => {
    const { api, storage } = await twoLorebooks();
    await restoreShared(storage);

    const image = Object.values(storage.manifest.images)[0];
    await storage.setLock(image.id, true);

    await storage.deleteGroup('g1');
    assert.equal(imageFiles(api).length, 1);

    await assert.rejects(() => storage.deleteImage(image.id), /locked/i);
});

test('the shared state survives a reload of the catalogue', async () => {
    const { api, storage } = await twoLorebooks();
    await restoreShared(storage);

    const reopened = createStorage({ api });
    await reopened.load();

    const image = Object.values(reopened.manifest.images)[0];
    const groups = new Set(image.refs.map(ref => ref.groupId));
    assert.deepEqual([...groups].sort(), ['g1', 'g2'], 'references must be persisted, not held in memory');
});

test('restoring the same archive twice does not multiply references', async () => {
    const { storage } = await twoLorebooks();
    await restoreShared(storage);
    await restoreShared(storage);

    const image = Object.values(storage.manifest.images)[0];
    assert.equal(image.refs.length, 2, 'a repeated restore is idempotent');
});
