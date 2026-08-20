import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEntryMatchIndex, matchEntry, diffEntries, normalizeForMatch } from '../src/entry-match.js';

const entry = (uid, comment, key, content = '') => ({ uid, comment, key: key ? [key] : [], content });

test('matching prefers the comment, the most human-meaningful signal', () => {
    const index = buildEntryMatchIndex([entry(0, 'Novigrad', 'city'), entry(1, 'Oxenfurt', 'city2')]);
    const result = matchEntry(entry(99, 'Novigrad'), index);
    assert.equal(result.method, 'comment');
    assert.equal(result.confidence, 'high');
    assert.equal(result.target.uid, 0);
});

test('comment matching ignores case, spacing and diacritics', () => {
    const index = buildEntryMatchIndex([entry(0, 'Café  Ambiance')]);
    assert.equal(matchEntry(entry(5, 'cafe ambiance'), index).target.uid, 0);

    // Decomposition also folds ё onto е, which is wanted: the two are written
    // interchangeably in Russian and should not split an otherwise identical entry.
    assert.equal(normalizeForMatch('  Ёлка \n Ёлка '), 'елка елка');
    assert.equal(normalizeForMatch('елка'), normalizeForMatch('ёлка'));
});

test('the same uid holding a different entry is refused, not merged', () => {
    // This is the whole reason matching is not uid-based: in SillyTavern a uid is an array
    // position, so two edited copies routinely disagree about what lives at slot 3.
    const index = buildEntryMatchIndex([entry(3, 'Dragons')]);
    const result = matchEntry(entry(3, 'Taverns'), index);
    assert.equal(result.method, 'uid-conflict');
    assert.equal(result.target, null);
});

test('uid still matches when nothing contradicts it', () => {
    const index = buildEntryMatchIndex([entry(3, '')]);
    assert.equal(matchEntry(entry(3, ''), index).method, 'uid');
});

test('falls back to the primary key, then to content', () => {
    const byKey = buildEntryMatchIndex([entry(0, 'Local name', 'novigrad')]);
    assert.equal(matchEntry({ uid: 77, comment: 'Different', key: ['novigrad'] }, byKey).method, 'primaryKey');

    const byContent = buildEntryMatchIndex([entry(0, 'Local', '', 'A great free city on the coast')]);
    const result = matchEntry({ uid: 88, comment: 'Other', content: 'A great free city on the coast' }, byContent);
    assert.equal(result.method, 'content');
    assert.equal(result.confidence, 'low');
});

test('nothing in common means no match', () => {
    const index = buildEntryMatchIndex([entry(0, 'Alpha', 'a', 'aaa')]);
    assert.equal(matchEntry(entry(9, 'Omega', 'z', 'zzz'), index).method, 'none');
});

test('diff splits three ways', () => {
    const local = [entry(0, 'Shared'), entry(1, 'LocalOnly')];
    const incoming = [entry(0, 'Shared'), entry(5, 'FromArchive')];

    const diff = diffEntries(incoming, local);
    assert.equal(diff.matched.length, 1);
    assert.deepEqual(diff.incomingOnly.map(e => e.comment), ['FromArchive']);
    assert.deepEqual(diff.localOnly.map(e => e.comment), ['LocalOnly']);
});

test('one local entry cannot absorb two incoming ones', () => {
    const local = [entry(0, 'Shared')];
    const incoming = [entry(0, 'Shared'), entry(1, 'Shared')];

    const diff = diffEntries(incoming, local);
    assert.equal(diff.matched.length, 1);
    assert.equal(diff.incomingOnly.length, 1, 'the duplicate is treated as new, not merged twice');
});

test('an empty side degrades gracefully', () => {
    assert.equal(diffEntries([], [entry(0, 'A')]).localOnly.length, 1);
    assert.equal(diffEntries([entry(0, 'A')], []).incomingOnly.length, 1);
    assert.deepEqual(diffEntries([], []), { matched: [], incomingOnly: [], localOnly: [] });
});

test('malformed entries are skipped instead of crashing the index', () => {
    const index = buildEntryMatchIndex([null, 'nonsense', entry(0, 'Valid')]);
    assert.equal(index.entries.length, 1);
});
