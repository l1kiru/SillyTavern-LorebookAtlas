import test from 'node:test';
import assert from 'node:assert/strict';

import { matches } from '../src/ui/dom.js';

test('gallery search ignores case', () => {
    assert.ok(matches('Закат над морем', 'закат'));
    assert.ok(matches('Sunset.PNG', 'sunset'));
});

test('gallery search ignores diacritics', () => {
    assert.ok(matches('Café Ambiance', 'cafe'));
    assert.ok(matches('naïve.png', 'naive'));
});

test('an empty query matches everything, so the list is not blanked on focus', () => {
    assert.ok(matches('anything', ''));
    assert.ok(matches('', ''));
});

test('non-matching queries are rejected', () => {
    assert.equal(matches('Закат', 'рассвет'), false);
});

test('null-ish input does not throw', () => {
    assert.equal(matches(null, 'x'), false);
    assert.ok(matches(undefined, ''));
});
