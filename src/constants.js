/** Shared constants. Kept free of any browser or SillyTavern dependency so tests can import it directly. */

export const MODULE_NAME = 'lorebook_atlas';
/**
 * Folder this extension was installed into, as SillyTavern addresses it.
 *
 * Not a constant, because the name is not ours to choose: /api/extensions/install derives
 * it from the repository URL (`path.basename(url)`), so a fork or a rename lands the code
 * somewhere else entirely. renderExtensionTemplateAsync() builds a URL from this value, so
 * a wrong guess means the settings template 404s and the panel never appears.
 *
 * Reading it back from import.meta.url removes the guess: the module knows where it is.
 * Under node (tests) the URL is a file:// path and the fallback applies.
 */
function resolveExtensionFolder() {
    const match = /\/scripts\/extensions\/(third-party\/[^/]+)\//.exec(import.meta.url);
    return match?.[1] ?? 'third-party/SillyTavern-LorebookAtlas';
}

export const EXTENSION_FOLDER = resolveExtensionFolder();

/**
 * Settings template, addressed relative to the extension folder.
 * Kept next to EXTENSION_FOLDER because the two are always used together, and a mismatch
 * between this and the file on disk fails as a 404 that only shows up at runtime.
 */
export const TEMPLATE_ID = 'templates/settings';

export const SCHEMA_VERSION = 2;

/**
 * Names of our files inside the user's file store.
 *
 * The manifest name MUST stay a hard-coded constant with no hash or version in it.
 * It is the only anchor by which the whole catalogue can be recovered after the
 * extension is deleted and reinstalled, because /api/files has no listing endpoint.
 */
export const MANIFEST_FILE = 'lba_manifest.json';
export const MANIFEST_BAK_FILE = 'lba_manifest_bak.json';
export const TOMBSTONE_FILE = 'lba_tombstone.json';

/** Prefix for every file we own, so a human can identify them in data/<handle>/user/files. */
export const FILE_PREFIX = 'lba';

/** Route prefix under which SillyTavern serves the per-user file store. */
export const FILES_ROUTE = 'user/files';

/** Identifier of the system group that collects images surviving a group deletion. */
export const ORPHAN_GROUP_ID = '__orphaned__';
/**
 * Stored fallback only. What the user actually sees comes from T('group.orphanBucket'),
 * because localized text must never be persisted into the manifest — the same file is
 * read by users on other locales.
 */
export const ORPHAN_GROUP_NAME = 'Without lorebook';

/**
 * Variants stored per image.
 *
 * Deliberately two, not three: the icon is derived from the preview with CSS
 * object-fit. Cleanup cost is linear in the number of files, and the delete hook
 * has a hard 5 second budget, so every variant dropped is a third off both the
 * teardown time and the disk footprint.
 */
export const VARIANT = Object.freeze({
    PREVIEW: 'preview',
    ORIGINAL: 'original',
});

export const VARIANT_CODE = Object.freeze({
    [VARIANT.PREVIEW]: 'p',
    [VARIANT.ORIGINAL]: 'o',
});

export const CODE_VARIANT = Object.freeze({
    p: VARIANT.PREVIEW,
    o: VARIANT.ORIGINAL,
});

export const MIME_EXT = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
});

export const EXT_MIME = Object.freeze({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
});

export const DEFAULTS = Object.freeze({
    previewMaxSide: 512,
    previewMime: 'image/webp',
    previewQuality: 0.85,
    keepOriginal: true,
    maxOriginalBytes: 8 * 1024 * 1024,
    cleanupConcurrency: 8,
});

/**
 * Display-size presets for the World Info header icon. Same clamps Lorebook Images used.
 * Encoding size is previewMaxSide; this only changes how large the icon is on screen.
 */
export const LAYOUT_PRESETS = Object.freeze({
    compact: Object.freeze({
        iconDesktop: 'clamp(2.15rem, 3vw, 2.5rem)',
        iconTablet: 'clamp(2.05rem, 5vw, 2.35rem)',
        iconMobile: 'clamp(2rem, 11vw, 2.25rem)',
    }),
    normal: Object.freeze({
        iconDesktop: 'clamp(2.55rem, 3.5vw, 3rem)',
        iconTablet: 'clamp(2.35rem, 5.8vw, 2.75rem)',
        iconMobile: 'clamp(2.2rem, 12vw, 2.55rem)',
    }),
    large: Object.freeze({
        iconDesktop: 'clamp(3.1rem, 4.5vw, 4rem)',
        iconTablet: 'clamp(2.8rem, 7vw, 3.5rem)',
        iconMobile: 'clamp(2.45rem, 13vw, 3rem)',
    }),
    xlarge: Object.freeze({
        iconDesktop: 'clamp(3.6rem, 5.4vw, 4.75rem)',
        iconTablet: 'clamp(3.1rem, 8vw, 4rem)',
        iconMobile: 'clamp(2.7rem, 14vw, 3.35rem)',
    }),
});

export function normalizeLayoutPreset(name) {
    return Object.hasOwn(LAYOUT_PRESETS, name) ? name : 'normal';
}

/** Hard limit imposed by SillyTavern's validateAssetFileName(). */
export const SAFE_FILENAME_RE = /^[a-zA-Z0-9_\-.]+$/;
