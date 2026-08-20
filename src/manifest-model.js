/**
 * Pure operations over the catalogue object (lba_manifest.json).
 *
 * Nothing here touches the network or the DOM: every function takes a manifest and
 * returns a new one, so the interesting logic — group deletion with locks and
 * cross-references, orphan reconciliation — is testable without a browser.
 */

import { SCHEMA_VERSION, ORPHAN_GROUP_ID, ORPHAN_GROUP_NAME } from './constants.js';
import { T } from './i18n.js';
import { normalizeLists } from './lists.js';

function clone(value) {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function nowIso(now) {
    return (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
}

/** A fresh, empty catalogue containing only the system orphan group. */
export function createManifest(now = new Date()) {
    return {
        schema: SCHEMA_VERSION,
        rev: 0,
        updatedAt: nowIso(now),
        groups: {
            [ORPHAN_GROUP_ID]: {
                id: ORPHAN_GROUP_ID,
                system: true,
                displayName: ORPHAN_GROUP_NAME,
                lastKnownName: ORPHAN_GROUP_NAME,
                lorebookName: null,
                orphanedAt: null,
                createdAt: nowIso(now),
            },
        },
        images: {},
        // List definitions per lorebook, keyed by groupId. Membership itself lives inside
        // the entries; only the definitions are kept here.
        lists: {},
    };
}

/**
 * Defensive normalisation of anything read off disk. A manifest that fails to parse is
 * worse than useless — with no listing endpoint it is the only map to our own files — so
 * unknown shapes are repaired rather than rejected.
 */
export function normalizeManifest(raw, now = new Date()) {
    const base = createManifest(now);
    if (!raw || typeof raw !== 'object') return base;

    const out = {
        schema: SCHEMA_VERSION,
        rev: Number.isFinite(raw.rev) ? Math.max(0, Math.floor(raw.rev)) : 0,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(now),
        groups: { ...base.groups },
        images: {},
        lists: {},
    };

    for (const [groupId, lists] of Object.entries(raw.lists || {})) {
        out.lists[groupId] = normalizeLists(lists);
    }

    for (const [id, group] of Object.entries(raw.groups || {})) {
        if (!group || typeof group !== 'object') continue;
        out.groups[id] = {
            id,
            system: id === ORPHAN_GROUP_ID,
            displayName: String(group.displayName || group.lorebookName || group.lastKnownName || id),
            lastKnownName: String(group.lastKnownName || group.lorebookName || group.displayName || ''),
            lorebookName: group.lorebookName == null ? null : String(group.lorebookName),
            orphanedAt: group.orphanedAt == null ? null : String(group.orphanedAt),
            createdAt: String(group.createdAt || nowIso(now)),
        };
    }
    // The system group is never allowed to be dropped or shadowed by bad data.
    out.groups[ORPHAN_GROUP_ID] = { ...base.groups[ORPHAN_GROUP_ID], ...out.groups[ORPHAN_GROUP_ID], id: ORPHAN_GROUP_ID, system: true };

    for (const [id, image] of Object.entries(raw.images || {})) {
        if (!image || typeof image !== 'object') continue;
        const variants = {};
        for (const [variant, url] of Object.entries(image.variants || {})) {
            if (url) variants[variant] = String(url);
        }
        const groupId = out.groups[image.groupId] ? image.groupId : ORPHAN_GROUP_ID;
        out.images[id] = {
            id,
            groupId,
            locked: Boolean(image.locked),
            sha256: String(image.sha256 || ''),
            mime: String(image.mime || ''),
            bytes: Number(image.bytes) || 0,
            width: Number(image.width) || 0,
            height: Number(image.height) || 0,
            originalName: String(image.originalName || ''),
            createdAt: String(image.createdAt || nowIso(now)),
            movedFrom: image.movedFrom ? String(image.movedFrom) : null,
            variants,
            refs: Array.isArray(image.refs)
                ? image.refs
                    .filter(r => r && typeof r === 'object')
                    .map(r => ({ groupId: String(r.groupId || ''), entryUid: r.entryUid }))
                    .filter(r => r.groupId)
                : [],
        };
    }

    return out;
}

function touch(manifest, now) {
    manifest.rev += 1;
    manifest.updatedAt = nowIso(now);
    return manifest;
}

export function upsertGroup(manifest, { id, lorebookName, displayName }, now = new Date()) {
    const next = clone(manifest);
    const existing = next.groups[id];
    next.groups[id] = {
        id,
        system: id === ORPHAN_GROUP_ID,
        displayName: String(displayName || lorebookName || existing?.displayName || id),
        lastKnownName: String(lorebookName || existing?.lastKnownName || ''),
        lorebookName: lorebookName == null ? (existing?.lorebookName ?? null) : String(lorebookName),
        orphanedAt: existing?.orphanedAt ?? null,
        createdAt: existing?.createdAt || nowIso(now),
    };
    return touch(next, now);
}

export function upsertImage(manifest, image, now = new Date()) {
    const next = clone(manifest);
    if (!next.groups[image.groupId]) throw new Error(`Unknown group: ${image.groupId}`);
    next.images[image.id] = {
        locked: false,
        refs: [],
        movedFrom: null,
        createdAt: nowIso(now),
        ...next.images[image.id],
        ...image,
    };
    return touch(next, now);
}

export function removeImage(manifest, imageId, now = new Date()) {
    const next = clone(manifest);
    delete next.images[imageId];
    return touch(next, now);
}

export function setLock(manifest, imageId, locked, now = new Date()) {
    const next = clone(manifest);
    const image = next.images[imageId];
    if (!image) throw new Error(`Unknown image: ${imageId}`);
    image.locked = Boolean(locked);
    return touch(next, now);
}

export function moveImage(manifest, imageId, targetGroupId, now = new Date()) {
    const next = clone(manifest);
    const image = next.images[imageId];
    if (!image) throw new Error(`Unknown image: ${imageId}`);
    if (!next.groups[targetGroupId]) throw new Error(`Unknown group: ${targetGroupId}`);
    image.movedFrom = next.groups[image.groupId]?.displayName || image.groupId;
    image.groupId = targetGroupId;
    return touch(next, now);
}

/** Adds a usage reference, keeping the list free of duplicates. */
export function addRef(manifest, imageId, ref, now = new Date()) {
    const next = clone(manifest);
    const image = next.images[imageId];
    if (!image) throw new Error(`Unknown image: ${imageId}`);
    const exists = image.refs.some(r => r.groupId === ref.groupId && String(r.entryUid) === String(ref.entryUid));
    if (!exists) image.refs.push({ groupId: String(ref.groupId), entryUid: ref.entryUid });
    return touch(next, now);
}

export function removeRef(manifest, imageId, ref, now = new Date()) {
    const next = clone(manifest);
    const image = next.images[imageId];
    if (!image) return next;
    image.refs = image.refs.filter(r => !(r.groupId === ref.groupId && String(r.entryUid) === String(ref.entryUid)));
    return touch(next, now);
}

export function imagesOfGroup(manifest, groupId) {
    return Object.values(manifest.images).filter(image => image.groupId === groupId);
}

/** SillyTavern uids are per-lorebook; a ref is only a match with both group and uid. */
export function imageByRef(manifest, { groupId, entryUid } = {}) {
    const gid = String(groupId || '');
    const uid = String(entryUid ?? '');
    if (!gid || !uid) return null;
    for (const image of Object.values(manifest.images || {})) {
        if ((image.refs || []).some(ref => String(ref.groupId) === gid && String(ref.entryUid) === uid)) {
            return image;
        }
    }
    return null;
}

export function groupIdForLorebook(manifest, lorebookName) {
    const name = String(lorebookName || '');
    if (!name) return '';
    for (const group of Object.values(manifest.groups || {})) {
        if (group.lorebookName === name) return group.id;
    }
    return '';
}

export function findImageBySha(manifest, sha256) {
    if (!sha256) return null;
    return Object.values(manifest.images).find(image => image.sha256 === sha256) || null;
}

export function groupStats(manifest, groupId) {
    const images = imagesOfGroup(manifest, groupId);
    return {
        count: images.length,
        locked: images.filter(i => i.locked).length,
        bytes: images.reduce((sum, i) => sum + (Number(i.bytes) || 0), 0),
    };
}

/** Every file URL referenced by an image record. */
export function imageFiles(image) {
    return Object.values(image?.variants || {}).filter(Boolean);
}

/**
 * Works out what deleting a group would actually do, without touching anything.
 *
 * Two classes of image survive:
 *   locked    — the user pinned it explicitly;
 *   cross-ref — deduplication by sha256 means one file can back entries in several
 *               lorebooks. Deleting it with this group would silently blank the image
 *               in another lorebook, so it is protected exactly like a lock.
 *
 * Survivors move to the system orphan group rather than being deleted.
 *
 * @returns {{ groupId: string, remove: string[], keep: Array<{id: string, reason: 'locked'|'cross-ref', crossRefs?: object[]}>, files: string[], bytes: number }}
 */
export function planGroupDeletion(manifest, groupId) {
    const group = manifest.groups[groupId];
    if (!group) throw new Error(`Unknown group: ${groupId}`);
    if (group.system) throw new Error(T('error.systemGroupDelete'));

    const remove = [];
    const keep = [];

    for (const image of imagesOfGroup(manifest, groupId)) {
        const crossRefs = (image.refs || []).filter(ref => ref.groupId && ref.groupId !== groupId);
        if (image.locked) {
            keep.push({ id: image.id, reason: 'locked' });
        } else if (crossRefs.length) {
            keep.push({ id: image.id, reason: 'cross-ref', crossRefs });
        } else {
            remove.push(image.id);
        }
    }

    const files = remove.flatMap(id => imageFiles(manifest.images[id]));
    const bytes = remove.reduce((sum, id) => sum + (Number(manifest.images[id]?.bytes) || 0), 0);

    return { groupId, remove, keep, files, bytes };
}

/**
 * Applies a plan produced by planGroupDeletion. Call only after the corresponding files
 * have been deleted, so a crash leaves a detectable dangling record rather than an
 * untraceable file.
 */
export function applyGroupDeletion(manifest, plan, now = new Date()) {
    let next = clone(manifest);

    for (const id of plan.remove) {
        delete next.images[id];
    }

    for (const kept of plan.keep) {
        const image = next.images[kept.id];
        if (!image) continue;
        image.movedFrom = next.groups[plan.groupId]?.displayName || plan.groupId;
        image.groupId = ORPHAN_GROUP_ID;
        // References into the group being deleted are gone; usages elsewhere survive.
        image.refs = (image.refs || []).filter(ref => ref.groupId !== plan.groupId);
    }

    delete next.groups[plan.groupId];
    next = touch(next, now);
    return next;
}

/** Total footprint, for the settings screen. */
export function totals(manifest) {
    const images = Object.values(manifest.images);
    return {
        groups: Object.keys(manifest.groups).length,
        images: images.length,
        locked: images.filter(i => i.locked).length,
        files: images.reduce((sum, i) => sum + imageFiles(i).length, 0),
        bytes: images.reduce((sum, i) => sum + (Number(i.bytes) || 0), 0),
    };
}

// ---------------------------------------------------------------------------
// List definitions
// ---------------------------------------------------------------------------

/** Definitions for one lorebook. Always an object, never undefined. */
export function listsOfGroup(manifest, groupId) {
    return manifest.lists?.[groupId] ?? {};
}

export function setGroupLists(manifest, groupId, lists, now = new Date()) {
    const next = clone(manifest);
    next.lists = next.lists || {};
    if (lists && Object.keys(lists).length) {
        next.lists[groupId] = lists;
    } else {
        delete next.lists[groupId];
    }
    return touch(next, now);
}
