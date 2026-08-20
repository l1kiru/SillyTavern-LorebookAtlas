import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createLists, normalizeLists, addList, renameList, setParent, removeList,
    childrenOf, ancestorsOf, descendantsOf, isDescendant, depthOf, buildTree,
    entriesOfList, listCounts, distinctListedCount, danglingListIds,
    reconstructMissingLists, pruneMembership, computedListsFor, listLabel,
    LIST_KIND, MAX_DEPTH, isComputed, COMPUTED_PREFIX,
} from '../src/lists.js';

const NOW = new Date('2026-08-20T12:00:00Z');

function tree() {
    let lists = createLists();
    lists = addList(lists, { id: 'geo', name: 'Geography' }, NOW);
    lists = addList(lists, { id: 'cities', name: 'Cities', parentId: 'geo' }, NOW);
    lists = addList(lists, { id: 'north', name: 'Northern', parentId: 'cities' }, NOW);
    lists = addList(lists, { id: 'magic', name: 'Magic' }, NOW);
    return lists;
}

test('nesting builds the expected ancestry', () => {
    const lists = tree();
    assert.deepEqual(ancestorsOf(lists, 'north'), ['cities', 'geo']);
    assert.deepEqual(descendantsOf(lists, 'geo').sort(), ['cities', 'north']);
    assert.equal(depthOf(lists, 'north'), 2);
    assert.equal(depthOf(lists, 'geo'), 0);
});

test('a list cannot be nested inside its own descendant', () => {
    const lists = tree();
    assert.throws(() => setParent(lists, 'geo', 'north'), /itself|cycle/i);
    assert.throws(() => setParent(lists, 'geo', 'geo'), /itself|cycle/i);
});

test('reparenting to an unrelated branch is allowed', () => {
    const moved = setParent(tree(), 'north', 'magic');
    assert.equal(moved.north.parentId, 'magic');
    assert.deepEqual(descendantsOf(moved, 'cities'), []);
});

test('depth is capped, counting the height of the moved subtree', () => {
    let lists = createLists();
    let parent = null;
    for (let i = 0; i < MAX_DEPTH; i += 1) {
        lists = addList(lists, { id: `l${i}`, name: `L${i}`, parentId: parent }, NOW);
        parent = `l${i}`;
    }
    assert.equal(depthOf(lists, `l${MAX_DEPTH - 1}`), MAX_DEPTH - 1, `${MAX_DEPTH} levels are allowed`);
    assert.throws(() => addList(lists, { id: 'over', name: 'Over', parentId: parent }, NOW), /levels|depth/i);

    // Moving a whole subtree must account for its height, not just its root.
    const deep = setParent(addList(tree(), { id: 'leaf', name: 'Leaf', parentId: 'north' }, NOW), 'magic', 'north');
    assert.ok(deep.magic.parentId === 'north');
});

test('removing a list lifts its children to the grandparent by default', () => {
    const after = removeList(tree(), 'cities');
    assert.equal(after.cities, undefined);
    assert.equal(after.north.parentId, 'geo', 'child is re-attached, not orphaned');
});

test('cascade removal takes the whole branch', () => {
    const after = removeList(tree(), 'geo', 'cascade');
    assert.deepEqual(Object.keys(after), ['magic']);
});

test('normalize repairs a cycle rather than hanging on it', () => {
    const broken = {
        a: { id: 'a', name: 'A', parentId: 'b' },
        b: { id: 'b', name: 'B', parentId: 'a' },
    };
    const fixed = normalizeLists(broken);
    assert.doesNotThrow(() => descendantsOf(fixed, 'a'));
    assert.ok(fixed.a.parentId === null || fixed.b.parentId === null, 'the back-edge is cut');
});

test('normalize detaches a list whose parent no longer exists', () => {
    const fixed = normalizeLists({ a: { id: 'a', name: 'A', parentId: 'ghost' } });
    assert.equal(fixed.a.parentId, null);
});

test('membership is transitive: an entry in a child shows up in the parent', () => {
    const lists = tree();
    const entries = [
        { uid: 1, lists: ['north'] },
        { uid: 2, lists: ['cities'] },
        { uid: 3, lists: ['magic'] },
    ];
    assert.deepEqual(entriesOfList(entries, lists, 'geo', true).map(e => e.uid), [1, 2]);
    assert.deepEqual(entriesOfList(entries, lists, 'geo', false).map(e => e.uid), []);
});

test('counts separate what is attached here from what is in the subtree', () => {
    const lists = tree();
    const entries = [
        { uid: 1, lists: ['north'] },
        { uid: 2, lists: ['cities'] },
        { uid: 3, lists: ['magic'] },
    ];
    const counts = listCounts(lists, entries);
    assert.deepEqual(counts.geo, { own: 0, total: 2 });
    assert.deepEqual(counts.cities, { own: 1, total: 2 });
    assert.deepEqual(counts.north, { own: 1, total: 1 });
});

test('an entry attached to both a node and its child is counted once', () => {
    const lists = tree();
    const entries = [{ uid: 1, lists: ['cities', 'north'] }];
    // Naive summing would report two; the same entry must not inflate the total.
    assert.equal(listCounts(lists, entries).geo.total, 1);
    assert.equal(distinctListedCount(entries), 1);
});

test('multi-membership across unrelated branches works', () => {
    const lists = tree();
    const entries = [{ uid: 1, lists: ['north', 'magic'] }];
    assert.equal(entriesOfList(entries, lists, 'geo').length, 1);
    assert.equal(entriesOfList(entries, lists, 'magic').length, 1);
});

test('dangling membership is detected and reconstructed as placeholders', () => {
    const lists = tree();
    const entries = [{ uid: 1, lists: ['geo', 'a1b2c3d4e5'] }];
    assert.deepEqual(danglingListIds(lists, entries), ['a1b2c3d4e5']);

    const repaired = reconstructMissingLists(lists, entries, NOW);
    assert.ok(repaired.a1b2c3d4e5, 'a lorebook that arrives without definitions keeps its structure');
    assert.deepEqual(danglingListIds(repaired, entries), []);
});

test('pruning drops membership pointing at removed lists but keeps computed ones', () => {
    const lists = tree();
    const kept = pruneMembership(lists, ['geo', 'ghost', `${COMPUTED_PREFIX}no-image`]);
    assert.deepEqual(kept, ['geo', `${COMPUTED_PREFIX}no-image`]);
});

test('computed lists derive from state and are never stored', () => {
    assert.deepEqual(
        computedListsFor({ entry: {}, image: null, membership: [] }).sort(),
        [`${COMPUTED_PREFIX}no-image`, `${COMPUTED_PREFIX}unlisted`].sort(),
    );
    assert.deepEqual(
        computedListsFor({ entry: {}, image: { locked: true }, membership: ['geo'] }),
        [`${COMPUTED_PREFIX}locked-image`],
    );
    assert.ok(isComputed(`${COMPUTED_PREFIX}no-image`));
    assert.equal(isComputed('geo'), false);
});

test('normalize refuses to store a computed list', () => {
    const stored = normalizeLists({ [`${COMPUTED_PREFIX}no-image`]: { name: 'x' }, geo: { name: 'Geo' } });
    assert.deepEqual(Object.keys(stored), ['geo']);
});

test('captions: manual lists use their name, computed ones the locale', () => {
    assert.equal(listLabel({ id: 'geo', name: 'Geography', kind: LIST_KIND.MANUAL }), 'Geography');
    assert.equal(listLabel({ id: `${COMPUTED_PREFIX}no-image`, kind: LIST_KIND.COMPUTED }), 'Without image');
});

test('the tree is a forest sorted by caption', () => {
    const forest = buildTree(tree());
    assert.deepEqual(forest.map(node => node.list.id), ['geo', 'magic']);
    assert.deepEqual(forest[0].children.map(node => node.list.id), ['cities']);
    assert.deepEqual(forest[0].children[0].children.map(node => node.list.id), ['north']);
});

test('renaming does not disturb the structure', () => {
    const renamed = renameList(tree(), 'geo', 'Places');
    assert.equal(renamed.geo.name, 'Places');
    assert.deepEqual(childrenOf(renamed, 'geo').map(l => l.id), ['cities']);
});

test('unknown ids are rejected loudly', () => {
    assert.throws(() => renameList(tree(), 'ghost', 'x'), /not found/i);
    assert.throws(() => setParent(tree(), 'geo', 'ghost'), /not found/i);
    assert.throws(() => addList(tree(), { name: 'x', parentId: 'ghost' }), /not found/i);
});
