/**
 * Which entries survive a filter, and how the filter reaches SillyTavern.
 *
 * The selection rule is where a mistake is invisible — the user sees a shorter list and
 * has no way to tell that something is wrongly missing. The host-attachment half matters
 * for a different reason: the entry list is paginated at 25 rows, so a filter that runs
 * after pagination silently only covers one page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWiFilter, entryPasses, ALL, UNLISTED, FILTER_KEY } from '../src/ui/wi-filter.js';
import { createLists, addList, COMPUTED_PREFIX } from '../src/lists.js';
import { writeEntryLists } from '../src/lorebook-binding.js';

const NOW = new Date('2026-08-20T12:00:00Z');

function tree() {
    let lists = createLists();
    lists = addList(lists, { id: 'geo', name: 'Geography' }, NOW);
    lists = addList(lists, { id: 'cities', name: 'Cities', parentId: 'geo' }, NOW);
    lists = addList(lists, { id: 'magic', name: 'Magic' }, NOW);
    return lists;
}

// ---------------------------------------------------------------- selection rule

test('"all entries" lets everything through', () => {
    assert.ok(entryPasses({ selected: ALL, membership: [], lists: tree() }));
    assert.ok(entryPasses({ selected: '', membership: [], lists: tree() }));
});

test('a parent list includes everything nested below it', () => {
    const lists = tree();
    assert.ok(entryPasses({ selected: 'geo', membership: ['cities'], lists }), 'child membership counts for the parent');
    assert.ok(entryPasses({ selected: 'geo', membership: ['geo'], lists }));
    assert.equal(entryPasses({ selected: 'cities', membership: ['geo'], lists }), false, 'but not the other way round');
});

test('an unrelated branch is excluded', () => {
    assert.equal(entryPasses({ selected: 'magic', membership: ['cities'], lists: tree() }), false);
});

test('"not in any list" finds exactly the unassigned entries', () => {
    assert.ok(entryPasses({ selected: UNLISTED, membership: [] }));
    assert.equal(entryPasses({ selected: UNLISTED, membership: ['geo'] }), false);
});

test('computed lists look at the image, not at stored membership', () => {
    const noImage = `${COMPUTED_PREFIX}no-image`;
    const locked = `${COMPUTED_PREFIX}locked-image`;

    assert.ok(entryPasses({ selected: noImage, membership: ['geo'], image: null }));
    assert.equal(entryPasses({ selected: noImage, membership: [], image: { locked: false } }), false);
    assert.ok(entryPasses({ selected: locked, membership: [], image: { locked: true } }));
});

test('membership pointing at a list that no longer exists does not match', () => {
    assert.equal(entryPasses({ selected: 'geo', membership: ['ghost'], lists: tree() }), false);
});

// ---------------------------------------------------------------- host attachment

/** Stand-in for SillyTavern's FilterHelper, matching the parts we touch. */
function fakeFilterHelper() {
    const helper = {
        filterFunctions: { builtin: data => data },
        filterData: {},
        changes: 0,
        setFilterData(type, value) {
            helper.filterData[type] = value;
            helper.changes += 1;
        },
        /** Mirrors applyFilters: reduce the array through every registered function. */
        applyFilters(data) {
            return Object.values(helper.filterFunctions).reduce((acc, fn) => fn(acc), data);
        },
    };
    return helper;
}

function fakeWi(bookName = 'Book') {
    return { bookName: () => bookName, entries: () => [], uidOf: () => '', entryList: () => null };
}

function entry(uid, listIds) {
    const value = { uid, comment: `Entry ${uid}`, extensions: {} };
    writeEntryLists(value, listIds);
    return value;
}

/** Wires a filter to a fake host, bypassing the dynamic import. */
function attachFake(filter, helper, lists) {
    filter.setLists(lists);
    helper.filterFunctions[FILTER_KEY] = data => {
        if (filter.selected === ALL) return data;
        return data.filter(item => entryPasses({
            selected: filter.selected,
            membership: item.extensions?.lorebookAtlas?.lists ?? [],
            lists,
        }));
    };
}

test('registered as one more filter function, it composes with the built-in ones', () => {
    const helper = fakeFilterHelper();
    const filter = createWiFilter({ wi: fakeWi(), io: { readBook: async () => null, imageForEntry: () => null } });
    attachFake(filter, helper, tree());

    const data = [entry(1, ['cities']), entry(2, ['magic']), entry(3, [])];

    // Filtering happens on the data, before SillyTavern paginates it — which is the whole
    // point: hiding rendered rows would only ever cover the 25 on the current page.
    assert.equal(helper.applyFilters(data).length, 3, 'no selection leaves the data alone');

    filter.selected = 'geo';
    const filtered = helper.applyFilters(data);
    assert.deepEqual(filtered.map(e => e.uid), [1]);
});

test('a failed import degrades to the fallback instead of throwing', async () => {
    // There is no world-info.js under node, so this exercises the real failure path.
    const filter = createWiFilter({
        wi: fakeWi(),
        io: { readBook: async () => null, imageForEntry: () => null },
    });

    await assert.doesNotReject(() => filter.attachToHost());
    assert.equal(filter.usesHostFilter, false, 'without the host it must fall back, not pretend');
});

// ---------------------------------------------------------------- reload

test('reload survives a lorebook that cannot be read', async () => {
    const filter = createWiFilter({
        wi: fakeWi('Missing'),
        io: { readBook: async () => null, imageForEntry: () => null },
    });
    await assert.doesNotReject(() => filter.reload());
});

test('with no lorebook open the filter stays inert', async () => {
    const filter = createWiFilter({
        wi: fakeWi(''),
        io: { readBook: async () => { throw new Error('should not be read'); }, imageForEntry: () => null },
    });
    await assert.doesNotReject(() => filter.reload());
    assert.equal(filter.selected, ALL);
});

test('membership drives the fallback path too', async () => {
    const filter = createWiFilter({
        wi: fakeWi(),
        io: {
            readBook: async () => ({ lists: tree(), entries: [{ uid: 1, lists: ['cities'] }, { uid: 2, lists: [] }] }),
            imageForEntry: () => null,
        },
    });
    await filter.reload();

    filter.selected = 'geo';
    assert.equal(filter.passesFor(1), true);
    assert.equal(filter.passesFor(2), false);
});
