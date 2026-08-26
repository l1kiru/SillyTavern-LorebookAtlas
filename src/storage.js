/**
 * Public storage facade. The UI talks to this and never to /api/files directly.
 *
 * Write-ahead ordering is the invariant that matters here: the manifest record is
 * committed *before* the bytes are uploaded, and removed *after* they are deleted.
 * Because /api/files has no listing endpoint, a crash must never be able to leave a file
 * that nothing points at — a dangling manifest record is detectable via /api/files/verify,
 * an untracked file is not findable at all.
 */

import { MANIFEST_FILE, MANIFEST_BAK_FILE, TOMBSTONE_FILE, DEFAULTS } from './constants.js';
import { buildFileName, fileUrl } from './filenames.js';
import { bytesToBase64 } from './files-api.js';
import { blobToBase64, prepareVariants } from './images.js';
import { buildTombstone, mergeTombstone, runCleanup, runFireAndForget } from './cleanup.js';
import * as model from './manifest-model.js';
import { uuid, pool } from './util.js';
import { T } from './i18n.js';

export function createStorage({ api, onChange, onConflict } = {}) {
    let manifest = model.createManifest();
    let loaded = false;

    /**
     * The revision this session last saw on disk.
     *
     * `rev` advances on every mutation, which makes it a cheap way to notice that another
     * tab wrote the catalogue underneath us. Without the check the later save silently
     * discards the other tab's work; with it the loss is at least reported. Detection only:
     * refusing the write would strand the edit the user just made.
     */
    let baseRev = 0;

    async function persist() {
        // Keep the previous revision alongside the current one. Cheap insurance against a
        // torn write leaving no readable catalogue at all — and the same read tells us
        // whether somebody else has written since we loaded.
        const previous = await api.readJson(fileUrl(MANIFEST_FILE));

        const theirs = Number(previous?.rev);
        if (Number.isFinite(theirs) && theirs > baseRev) {
            onConflict?.({ ours: manifest.rev, theirs, base: baseRev });
        }

        if (previous) await api.writeJson(MANIFEST_BAK_FILE, previous).catch(() => {});
        await api.writeJson(MANIFEST_FILE, manifest);
        baseRev = manifest.rev;
        onChange?.(manifest);
    }

    async function commit(next) {
        manifest = next;
        await persist();
        return manifest;
    }

    return {
        get manifest() {
            return manifest;
        },

        /** Reads the catalogue, falling back to the backup copy, then to an empty one. */
        async load() {
            const raw = await api.readJson(fileUrl(MANIFEST_FILE))
                ?? await api.readJson(fileUrl(MANIFEST_BAK_FILE));
            manifest = model.normalizeManifest(raw);
            baseRev = manifest.rev;
            loaded = true;
            onChange?.(manifest);
            return manifest;
        },

        get isLoaded() {
            return loaded;
        },

        async ensureGroup(groupId, lorebookName) {
            if (manifest.groups[groupId]) {
                if (manifest.groups[groupId].lorebookName === lorebookName) return manifest.groups[groupId];
            }
            await commit(model.upsertGroup(manifest, { id: groupId, lorebookName }));
            return manifest.groups[groupId];
        },

        /**
         * Stores an image into a group.
         *
         * Identical bytes already present anywhere are reused: the existing record gains a
         * reference instead of a second copy being uploaded.
         */
        async putImage(groupId, blob, { originalName = '', entryUid = null, ...options } = {}) {
            if (!manifest.groups[groupId]) throw new Error(T('error.unknownGroup', { id: groupId }));

            const prepared = await prepareVariants(blob, options);

            const duplicate = model.findImageBySha(manifest, prepared.sha256);
            if (duplicate) {
                if (entryUid != null) {
                    await commit(model.addRef(manifest, duplicate.id, { groupId, entryUid }));
                }
                return { image: manifest.images[duplicate.id], deduplicated: true };
            }

            const imageId = uuid();
            const planned = Object.entries(prepared.variants).map(([variant, payload]) => ({
                variant,
                payload,
                name: buildFileName({ groupId, imageId, variant, sha256: prepared.sha256, mime: payload.mime }),
            }));

            // Write-ahead: the record exists before any byte is uploaded.
            const record = {
                id: imageId,
                groupId,
                locked: false,
                sha256: prepared.sha256,
                mime: prepared.mime || blob.type,
                bytes: prepared.bytes,
                width: prepared.width,
                height: prepared.height,
                originalName: String(originalName || ''),
                variants: Object.fromEntries(planned.map(p => [p.variant, fileUrl(p.name)])),
                refs: entryUid == null ? [] : [{ groupId, entryUid }],
            };
            await commit(model.upsertImage(manifest, record));

            try {
                for (const item of planned) {
                    await api.upload(item.name, await blobToBase64(item.payload.blob));
                }
            } catch (error) {
                // Roll the record back so the catalogue does not advertise files that were
                // never written. Anything that did land is swept by verify() later.
                await commit(model.removeImage(manifest, imageId));
                throw error;
            }

            return { image: manifest.images[imageId], deduplicated: false };
        },

        async deleteImage(imageId) {
            const image = manifest.images[imageId];
            if (!image) return false;
            if (image.locked) throw new Error(T('error.imageLocked'));

            const files = model.imageFiles(image);
            await pool(files, DEFAULTS.cleanupConcurrency, path => api.remove(path));
            await commit(model.removeImage(manifest, imageId));
            return true;
        },

        /** Drops one usage reference. The file stays — other entries may still use it. */
        async removeRef(imageId, ref) {
            if (!manifest.images[imageId]) return null;
            await commit(model.removeRef(manifest, imageId, ref));
            return manifest.images[imageId];
        },

        async setLock(imageId, locked) {
            await commit(model.setLock(manifest, imageId, locked));
            return manifest.images[imageId];
        },

        /** List definitions for one lorebook. Membership itself lives inside the entries. */
        listsOf(groupId) {
            return model.listsOfGroup(manifest, groupId);
        },

        async setLists(groupId, lists) {
            await commit(model.setGroupLists(manifest, groupId, lists));
            return model.listsOfGroup(manifest, groupId);
        },

        /** Stores an image that came out of an archive, bytes and metadata already known. */
        async putImageFromArchive(record, bytesByVariant) {
            if (!manifest.groups[record.groupId]) throw new Error(T('error.unknownGroup', { id: record.groupId }));

            const duplicate = model.findImageBySha(manifest, record.sha256);
            if (duplicate) return { image: duplicate, deduplicated: true };

            const imageId = record.id || uuid();
            const planned = Object.entries(bytesByVariant).map(([variant, bytes]) => ({
                variant,
                bytes,
                name: buildFileName({
                    groupId: record.groupId,
                    imageId,
                    variant,
                    sha256: record.sha256,
                    mime: variant === 'original' ? record.mime : DEFAULTS.previewMime,
                }),
            }));

            await commit(model.upsertImage(manifest, {
                ...record,
                id: imageId,
                variants: Object.fromEntries(planned.map(p => [p.variant, fileUrl(p.name)])),
            }));

            try {
                for (const item of planned) {
                    await api.upload(item.name, bytesToBase64(item.bytes));
                }
            } catch (error) {
                await commit(model.removeImage(manifest, imageId));
                throw error;
            }

            return { image: manifest.images[imageId], deduplicated: false };
        },

        /** Raw bytes of a stored file, for archive building. */
        async readFile(url) {
            return await api.readBytes?.(url) ?? null;
        },

        /** Non-destructive preview of what deleting a group would do. */
        planGroupDeletion(groupId) {
            return model.planGroupDeletion(manifest, groupId);
        },

        /**
         * Deletes a group. Locked images and images shared with another group survive and
         * move to the system orphan group.
         */
        async deleteGroup(groupId) {
            const plan = model.planGroupDeletion(manifest, groupId);
            const results = await pool(plan.files, DEFAULTS.cleanupConcurrency, path => api.remove(path));
            const failed = results.filter(r => !r.ok).map(r => r.item);
            await commit(model.applyGroupDeletion(manifest, plan));
            return { ...plan, failed, moved: plan.keep.length, deleted: plan.remove.length };
        },

        /** Cross-checks the catalogue against what is actually on disk. */
        async verify() {
            const urls = Object.values(manifest.images).flatMap(model.imageFiles);
            const report = await api.verify(urls);
            const missing = urls.filter(url => report[url] === false);
            const affected = Object.values(manifest.images)
                .filter(image => model.imageFiles(image).some(url => missing.includes(url)))
                .map(image => image.id);
            return { checked: urls.length, missing, affectedImages: affected };
        },

        /** Full teardown, awaited and reported. Backs the broom button and the clean hook. */
        async cleanupAll({ onProgress } = {}) {
            const previous = await api.readJson(fileUrl(TOMBSTONE_FILE));
            const tombstone = mergeTombstone(previous, buildTombstone(manifest));
            await api.writeJson(TOMBSTONE_FILE, tombstone);
            const result = await runCleanup(api, tombstone, { onProgress });
            manifest = model.createManifest();
            baseRev = manifest.rev;
            onChange?.(manifest);
            return result;
        },

        /** Best-effort teardown from the delete hook; see cleanup.js for the constraints. */
        async cleanupFireAndForget() {
            const tombstone = buildTombstone(manifest);
            await api.writeJson(TOMBSTONE_FILE, tombstone);
            return runFireAndForget(api, tombstone);
        },

        totals() {
            return model.totals(manifest);
        },
    };
}
