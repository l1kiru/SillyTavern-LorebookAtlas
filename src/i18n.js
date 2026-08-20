/**
 * Localization.
 *
 * English is the source language: every string lives here in English, and locale files
 * map the key to a translation. Nothing user-visible is written in another language
 * anywhere else in the codebase.
 *
 * Keys are namespaced with `lba.` because SillyTavern's addLocaleData() refuses to
 * override keys that already exist in the core locale — an unprefixed key like "Delete"
 * would silently resolve to the core translation instead of ours.
 *
 * Placeholders are `{name}` and are substituted after translation, so a translator may
 * reorder them freely.
 */

export const KEY_PREFIX = 'lba.';

/** The single source of truth for every user-visible string. */
export const STRINGS = Object.freeze({
    // Groups
    'group.orphanBucket': 'Without lorebook',
    'group.orphanedLabel': '"{name}" — deleted {date}',
    'group.orphanedUnnamed': 'Unnamed lorebook — deleted {date}',
    'group.badgeDeleted': 'lorebook deleted',
    'group.badgeSystem': 'system',
    'group.badgeLocked': '{count} locked',
    'group.unlockAll': 'Unlock all in group',
    'group.delete': 'Delete group',

    // Tiles and image detail
    'image.unused': 'not used',
    'image.usedInShort': 'used in {count}',
    'image.movedFromShort': 'from "{name}"',
    'image.noName': '(no name)',
    'image.usedIn': 'Used in {count} entries',
    'image.notUsed': 'Not used in any entry',
    'image.movedFrom': 'Moved from "{name}"',
    'image.lock': 'Lock',
    'image.unlock': 'Unlock',
    'image.delete': 'Delete',
    'image.bindToEntry': 'Bind to entry',
    'image.confirmDelete': 'Delete "{name}"? The file will be erased from disk.',
    'image.lockedWarning': 'Image is locked — unlock it first',

    // Group deletion dialog
    'delete.confirmGroup': 'Delete group "{name}"?',
    'delete.willRemove': 'Will be deleted: {count} images ({size})',
    'delete.keepLocked': 'Locked images kept: {count}',
    'delete.keepShared': 'Images used in other lorebooks kept: {count}',
    'delete.keepMoveTo': 'Kept images will move to the "Without lorebook" group',
    'delete.done': 'Deleted {deleted}, kept {moved}',
    'delete.partial': 'Deleted {deleted} of {total}, errors: {failed}',

    // Gallery shell
    'gallery.search': 'Search across all groups',
    'gallery.filterAll': 'All',
    'gallery.filterLocked': 'Locked only',
    'gallery.filterOrphaned': 'Orphaned only',
    'gallery.filterUnused': 'No references',
    'gallery.verify': 'Verify storage',
    'gallery.close': 'Close',
    'gallery.notFound': 'Nothing found',
    'gallery.emptyGroup': 'Empty',
    'gallery.emptyStorage': 'Storage is empty',
    'gallery.totals': '{images} images in {groups} groups · {files} files · {size}',

    // Integrity check
    'verify.ok': 'Checked {checked} files, all present.',
    'verify.missing': 'Checked {checked} files, {missing} missing.',
    'verify.affected': 'Affected images: {count}. Their records point to files that are not on disk.',

    // Settings panel. settings.title is the product name — keep it English in every locale.
    'settings.title': 'Lorebook Atlas',
    'settings.openGallery': 'Open gallery',
    'settings.verify': 'Verify storage',
    'settings.keepOriginal': 'Keep the original alongside the preview',
    'settings.previewSize': 'Preview size, px',
    'settings.iconSize': 'Icon size',
    'settings.iconSizeCompact': 'Compact',
    'settings.iconSizeNormal': 'Normal',
    'settings.iconSizeLarge': 'Large',
    'settings.iconSizeXLarge': 'Extra large',
    'settings.bindingStrategy': 'Where to store the group identifier',
    'settings.strategyEntry': 'In every lorebook entry (reliable)',
    'settings.strategyBook': 'One field per lorebook (compact)',
    'settings.strategyHint': 'The compact option keeps one field per lorebook, the reliable one repeats it in every entry. Compact only works if SillyTavern preserves unknown top-level fields; if images or lists stop following a lorebook, switch back to reliable.',
    'settings.cleanup': 'Delete all extension data',
    'settings.cleanupHint': 'Removes every image and the manifest from storage. The broom button in the extensions list does the same. Deleting the extension itself triggers cleanup automatically.',
    'settings.summaryLocked': '{count} locked',

    // Cleanup
    'cleanup.confirm': 'Delete {files} files ({images} images, {size})?',
    'cleanup.warning': 'Locks will not help — everything is deleted, including locked images. This cannot be undone.',
    'cleanup.alreadyEmpty': 'Storage is already empty',
    'cleanup.done': 'Deleted {total} files',
    'cleanup.partial': 'Deleted {deleted} of {total}, failed: {failed}',

    // World Info entries
    'entry.add': 'Add image',
    'entry.replace': 'Entry image — click to replace or crop',
    'entry.menuReplace': 'Replace image',
    'entry.crop': 'Crop',
    'entry.cropHelp': 'X/Y moves the frame, Zoom crops tighter.',
    'entry.cropX': 'X',
    'entry.cropY': 'Y',
    'entry.cropZoom': 'Zoom',
    'entry.cropApply': 'Apply',
    'entry.cropReset': 'Reset',
    'entry.cropCancel': 'Cancel',
    'entry.openBookFirst': 'Open a lorebook first',
    'entry.added': 'Image added',
    'entry.deduplicated': 'Image was already in storage — reused',

    // Lists
    'list.unnamed': 'Unnamed list',
    'list.unknown': 'Unknown list',
    'list.reconstructed': 'List {id}',
    'list.computedNoImage': 'Without image',
    'list.computedLocked': 'With locked image',
    'list.computedUnlisted': 'Not in any list',
    'list.snapshotLocal': 'Local',
    'list.snapshotRestored': 'Restored {date}',
    'list.create': 'New list',
    'list.addTo': 'Add to lists',
    'list.noLists': 'Create a list first',
    'list.rename': 'Rename',
    'list.delete': 'Delete list',
    'list.deleteChildren': 'Delete nested lists too',
    'list.countOwn': '{own} here',
    'list.countTotal': '{total} in total',
    'list.empty': 'No entries in this list',
    'list.rootLabel': 'All entries',
    'list.explorer': 'Lorebook explorer',
    'list.filterActive': 'Filtering by list: {name}',
    'filter.label': 'List',
    'filter.pageOnly': 'current page only',
    'list.clearFilter': 'Show all entries',

    // Archive and restore
    'archive.export': 'Export archive',
    'archive.exportFull': 'Everything',
    'archive.exportSingle': 'One lorebook',
    'archive.import': 'Restore from archive',
    'archive.includeOriginals': 'Include original images',
    'archive.includeSettings': 'Include extension settings',
    'archive.includeOrphaned': 'Include images of deleted lorebooks',
    'archive.building': 'Building archive…',
    'archive.built': 'Archive ready: {size}',
    'archive.skippedFiles': '{count} files were missing and are not in the archive',
    'archive.hint': 'One format for both: a full backup and a single-lorebook transfer differ only in what goes in. Restoring always shows a per-lorebook preview first.',
    'archive.sizeWarning': 'Estimated size {size}. Large archives are assembled in browser memory and may fail.',

    'restore.suffix': '{name} (restored)',
    'restore.suffixN': '{name} (restored {n})',
    'restore.title': 'Restore preview',
    'restore.columnArchive': 'In archive',
    'restore.columnLocal': 'Local',
    'restore.columnAction': 'Action',
    'restore.columnName': 'Result name',
    'restore.policyCreate': 'Create',
    'restore.policySeparate': 'Separately',
    'restore.policyReplace': 'Replace',
    'restore.policyMerge': 'Merge',
    'restore.policySkip': 'Skip',
    'restore.defaultPolicy': 'Default for conflicts',
    'restore.markLists': 'Mark merge result with lists',
    'restore.noLocal': 'not present',
    'restore.localEntries': '{count} entries',
    'restore.mergeSummary': 'match {matched}, from archive {incoming}, local only {local}',
    'restore.lowConfidence': '{count} matched loosely — check the result',
    'restore.dryRun': 'Show plan',
    'restore.apply': 'Restore',
    'restore.done': 'Restored: created {created}, replaced {replaced}, merged {merged}, separately {separated}',
    'restore.failed': 'Failed: {count}',

    // Errors
    'error.unknownGroup': 'Group not found: {id}',
    'error.unknownList': 'List not found: {id}',
    'error.listCycle': 'A list cannot be nested inside itself',
    'error.listTooDeep': 'Nesting is limited to {max} levels',
    'error.notAnArchive': 'This file is not a Lorebook Atlas archive',
    'error.archiveTooNew': 'Archive schema {found} is newer than this version supports ({supported})',
    'error.archiveItemMissing': 'Lorebook is missing from the archive: {name}',
    'error.systemGroupDelete': 'The system group cannot be deleted',
    'error.imageLocked': 'Image is locked — unlock it first',
    'error.notAnImage': 'File was not recognised as an image',
    'error.unsupportedFormat': 'Unsupported format: {mime}',
    'error.unknownMime': 'unknown',

    // Byte units
    'unit.b': 'B',
    'unit.kb': 'KB',
    'unit.mb': 'MB',
    'unit.gb': 'GB',
    'unit.tb': 'TB',
});

/** Substitutes {placeholders}. Unknown names are left alone rather than blanked. */
export function format(template, params) {
    if (!params) return template;
    return String(template).replace(/\{(\w+)\}/g, (match, name) =>
        Object.hasOwn(params, name) ? String(params[name]) : match);
}

/**
 * Translates a key from STRINGS.
 *
 * Resolution goes through SillyTavern's translate() when available, falling back to the
 * English source. The lookup is lazy so src/ remains importable under node for tests.
 *
 * @param {keyof STRINGS} key
 * @param {Record<string, any>} [params]
 */
export function T(key, params) {
    const english = STRINGS[key];
    if (english === undefined) {
        console.warn(`[lorebook-atlas] missing string key: ${key}`);
        return key;
    }
    const translate = globalThis.SillyTavern?.getContext?.()?.translate;
    const translated = typeof translate === 'function' ? translate(english, KEY_PREFIX + key) : english;
    return format(translated, params);
}

/**
 * The translated template with its {placeholders} still in place.
 *
 * Needed where a template has to be parsed back apart rather than rendered — the restore
 * suffix, for instance, is stripped and re-applied so repeated restores do not stack up.
 */
export function rawTemplate(key) {
    const english = STRINGS[key];
    if (english === undefined) return key;
    const translate = globalThis.SillyTavern?.getContext?.()?.translate;
    return typeof translate === 'function' ? translate(english, KEY_PREFIX + key) : english;
}

/**
 * Builds a regex that recognises the output of a template.
 * @param {string} key
 * @param {Record<string, string>} groups placeholder name → capture pattern
 */
export function templateMatcher(key, groups) {
    let pattern = rawTemplate(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [name, capture] of Object.entries(groups)) {
        pattern = pattern.replace(`\\{${name}\\}`, capture);
    }
    return new RegExp(`^${pattern}$`);
}

/** Full key as it appears in locale files and data-i18n attributes. */
export function fullKey(key) {
    return KEY_PREFIX + key;
}
