/**
 * Group identity and lifecycle.
 *
 * A group is bound to a lorebook by a UUID written *into the lorebook*, not by its name,
 * so renaming a lorebook does not orphan its images. Where exactly that UUID lives is
 * kept behind one interface in lorebook-binding.js, so this module never has to care.
 *
 * Note what is *not* stored: the "deleted on ..." caption for an orphaned group. Only the
 * raw last known name and the timestamp go into the manifest; the caption is rendered at
 * display time by groupLabel(). Persisting a localized string would freeze one user's
 * language into a data file that other users read.
 */

import { ORPHAN_GROUP_ID } from './constants.js';
import { T } from './i18n.js';
import { formatDate } from './util.js';

/**
 * Localized caption for a group, including the orphan decoration where applicable.
 * @param {object} group
 */
export function groupLabel(group) {
    if (!group) return '';
    if (group.system) return T('group.orphanBucket');
    if (!group.orphanedAt) return group.displayName || group.lastKnownName || group.id;

    const date = formatDate(new Date(group.orphanedAt));
    const name = String(group.lastKnownName || '').trim();
    return name
        ? T('group.orphanedLabel', { name, date })
        : T('group.orphanedUnnamed', { date });
}

/**
 * Reconciles the catalogue against what is actually present in World Info.
 *
 * @param {object} manifest
 * @param {Record<string, string>} discovered Map of groupId → current lorebook name,
 *        built by scanning every lorebook for our binding.
 * @param {Date} [now]
 * @returns {{ manifest: object, changes: Array<{ groupId: string, type: 'renamed'|'orphaned'|'restored', from?: string, to?: string }> }}
 */
export function reconcileGroups(manifest, discovered = {}, now = new Date()) {
    const next = typeof structuredClone === 'function' ? structuredClone(manifest) : JSON.parse(JSON.stringify(manifest));
    const changes = [];

    for (const group of Object.values(next.groups)) {
        if (group.system) continue;

        const currentName = discovered[group.id];

        if (currentName) {
            // The lorebook exists. Pick up renames and undo any previous orphaning —
            // a book can come back through an import or a restored backup.
            if (group.orphanedAt) {
                changes.push({ groupId: group.id, type: 'restored', to: currentName });
                group.orphanedAt = null;
            } else if (group.lorebookName !== currentName) {
                changes.push({ groupId: group.id, type: 'renamed', from: group.lorebookName, to: currentName });
            }
            group.lorebookName = currentName;
            group.lastKnownName = currentName;
            group.displayName = currentName;
            continue;
        }

        // The lorebook is gone. Record the fact once; the caption is rendered later.
        if (!group.orphanedAt) {
            group.orphanedAt = (now instanceof Date ? now : new Date(now)).toISOString();
            group.lorebookName = null;
            changes.push({ groupId: group.id, type: 'orphaned', from: group.lastKnownName });
        }
    }

    if (changes.length) {
        next.rev += 1;
        next.updatedAt = (now instanceof Date ? now : new Date(now)).toISOString();
    }

    return { manifest: next, changes };
}

/**
 * Ordering for every storage-browsing view: live groups alphabetically, then orphaned
 * lorebooks by when they were lost, then the system group pinned to the bottom.
 */
export function sortGroups(manifest, locale = undefined) {
    const groups = Object.values(manifest.groups);
    const live = groups.filter(g => !g.system && !g.orphanedAt);
    const orphaned = groups.filter(g => !g.system && g.orphanedAt);
    const system = groups.filter(g => g.system);

    const byName = (a, b) => groupLabel(a).localeCompare(groupLabel(b), locale);
    const byOrphanDate = (a, b) => String(b.orphanedAt).localeCompare(String(a.orphanedAt));

    return [...live.sort(byName), ...orphaned.sort(byOrphanDate), ...system];
}

/** True when the group may be deleted as a whole. */
export function isDeletable(manifest, groupId) {
    const group = manifest.groups[groupId];
    return Boolean(group) && !group.system && groupId !== ORPHAN_GROUP_ID;
}
