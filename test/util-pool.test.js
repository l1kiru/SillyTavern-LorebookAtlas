/**
 * The concurrency pool.
 *
 * Its contract is unusual and load-bearing: it never rejects, and reports every item
 * individually. Deleting a group and tearing the extension down both count failures from
 * what it returns, so if it ever started throwing or swallowing, cleanup would report
 * success while leaving files behind.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pool, debounce } from '../src/util.js';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

test('every item gets a result, in the order it was given', async () => {
    const results = await pool([1, 2, 3, 4], 2, async n => n * 2);

    assert.deepEqual(results.map(r => r.value), [2, 4, 6, 8]);
    assert.ok(results.every(r => r.ok));
});

test('a failing item does not reject the whole run', async () => {
    const results = await pool([1, 2, 3], 2, async n => {
        if (n === 2) throw new Error('nope');
        return n;
    });

    assert.deepEqual(results.map(r => r.ok), [true, false, true]);
    assert.match(results[1].error.message, /nope/);
    assert.equal(results[1].item, 2, 'the failed item is identifiable, so it can be retried');
});

test('every item failing is still a resolved run', async () => {
    // Cleanup counts failures rather than catching; a rejection here would abort teardown.
    const results = await pool([1, 2], 2, async () => { throw new Error('all bad'); });
    assert.equal(results.filter(r => !r.ok).length, 2);
});

test('concurrency is bounded', async () => {
    let active = 0;
    let peak = 0;

    await pool([1, 2, 3, 4, 5, 6], 2, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(5);
        active -= 1;
    });

    assert.ok(peak <= 2, `ran ${peak} at once with a limit of 2`);
});

test('an empty list resolves immediately without calling the worker', async () => {
    let called = false;
    assert.deepEqual(await pool([], 4, async () => { called = true; }), []);
    assert.equal(called, false);
});

test('a nonsensical limit still runs everything', async () => {
    for (const limit of [0, -1, NaN, undefined]) {
        const results = await pool([1, 2, 3], limit, async n => n);
        assert.equal(results.length, 3, `limit ${limit} dropped work`);
    }
});

test('progress is reported once per item and ends at the total', async () => {
    const seen = [];
    await pool([1, 2, 3], 2, async n => n, (done, total) => seen.push([done, total]));

    assert.equal(seen.length, 3);
    assert.deepEqual(seen.at(-1), [3, 3], 'the last call must show completion, or a progress bar sticks');
});

test('progress counts failures too', async () => {
    const seen = [];
    await pool([1, 2], 1, async n => { if (n === 1) throw new Error('x'); return n; }, done => seen.push(done));
    assert.deepEqual(seen, [1, 2]);
});

// ---------------------------------------------------------------- debounce

test('debounce runs once, with the last arguments', async () => {
    const calls = [];
    const fn = debounce(value => calls.push(value), 5);

    fn('a'); fn('b'); fn('c');
    await tick(20);

    assert.deepEqual(calls, ['c']);
});

test('flush runs the pending call immediately', async () => {
    const calls = [];
    const fn = debounce(value => calls.push(value), 50);

    fn('pending');
    fn.flush();

    assert.deepEqual(calls, ['pending']);
    await tick(60);
    assert.deepEqual(calls, ['pending'], 'the timer must not fire again after a flush');
});

test('cancel drops the pending call', async () => {
    const calls = [];
    const fn = debounce(() => calls.push(1), 5);

    fn();
    fn.cancel();
    await tick(20);

    assert.deepEqual(calls, []);
});

test('flush with nothing pending does nothing', () => {
    const calls = [];
    const fn = debounce(() => calls.push(1), 5);
    assert.equal(fn.flush(), undefined);
    assert.deepEqual(calls, []);
});
