/**
 * Packaging invariants.
 *
 * SillyTavern's /api/extensions/install clones the repository and then reads
 * `manifest.json` **from the clone root**; if it is not there the clone is deleted and the
 * install fails outright. Everything below guards that contract and the handful of
 * metadata fields that fail silently rather than loudly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const readJson = name => JSON.parse(read(name));

test('manifest.json sits at the repository root', () => {
    // Anywhere else and installing from a URL fails, taking the clone with it.
    assert.ok(fs.existsSync(path.join(root, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(root, 'index.js')), 'the js entry point is resolved relative to the root');
});

test('the manifest declares everything SillyTavern reads', () => {
    const manifest = readJson('manifest.json');

    // display_name, js and author are required by the extension loader.
    assert.ok(manifest.display_name);
    assert.ok(manifest.js);
    assert.ok(manifest.author);
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
    assert.equal(manifest.minimum_client_version, '1.18.0');
});

test('every file the manifest points at actually exists', () => {
    const manifest = readJson('manifest.json');

    for (const key of ['js', 'css']) {
        if (!manifest[key]) continue;
        assert.ok(fs.existsSync(path.join(root, manifest[key])), `${key}: ${manifest[key]} is missing`);
    }
    for (const [locale, file] of Object.entries(manifest.i18n ?? {})) {
        assert.ok(fs.existsSync(path.join(root, file)), `locale ${locale}: ${file} is missing`);
    }
});

test('every declared hook is exported by the entry point', () => {
    const manifest = readJson('manifest.json');
    const entry = read(manifest.js);

    for (const [hook, fnName] of Object.entries(manifest.hooks ?? {})) {
        // A hook naming a function that does not exist is silent: SillyTavern logs a
        // warning nobody reads and the lifecycle step simply never happens.
        const exported = new RegExp(`export\\s+(async\\s+)?function\\s+${fnName}\\b`).test(entry);
        assert.ok(exported, `hook "${hook}" names ${fnName}(), which is not exported from ${manifest.js}`);
    }
});

test('the licence is present and matches what package.json claims', () => {
    const licence = read('LICENSE');
    assert.match(licence, /MIT License/);
    // The copyright line is the one part of MIT that is easy to leave as a placeholder.
    assert.match(licence, /Copyright \(c\) \d{4} \S+/);
    assert.equal(readJson('package.json').license, 'MIT');
});

test('manifest and package.json agree on the version', () => {
    assert.equal(readJson('manifest.json').version, readJson('package.json').version);
});

test('the extension folder is derived, not hardcoded', async () => {
    // The installed folder name comes from the repository URL, so a fork or a rename would
    // break a hardcoded path and the settings template would 404.
    const source = read('src/constants.js');
    assert.match(source, /import\.meta\.url/);

    const { EXTENSION_FOLDER } = await import('../src/constants.js');
    assert.match(EXTENSION_FOLDER, /^third-party\//, 'the node fallback must still be usable');
});

test('nothing in the repository points at a placeholder URL', () => {
    const manifest = readJson('manifest.json');
    if (!manifest.homePage) return;
    assert.ok(!/example\.com|your\/extension|TODO/i.test(manifest.homePage), 'homePage is still a placeholder');
});
