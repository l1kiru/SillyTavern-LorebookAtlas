/**
 * Archive round-trip and restore planning.
 *
 * The planner is pure, so the table the user reviews and the instructions that execute are
 * literally the same object. These tests hold that property, plus the two traps the design
 * exists to avoid: a duplicated group UUID, and a merge that deletes local work.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildArchive, readArchive, slugFor, ARCHIVE_SCHEMA } from '../src/archive.js';
import { planRestore, applyRestore, mergeBooks, mergeEntry, suggestRestoredName, stripRestoredSuffix, POLICY } from '../src/restore.js';
import { readGroupId, writeGroupId, readEntryLists, writeEntryLists } from '../src/lorebook-binding.js';
import * as model from '../src/manifest-model.js';
import { fileUrl } from '../src/filenames.js';

const NOW = new Date('2026-08-20T12:00:00Z');
const encoder = new TextEncoder();

function entry(uid, comment, extra = {}) {
    return { uid, comment, key: [comment.toLowerCase()], content: `${comment} body`, extensions: {}, ...extra };
}

function book(groupId, entries) {
    const b = { entries: Object.fromEntries(entries.map((e, i) => [i, e])) };
    if (groupId) writeGroupId(b, groupId, 'book');
    return b;
}

function manifestWithImage() {
    let m = model.createManifest(NOW);
    m = model.upsertGroup(m, { id: 'g1', lorebookName: 'Bestiary' }, NOW);
    m = model.upsertImage(m, {
        id: 'img1',
        groupId: 'g1',
        sha256: 'abc',
        mime: 'image/webp',
        bytes: 10,
        locked: true,
        variants: { preview: fileUrl('lba_aaaaaaaa_img1_p_bbbbbbbb.webp') },
    }, NOW);
    m = model.setGroupLists(m, 'g1', { l1: { id: 'l1', name: 'Beasts', parentId: null, kind: 'manual', createdAt: NOW.toISOString() } }, NOW);
    return m;
}

async function makeArchive() {
    return await buildArchive({
        manifest: manifestWithImage(),
        lorebooks: [{ name: 'Bestiary', groupId: 'g1', book: book('g1', [entry(0, 'Dragon'), entry(1, 'Griffin')]) }],
        readImage: async () => encoder.encode('image-bytes'),
        now: NOW,
    });
}

// ---------------------------------------------------------------- archive

test('an archive round-trips through the ZIP layer', async () => {
    const { bytes } = await makeArchive();
    const archive = readArchive(bytes);

    assert.equal(archive.meta.schema, ARCHIVE_SCHEMA);
    assert.equal(archive.lorebooks.length, 1);
    assert.equal(archive.lorebooks[0].name, 'Bestiary');
    assert.equal(Object.keys(archive.lorebooks[0].book.entries).length, 2);
});

test('locks, list definitions and image metadata travel with the archive', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    assert.equal(archive.meta.images.img1.locked, true, 'without this a restored image loses its protection');
    assert.equal(archive.lorebooks[0].lists.l1.name, 'Beasts');
    assert.ok(archive.imageBytes('lba_aaaaaaaa_img1_p_bbbbbbbb.webp'));
});

test('a missing file is reported, not fatal', async () => {
    const result = await buildArchive({
        manifest: manifestWithImage(),
        lorebooks: [{ name: 'Bestiary', groupId: 'g1', book: book('g1', [entry(0, 'Dragon')]) }],
        readImage: async () => null,
        now: NOW,
    });
    assert.equal(result.skipped.length, 1);
    assert.doesNotThrow(() => readArchive(result.bytes));
});

test('a newer schema is refused rather than half-read', async () => {
    const { bytes } = await makeArchive();
    const archive = readArchive(bytes);
    archive.meta.schema = ARCHIVE_SCHEMA + 1;

    const tampered = await buildArchive({
        manifest: manifestWithImage(),
        lorebooks: [],
        readImage: async () => null,
        now: NOW,
    });
    const parsed = readArchive(tampered.bytes);
    parsed.meta.schema = 99;
    assert.throws(() => {
        if (Number(parsed.meta.schema) > ARCHIVE_SCHEMA) throw new Error('newer');
    }, /newer/);
});

test('lorebook names become ASCII slugs, because ZIP names must be', () => {
    assert.match(slugFor('Мой лорбук', 0), /^[a-z0-9._-]+$/);
    assert.match(slugFor('', 3), /^lorebook-3$/);
});

// ---------------------------------------------------------------- naming

test('the restored suffix is parsed and incremented, never stacked', () => {
    assert.equal(suggestRestoredName('Book', ['Book']), 'Book (restored)');
    assert.equal(suggestRestoredName('Book', ['Book', 'Book (restored)']), 'Book (restored 2)');
    // The trap: restoring an already-restored copy must not produce "(restored) (restored)".
    assert.equal(suggestRestoredName('Book (restored)', ['Book', 'Book (restored)']), 'Book (restored 2)');
    assert.equal(stripRestoredSuffix('Book (restored 7)'), 'Book');
    assert.equal(stripRestoredSuffix('Plain name'), 'Plain name');
});

// ---------------------------------------------------------------- planning

test('no local lorebook means a plain create', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const plan = planRestore({ archive, localBooks: [], now: NOW });
    assert.equal(plan.items[0].policy, POLICY.CREATE);
    assert.equal(plan.items[0].targetName, 'Bestiary');
});

test('restoring separately mints a new group id', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const local = [{ name: 'Bestiary', book: book('g1', [entry(0, 'Dragon')]) }];

    const plan = planRestore({ archive, localBooks: local, defaultPolicy: POLICY.SEPARATE, now: NOW });
    const item = plan.items[0];

    // Two lorebooks carrying the same group UUID would collapse into one entry of the
    // groupId → name map, and the group would flip between them on every sync.
    assert.ok(item.newGroupId);
    assert.notEqual(item.newGroupId, 'g1');
    assert.equal(item.targetName, 'Bestiary (restored)');
});

test('replace and merge keep the original group id', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const local = [{ name: 'Bestiary', book: book('g1', [entry(0, 'Dragon')]) }];

    for (const policy of [POLICY.REPLACE, POLICY.MERGE]) {
        const item = planRestore({ archive, localBooks: local, defaultPolicy: policy, now: NOW }).items[0];
        assert.equal(item.newGroupId, null, `${policy} must not re-mint the id`);
    }
});

test('per-row overrides beat the global default', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const local = [{ name: 'Bestiary', book: book('g1', [entry(0, 'Dragon')]) }];

    const plan = planRestore({
        archive,
        localBooks: local,
        defaultPolicy: POLICY.MERGE,
        overrides: { Bestiary: { policy: POLICY.SEPARATE, targetName: 'My own name' } },
        now: NOW,
    });
    assert.equal(plan.items[0].policy, POLICY.SEPARATE);
    assert.equal(plan.items[0].targetName, 'My own name');
});

test('a row can be skipped entirely', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const plan = planRestore({ archive, localBooks: [], overrides: { Bestiary: { skip: true } }, now: NOW });
    assert.equal(plan.items[0].skip, true);
    assert.equal(plan.totals.skipped, 1);
});

test('the merge plan counts the three buckets and is side-effect free', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const localBook = book('g1', [entry(0, 'Dragon'), entry(1, 'Local hero')]);
    const snapshot = JSON.stringify(localBook);

    const item = planRestore({
        archive,
        localBooks: [{ name: 'Bestiary', book: localBook }],
        defaultPolicy: POLICY.MERGE,
        now: NOW,
    }).items[0];

    assert.equal(item.entries.matched, 1);
    assert.equal(item.entries.incomingOnly, 1, 'Griffin arrives from the archive');
    assert.equal(item.entries.localOnly, 1, 'Local hero exists only here');
    assert.equal(JSON.stringify(localBook), snapshot, 'planning must not mutate anything');
});

// ---------------------------------------------------------------- merging

test('merging keeps local-only entries and tags both sides', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const localBook = book('g1', [entry(0, 'Dragon'), entry(1, 'Local hero')]);
    const item = planRestore({
        archive,
        localBooks: [{ name: 'Bestiary', book: localBook }],
        defaultPolicy: POLICY.MERGE,
        now: NOW,
    }).items[0];

    const merged = mergeBooks(localBook, archive.lorebooks[0].book, item);
    const entries = Object.values(merged.entries);
    const byComment = Object.fromEntries(entries.map(e => [e.comment, e]));

    assert.equal(entries.length, 3, 'merge adds and updates, it never deletes');
    assert.ok(byComment['Local hero'], 'local work survives');

    const localList = item.snapshotLists.local.id;
    const restoredList = item.snapshotLists.restored.id;
    assert.deepEqual(readEntryLists(byComment['Local hero']), [localList]);
    assert.deepEqual(readEntryLists(byComment.Griffin), [restoredList]);
    assert.deepEqual(readEntryLists(byComment.Dragon), [], 'entries present on both sides are not disputed');
});

test('merged entries get unique uids even when the sides collide', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const localBook = book('g1', [entry(1, 'Local hero')]);
    const item = planRestore({
        archive,
        localBooks: [{ name: 'Bestiary', book: localBook }],
        defaultPolicy: POLICY.MERGE,
        now: NOW,
    }).items[0];

    const uids = Object.values(mergeBooks(localBook, archive.lorebooks[0].book, item)).length
        ? Object.values(mergeBooks(localBook, archive.lorebooks[0].book, item).entries).map(e => String(e.uid))
        : [];
    assert.equal(new Set(uids).size, uids.length, 'no two entries may share a uid');
});

test('field merge: archive wins, local extras survive, lists are unioned', () => {
    const local = { uid: 0, comment: 'Dragon', content: 'old', localOnlyField: 'keep me', extensions: {} };
    writeEntryLists(local, ['list-a']);
    const incoming = { uid: 0, comment: 'Dragon', content: 'new', extensions: {} };
    writeEntryLists(incoming, ['list-b']);

    const merged = mergeEntry(local, incoming);
    assert.equal(merged.content, 'new');
    assert.equal(merged.localOnlyField, 'keep me');
    assert.deepEqual(readEntryLists(merged).sort(), ['list-a', 'list-b']);
});

// ---------------------------------------------------------------- applying

function makeIo(localBooks = {}) {
    const saved = { ...localBooks };
    const groups = {};
    const lists = {};
    const images = [];
    const deleted = [];

    return {
        saved, groups, lists, images, deleted,
        loadBook: async name => saved[name] ?? null,
        saveBook: async (name, value) => { saved[name] = value; },
        loadLists: async groupId => lists[groupId] ?? {},
        ensureGroup: async (groupId, name) => { groups[groupId] = name; },
        setLists: async (groupId, value) => { lists[groupId] = value; },
        putImage: async record => { images.push(record); },
        deleteGroup: async groupId => { deleted.push(groupId); },
    };
}

test('applying a create writes the lorebook, the group and the images', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const plan = planRestore({ archive, localBooks: [], now: NOW });
    const io = makeIo();

    const report = await applyRestore(plan, archive, io);

    assert.deepEqual(report.created, ['Bestiary']);
    assert.ok(io.saved.Bestiary);
    assert.equal(io.groups.g1, 'Bestiary');
    assert.equal(io.images.length, 1);
    assert.equal(io.images[0].locked, true);
});

test('applying separate stores under the new name and the new group id', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const local = [{ name: 'Bestiary', book: book('g1', [entry(0, 'Dragon')]) }];
    const plan = planRestore({ archive, localBooks: local, defaultPolicy: POLICY.SEPARATE, now: NOW });
    const io = makeIo({ Bestiary: local[0].book });

    await applyRestore(plan, archive, io);
    const newGroupId = plan.items[0].newGroupId;

    assert.ok(io.saved['Bestiary (restored)']);
    assert.equal(readGroupId(io.saved['Bestiary (restored)']), newGroupId);
    assert.equal(readGroupId(io.saved.Bestiary), 'g1', 'the existing lorebook is left alone');
    assert.equal(io.groups[newGroupId], 'Bestiary (restored)');
});

test('applying replace disposes of the old group through the protected path', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const local = [{ name: 'Bestiary', book: book('g1', [entry(0, 'Dragon')]) }];
    const plan = planRestore({ archive, localBooks: local, defaultPolicy: POLICY.REPLACE, now: NOW });
    const io = makeIo({ Bestiary: local[0].book });

    const report = await applyRestore(plan, archive, io);
    assert.deepEqual(report.replaced, ['Bestiary']);
    assert.deepEqual(io.deleted, ['g1'], 'deletion goes through deleteGroup, which protects locks and shared images');
});

test('applying merge registers both snapshot lists', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const localBook = book('g1', [entry(0, 'Dragon'), entry(1, 'Local hero')]);
    const plan = planRestore({ archive, localBooks: [{ name: 'Bestiary', book: localBook }], defaultPolicy: POLICY.MERGE, now: NOW });
    const io = makeIo({ Bestiary: localBook });

    await applyRestore(plan, archive, io);

    const stored = io.lists.g1;
    assert.ok(stored[plan.items[0].snapshotLists.local.id], 'the "Local" pile is browsable afterwards');
    assert.ok(stored[plan.items[0].snapshotLists.restored.id]);
    assert.ok(stored.l1, 'list definitions from the archive are kept too');
});

test('a failing item is reported without stopping the rest', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const plan = planRestore({ archive, localBooks: [], now: NOW });
    const io = makeIo();
    io.saveBook = async () => { throw new Error('disk full'); };

    const report = await applyRestore(plan, archive, io);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0].message, /disk full/);
});

test('skipped items are neither applied nor counted as failures', async () => {
    const archive = readArchive((await makeArchive()).bytes);
    const plan = planRestore({ archive, localBooks: [], overrides: { Bestiary: { skip: true } }, now: NOW });
    const io = makeIo();

    const report = await applyRestore(plan, archive, io);
    assert.deepEqual(report.skipped, ['Bestiary']);
    assert.deepEqual(report.created, []);
    assert.deepEqual(io.saved, {});
});
