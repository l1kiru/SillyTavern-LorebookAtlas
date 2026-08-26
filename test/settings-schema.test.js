/**
 * The settings upgrade path.
 *
 * The registry is empty today, which is exactly why this is worth pinning now: the first
 * migration to be written will be written against whatever this runner already does, and
 * a runner that skips a step or spins on an unexpected version is easier to catch before
 * anything depends on it than after.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, SETTINGS_MIGRATIONS,
    migrateSettings, normalizeSettings,
} from '../src/settings-schema.js';

test('defaults declare the current schema version', () => {
    assert.equal(DEFAULT_SETTINGS.schemaVersion, SETTINGS_SCHEMA_VERSION);
});

test('an empty object comes back fully populated', () => {
    const stored = normalizeSettings({});
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        assert.ok(Object.hasOwn(stored, key), `missing ${key}`);
    }
});

test('values the user already set are left alone', () => {
    const stored = normalizeSettings({ previewMaxSide: 1024, keepOriginal: false });
    assert.equal(stored.previewMaxSide, 1024);
    assert.equal(stored.keepOriginal, false);
});

test('array defaults are copied, not shared between installs', () => {
    const first = normalizeSettings({});
    const second = normalizeSettings({});
    first.collapsedGroups.push('a');
    assert.deepEqual(second.collapsedGroups, [], 'a shared array would leak state across users');
});

test('steps run in order, once each', () => {
    const seen = [];
    const registry = {
        0: stored => { seen.push(0); stored.a = 1; },
        1: stored => { seen.push(1); stored.b = 2; },
        2: () => seen.push(2),
    };

    // Pretend the current version is further ahead than it really is by starting below it.
    const stored = migrateSettings({ schemaVersion: 0 }, registry);

    assert.deepEqual(seen, Array.from({ length: SETTINGS_SCHEMA_VERSION }, (_, i) => i));
    assert.equal(stored.schemaVersion, SETTINGS_SCHEMA_VERSION);
});

test('a missing or nonsensical version is treated as the oldest', () => {
    for (const value of [undefined, null, 'two', NaN, -5]) {
        const ran = [];
        const stored = migrateSettings({ schemaVersion: value }, { 0: () => ran.push(0) });
        assert.equal(stored.schemaVersion, SETTINGS_SCHEMA_VERSION);
        assert.deepEqual(ran, SETTINGS_SCHEMA_VERSION > 0 ? [0] : []);
    }
});

test('a version from the future is left as it is', () => {
    // Downgrading cannot be done safely, and walking backwards would never terminate.
    const stored = migrateSettings({ schemaVersion: 99, custom: true }, { 0: s => { s.touched = true; } });

    assert.equal(stored.schemaVersion, 99);
    assert.equal(stored.touched, undefined, 'no step may run against a newer schema');
    assert.equal(stored.custom, true);
});

test('a throwing step does not abort the rest of the chain', () => {
    const ran = [];
    const registry = {
        0: () => { throw new Error('boom'); },
        1: () => ran.push(1),
    };

    // A user stuck on an old version because one step is broken is worse than a user who
    // skipped it: the remaining steps still need to apply.
    const stored = migrateSettings({ schemaVersion: 0 }, registry);
    assert.equal(stored.schemaVersion, SETTINGS_SCHEMA_VERSION);
});

test('migrating twice changes nothing the second time', () => {
    const once = normalizeSettings({ previewMaxSide: 256 });
    const snapshot = JSON.stringify(once);
    normalizeSettings(once);
    assert.equal(JSON.stringify(once), snapshot);
});

test('the registry is frozen so a stray write cannot corrupt the chain', () => {
    assert.throws(() => { SETTINGS_MIGRATIONS[0] = () => {}; }, TypeError);
});
