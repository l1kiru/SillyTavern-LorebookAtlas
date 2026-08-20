/**
 * Lists — a nestable, multi-membership grouping for the entries of one lorebook.
 *
 * Not to be confused with `groups`, which tie images to lorebooks. Groups are flat and
 * exclusive; lists nest and an entry may belong to several at once. Different concept,
 * different word, deliberately no overlap in vocabulary.
 *
 * Because an entry can sit in several lists and lists nest, the structure is a forest in
 * which the same entry surfaces at more than one node. That is expected — but it means
 * "how many entries" always needs saying twice: how many attached here, and how many
 * distinct entries in this subtree.
 *
 * Definitions live here (keyed by list id). Membership lives inside the entry itself, in
 * `extensions.lorebookAtlas.lists` — see lorebook-binding.js. Membership is stored there
 * rather than in an external index because SillyTavern's `uid` is effectively an array
 * position: reorder the entries and any external index by uid is silently wrong.
 */

import { T } from './i18n.js';
import { uuid } from './util.js';

/** Guard against a UI that cannot render, not a technical limit. */
export const MAX_DEPTH = 8;

export const LIST_KIND = Object.freeze({
    /** Created by the user; membership is stored. */
    MANUAL: 'manual',
    /** Derived on the fly; membership is never stored. */
    COMPUTED: 'computed',
    /** Auto-created once, then behaves like a manual list. Captures a moment in time. */
    SNAPSHOT: 'snapshot',
});

export const COMPUTED_PREFIX = '__computed:';

/**
 * Computed lists. Each predicate receives the entry and whatever the caller knows about
 * its image, so nothing here needs access to the manifest directly.
 */
export const COMPUTED_LISTS = Object.freeze({
    [`${COMPUTED_PREFIX}no-image`]: {
        labelKey: 'list.computedNoImage',
        predicate: ({ image }) => !image,
    },
    [`${COMPUTED_PREFIX}locked-image`]: {
        labelKey: 'list.computedLocked',
        predicate: ({ image }) => Boolean(image?.locked),
    },
    [`${COMPUTED_PREFIX}unlisted`]: {
        labelKey: 'list.computedUnlisted',
        predicate: ({ membership }) => !membership || membership.length === 0,
    },
});

function clone(value) {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export function isComputed(listId) {
    return String(listId || '').startsWith(COMPUTED_PREFIX);
}

/** Localized caption. Computed lists have no stored name; manual ones are user text. */
export function listLabel(list) {
    if (!list) return '';
    if (list.kind === LIST_KIND.COMPUTED) return T(COMPUTED_LISTS[list.id]?.labelKey ?? 'list.unknown');
    return list.name || T('list.unnamed');
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export function createLists() {
    return {};
}

export function normalizeLists(raw) {
    const out = {};
    for (const [id, list] of Object.entries(raw || {})) {
        if (!list || typeof list !== 'object' || isComputed(id)) continue;
        out[id] = {
            id,
            name: String(list.name || ''),
            parentId: list.parentId ? String(list.parentId) : null,
            kind: Object.values(LIST_KIND).includes(list.kind) && list.kind !== LIST_KIND.COMPUTED
                ? list.kind
                : LIST_KIND.MANUAL,
            createdAt: String(list.createdAt || new Date().toISOString()),
        };
    }

    // A parent that no longer exists would strand the whole branch out of the tree.
    for (const list of Object.values(out)) {
        if (list.parentId && !out[list.parentId]) list.parentId = null;
    }

    // Repair cycles left by hand-edited or corrupted data by cutting the back-edge.
    for (const list of Object.values(out)) {
        const seen = new Set([list.id]);
        let cursor = list.parentId;
        while (cursor && out[cursor]) {
            if (seen.has(cursor)) {
                list.parentId = null;
                break;
            }
            seen.add(cursor);
            cursor = out[cursor].parentId;
        }
    }

    return out;
}

export function addList(lists, { id = uuid(), name, parentId = null, kind = LIST_KIND.MANUAL } = {}, now = new Date()) {
    const next = clone(lists);
    if (parentId && !next[parentId]) throw new Error(T('error.unknownList', { id: parentId }));
    if (parentId && depthOf(next, parentId) + 1 >= MAX_DEPTH) throw new Error(T('error.listTooDeep', { max: MAX_DEPTH }));

    next[id] = {
        id,
        name: String(name || ''),
        parentId: parentId || null,
        kind,
        createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    };
    return next;
}

export function renameList(lists, id, name) {
    const next = clone(lists);
    if (!next[id]) throw new Error(T('error.unknownList', { id }));
    next[id].name = String(name || '');
    return next;
}

/**
 * Reparents a list, refusing moves that would create a cycle or exceed the depth cap.
 * Without the cycle check the first mis-aimed drag would hang the tree renderer.
 */
export function setParent(lists, id, parentId) {
    const next = clone(lists);
    if (!next[id]) throw new Error(T('error.unknownList', { id }));
    if (parentId && !next[parentId]) throw new Error(T('error.unknownList', { id: parentId }));
    if (parentId === id) throw new Error(T('error.listCycle'));
    if (parentId && isDescendant(next, parentId, id)) throw new Error(T('error.listCycle'));

    const newDepth = parentId ? depthOf(next, parentId) + 1 : 0;
    if (newDepth + subtreeHeight(next, id) >= MAX_DEPTH) throw new Error(T('error.listTooDeep', { max: MAX_DEPTH }));

    next[id].parentId = parentId || null;
    return next;
}

/**
 * Removes a list. Entries are never touched — only membership ids, and those are cleaned
 * separately by pruneMembership().
 * @param {'reparent'|'cascade'} childPolicy what to do with nested lists
 */
export function removeList(lists, id, childPolicy = 'reparent') {
    const next = clone(lists);
    const target = next[id];
    if (!target) return next;

    if (childPolicy === 'cascade') {
        for (const descendant of descendantsOf(next, id)) delete next[descendant];
    } else {
        for (const list of Object.values(next)) {
            if (list.parentId === id) list.parentId = target.parentId;
        }
    }

    delete next[id];
    return next;
}

// ---------------------------------------------------------------------------
// Tree queries
// ---------------------------------------------------------------------------

export function childrenOf(lists, parentId) {
    return Object.values(lists).filter(list => (list.parentId || null) === (parentId || null));
}

export function ancestorsOf(lists, id) {
    const out = [];
    const seen = new Set([id]);
    let cursor = lists[id]?.parentId;
    while (cursor && lists[cursor] && !seen.has(cursor)) {
        out.push(cursor);
        seen.add(cursor);
        cursor = lists[cursor].parentId;
    }
    return out;
}

export function descendantsOf(lists, id) {
    const out = [];
    const stack = [id];
    const seen = new Set([id]);
    while (stack.length) {
        for (const child of childrenOf(lists, stack.pop())) {
            if (seen.has(child.id)) continue;
            seen.add(child.id);
            out.push(child.id);
            stack.push(child.id);
        }
    }
    return out;
}

export function isDescendant(lists, id, maybeAncestor) {
    return descendantsOf(lists, maybeAncestor).includes(id);
}

export function depthOf(lists, id) {
    return ancestorsOf(lists, id).length;
}

function subtreeHeight(lists, id) {
    const children = childrenOf(lists, id);
    if (!children.length) return 0;
    return 1 + Math.max(...children.map(child => subtreeHeight(lists, child.id)));
}

/** Forest of `{ list, children[] }`, siblings sorted by caption. */
export function buildTree(lists, locale = undefined) {
    const byName = (a, b) => listLabel(a.list).localeCompare(listLabel(b.list), locale);
    const build = parentId => childrenOf(lists, parentId)
        .map(list => ({ list, children: build(list.id) }))
        .sort(byName);
    return build(null);
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * Entries attached to a list.
 * @param {Array<{ uid: any, lists: string[] }>} entries
 * @param {boolean} transitive include entries of nested lists
 */
export function entriesOfList(entries, lists, listId, transitive = true) {
    const wanted = new Set([listId, ...(transitive ? descendantsOf(lists, listId) : [])]);
    return entries.filter(entry => (entry.lists || []).some(id => wanted.has(id)));
}

/**
 * Per-list counts.
 *
 * `own` is what is attached directly, `total` counts *distinct* entries across the whole
 * subtree. They differ whenever lists nest, and totals must be de-duplicated because one
 * entry can be attached to a node and to its child at the same time.
 */
export function listCounts(lists, entries) {
    const counts = {};
    for (const id of Object.keys(lists)) {
        const own = entries.filter(entry => (entry.lists || []).includes(id));
        const total = entriesOfList(entries, lists, id, true);
        counts[id] = { own: own.length, total: new Set(total.map(e => String(e.uid))).size };
    }
    return counts;
}

/** Distinct entries across the whole forest — never the sum of per-node totals. */
export function distinctListedCount(entries) {
    return new Set(entries.filter(e => (e.lists || []).length).map(e => String(e.uid))).size;
}

/**
 * Membership ids referenced by entries but absent from the definitions.
 * Happens when a lorebook arrives from elsewhere carrying membership without definitions.
 */
export function danglingListIds(lists, entries) {
    const known = new Set(Object.keys(lists));
    const dangling = new Set();
    for (const entry of entries) {
        for (const id of entry.lists || []) {
            if (!known.has(id) && !isComputed(id)) dangling.add(id);
        }
    }
    return [...dangling];
}

/**
 * Materialises placeholder definitions for dangling ids, so an imported lorebook keeps its
 * structure even when the definitions did not travel with it. The user renames them later.
 */
export function reconstructMissingLists(lists, entries, now = new Date()) {
    let next = clone(lists);
    for (const id of danglingListIds(next, entries)) {
        next = addList(next, { id, name: T('list.reconstructed', { id: id.slice(0, 8) }), kind: LIST_KIND.MANUAL }, now);
    }
    return next;
}

/** Drops membership ids that point at lists which no longer exist. */
export function pruneMembership(lists, membership) {
    return (membership || []).filter(id => Boolean(lists[id]) || isComputed(id));
}

/** Computed lists that currently apply to an entry. */
export function computedListsFor({ entry, image, membership }) {
    return Object.entries(COMPUTED_LISTS)
        .filter(([, def]) => def.predicate({ entry, image, membership }))
        .map(([id]) => id);
}

/** Pseudo-definitions for computed lists, for rendering alongside the real ones. */
export function computedDefinitions() {
    return Object.keys(COMPUTED_LISTS).map(id => ({
        id,
        name: '',
        parentId: null,
        kind: LIST_KIND.COMPUTED,
        createdAt: null,
    }));
}
