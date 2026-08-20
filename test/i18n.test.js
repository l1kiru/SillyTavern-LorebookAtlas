/**
 * Translation completeness.
 *
 * These are the guard against the failure mode this codebase already had once: a locale
 * file that drifted away from the strings actually used, and markup whose visible text
 * was in one language while its keys claimed another.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STRINGS, KEY_PREFIX, T, format, fullKey } from '../src/i18n.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['ru-ru'];

const readLocale = name => JSON.parse(fs.readFileSync(path.join(root, 'i18n', `${name}.json`), 'utf8'));
const placeholders = text => new Set([...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]));

for (const locale of LOCALES) {
    test(`${locale}: every string has a translation`, () => {
        const data = readLocale(locale);
        const missing = Object.keys(STRINGS).map(fullKey).filter(key => !Object.hasOwn(data, key));
        assert.deepEqual(missing, [], `untranslated keys in ${locale}`);
    });

    test(`${locale}: no orphan keys left over from earlier revisions`, () => {
        const data = readLocale(locale);
        const known = new Set(Object.keys(STRINGS).map(fullKey));
        const extra = Object.keys(data).filter(key => !known.has(key));
        assert.deepEqual(extra, [], `keys present in ${locale} but not used in code`);
    });

    test(`${locale}: placeholders survive translation`, () => {
        const data = readLocale(locale);
        for (const [key, english] of Object.entries(STRINGS)) {
            const translated = data[fullKey(key)];
            if (translated === undefined) continue;
            assert.deepEqual(
                placeholders(translated),
                placeholders(english),
                `placeholder mismatch in ${locale} for ${key}`,
            );
        }
    });

    test(`${locale}: every key is namespaced`, () => {
        const data = readLocale(locale);
        const unprefixed = Object.keys(data).filter(key => !key.startsWith(KEY_PREFIX));
        // Unprefixed keys would collide with SillyTavern's core locale, where
        // addLocaleData refuses to override an existing key.
        assert.deepEqual(unprefixed, [], 'keys must be namespaced to avoid core collisions');
    });

    test(`${locale}: nothing is left in English by accident`, () => {
        const data = readLocale(locale);
        const untouched = Object.entries(STRINGS)
            .filter(([key, english]) => data[fullKey(key)] === english && /[a-zA-Z]{4}/.test(english))
            .map(([key]) => key);
        assert.deepEqual(untouched, [], `strings identical to the English source in ${locale}`);
    });
}

test('the settings template uses keys that exist', () => {
    const html = fs.readFileSync(path.join(root, 'templates', 'settings.html'), 'utf8');
    const used = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]);
    assert.ok(used.length > 0, 'template should carry data-i18n attributes');

    const known = new Set(Object.keys(STRINGS).map(fullKey));
    const unknown = used.filter(key => !known.has(key.replace(/^\[[^\]]+\]/, '')));
    assert.deepEqual(unknown, [], 'template references keys absent from STRINGS');
});

test('the manifest declares every locale file that exists', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    for (const locale of LOCALES) {
        assert.ok(manifest.i18n?.[locale], `manifest does not declare ${locale}`);
        assert.ok(fs.existsSync(path.join(root, manifest.i18n[locale])), `declared locale file is missing: ${locale}`);
    }
});

test('T falls back to English outside SillyTavern', () => {
    assert.equal(T('gallery.close'), 'Close');
    assert.equal(T('group.badgeLocked', { count: 3 }), '3 locked');
});

test('T reports an unknown key instead of rendering an empty string', () => {
    assert.equal(T('no.such.key'), 'no.such.key');
});

test('format leaves unknown placeholders untouched rather than blanking them', () => {
    assert.equal(format('{a} and {b}', { a: 1 }), '1 and {b}');
    assert.equal(format('nothing', null), 'nothing');
});
