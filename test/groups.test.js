import test from 'node:test';
import assert from 'node:assert/strict';

import * as model from '../src/manifest-model.js';
import { reconcileGroups, groupLabel, sortGroups, isDeletable } from '../src/groups.js';
import { readGroupId, writeGroupId, ensureGroupId, discoverBindings, STRATEGY } from '../src/lorebook-binding.js';
import { ORPHAN_GROUP_ID } from '../src/constants.js';

const NOW = new Date('2026-08-20T12:00:00Z');

function withGroups() {
    let m = model.createManifest(NOW);
    m = model.upsertGroup(m, { id: 'g1', lorebookName: 'Мой лорбук' }, NOW);
    m = model.upsertGroup(m, { id: 'g2', lorebookName: 'Второй' }, NOW);
    return m;
}

test('renaming a lorebook keeps the group, because binding is by UUID', () => {
    const { manifest, changes } = reconcileGroups(withGroups(), { g1: 'Переименованный', g2: 'Второй' }, NOW);
    assert.equal(manifest.groups.g1.lorebookName, 'Переименованный');
    assert.equal(manifest.groups.g1.displayName, 'Переименованный');
    assert.equal(manifest.groups.g1.orphanedAt, null);
    assert.deepEqual(changes.map(c => c.type), ['renamed']);
});

test('a deleted lorebook orphans its group and keeps the raw last known name', () => {
    const { manifest, changes } = reconcileGroups(withGroups(), { g2: 'Второй' }, NOW);
    assert.ok(manifest.groups.g1.orphanedAt);
    assert.equal(manifest.groups.g1.lorebookName, null);
    assert.deepEqual(changes.map(c => c.type), ['orphaned']);

    // The stored name stays raw. Baking a localized caption into the manifest would
    // freeze one user's language into a file that other users read.
    assert.equal(manifest.groups.g1.lastKnownName, 'Мой лорбук');
    assert.ok(!/deleted|удал/i.test(manifest.groups.g1.displayName));
});

test('the orphan caption is produced at display time, localized', () => {
    const { manifest } = reconcileGroups(withGroups(), { g2: 'Второй' }, NOW);
    assert.equal(groupLabel(manifest.groups.g1), '"Мой лорбук" — deleted 20.08.2026');
});

test('orphaning is idempotent — the date is not rewritten on every sync', () => {
    const first = reconcileGroups(withGroups(), { g2: 'Второй' }, NOW).manifest;
    const later = new Date('2026-09-01T00:00:00Z');
    const second = reconcileGroups(first, { g2: 'Второй' }, later);
    assert.equal(second.manifest.groups.g1.orphanedAt, first.groups.g1.orphanedAt);
    assert.equal(second.changes.length, 0);
});

test('a reimported lorebook un-orphans its group and restores the name', () => {
    const orphaned = reconcileGroups(withGroups(), {}, NOW).manifest;
    const { manifest, changes } = reconcileGroups(orphaned, { g1: 'Мой лорбук', g2: 'Второй' }, NOW);
    assert.equal(manifest.groups.g1.orphanedAt, null);
    assert.equal(groupLabel(manifest.groups.g1), 'Мой лорбук');
    assert.ok(changes.some(c => c.type === 'restored'));
});

test('the system group is never orphaned or deletable', () => {
    const { manifest } = reconcileGroups(withGroups(), {}, NOW);
    assert.equal(manifest.groups[ORPHAN_GROUP_ID].orphanedAt, null);
    assert.equal(isDeletable(manifest, ORPHAN_GROUP_ID), false);
    assert.equal(isDeletable(manifest, 'g1'), true);
});

test('display order is live groups, then orphans, then the system group last', () => {
    const { manifest } = reconcileGroups(withGroups(), { g2: 'Второй' }, NOW);
    const order = sortGroups(manifest).map(g => g.id);
    assert.equal(order[0], 'g2');
    assert.equal(order.at(-1), ORPHAN_GROUP_ID);
});

test('a nameless lorebook still gets a usable generated label', () => {
    const group = { id: 'x', lastKnownName: '', orphanedAt: NOW.toISOString() };
    assert.equal(groupLabel(group), 'Unnamed lorebook — deleted 20.08.2026');
});

test('the system group caption comes from the locale, not from stored text', () => {
    assert.equal(groupLabel({ id: '__orphaned__', system: true, displayName: 'whatever' }), 'Without lorebook');
});

test('binding survives both layouts, so switching strategy loses nothing', () => {
    const bookLevel = { extensions: {}, entries: { 0: {}, 1: {} } };
    writeGroupId(bookLevel, 'uuid-1', STRATEGY.BOOK);
    assert.equal(readGroupId(bookLevel), 'uuid-1');

    const entryLevel = { entries: { 0: {}, 1: {} } };
    writeGroupId(entryLevel, 'uuid-2', STRATEGY.ENTRY);
    assert.equal(readGroupId(entryLevel), 'uuid-2');
    assert.equal(entryLevel.entries[1].extensions.lorebookAtlas.groupId, 'uuid-2');
});

test('ensureGroupId only generates once', () => {
    const book = { entries: { 0: {} } };
    const first = ensureGroupId(book, STRATEGY.ENTRY);
    const second = ensureGroupId(book, STRATEGY.ENTRY);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.groupId, second.groupId);
});

test('discoverBindings builds the map reconcile expects', () => {
    const a = { entries: { 0: {} } };
    const b = { entries: { 0: {} } };
    writeGroupId(a, 'uuid-a', STRATEGY.ENTRY);
    writeGroupId(b, 'uuid-b', STRATEGY.BOOK);
    const discovered = discoverBindings([{ name: 'A', book: a }, { name: 'B', book: b }, { name: 'C', book: { entries: {} } }]);
    assert.deepEqual(discovered, { 'uuid-a': 'A', 'uuid-b': 'B' });
});
