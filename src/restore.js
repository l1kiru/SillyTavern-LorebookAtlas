/**
 * Restore: planning and application.
 *
 * Planning is pure and side-effect free, which is what makes the preview screen honest —
 * the same function produces both the table the user reviews and the instructions that get
 * executed. There is no second code path that could disagree with the preview.
 *
 * The collision policy is decided per lorebook, not per archive. A global default seeds
 * every row and each row can be overridden; with a dozen lorebooks of which three collide,
 * one archive-wide switch would force two separate imports.
 */

import { T, templateMatcher } from './i18n.js';
import { uuid } from './util.js';
import { diffEntries } from './entry-match.js';
import { readEntryLists, writeEntryLists, readGroupId, writeGroupId } from './lorebook-binding.js';
import { LIST_KIND, addList, normalizeLists } from './lists.js';
import { formatDate } from './util.js';

export const POLICY = Object.freeze({
    /** No local lorebook of that name: just create it. */
    CREATE: 'create',
    /** Keep the local one untouched, bring the archived one in under a new name. */
    SEPARATE: 'separate',
    /** Overwrite the local lorebook wholesale. */
    REPLACE: 'replace',
    /** Fold the archive into the local lorebook. */
    MERGE: 'merge',
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Removes a previously applied suffix so repeated restores do not stack them up.
 * The matcher is derived from the same localized template used to add the suffix, so the
 * two cannot drift apart.
 */
export function stripRestoredSuffix(name) {
    const numbered = templateMatcher('restore.suffixN', { name: '(.*)', n: '\\d+' }).exec(name);
    if (numbered) return numbered[1];

    const plain = templateMatcher('restore.suffix', { name: '(.*)' }).exec(name);
    if (plain) return plain[1];

    return name;
}

/**
 * Proposes a free name for a restored duplicate.
 * The suffix is parsed and incremented rather than appended — otherwise a second restore
 * yields "Lorebook (restored) (restored)".
 */
export function suggestRestoredName(name, existingNames) {
    const taken = new Set(existingNames);
    const base = stripRestoredSuffix(name);

    const first = T('restore.suffix', { name: base });
    if (!taken.has(first)) return first;

    for (let n = 2; n < 1000; n += 1) {
        const candidate = T('restore.suffixN', { name: base, n });
        if (!taken.has(candidate)) return candidate;
    }
    return `${base} ${uuid().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {object} params.archive result of readArchive()
 * @param {Array<{ name: string, book: object }>} params.localBooks
 * @param {string} [params.defaultPolicy] seeds every colliding row
 * @param {Record<string, {policy?: string, targetName?: string, skip?: boolean}>} [params.overrides] keyed by archived name
 * @param {boolean} [params.markLists] create the snapshot lists that diff a merge
 */
export function planRestore({
    archive,
    localBooks = [],
    defaultPolicy = POLICY.MERGE,
    overrides = {},
    markLists = true,
    now = new Date(),
}) {
    const localByName = new Map(localBooks.map(item => [item.name, item]));
    const takenNames = new Set(localByName.keys());
    const items = [];

    for (const incoming of archive.lorebooks) {
        const override = overrides[incoming.name] || {};
        if (override.skip) {
            items.push({ name: incoming.name, skip: true, policy: null });
            continue;
        }

        const local = localByName.get(incoming.name);
        const policy = local ? (override.policy || defaultPolicy) : POLICY.CREATE;

        const item = {
            name: incoming.name,
            policy,
            skip: false,
            hasLocal: Boolean(local),
            groupId: incoming.groupId || null,
            newGroupId: null,
            targetName: incoming.name,
            lists: normalizeLists(incoming.lists),
            imageIds: incoming.images || [],
            entries: { matched: 0, incomingOnly: 0, localOnly: 0, lowConfidence: 0 },
            snapshotLists: null,
        };

        if (policy === POLICY.SEPARATE) {
            item.targetName = override.targetName || suggestRestoredName(incoming.name, takenNames);
            takenNames.add(item.targetName);

            // A copy carrying the original group UUID would leave two lorebooks claiming
            // the same image group; discoverBindings builds a map keyed by that UUID and
            // one of the two would silently win. So the copy gets a fresh identity.
            item.newGroupId = uuid();
        }

        if (policy === POLICY.MERGE && local) {
            const incomingEntries = Object.values(incoming.book?.entries || {});
            const localEntries = Object.values(local.book?.entries || {});
            const diff = diffEntries(incomingEntries, localEntries);

            item.entries = {
                matched: diff.matched.length,
                incomingOnly: diff.incomingOnly.length,
                localOnly: diff.localOnly.length,
                lowConfidence: diff.matched.filter(m => m.confidence === 'low').length,
            };
            item.diff = diff;

            // The snapshot lists turn an opaque merge into two navigable piles.
            if (markLists && (diff.incomingOnly.length || diff.localOnly.length)) {
                item.snapshotLists = {
                    local: { id: uuid(), name: T('list.snapshotLocal'), kind: LIST_KIND.SNAPSHOT },
                    restored: { id: uuid(), name: T('list.snapshotRestored', { date: formatDate(now) }), kind: LIST_KIND.SNAPSHOT },
                };
            }
        }

        items.push(item);
    }

    return {
        createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
        archiveCreatedAt: archive.meta?.createdAt ?? null,
        items,
        totals: {
            lorebooks: items.filter(i => !i.skip).length,
            skipped: items.filter(i => i.skip).length,
            images: Object.keys(archive.meta?.images || {}).length,
        },
    };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Folds an incoming entry into a local one.
 * Fields present in the archive win; fields only the local copy has are preserved; list
 * membership is a set and gets unioned rather than replaced.
 */
export function mergeEntry(local, incoming) {
    const merged = { ...local, ...incoming };
    merged.uid = local.uid;

    const lists = [...new Set([...readEntryLists(local), ...readEntryLists(incoming)])];
    merged.extensions = { ...local.extensions, ...incoming.extensions };
    writeEntryLists(merged, lists);
    return merged;
}

function nextUid(entries) {
    const used = new Set(entries.map(entry => Number(entry.uid)).filter(Number.isFinite));
    let candidate = 0;
    while (used.has(candidate)) candidate += 1;
    return candidate;
}

/**
 * Produces the merged lorebook for one plan item. Pure: takes both books, returns a new one.
 */
export function mergeBooks(localBook, incomingBook, item) {
    const result = { ...localBook, entries: {} };
    const diff = item.diff ?? diffEntries(Object.values(incomingBook?.entries || {}), Object.values(localBook?.entries || {}));
    const snapshot = item.snapshotLists;
    const out = [];

    for (const pair of diff.matched) {
        out.push(mergeEntry(pair.local, pair.incoming));
    }

    // Entries only the local copy has are always kept — merging adds and updates, it never
    // deletes. Use REPLACE when an exact mirror of the archive is what is wanted.
    for (const entry of diff.localOnly) {
        const copy = { ...entry };
        if (snapshot) writeEntryLists(copy, [...readEntryLists(entry), snapshot.local.id]);
        out.push(copy);
    }

    for (const entry of diff.incomingOnly) {
        const copy = { ...entry };
        if (snapshot) writeEntryLists(copy, [...readEntryLists(entry), snapshot.restored.id]);
        out.push(copy);
    }

    // Incoming uids may collide with local ones that mean something else entirely.
    const assigned = [];
    for (const entry of out) {
        const clash = assigned.some(other => String(other.uid) === String(entry.uid));
        assigned.push(clash ? { ...entry, uid: nextUid(assigned) } : entry);
    }

    result.entries = Object.fromEntries(assigned.map((entry, index) => [index, entry]));
    return result;
}

/** List definitions after a merge: archive definitions plus any snapshot lists. */
export function mergeListDefinitions(localLists, item, now = new Date()) {
    let lists = normalizeLists({ ...localLists, ...item.lists });
    if (item.snapshotLists) {
        lists = addList(lists, item.snapshotLists.local, now);
        lists = addList(lists, item.snapshotLists.restored, now);
    }
    return lists;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * Executes a plan.
 *
 * All effects are funnelled through `io` so the whole thing runs against a fake in tests.
 *
 * @param {object} plan
 * @param {object} archive
 * @param {object} io
 * @param {(name: string) => Promise<object|null>} io.loadBook
 * @param {(name: string, book: object) => Promise<void>} io.saveBook
 * @param {(groupId: string, name: string) => Promise<void>} io.ensureGroup
 * @param {(groupId: string, lists: object) => Promise<void>} io.setLists
 * @param {(record: object, bytes: Record<string, Uint8Array>) => Promise<void>} io.putImage
 * @param {(groupId: string) => Promise<void>} [io.deleteGroup]
 * @param {object} [options]
 * @param {string} [options.bindingStrategy] where to write the group id; defaults to the
 *        safe per-entry layout. Passing it through means a restore does not quietly move
 *        the binding to the other location and override what the user chose.
 */
export async function applyRestore(plan, archive, io, { onProgress, bindingStrategy } = {}) {
    const report = { created: [], replaced: [], merged: [], separated: [], skipped: [], failed: [] };
    const done = { n: 0 };
    const total = plan.items.filter(item => !item.skip).length;

    for (const item of plan.items) {
        if (item.skip) {
            report.skipped.push(item.name);
            continue;
        }

        try {
            const incoming = archive.lorebooks.find(book => book.name === item.name);
            if (!incoming) throw new Error(T('error.archiveItemMissing', { name: item.name }));

            const groupId = item.newGroupId || item.groupId;
            let book;
            let lists = item.lists;

            switch (item.policy) {
                case POLICY.CREATE:
                case POLICY.SEPARATE: {
                    book = structuredClone(incoming.book);
                    if (groupId) writeGroupId(book, groupId, bindingStrategy);
                    // A separate copy must not keep pointing at the original group.
                    if (item.newGroupId) book = remapEntryImages(book);
                    break;
                }
                case POLICY.REPLACE: {
                    book = structuredClone(incoming.book);
                    if (groupId) writeGroupId(book, groupId, bindingStrategy);
                    if (io.deleteGroup && item.groupId) await io.deleteGroup(item.groupId);
                    break;
                }
                case POLICY.MERGE: {
                    const local = await io.loadBook(item.name);
                    book = mergeBooks(local ?? { entries: {} }, incoming.book, item);
                    const existingGroupId = readGroupId(local ?? {}) || groupId;
                    if (existingGroupId) writeGroupId(book, existingGroupId, bindingStrategy);
                    lists = mergeListDefinitions(await io.loadLists?.(existingGroupId), item);
                    break;
                }
                default:
                    throw new Error(`Unknown policy: ${item.policy}`);
            }

            const targetGroupId = readGroupId(book) || groupId;
            if (targetGroupId) {
                await io.ensureGroup(targetGroupId, item.targetName);
                await io.setLists(targetGroupId, lists);
            }

            for (const imageId of item.imageIds) {
                const record = archive.meta.images[imageId];
                if (!record) continue;
                const bytes = {};
                for (const [variant, name] of Object.entries(record.variants || {})) {
                    const data = archive.imageBytes(name);
                    if (data) bytes[variant] = data;
                }
                if (!Object.keys(bytes).length) continue;
                await io.putImage({ ...record, groupId: targetGroupId }, bytes);
            }

            await io.saveBook(item.targetName, book);

            const bucket = {
                [POLICY.CREATE]: report.created,
                [POLICY.SEPARATE]: report.separated,
                [POLICY.REPLACE]: report.replaced,
                [POLICY.MERGE]: report.merged,
            }[item.policy];
            bucket.push(item.targetName);
        } catch (error) {
            report.failed.push({ name: item.name, message: error.message });
        }

        done.n += 1;
        onProgress?.(done.n, total);
    }

    return report;
}

/** Drops per-entry image bindings that refer to the source installation's image ids. */
function remapEntryImages(book) {
    const copy = structuredClone(book);
    for (const entry of Object.values(copy.entries || {})) {
        if (entry?.extensions?.lorebookAtlas) {
            delete entry.extensions.lorebookAtlas.imageId;
            delete entry.extensions.lorebookAtlas.variants;
        }
    }
    return copy;
}
