import test from 'node:test';
import assert from 'node:assert/strict';

import * as model from '../src/manifest-model.js';
import { buildTombstone, mergeTombstone, filterOwnFiles, runCleanup, runFireAndForget, resumePendingCleanup } from '../src/cleanup.js';
import { MANIFEST_FILE, TOMBSTONE_FILE } from '../src/constants.js';
import { fileUrl } from '../src/filenames.js';
import { createMockFilesApi } from './mock-files-api.js';

function manifestWith(count) {
    let m = model.createManifest();
    m = model.upsertGroup(m, { id: 'g1', lorebookName: 'Книга' });
    for (let i = 0; i < count; i += 1) {
        const id = `img${String(i).padStart(5, '0')}`;
        m = model.upsertImage(m, {
            id,
            groupId: 'g1',
            sha256: `sha${i}`,
            mime: 'image/webp',
            bytes: 100,
            variants: {
                preview: fileUrl(`lba_aaaaaaaa_${id}_p_bbbbbbbb.webp`),
                original: fileUrl(`lba_aaaaaaaa_${id}_o_bbbbbbbb.webp`),
            },
        });
    }
    return m;
}

test('the tombstone covers every file and puts the manifest last', () => {
    const tombstone = buildTombstone(manifestWith(3));
    assert.equal(tombstone.files.length, 3 * 2 + 2);
    assert.equal(tombstone.files.at(-1), fileUrl(MANIFEST_FILE));
});

test('cleanup never issues a delete for a file it does not own', () => {
    const mixed = ['user/files/lba_aaaaaaaa_img_p_bbbbbbbb.webp', 'user/files/tax-return.pdf', 'user/files/lba_manifest.json'];
    assert.deepEqual(filterOwnFiles(mixed), [mixed[0], mixed[2]]);
});

test('a full cleanup empties the store and removes the tombstone', async () => {
    const api = createMockFilesApi();
    const manifest = manifestWith(4);
    const tombstone = buildTombstone(manifest);

    for (const url of tombstone.files) await api.upload(url.split('/').pop(), 'x');
    await api.writeJson(TOMBSTONE_FILE, tombstone);

    const result = await runCleanup(api, tombstone, { concurrency: 4 });

    assert.equal(result.failed.length, 0);
    assert.equal(result.deleted, tombstone.files.length);
    assert.equal(api.files.size, 0, 'nothing left behind, tombstone included');
});

test('failures are reported and the tombstone is kept for a later resume', async () => {
    const doomed = fileUrl('lba_aaaaaaaa_img00002_p_bbbbbbbb.webp');
    const api = createMockFilesApi({ failOn: path => path === doomed });
    const tombstone = buildTombstone(manifestWith(4));

    for (const url of tombstone.files) await api.upload(url.split('/').pop(), 'x');
    await api.writeJson(TOMBSTONE_FILE, tombstone);

    const result = await runCleanup(api, tombstone, { concurrency: 4 });

    assert.deepEqual(result.failed, [doomed]);
    assert.ok(api.files.has(TOMBSTONE_FILE), 'tombstone survives so install can finish the job');
});

test('an interrupted cleanup is finished by the install hook', async () => {
    const api = createMockFilesApi();
    const tombstone = buildTombstone(manifestWith(3));
    for (const url of tombstone.files) await api.upload(url.split('/').pop(), 'x');
    await api.writeJson(TOMBSTONE_FILE, tombstone);

    // Simulate a teardown that only got through the first two files.
    await api.remove(tombstone.files[0]);
    await api.remove(tombstone.files[1]);

    const resumed = await resumePendingCleanup(api);
    assert.ok(resumed);
    assert.equal(api.files.size, 0);
});

test('install does nothing when there is no tombstone', async () => {
    assert.equal(await resumePendingCleanup(createMockFilesApi()), null);
});

test('the delete hook fires every request with keepalive and awaits none of them', () => {
    const api = createMockFilesApi();
    const tombstone = buildTombstone(manifestWith(5));
    const count = runFireAndForget(api, tombstone);
    assert.equal(count, tombstone.files.length - 0);
    assert.equal(api.calls.keepalive, count, 'all deletes must survive the page reload');
});

test('merging tombstones de-duplicates across a resumed run', () => {
    const a = buildTombstone(manifestWith(2));
    const b = buildTombstone(manifestWith(3));
    const merged = mergeTombstone(a, b);
    assert.equal(merged.files.length, new Set([...a.files, ...b.files]).size);
    assert.equal(merged.createdAt, a.createdAt);
});
