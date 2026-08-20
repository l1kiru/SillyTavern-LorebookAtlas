import test from 'node:test';
import assert from 'node:assert/strict';

import * as model from '../src/manifest-model.js';
import { ORPHAN_GROUP_ID } from '../src/constants.js';

const GROUP_A = 'group-a';
const GROUP_B = 'group-b';

function fixture() {
    let m = model.createManifest();
    m = model.upsertGroup(m, { id: GROUP_A, lorebookName: 'Лорбук А' });
    m = model.upsertGroup(m, { id: GROUP_B, lorebookName: 'Лорбук Б' });

    const image = (id, groupId, extra = {}) => ({
        id,
        groupId,
        sha256: `sha-${id}`,
        mime: 'image/webp',
        bytes: 1000,
        variants: { preview: `user/files/lba_aaaaaaaa_${id}_p_bbbbbbbb.webp` },
        refs: [{ groupId, entryUid: 1 }],
        ...extra,
    });

    m = model.upsertImage(m, image('plain001', GROUP_A));
    m = model.upsertImage(m, image('locked01', GROUP_A, { locked: true }));
    m = model.upsertImage(m, image('shared01', GROUP_A, {
        refs: [{ groupId: GROUP_A, entryUid: 1 }, { groupId: GROUP_B, entryUid: 7 }],
    }));
    m = model.upsertImage(m, image('other001', GROUP_B));
    return m;
}

test('plan deletes only unlocked, unshared images', () => {
    const plan = model.planGroupDeletion(fixture(), GROUP_A);
    assert.deepEqual(plan.remove, ['plain001']);

    const reasons = Object.fromEntries(plan.keep.map(k => [k.id, k.reason]));
    assert.equal(reasons.locked01, 'locked');
    assert.equal(reasons.shared01, 'cross-ref');
    assert.equal(plan.keep.length, 2);
});

test('plan lists exactly the files belonging to removed images', () => {
    const plan = model.planGroupDeletion(fixture(), GROUP_A);
    assert.equal(plan.files.length, 1);
    assert.match(plan.files[0], /plain001/);
    assert.equal(plan.bytes, 1000);
});

test('survivors move to the orphan group and keep their outside references', () => {
    const before = fixture();
    const plan = model.planGroupDeletion(before, GROUP_A);
    const after = model.applyGroupDeletion(before, plan);

    assert.equal(after.images.plain001, undefined, 'plain image is gone');
    assert.equal(after.images.locked01.groupId, ORPHAN_GROUP_ID);
    assert.equal(after.images.shared01.groupId, ORPHAN_GROUP_ID);
    assert.equal(after.groups[GROUP_A], undefined, 'group itself is gone');

    // The reference into the deleted group is dropped; the one into group B survives,
    // which is the whole reason the image was protected.
    assert.deepEqual(after.images.shared01.refs, [{ groupId: GROUP_B, entryUid: 7 }]);
    assert.equal(after.images.locked01.movedFrom, 'Лорбук А');
});

test('a deduplicated image shared with another lorebook is never silently destroyed', () => {
    const before = fixture();
    const after = model.applyGroupDeletion(before, model.planGroupDeletion(before, GROUP_A));
    const stillReachable = Object.values(after.images).some(i => i.sha256 === 'sha-shared01');
    assert.ok(stillReachable, 'image used by group B must still exist');
});

test('the system orphan group cannot be deleted wholesale', () => {
    assert.throws(() => model.planGroupDeletion(fixture(), ORPHAN_GROUP_ID), /system group/i);
});

test('deleting an unknown group is an error, not a silent no-op', () => {
    assert.throws(() => model.planGroupDeletion(fixture(), 'nope'), /Unknown group/);
});

test('group deletion is pure — the input manifest is untouched', () => {
    const before = fixture();
    const snapshot = JSON.stringify(before);
    model.applyGroupDeletion(before, model.planGroupDeletion(before, GROUP_A));
    assert.equal(JSON.stringify(before), snapshot);
});

test('locking blocks removal and shows up in the stats', () => {
    let m = fixture();
    m = model.setLock(m, 'plain001', true);
    const plan = model.planGroupDeletion(m, GROUP_A);
    assert.deepEqual(plan.remove, []);
    assert.equal(model.groupStats(m, GROUP_A).locked, 2);
});
