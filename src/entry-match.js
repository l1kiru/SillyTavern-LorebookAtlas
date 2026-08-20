/**
 * Matching entries between an archived lorebook and the local one.
 *
 * The obvious approach — match on `uid` — is wrong. In SillyTavern a uid is effectively an
 * array position, so two independently edited copies of the same lorebook will happily
 * present different entries under the same uid. Merging on that basis silently overwrites
 * the wrong entry, and the user has no way to notice.
 *
 * So matching goes by content, in descending order of confidence, with uid used only as a
 * corroborating signal.
 */

/** Normalises a value for comparison: case, whitespace and diacritics folded away. */
export function normalizeForMatch(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function firstKey(entry) {
    if (Array.isArray(entry?.key) && entry.key.length) return entry.key[0];
    if (Array.isArray(entry?.keys) && entry.keys.length) return entry.keys[0];
    return entry?.primaryKey ?? '';
}

/** Normalised body text, used as the last-resort match signal. */
export function contentKey(entry) {
    return normalizeForMatch(entry?.content).slice(0, 512);
}

export function buildEntryMatchIndex(entries = []) {
    const index = {
        byUid: new Map(),
        byComment: new Map(),
        byPrimaryKey: new Map(),
        byContent: new Map(),
        entries: [],
    };

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;

        const normalized = {
            entry,
            uid: String(entry.uid ?? '').trim(),
            comment: normalizeForMatch(entry.comment ?? entry.name ?? entry.title),
            primaryKey: normalizeForMatch(firstKey(entry)),
            content: contentKey(entry),
        };
        index.entries.push(normalized);

        if (normalized.uid) index.byUid.set(normalized.uid, normalized);
        // Only the first occurrence is indexed: an ambiguous key is worse than no key,
        // and silently picking the last one would be arbitrary.
        if (normalized.comment && !index.byComment.has(normalized.comment)) index.byComment.set(normalized.comment, normalized);
        if (normalized.primaryKey && !index.byPrimaryKey.has(normalized.primaryKey)) index.byPrimaryKey.set(normalized.primaryKey, normalized);
        if (normalized.content && !index.byContent.has(normalized.content)) index.byContent.set(normalized.content, normalized);
    }

    return index;
}

/**
 * @returns {{ method: string, confidence: 'high'|'medium'|'low'|'none', target: object|null }}
 */
export function matchEntry(candidate, index) {
    const comment = normalizeForMatch(candidate?.comment ?? candidate?.name ?? candidate?.title);
    if (comment && index.byComment.has(comment)) {
        return { method: 'comment', confidence: 'high', target: index.byComment.get(comment).entry };
    }

    const uid = String(candidate?.uid ?? '').trim();
    if (uid && index.byUid.has(uid)) {
        const found = index.byUid.get(uid);
        // Same slot, different name: almost certainly two unrelated entries that merely
        // ended up at the same position. Refusing to match is the safe answer.
        if (comment && found.comment && comment !== found.comment) {
            return { method: 'uid-conflict', confidence: 'none', target: null };
        }
        return { method: 'uid', confidence: 'high', target: found.entry };
    }

    const primaryKey = normalizeForMatch(firstKey(candidate));
    if (primaryKey && index.byPrimaryKey.has(primaryKey)) {
        return { method: 'primaryKey', confidence: 'medium', target: index.byPrimaryKey.get(primaryKey).entry };
    }

    const content = contentKey(candidate);
    if (content && index.byContent.has(content)) {
        return { method: 'content', confidence: 'low', target: index.byContent.get(content).entry };
    }

    return { method: 'none', confidence: 'none', target: null };
}

/**
 * Pairs up two entry sets.
 * @returns {{ matched: Array<{ incoming: object, local: object, method: string, confidence: string }>,
 *             incomingOnly: object[], localOnly: object[] }}
 */
export function diffEntries(incoming = [], local = []) {
    const index = buildEntryMatchIndex(local);
    const matched = [];
    const incomingOnly = [];
    const takenLocal = new Set();

    for (const entry of incoming) {
        const result = matchEntry(entry, index);
        // One local entry may not absorb two incoming ones; the second is treated as new.
        if (result.target && !takenLocal.has(result.target)) {
            takenLocal.add(result.target);
            matched.push({ incoming: entry, local: result.target, method: result.method, confidence: result.confidence });
        } else {
            incomingOnly.push(entry);
        }
    }

    const localOnly = local.filter(entry => !takenLocal.has(entry));
    return { matched, incomingOnly, localOnly };
}
