/**
 * The adapter's pure parts.
 *
 * The DOM-walking half needs a browser, but the two pieces that actually decide whether
 * the extension works after a SillyTavern update — selector fallback and uid extraction —
 * are testable against a tiny fake document.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { firstMatching, allMatching, parseUidFromText, WI_SELECTORS } from '../src/ui/wi-adapter.js';

/** Minimal stand-in: answers only the selectors it was given. */
function fakeRoot(map) {
    return {
        querySelector(selector) {
            if (selector.includes(':scope')) throw new Error('unsupported selector');
            return map[selector] ?? null;
        },
        querySelectorAll(selector) {
            if (selector.includes(':scope')) throw new Error('unsupported selector');
            const value = map[selector];
            return value ? [].concat(value) : [];
        },
    };
}

test('the first selector that matches wins', () => {
    const root = fakeRoot({ '#world_popup': 'second' });
    assert.equal(firstMatching(root, WI_SELECTORS.editorRoot), 'second');
});

test('a selector the engine cannot parse is skipped, not fatal', () => {
    // `:scope > ...` throws on older engines; the chain must survive that and carry on.
    const root = fakeRoot({ '.inline-drawer-header': 'header' });
    assert.equal(firstMatching(root, WI_SELECTORS.header), 'header');
});

test('nothing matching yields null rather than an exception', () => {
    assert.equal(firstMatching(fakeRoot({}), WI_SELECTORS.editorRoot), null);
});

test('allMatching de-duplicates across overlapping selectors', () => {
    const shared = { id: 'entry' };
    const root = fakeRoot({ '.world_entry': shared, '[data-uid].world_entry': shared });
    assert.deepEqual(allMatching(root, WI_SELECTORS.entry), [shared]);
});

test('uid is parsed out of visible label text', () => {
    assert.equal(parseUidFromText('UID: 42'), '42');
    assert.equal(parseUidFromText('uid:7'), '7');
    assert.equal(parseUidFromText('  12  '), '12');
    assert.equal(parseUidFromText('no digits here'), '');
    assert.equal(parseUidFromText(null), '');
});

test('the selector chains keep the historically working selector first', () => {
    // These are the ones verified against SillyTavern 1.18; the rest are insurance.
    assert.equal(WI_SELECTORS.entryList[0], '#world_popup_entries_list');
    assert.equal(WI_SELECTORS.entry[0], '.world_entry');
    assert.equal(WI_SELECTORS.bookSelect[0], '#world_editor_select');
    for (const chain of Object.values(WI_SELECTORS)) {
        assert.ok(chain.length > 1, 'every lookup needs a fallback, not just one selector');
    }
});
