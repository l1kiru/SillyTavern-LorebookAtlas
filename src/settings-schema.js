/**
 * Stored settings: the schema version and how older shapes are brought forward.
 *
 * Kept out of the entry point so the upgrade path can be exercised without SillyTavern.
 * The registry is empty today; the machinery is here from the start because without a
 * version there is no way to repair a bad default once it has been written into every
 * user's settings.json.
 */

import { STRATEGY } from './lorebook-binding.js';

export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    enabled: true,
    bindingStrategy: STRATEGY.ENTRY,
    keepOriginal: true,
    previewMaxSide: 512,
    includeSettingsInArchive: false,
    collapsedGroups: [],
});

/**
 * Upgrade steps, keyed by the version each one upgrades *from*, so a user several versions
 * behind runs them all in order. Empty until the first breaking change.
 * @type {Record<number, (stored: object) => void>}
 */
export const SETTINGS_MIGRATIONS = Object.freeze({});

/**
 * Brings stored settings up to the current schema.
 *
 * A missing or nonsensical version counts as 0, and a version from the future is left
 * alone rather than walked backwards — downgrading is not something this can do safely,
 * and looping on it would hang the load.
 *
 * @param {object} stored mutated in place
 * @param {object} [registry] injectable for tests
 * @returns {object} the same object
 */
export function migrateSettings(stored, registry = SETTINGS_MIGRATIONS) {
    let version = Number(stored.schemaVersion);
    if (!Number.isFinite(version) || version < 0) version = 0;

    while (version < SETTINGS_SCHEMA_VERSION) {
        const step = registry[version];
        if (step) {
            try {
                step(stored);
            } catch (error) {
                console.error(`[lorebook-atlas] settings migration ${version} failed:`, error);
            }
        }
        version += 1;
    }

    stored.schemaVersion = Math.max(version, SETTINGS_SCHEMA_VERSION);
    return stored;
}

/** Fills in anything the stored object is missing and upgrades it if needed. */
export function normalizeSettings(stored, registry = SETTINGS_MIGRATIONS) {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(stored, key)) stored[key] = structuredClone(value);
    }
    if (Number(stored.schemaVersion) !== SETTINGS_SCHEMA_VERSION) migrateSettings(stored, registry);
    return stored;
}
