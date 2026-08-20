import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFileName, parseFileName, isOwnFile, fileUrl, fileNameFromUrl } from '../src/filenames.js';
import { SAFE_FILENAME_RE, VARIANT } from '../src/constants.js';

const GROUP = 'a3f1b2c4-1111-2222-3333-444444444444';
const IMAGE = '7e9d0a11-5555-6666-7777-888888888888';
const SHA = '9c1f2e3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6';

test('generated names satisfy SillyTavern validateAssetFileName', () => {
    for (const variant of Object.values(VARIANT)) {
        for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml', 'image/bmp']) {
            const name = buildFileName({ groupId: GROUP, imageId: IMAGE, variant, sha256: SHA, mime });
            assert.match(name, SAFE_FILENAME_RE, `rejected: ${name}`);
            assert.ok(!name.startsWith('.'), 'name must not start with a dot');
        }
    }
});

test('round-trips through parseFileName', () => {
    const name = buildFileName({ groupId: GROUP, imageId: IMAGE, variant: VARIANT.PREVIEW, sha256: SHA, mime: 'image/webp' });
    const parsed = parseFileName(name);
    assert.ok(parsed);
    assert.equal(parsed.variant, VARIANT.PREVIEW);
    assert.equal(parsed.groupId8, GROUP.replace(/-/g, '').slice(0, 8));
    assert.equal(parsed.imageId8, IMAGE.replace(/-/g, '').slice(0, 8));
    assert.equal(parsed.ext, 'webp');
});

test('parseFileName accepts a full client-relative path', () => {
    const name = buildFileName({ groupId: GROUP, imageId: IMAGE, variant: VARIANT.ORIGINAL, sha256: SHA, mime: 'image/png' });
    assert.deepEqual(parseFileName(fileUrl(name)), parseFileName(name));
    assert.equal(fileNameFromUrl(fileUrl(name)), name);
});

test('foreign files are not claimed as ours', () => {
    assert.equal(parseFileName('vacation-photo.png'), null);
    assert.equal(parseFileName('lba_short_x_p_abc.png'), null);
    assert.equal(isOwnFile('user/files/notes.txt'), false);
    assert.equal(isOwnFile('user/files/lba_manifest.json'), true);
});

test('a different content hash produces a different name, defeating stale caches', () => {
    const a = buildFileName({ groupId: GROUP, imageId: IMAGE, variant: VARIANT.PREVIEW, sha256: SHA, mime: 'image/webp' });
    const b = buildFileName({ groupId: GROUP, imageId: IMAGE, variant: VARIANT.PREVIEW, sha256: 'ff'.repeat(32), mime: 'image/webp' });
    assert.notEqual(a, b);
});

test('unsupported inputs are rejected loudly', () => {
    assert.throws(() => buildFileName({ groupId: GROUP, imageId: IMAGE, variant: 'thumbnail', sha256: SHA, mime: 'image/webp' }), /variant/i);
    assert.throws(() => buildFileName({ groupId: GROUP, imageId: IMAGE, variant: VARIANT.PREVIEW, sha256: SHA, mime: 'image/heic' }), /mime/i);
    assert.throws(() => buildFileName({ groupId: '', imageId: IMAGE, variant: VARIANT.PREVIEW, sha256: SHA, mime: 'image/webp' }), /required/i);
});
