/**
 * Visual integration cannot be guaranteed by a test — themes are user-editable and only a
 * human eye can judge "harmonious". The mechanical part can be, and these are the checks
 * that catch the ways it silently breaks:
 *
 *   - a class that SillyTavern does not define styles nothing at all;
 *   - an invented variable falls back forever and drifts unnoticed;
 *   - --warning is pure red, not amber, so borrowing it shouts where it should murmur.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssRaw = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
// Comments mention SillyTavern variables by name while explaining why they are avoided;
// analysing them as if they were live declarations produces false positives.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

const sources = ['src/ui/gallery.js', 'src/ui/explorer.js', 'src/ui/settings.js',
    'src/ui/entry-button.js', 'src/ui/restore-preview.js', 'templates/settings.html']
    .map(file => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') }));

/**
 * Verified against SillyTavern 1.18: public/style.css defines .menu_button and .text_pole;
 * .checkbox_label and the .inline-drawer family are the documented markup for extension
 * settings panels.
 */
const KNOWN_ST_CLASSES = new Set([
    'menu_button', 'text_pole', 'checkbox_label',
    'inline-drawer', 'inline-drawer-toggle', 'inline-drawer-header',
    'inline-drawer-content', 'inline-drawer-icon',
    'fa-solid', 'fa-fw', 'down',
]);

/** Confirmed present in SillyTavern's public/style.css. */
const KNOWN_ST_VARIABLES = new Set([
    '--SmartThemeBodyColor', '--SmartThemeEmColor', '--SmartThemeBorderColor',
    '--SmartThemeBlurTintColor', '--SmartThemeShadowColor',
    '--black30a', '--black50a', '--white20a', '--golden', '--warning',
    '--mainFontFamily', '--mainFontSize',
]);

const cssVariableUses = () => [...css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)]
    .map(m => ({ name: m[1], hasFallback: m[2] === ',' }));

test('every SillyTavern variable is referenced with a fallback', () => {
    const external = cssVariableUses().filter(use => !use.name.startsWith('--lba-'));
    const bare = external.filter(use => !use.hasFallback).map(use => use.name);
    // A theme can redefine or drop anything; a bare var() renders as nothing at all.
    assert.deepEqual([...new Set(bare)], [], 'external variables need a fallback value');
});

test('no SillyTavern variable is used that was not verified to exist', () => {
    const external = cssVariableUses()
        .filter(use => !use.name.startsWith('--lba-'))
        .map(use => use.name);
    const unknown = [...new Set(external)].filter(name => !KNOWN_ST_VARIABLES.has(name));
    assert.deepEqual(unknown, [], 'invented variables silently fall back and drift');
});

test('our own variables are all defined before use', () => {
    const defined = new Set([...css.matchAll(/^\s*(--lba-[\w-]+)\s*:/gm)].map(m => m[1]));
    const used = new Set(cssVariableUses().filter(use => use.name.startsWith('--lba-')).map(use => use.name));
    const missing = [...used].filter(name => !defined.has(name));
    assert.deepEqual(missing, []);
});

test('colours live only in the theme layer', () => {
    // Everything past the theme block must go through --lba-*, or a light theme breaks it.
    const body = css.slice(css.indexOf('.menu_button.lba-button--icon'));
    const literals = [...body.matchAll(/:\s*(?:#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi)].map(m => m[0].trim());
    assert.deepEqual(literals, [], 'hardcoded colours assume one theme; use a --lba-* variable');
});

test('only verified SillyTavern classes are used in markup', () => {
    const found = new Set();

    // Each quote style needs its own pattern. A single character class would stop at the
    // first inner quote of `lba-node${flag ? ' active' : ''}` and leave a broken fragment,
    // which then splits into pieces of the expression rather than class names.
    const patterns = [
        [/class(?:Name)?\s*[=:]\s*`([^`]*)`/g, true],
        [/class(?:Name)?\s*[=:]\s*'([^']*)'/g, false],
        [/class(?:Name)?\s*[=:]\s*"([^"]*)"/g, false],
    ];

    for (const { text } of sources) {
        for (const [pattern, isTemplate] of patterns) {
            for (const match of text.matchAll(pattern)) {
                const literal = isTemplate ? match[1].replace(/\$\{[\s\S]*?\}/g, ' ') : match[1];
                for (const token of literal.split(/\s+/)) {
                    if (!token || token.startsWith('lba-')) continue;
                    found.add(token);
                }
            }
        }
    }

    const unknown = [...found].filter(name => !KNOWN_ST_CLASSES.has(name) && !name.startsWith('fa-'));
    assert.deepEqual(unknown, [], 'these classes do not exist in SillyTavern and style nothing');
});

test('destructive and icon buttons build on the real .menu_button', () => {
    // .redWarningBG and .menu_button_icon were both assumed and neither exists: delete
    // buttons rendered as ordinary ones and icon buttons kept text-sized padding.
    assert.match(css, /\.menu_button\.lba-button--danger/);
    assert.match(css, /\.menu_button\.lba-button--icon/);

    for (const { file, text } of sources) {
        assert.ok(!text.includes('redWarningBG'), `${file} still uses a class that does not exist`);
        assert.ok(!text.includes('menu_button_icon'), `${file} still uses a class that does not exist`);
    }
});

test('theme-neutral surfaces are declared twice, plain value first', () => {
    // Progressive enhancement: browsers without color-mix keep the plain declaration.
    for (const name of ['--lba-border', '--lba-surface', '--lba-surface-hover']) {
        const declarations = [...css.matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, 'g'))].map(m => m[1].trim());
        assert.equal(declarations.length, 2, `${name} needs a fallback and a color-mix form`);
        assert.ok(!declarations[0].includes('color-mix'), `${name}: plain value must come first`);
        assert.ok(declarations[1].includes('color-mix'), `${name}: enhanced value must come second`);
    }
});

test('the orphan badge does not borrow SillyTavern red', () => {
    // --warning is rgba(255,0,0,0.9) in SillyTavern. A missing lorebook is a notice, not
    // an emergency, so it gets its own amber; only destructive actions use the red.
    assert.match(css, /--lba-attention:\s*#d09a3c/);
    assert.match(css, /--lba-danger:\s*var\(--warning,/);
});
