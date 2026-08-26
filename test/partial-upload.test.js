/**
 * What happens when an upload fails halfway.
 *
 * An image has more than one variant, so a failure can leave some files written and others
 * not. This is the one place where the write-ahead ordering can still lose data: dropping
 * the catalogue entry strands whatever did land, and `/api/files` has no listing endpoint,
 * so nothing can ever find those files again — not even `verify()`, which only inspects
 * files the manifest still names.
 *
 * Driven through putImageFromArchive because it takes raw bytes: putImage needs
 * createImageBitmap and cannot run outside a browser. Both share the same unwind path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorage } from '../src/storage.js';
import * as model from '../src/manifest-model.js';
import { MANIFEST_FILE } from '../src/constants.js';
import { parseFileName } from '../src/filenames.js';
import { createMockFilesApi } from './mock-files-api.js';

const bytes = () => new Uint8Array([1, 2, 3, 4]);

const imageFileNames = api => [...api.files.keys()].filter(name => parseFileName(name) !== null);

/**
 * @param {(name: string) => boolean} failUploadOn which upload should throw
 * @param {(path: string) => boolean} [failRemoveOn] which cleanup delete should throw
 */
async function makeStorage({ failUploadOn = () => false, failRemoveOn = () => false } = {}) {
    const api = createMockFilesApi({ failOn: failRemoveOn });

    const realUpload = api.upload.bind(api);
    api.upload = async (name, data) => {
        if (failUploadOn(name)) throw new Error(`upload refused: ${name}`);
        return realUpload(name, data);
    };

    let manifest = model.createManifest();
    manifest = model.upsertGroup(manifest, { id: 'g1', lorebookName: 'Book' });
    await api.writeJson(MANIFEST_FILE, manifest);

    const storage = createStorage({ api });
    await storage.load();
    return { api, storage };
}

const record = {
    id: 'img1',
    groupId: 'g1',
    sha256: 'abc123',
    mime: 'image/png',
    bytes: 4,
    locked: false,
    refs: [],
};

test('a clean two-variant upload leaves both files and one record', async () => {
    const { api, storage } = await makeStorage();

    const result = await storage.putImageFromArchive(record, { preview: bytes(), original: bytes() });

    assert.equal(result.deduplicated, false);
    assert.equal(imageFileNames(api).length, 2);
    assert.ok(storage.manifest.images.img1);
});

test('a failure on the first variant leaves nothing behind', async () => {
    const { api, storage } = await makeStorage({ failUploadOn: name => name.includes('_p_') });

    await assert.rejects(() => storage.putImageFromArchive(record, { preview: bytes(), original: bytes() }));

    assert.deepEqual(imageFileNames(api), []);
    assert.equal(storage.manifest.images.img1, undefined, 'the write-ahead record is rolled back');
});

test('a failure on the second variant removes the one that already landed', async () => {
    // The whole point: without this, the preview stays on disk with nothing pointing at it
    // and no way to enumerate it.
    const { api, storage } = await makeStorage({ failUploadOn: name => name.includes('_o_') });

    await assert.rejects(() => storage.putImageFromArchive(record, { preview: bytes(), original: bytes() }));

    assert.deepEqual(imageFileNames(api), [], 'no orphan file may survive a failed upload');
    assert.equal(storage.manifest.images.img1, undefined);
});

test('when cleanup itself fails the record is kept, not dropped', async () => {
    // A record pointing at a missing file is visible to verify() and can be repaired.
    // An unreferenced file is invisible forever. Keep the recoverable state.
    const { api, storage } = await makeStorage({
        failUploadOn: name => name.includes('_o_'),
        failRemoveOn: () => true,
    });

    await assert.rejects(() => storage.putImageFromArchive(record, { preview: bytes(), original: bytes() }));

    assert.ok(storage.manifest.images.img1, 'the entry must survive so the file stays reachable');
    assert.equal(imageFileNames(api).length, 1);
});

test('the surviving record still points at the stranded file', async () => {
    const { api, storage } = await makeStorage({
        failUploadOn: name => name.includes('_o_'),
        failRemoveOn: () => true,
    });
    await assert.rejects(() => storage.putImageFromArchive(record, { preview: bytes(), original: bytes() }));

    // verify() is the repair path, and it can only see what the manifest names.
    const report = await storage.verify();
    assert.equal(report.missing.length, 1, 'the variant that never uploaded shows as missing');
    assert.deepEqual(report.affectedImages, ['img1']);
    assert.equal(imageFileNames(api).length, 1);
});

test('a failed upload does not corrupt the rest of the catalogue', async () => {
    const { storage } = await makeStorage({ failUploadOn: name => name.includes('_p_') });

    await storage.putImageFromArchive({ ...record, id: 'good', sha256: 'other' }, { original: bytes() });
    await assert.rejects(() => storage.putImageFromArchive(record, { preview: bytes() }));

    assert.ok(storage.manifest.images.good, 'an unrelated image is untouched');
    assert.ok(storage.manifest.groups.g1);
});

test('the rollback survives a reload — it was persisted, not just in memory', async () => {
    const { api, storage } = await makeStorage({ failUploadOn: name => name.includes('_o_') });
    await assert.rejects(() => storage.putImageFromArchive(record, { preview: bytes(), original: bytes() }));

    const reopened = createStorage({ api });
    await reopened.load();
    assert.equal(reopened.manifest.images.img1, undefined);
});
