/**
 * The group binding has to survive being written.
 *
 * These cover the failure that made creating lists lose data: the id was reported as
 * created but was not actually stored anywhere findable, so the next read minted a new one
 * and every list attached to the previous id was stranded under a group nothing referenced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureGroupId, readGroupId, writeGroupId, clearGroupId, STRATEGY } from '../src/lorebook-binding.js';

const withEntries = () => ({ entries: { 0: { uid: 0, extensions: {} }, 1: { uid: 1, extensions: {} } } });
const withoutEntries = () => ({ entries: {} });

test('an id written into a lorebook can be read back', () => {
    for (const strategy of Object.values(STRATEGY)) {
        for (const book of [withEntries(), withoutEntries()]) {
            const { groupId } = ensureGroupId(book, strategy);
            assert.equal(readGroupId(book), groupId, `${strategy} lost the id`);
        }
    }
});

test('a lorebook with no entries still holds the id', () => {
    // The entry strategy has nowhere to write when there are no entries. Reporting success
    // while storing nothing is what made every call mint a fresh id.
    const book = withoutEntries();
    const { groupId, created } = ensureGroupId(book, STRATEGY.ENTRY);

    assert.equal(created, true);
    assert.equal(readGroupId(book), groupId);
});

test('ensureGroupId is idempotent, so lists stay attached to one group', () => {
    for (const book of [withEntries(), withoutEntries()]) {
        const first = ensureGroupId(book, STRATEGY.ENTRY);
        const second = ensureGroupId(book, STRATEGY.ENTRY);

        assert.equal(second.created, false);
        assert.equal(second.groupId, first.groupId, 'a second call must not mint a new id');
    }
});

test('an id survives entries appearing later', () => {
    // Lists can be created before any entry exists; the binding must not change when the
    // lorebook is filled in afterwards.
    const book = withoutEntries();
    const { groupId } = ensureGroupId(book, STRATEGY.ENTRY);

    book.entries = { 0: { uid: 0, extensions: {} } };
    const after = ensureGroupId(book, STRATEGY.ENTRY);

    assert.equal(after.created, false);
    assert.equal(after.groupId, groupId);
    assert.equal(readGroupId(book), groupId);
});

test('rebinding replaces the old id everywhere, leaving exactly one', () => {
    const book = withEntries();
    writeGroupId(book, 'first', STRATEGY.BOOK);
    writeGroupId(book, 'second', STRATEGY.ENTRY);

    assert.equal(readGroupId(book), 'second', 'a stale book-level id must not win the lookup');

    const ids = new Set(Object.values(book.entries).map(e => e.extensions?.lorebookAtlas?.groupId));
    assert.deepEqual([...ids], ['second']);
});

test('clearing removes the binding from both locations', () => {
    const book = withEntries();
    writeGroupId(book, 'x', STRATEGY.ENTRY);
    clearGroupId(book);
    assert.equal(readGroupId(book), null);

    const empty = withoutEntries();
    writeGroupId(empty, 'y', STRATEGY.ENTRY);
    clearGroupId(empty);
    assert.equal(readGroupId(empty), null);
});

test('the binding lands in the object it was handed, not a copy', () => {
    // The explorer holds one lorebook object and saves it; anything written into a second
    // copy is overwritten by that save.
    const book = withEntries();
    const snapshot = JSON.stringify(book);
    const { groupId } = ensureGroupId(book, STRATEGY.ENTRY);

    assert.notEqual(JSON.stringify(book), snapshot, 'the caller\'s object must be the one mutated');
    assert.equal(readGroupId(JSON.parse(JSON.stringify(book))), groupId, 'and it must survive serialisation');
});
