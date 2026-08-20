/**
 * The archive format.
 *
 * One format, one pipeline. "Full backup" and "transfer a single lorebook" are not two
 * features — they are two values of a filter applied at build time. Everything downstream,
 * including the whole restore path, is identical.
 *
 * Layout inside the ZIP:
 *
 *   lba-archive.json        metadata, list definitions, image records
 *   lorebooks/<slug>.json   raw SillyTavern lorebooks
 *   images/<file>           image files verbatim
 *   settings.json           extension settings (optional)
 */

import { buildStoreZip, parseStoreZip, jsonFile, readJsonFile } from './zip.js';
import { ORPHAN_GROUP_ID } from './constants.js';
import { imageFiles } from './manifest-model.js';
import { fileNameFromUrl } from './filenames.js';
import { listsOfGroup } from './manifest-model.js';
import { T } from './i18n.js';

export const ARCHIVE_SCHEMA = 1;
export const META_FILE = 'lba-archive.json';
export const SETTINGS_FILE = 'settings.json';
export const LOREBOOK_DIR = 'lorebooks';
export const IMAGE_DIR = 'images';

/** ZIP names are ASCII-only, so lorebook names become slugs and the real name lives in metadata. */
export function slugFor(name, index) {
    const slug = String(name || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .toLowerCase();
    return slug ? `${slug}-${index}` : `lorebook-${index}`;
}

/**
 * Assembles an archive.
 *
 * @param {object} params
 * @param {object} params.manifest
 * @param {Array<{ name: string, groupId: string|null, book: object }>} params.lorebooks
 * @param {(url: string) => Promise<Uint8Array|null>} params.readImage
 * @param {object} [params.settings] omitted when not supplied
 * @param {boolean} [params.includeOrphaned] carry groups whose lorebook is gone
 * @param {boolean} [params.includeOriginals] carry original variants, not just previews
 * @returns {Promise<{ bytes: Uint8Array, meta: object, skipped: string[] }>}
 */
export async function buildArchive({
    manifest,
    lorebooks = [],
    readImage,
    settings = null,
    includeOrphaned = true,
    includeOriginals = true,
    now = new Date(),
}) {
    const files = [];
    const skipped = [];
    const wantedImages = new Map();

    const meta = {
        schema: ARCHIVE_SCHEMA,
        createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
        scope: lorebooks.length === 1 ? 'single' : 'full',
        lorebooks: [],
        images: {},
        orphanedGroups: [],
    };

    function collectImagesOfGroup(groupId) {
        const ids = [];
        for (const image of Object.values(manifest.images)) {
            if (image.groupId !== groupId) continue;
            ids.push(image.id);
            wantedImages.set(image.id, image);
        }
        return ids;
    }

    lorebooks.forEach((item, index) => {
        const slug = slugFor(item.name, index);
        const path = `${LOREBOOK_DIR}/${slug}.json`;
        files.push(jsonFile(path, item.book));

        meta.lorebooks.push({
            name: item.name,
            file: path,
            groupId: item.groupId || null,
            lists: item.groupId ? listsOfGroup(manifest, item.groupId) : {},
            images: item.groupId ? collectImagesOfGroup(item.groupId) : [],
        });
    });

    if (includeOrphaned) {
        for (const group of Object.values(manifest.groups)) {
            const isOrphan = group.system || group.orphanedAt;
            if (!isOrphan) continue;
            const images = collectImagesOfGroup(group.id);
            if (!images.length && group.id !== ORPHAN_GROUP_ID) continue;
            meta.orphanedGroups.push({
                id: group.id,
                lastKnownName: group.lastKnownName || '',
                orphanedAt: group.orphanedAt || null,
                system: Boolean(group.system),
                images,
            });
        }
    }

    for (const image of wantedImages.values()) {
        const variants = {};

        for (const [variant, url] of Object.entries(image.variants || {})) {
            if (!includeOriginals && variant === 'original') continue;
            const name = fileNameFromUrl(url);
            const bytes = await readImage(url);
            if (!bytes) {
                // A record pointing at a file that is not on disk. Recorded rather than
                // thrown: one missing preview should not sink a whole backup.
                skipped.push(url);
                continue;
            }
            files.push({ name: `${IMAGE_DIR}/${name}`, data: bytes });
            variants[variant] = name;
        }

        meta.images[image.id] = {
            id: image.id,
            groupId: image.groupId,
            locked: Boolean(image.locked),
            sha256: image.sha256,
            mime: image.mime,
            bytes: image.bytes,
            width: image.width,
            height: image.height,
            originalName: image.originalName,
            createdAt: image.createdAt,
            refs: image.refs || [],
            variants,
        };
    }

    if (settings) files.push(jsonFile(SETTINGS_FILE, settings));
    files.unshift(jsonFile(META_FILE, meta));

    return { bytes: buildStoreZip(files, now), meta, skipped };
}

/**
 * Opens an archive and validates it enough to be trusted downstream.
 * @param {Uint8Array} bytes
 */
export function readArchive(bytes) {
    const files = parseStoreZip(bytes);
    const meta = readJsonFile(files, META_FILE);

    if (!meta || typeof meta !== 'object') {
        throw new Error(T('error.notAnArchive'));
    }
    // Refuse a newer schema outright. Guessing at an unknown layout is how backups get
    // silently half-restored.
    if (Number(meta.schema) > ARCHIVE_SCHEMA) {
        throw new Error(T('error.archiveTooNew', { found: meta.schema, supported: ARCHIVE_SCHEMA }));
    }

    const lorebooks = (meta.lorebooks || []).map(item => ({
        ...item,
        book: readJsonFile(files, item.file),
    })).filter(item => item.book);

    return {
        meta,
        files,
        lorebooks,
        settings: readJsonFile(files, SETTINGS_FILE, null),
        imageBytes: name => files.get(`${IMAGE_DIR}/${name}`) ?? null,
    };
}

/** Rough size estimate before building, so the UI can warn about very large backups. */
export function estimateArchiveBytes(manifest, groupIds) {
    const wanted = new Set(groupIds);
    return Object.values(manifest.images)
        .filter(image => wanted.has(image.groupId))
        .reduce((sum, image) => sum + (Number(image.bytes) || 0) + imageFiles(image).length * 512, 0);
}
