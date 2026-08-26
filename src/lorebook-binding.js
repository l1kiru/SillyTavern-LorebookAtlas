/**
 * Reading and writing the group UUID inside a lorebook.
 *
 * Two strategies, because it is not settled whether SillyTavern preserves unknown
 * top-level keys across loadWorldInfo/saveWorldInfo:
 *
 *   'book'  — a single `extensions.lorebookAtlas.groupId` at the top level of the
 *             lorebook object. Tidier, one place to look, but depends on that behaviour.
 *   'entry' — the same object repeated in every entry's `extensions`. Redundant, but
 *             entry-level extensions are the documented, well-trodden path, so this is
 *             guaranteed to survive. This is the default for that reason.
 *
 * Both are implemented; the active one is chosen at runtime and can be forced from
 * settings. Reads always accept either, so switching strategies never loses a binding.
 */

import { uuid } from './util.js';

export const BINDING_KEY = 'lorebookAtlas';

export const STRATEGY = Object.freeze({
    BOOK: 'book',
    ENTRY: 'entry',
});

/** Reads the group id out of a lorebook object, checking both layouts. */
export function readGroupId(book) {
    if (!book || typeof book !== 'object') return null;

    const atBook = book.extensions?.[BINDING_KEY]?.groupId;
    if (atBook) return String(atBook);

    for (const entry of Object.values(book.entries || {})) {
        const atEntry = entry?.extensions?.[BINDING_KEY]?.groupId;
        if (atEntry) return String(atEntry);
    }

    return null;
}

/** Removes the group binding from both possible locations. */
export function clearGroupId(book) {
    if (!book || typeof book !== 'object') return book;

    if (book.extensions?.[BINDING_KEY]) {
        delete book.extensions[BINDING_KEY].groupId;
        if (!Object.keys(book.extensions[BINDING_KEY]).length) delete book.extensions[BINDING_KEY];
    }
    for (const entry of Object.values(book.entries || {})) {
        if (entry?.extensions?.[BINDING_KEY]) delete entry.extensions[BINDING_KEY].groupId;
    }
    return book;
}

/**
 * Writes the group id into a lorebook object and returns it. Does not save — the caller
 * decides when to call saveWorldInfo, so a batch of edits costs one write.
 *
 * Any previous binding is cleared first, including one written under the other strategy.
 * Without that, re-binding a restored copy would leave the original id sitting in the
 * location readGroupId happens to check first, and the copy would silently claim the
 * original's image group.
 */
export function writeGroupId(book, groupId, strategy = STRATEGY.ENTRY) {
    if (!strategy) strategy = STRATEGY.ENTRY;
    if (!book || typeof book !== 'object') throw new Error('Lorebook object expected');
    clearGroupId(book);

    if (strategy === STRATEGY.BOOK) {
        book.extensions = book.extensions || {};
        book.extensions[BINDING_KEY] = { ...book.extensions[BINDING_KEY], groupId };
        return book;
    }

    let written = 0;
    for (const entry of Object.values(book.entries || {})) {
        if (!entry || typeof entry !== 'object') continue;
        entry.extensions = entry.extensions || {};
        entry.extensions[BINDING_KEY] = { ...entry.extensions[BINDING_KEY], groupId };
        written += 1;
    }

    // A lorebook with no entries has nowhere to put a per-entry binding. Writing nothing
    // while reporting success means readGroupId() returns null immediately afterwards, so
    // every call mints a fresh id and the lists attached to the previous one are stranded.
    // The book level is the only place left.
    if (!written) {
        book.extensions = book.extensions || {};
        book.extensions[BINDING_KEY] = { ...book.extensions[BINDING_KEY], groupId };
    }

    return book;
}

/** Ensures the lorebook carries a group id, generating one if absent. */
export function ensureGroupId(book, strategy = STRATEGY.ENTRY) {
    const existing = readGroupId(book);
    if (existing) return { groupId: existing, created: false };
    const groupId = uuid();
    writeGroupId(book, groupId, strategy);
    return { groupId, created: true };
}

export function writeEntryImage(entry, image) {
    if (!entry || typeof entry !== 'object') throw new Error('Entry object expected');
    entry.extensions = entry.extensions || {};
    const prev = entry.extensions[BINDING_KEY] || {};
    const same = prev.imageId === image.id && prev.sha256 === image.sha256;
    entry.extensions[BINDING_KEY] = {
        ...prev,
        imageId: image.id,
        sha256: image.sha256,
        variants: { ...image.variants },
    };
    // A different file needs a fresh frame; the same (deduplicated) file keeps it.
    if (!same) delete entry.extensions[BINDING_KEY].crop;
    return entry;
}

// ---------------------------------------------------------------------------
// Per-entry thumbnail crop (CSS only — no extra files)
// ---------------------------------------------------------------------------

export const CROP_DEFAULT = Object.freeze({ x: 0.5, y: 0.5, zoom: 1 });

function clamp(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function normalizeCrop(crop) {
    return {
        x: clamp(crop?.x, 0, 1, CROP_DEFAULT.x),
        y: clamp(crop?.y, 0, 1, CROP_DEFAULT.y),
        zoom: clamp(crop?.zoom, 1, 4, CROP_DEFAULT.zoom),
    };
}

export function cropIsDefault(crop) {
    const next = normalizeCrop(crop);
    return next.x === CROP_DEFAULT.x && next.y === CROP_DEFAULT.y && next.zoom === CROP_DEFAULT.zoom;
}

export function readEntryCrop(entry) {
    return normalizeCrop(entry?.extensions?.[BINDING_KEY]?.crop);
}

export function writeEntryCrop(entry, crop) {
    if (!entry || typeof entry !== 'object') throw new Error('Entry object expected');
    entry.extensions = entry.extensions || {};
    entry.extensions[BINDING_KEY] = entry.extensions[BINDING_KEY] || {};
    const next = normalizeCrop(crop);
    if (cropIsDefault(next)) {
        delete entry.extensions[BINDING_KEY].crop;
        if (!Object.keys(entry.extensions[BINDING_KEY]).length) delete entry.extensions[BINDING_KEY];
    } else {
        entry.extensions[BINDING_KEY].crop = next;
    }
    return entry;
}

/** Maps a crop onto an <img> that already uses object-fit: cover. */
export function applyCropStyle(node, crop) {
    if (!node?.style) return node;
    const next = normalizeCrop(crop);
    const x = `${(next.x * 100).toFixed(2)}%`;
    const y = `${(next.y * 100).toFixed(2)}%`;
    node.style.objectPosition = `${x} ${y}`;
    node.style.transformOrigin = `${x} ${y}`;
    node.style.transform = next.zoom === CROP_DEFAULT.zoom ? '' : `scale(${next.zoom})`;
    return node;
}

// ---------------------------------------------------------------------------
// List membership
// ---------------------------------------------------------------------------

/**
 * Which lists an entry belongs to.
 *
 * Membership is stored inside the entry rather than in an external index because a
 * SillyTavern uid is effectively an array position: reorder the entries and any external
 * index keyed by uid is silently wrong. Kept here, membership also survives the native
 * lorebook export untouched.
 */
export function readEntryLists(entry) {
    const raw = entry?.extensions?.[BINDING_KEY]?.lists;
    return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
}

export function writeEntryLists(entry, listIds) {
    if (!entry || typeof entry !== 'object') throw new Error('Entry object expected');
    entry.extensions = entry.extensions || {};
    entry.extensions[BINDING_KEY] = entry.extensions[BINDING_KEY] || {};

    const unique = [...new Set((listIds || []).map(String).filter(Boolean))];
    if (unique.length) {
        entry.extensions[BINDING_KEY].lists = unique;
    } else {
        delete entry.extensions[BINDING_KEY].lists;
        if (!Object.keys(entry.extensions[BINDING_KEY]).length) delete entry.extensions[BINDING_KEY];
    }
    return entry;
}

/**
 * Applies a checkbox selection to an entry's membership.
 *
 * Only the lists that were actually offered can be judged. Writing the checkbox state
 * wholesale would drop any other id the entry carries — an id whose definition did not
 * travel with the lorebook, for instance — so those are carried over untouched.
 *
 * @param {string[]} current membership as it stands
 * @param {string[]} offered list ids the dialog showed a checkbox for
 * @param {string[]} checked list ids the user ticked
 * @returns {string[]} the membership to store
 */
export function applyMembershipSelection(current, offered, checked) {
    const wasOffered = new Set(offered ?? []);
    const untouched = (current ?? []).filter(id => !wasOffered.has(id));
    return [...new Set([...(checked ?? []), ...untouched])];
}

export function addEntryToList(entry, listId) {
    return writeEntryLists(entry, [...readEntryLists(entry), listId]);
}

export function removeEntryFromList(entry, listId) {
    return writeEntryLists(entry, readEntryLists(entry).filter(id => id !== listId));
}

/** Flattens a lorebook into the shape the list helpers expect. */
export function entriesWithLists(book) {
    return Object.values(book?.entries || {})
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => ({ uid: entry.uid, entry, lists: readEntryLists(entry) }));
}

/**
 * Builds the groupId → lorebook name map that reconcileGroups() consumes.
 * @param {Array<{ name: string, book: object }>} books
 */
export function discoverBindings(books) {
    const discovered = {};
    for (const { name, book } of books) {
        const groupId = readGroupId(book);
        if (groupId) discovered[groupId] = name;
    }
    return discovered;
}
