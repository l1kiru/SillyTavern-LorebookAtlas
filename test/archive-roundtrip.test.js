/**
 * Export, restore, export again — the second archive must match the first.
 *
 * Individually every piece is covered: the ZIP codec round-trips, the planner picks the
 * right action, the model merges correctly. What none of them catches is something quietly
 * failing to make the trip. A lock that does not survive, a list definition that is dropped,
 * a reference that is lost — each looks fine in isolation and only shows up as an image
 * that stops being protected, or a lorebook that comes back without its structure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildArchive, readArchive } from '../src/archive.js';
import { applyRestore, planRestore, POLICY } from '../src/restore.js';
import { createStorage } from '../src/storage.js';
import * as model from '../src/manifest-model.js';
import { MANIFEST_FILE } from '../src/constants.js';
import { fileUrl } from '../src/filenames.js';
import { writeGroupId, writeEntryLists, writeEntryCrop, readEntryCrop, readEntryLists, readGroupId } from '../src/lorebook-binding.js';
import { createMockFilesApi } from './mock-files-api.js';

const NOW = new Date('2026-08-20T12:00:00Z');
const encoder = new TextEncoder();

function sourceBook() {
    const book = {
        entries: {
            0: { uid: 0, comment: 'Dragon', key: ['dragon'], content: 'A dragon', extensions: {} },
            1: { uid: 1, comment: 'Griffin', key: ['griffin'], content: 'A griffin', extensions: {} },
        },
    };
    writeGroupId(book, 'g1', 'book');
    writeEntryLists(book.entries[0], ['beasts']);
    writeEntryCrop(book.entries[0], { x: 0.3, y: 0.7, zoom: 2 });
    return book;
}

function sourceManifest() {
    let manifest = model.createManifest(NOW);
    manifest = model.upsertGroup(manifest, { id: 'g1', lorebookName: 'Bestiary' }, NOW);
    manifest = model.upsertImage(manifest, {
        id: 'img1',
        groupId: 'g1',
        sha256: 'abcdef01',
        mime: 'image/webp',
        bytes: 11,
        width: 64,
        height: 48,
        locked: true,
        originalName: 'закат.png',
        refs: [{ groupId: 'g1', entryUid: 0 }],
        variants: { preview: fileUrl('lba_g1000000_img10000_p_abcdef01.webp') },
    }, NOW);
    manifest = model.setGroupLists(manifest, 'g1', {
        beasts: { id: 'beasts', name: 'Beasts', parentId: null, kind: 'manual', createdAt: NOW.toISOString() },
    }, NOW);
    return manifest;
}

const exportOnce = (manifest, book) => buildArchive({
    manifest,
    lorebooks: [{ name: 'Bestiary', groupId: 'g1', book }],
    readImage: async () => encoder.encode('image-bytes'),
    now: NOW,
});

/** Restores an archive into an empty installation and returns what it produced. */
async function restoreInto(archive) {
    const api = createMockFilesApi();
    await api.writeJson(MANIFEST_FILE, model.createManifest(NOW));
    const storage = createStorage({ api });
    await storage.load();

    const saved = {};
    const plan = planRestore({ archive, localBooks: [], now: NOW });
    const report = await applyRestore(plan, archive, {
        loadBook: async name => saved[name] ?? null,
        saveBook: async (name, book) => { saved[name] = book; },
        loadLists: async groupId => storage.listsOf(groupId),
        ensureGroup: async (groupId, name) => { await storage.ensureGroup(groupId, name); },
        setLists: async (groupId, lists) => { await storage.setLists(groupId, lists); },
        putImage: async (record, bytes) => { await storage.putImageFromArchive(record, bytes); },
    });

    assert.deepEqual(report.failed, [], 'the restore itself must succeed');
    return { storage, saved };
}

test('a lorebook survives the trip with its entries intact', async () => {
    const archive = readArchive((await exportOnce(sourceManifest(), sourceBook())).bytes);
    const { saved } = await restoreInto(archive);

    const book = saved.Bestiary;
    assert.ok(book);
    assert.deepEqual(Object.values(book.entries).map(e => e.comment).sort(), ['Dragon', 'Griffin']);
    assert.equal(readGroupId(book), 'g1', 'the binding travels, so the images find their lorebook again');
});

test('list membership and crop ride inside the entries', async () => {
    const archive = readArchive((await exportOnce(sourceManifest(), sourceBook())).bytes);
    const { saved } = await restoreInto(archive);

    const dragon = Object.values(saved.Bestiary.entries).find(e => e.comment === 'Dragon');
    assert.deepEqual(readEntryLists(dragon), ['beasts']);
    assert.deepEqual(readEntryCrop(dragon), { x: 0.3, y: 0.7, zoom: 2 });
});

test('list definitions and the lock come back', async () => {
    const archive = readArchive((await exportOnce(sourceManifest(), sourceBook())).bytes);
    const { storage } = await restoreInto(archive);

    assert.equal(storage.listsOf('g1').beasts?.name, 'Beasts', 'definitions live in the manifest, not the lorebook');

    const image = Object.values(storage.manifest.images)[0];
    assert.equal(image.locked, true, 'an unlocked restore would drop the protection silently');
    assert.equal(image.originalName, 'закат.png', 'non-ASCII metadata survives the ASCII-only filenames');
});

test('exporting what was restored produces the same archive', async () => {
    const first = readArchive((await exportOnce(sourceManifest(), sourceBook())).bytes);
    const { storage, saved } = await restoreInto(first);

    const second = readArchive((await buildArchive({
        manifest: storage.manifest,
        lorebooks: [{ name: 'Bestiary', groupId: 'g1', book: saved.Bestiary }],
        readImage: async () => encoder.encode('image-bytes'),
        now: NOW,
    })).bytes);

    // Anything that fails to make the trip shows up as a difference on the second lap.
    const strip = meta => ({
        lorebooks: meta.lorebooks.map(({ name, groupId, lists }) => ({ name, groupId, lists })),
        images: Object.values(meta.images).map(({ sha256, locked, originalName, refs }) => ({
            sha256, locked, originalName, refs,
        })),
    });

    assert.deepEqual(strip(second.meta), strip(first.meta));
});

test('the entries themselves are unchanged by a lap', async () => {
    const first = readArchive((await exportOnce(sourceManifest(), sourceBook())).bytes);
    const { saved } = await restoreInto(first);

    // The group binding is deliberately excluded: where it is written is a setting, and a
    // restore is allowed to lay it out per its own configuration. Everything the user
    // actually authored has to come back byte for byte.
    const authored = entries => Object.values(entries)
        .map(e => ({ comment: e.comment, content: e.content, key: e.key, lists: readEntryLists(e), crop: readEntryCrop(e) }))
        .sort((a, b) => a.comment.localeCompare(b.comment));

    assert.deepEqual(authored(saved.Bestiary.entries), authored(first.lorebooks[0].book.entries));
});

test('a restore honours the configured binding layout', async () => {
    const first = readArchive((await exportOnce(sourceManifest(), sourceBook())).bytes);
    const api = createMockFilesApi();
    await api.writeJson(MANIFEST_FILE, model.createManifest(NOW));
    const storage = createStorage({ api });
    await storage.load();

    const saved = {};
    await applyRestore(planRestore({ archive: first, localBooks: [], now: NOW }), first, {
        loadBook: async name => saved[name] ?? null,
        saveBook: async (name, book) => { saved[name] = book; },
        loadLists: async groupId => storage.listsOf(groupId),
        ensureGroup: async (groupId, name) => { await storage.ensureGroup(groupId, name); },
        setLists: async (groupId, lists) => { await storage.setLists(groupId, lists); },
        putImage: async (record, bytes) => { await storage.putImageFromArchive(record, bytes); },
    }, { bindingStrategy: 'book' });

    // Ignoring the setting would silently move every user's binding to the other location.
    assert.equal(saved.Bestiary.extensions?.lorebookAtlas?.groupId, 'g1');
    assert.equal(saved.Bestiary.entries[1].extensions?.lorebookAtlas?.groupId, undefined);
});

test('a merge on the second lap adds nothing, because nothing is new', async () => {
    const archive = readArchive((await exportOnce(sourceManifest(), sourceBook())).bytes);
    const { saved } = await restoreInto(archive);

    // Restoring an archive over the lorebook it came from should be a no-op, not a
    // duplicate of every entry.
    const plan = planRestore({
        archive,
        localBooks: [{ name: 'Bestiary', book: saved.Bestiary }],
        defaultPolicy: POLICY.MERGE,
        now: NOW,
    });

    const item = plan.items[0];
    assert.equal(item.entries.matched, 2);
    assert.equal(item.entries.incomingOnly, 0, 'every entry must be recognised as already present');
    assert.equal(item.entries.localOnly, 0);
});
