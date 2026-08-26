/**
 * The file picker has to settle when the user backs out.
 *
 * Listening only for `change` leaves the promise pending forever on cancel, and whatever
 * awaits it hangs — in practice a spinner that never clears and stacks a fresh copy on
 * every attempt. These tests drive the two cancellation signals against a fake input.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickFile } from '../src/ui/dom.js';

/** Minimal stand-ins for the input element and the window. */
function harness() {
    const listeners = new Map();
    const winListeners = new Map();
    let clicked = false;

    const input = {
        files: null,
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: type => listeners.delete(type),
        click: () => { clicked = true; },
    };

    const doc = { createElement: () => input };
    const win = {
        addEventListener: (type, fn) => winListeners.set(type, fn),
        removeEventListener: type => winListeners.delete(type),
    };

    return {
        input, doc, win,
        get clicked() { return clicked; },
        get listenerCount() { return listeners.size + winListeners.size; },
        fire: (type, onWindow = false) => (onWindow ? winListeners : listeners).get(type)?.(),
    };
}

const options = h => ({ doc: h.doc, win: h.win, focusGraceMs: 5 });

test('a chosen file resolves the promise', async () => {
    const h = harness();
    const file = { name: 'sunset.png' };

    const promise = pickFile(options(h));
    assert.ok(h.clicked, 'the dialog should have been opened');

    h.input.files = [file];
    h.fire('change');

    assert.equal(await promise, file);
});

test('dismissing the dialog resolves with null instead of hanging', async () => {
    const h = harness();
    const promise = pickFile(options(h));

    h.fire('cancel');

    // Without this the promise never settles and the caller's spinner stays up forever.
    assert.equal(await promise, null);
});

test('on engines with no cancel event, regained focus ends the wait', async () => {
    const h = harness();
    const promise = pickFile(options(h));

    h.fire('focus', true);

    assert.equal(await promise, null);
});

test('focus does not steal a pick that is about to land', async () => {
    const h = harness();
    const file = { name: 'chosen.png' };
    const promise = pickFile(options(h));

    // Real order on a successful pick: focus returns first, change follows.
    h.fire('focus', true);
    h.input.files = [file];
    h.fire('change');

    assert.equal(await promise, file, 'the grace period must let change win');
});

test('the promise settles once, whatever arrives afterwards', async () => {
    const h = harness();
    const promise = pickFile(options(h));

    h.fire('cancel');
    h.input.files = [{ name: 'late.png' }];
    h.fire('change');

    assert.equal(await promise, null);
});

test('every listener is removed once it settles', async () => {
    const h = harness();
    const promise = pickFile(options(h));

    assert.ok(h.listenerCount > 0);
    h.fire('cancel');
    await promise;

    // A leaked window listener would fire on the next unrelated focus change.
    assert.equal(h.listenerCount, 0);
});

test('choosing nothing but firing change still resolves', async () => {
    const h = harness();
    const promise = pickFile(options(h));

    h.input.files = [];
    h.fire('change');

    assert.equal(await promise, null);
});
