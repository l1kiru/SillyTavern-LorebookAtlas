import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStoreZip, parseStoreZip, crc32, assertZipName, jsonFile, readJsonFile } from '../src/zip.js';

const encoder = new TextEncoder();
const bytes = s => encoder.encode(s);

test('round-trips files byte for byte', () => {
    const files = [
        { name: 'lba-archive.json', data: bytes('{"schema":1}') },
        { name: 'lorebooks/book-0.json', data: bytes('{"entries":{}}') },
        { name: 'images/lba_aaaaaaaa_bbbbbbbb_p_cccccccc.webp', data: new Uint8Array([0, 1, 2, 253, 254, 255]) },
    ];

    const parsed = parseStoreZip(buildStoreZip(files));

    assert.equal(parsed.size, 3);
    for (const file of files) {
        assert.deepEqual([...parsed.get(file.name)], [...file.data], file.name);
    }
});

test('survives an empty archive and empty members', () => {
    assert.equal(parseStoreZip(buildStoreZip([])).size, 0);
    const parsed = parseStoreZip(buildStoreZip([{ name: 'empty.bin', data: new Uint8Array(0) }]));
    assert.equal(parsed.get('empty.bin').length, 0);
});

test('handles non-ASCII content while keeping ASCII names', () => {
    const parsed = parseStoreZip(buildStoreZip([jsonFile('meta.json', { name: 'Мой лорбук — «тест»' })]));
    assert.equal(readJsonFile(parsed, 'meta.json').name, 'Мой лорбук — «тест»');
});

test('rejects path traversal in entry names', () => {
    for (const name of ['../escape.json', 'a/../../b.json', '/absolute.json', 'nul\0.json']) {
        assert.throws(() => assertZipName(name), /Unsafe|Unsupported/, name);
    }
});

test('rejects non-ASCII entry names, which is why lorebooks are slugged', () => {
    assert.throws(() => assertZipName('лорбук.json'), /Unsupported/);
});

test('a corrupted payload is refused rather than half-read', () => {
    const zip = buildStoreZip([{ name: 'a.bin', data: bytes('hello world') }]);
    const tampered = zip.slice();
    tampered[35] ^= 0xFF;
    assert.throws(() => parseStoreZip(tampered), /CRC|damaged|range/i);
});

test('garbage in, exception out', () => {
    assert.throws(() => parseStoreZip(new Uint8Array(0)), /empty or invalid/);
    assert.throws(() => parseStoreZip(bytes('this is not a zip file at all, really')), /end-of-central-directory/);
});

test('crc32 matches the known vector', () => {
    assert.equal(crc32(bytes('123456789')), 0xCBF43926);
});

test('a large member survives, since archives carry originals', () => {
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    const parsed = parseStoreZip(buildStoreZip([{ name: 'big.bin', data: big }]));
    assert.deepEqual([...parsed.get('big.bin').slice(-4)], [...big.slice(-4)]);
    assert.equal(parsed.get('big.bin').length, big.length);
});
