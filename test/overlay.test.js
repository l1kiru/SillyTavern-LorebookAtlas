/**
 * Overlay chrome is DOM-heavy; the geometry helpers are the part that can
 * silently put a menu off-screen or square a portrait crop preview.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { anchoredPosition, previewAspectRatio, nextOverlayZ } from '../src/ui/overlay.js';

test('anchoredPosition flips above the point when the menu would overflow', () => {
    assert.deepEqual(
        anchoredPosition({ width: 120, height: 80 }, { width: 400, height: 200 }, { x: 10, y: 10 }),
        { left: 10, top: 10 },
    );
    assert.deepEqual(
        anchoredPosition({ width: 120, height: 80 }, { width: 400, height: 200 }, { x: 350, y: 180 }),
        { left: 272, top: 100 },
    );
});

test('previewAspectRatio follows the stored image, not a square thumb', () => {
    assert.equal(previewAspectRatio(1920, 1080), '1920 / 1080');
    assert.equal(previewAspectRatio(0, 100), '1');
    assert.equal(previewAspectRatio(undefined, undefined), '1');
});

test('overlay z-index climbs so a later menu stacks above an earlier one', () => {
    const first = nextOverlayZ();
    assert.ok(nextOverlayZ() > first);
});
