/**
 * Lorebook Atlas — entry point.
 *
 * Everything SillyTavern-specific lives here; src/ stays free of globals so the logic can
 * be unit-tested under node. Access to SillyTavern.getContext() is deliberately lazy: the
 * manifest hooks are imported by ST at moments when the app may not be initialised yet.
 */

import { MODULE_NAME, ORPHAN_GROUP_ID } from './src/constants.js';
import { createFilesApi } from './src/files-api.js';
import { createStorage } from './src/storage.js';
import { resumePendingCleanup } from './src/cleanup.js';
import { reconcileGroups } from './src/groups.js';
import { T } from './src/i18n.js';
import { discoverBindings, ensureGroupId, writeEntryImage, readGroupId, entriesWithLists, STRATEGY } from './src/lorebook-binding.js';
import { buildArchive, readArchive, estimateArchiveBytes } from './src/archive.js';
import { applyRestore } from './src/restore.js';
import { reconstructMissingLists } from './src/lists.js';
import { formatBytes } from './src/util.js';
import { createGallery } from './src/ui/gallery.js';
import { createExplorer } from './src/ui/explorer.js';
import { createRestorePreview } from './src/ui/restore-preview.js';
import { createSettingsPanel, applyLayoutPreset } from './src/ui/settings.js';
import { createEntryButtons } from './src/ui/entry-button.js';
import { createWiAdapter } from './src/ui/wi-adapter.js';
import { createWiFilter } from './src/ui/wi-filter.js';

let sharedAdapter = null;
function wiAdapter() {
    if (!sharedAdapter) sharedAdapter = createWiAdapter();
    return sharedAdapter;
}

/**
 * Bumped whenever the stored shape changes.
 *
 * There is nothing to migrate yet — this is the first released schema. The machinery is
 * here from the start because without a version there is no way to repair a bad default
 * once it has been written into every user's settings.json.
 */
const SETTINGS_SCHEMA_VERSION = 1;

const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    enabled: true,
    bindingStrategy: STRATEGY.ENTRY,
    keepOriginal: true,
    previewMaxSide: 512,
    layoutPreset: 'normal',
    includeSettingsInArchive: false,
    collapsedGroups: [],
});

/**
 * Upgrade steps, keyed by the version each one upgrades *from*, so a user several versions
 * behind runs them all in order. Empty until the first breaking change.
 */
const SETTINGS_MIGRATIONS = Object.freeze({});

function migrateSettings(stored) {
    let version = Number(stored.schemaVersion) || 0;
    while (version < SETTINGS_SCHEMA_VERSION) {
        const step = SETTINGS_MIGRATIONS[version];
        if (step) {
            try {
                step(stored);
            } catch (error) {
                console.error(`[${MODULE_NAME}] settings migration ${version} failed:`, error);
            }
        }
        version += 1;
    }
    stored.schemaVersion = SETTINGS_SCHEMA_VERSION;
    return stored;
}

let storage = null;
let gallery = null;
let settingsPanel = null;
let entryButtons = null;
let explorer = null;
let wiFilter = null;

function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function api() {
    const context = ctx();
    return createFilesApi({
        fetch: globalThis.fetch.bind(globalThis),
        getHeaders: () => context?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
    });
}

function notify(message, type = 'info') {
    globalThis.toastr?.[type]?.(message, T('settings.title'));
}

function settings() {
    const context = ctx();
    if (!context) return { ...DEFAULT_SETTINGS };
    const bag = context.extensionSettings;
    if (!bag[MODULE_NAME]) bag[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);

    const stored = bag[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(stored, key)) stored[key] = value;
    }
    if (Number(stored.schemaVersion) !== SETTINGS_SCHEMA_VERSION) {
        migrateSettings(stored);
        context.saveSettingsDebounced?.();
    }
    return stored;
}

async function getStorage() {
    if (storage) return storage;
    storage = createStorage({
        api: api(),
        onChange: () => {
            settingsPanel?.refresh();
            entryButtons?.refresh();
        },
    });
    await storage.load();
    return storage;
}

// ---------------------------------------------------------------------------
// Lorebook plumbing
// ---------------------------------------------------------------------------

/**
 * Short-lived cache over loadWorldInfo.
 *
 * WORLDINFO_UPDATED fires on essentially every edit, and syncGroups reads every lorebook.
 * Without a cache a library of thirty books means thirty fetches per keystroke-ish event.
 * The TTL is deliberately short: correctness after an edit matters more than hit rate.
 */
const BOOK_CACHE_TTL_MS = 10_000;
const bookCache = new Map();

async function loadBookCached(name, { force = false } = {}) {
    const context = ctx();
    if (!context) return null;

    const hit = bookCache.get(name);
    if (!force && hit && Date.now() - hit.at < BOOK_CACHE_TTL_MS) return hit.book;

    try {
        const book = await context.loadWorldInfo(name);
        bookCache.set(name, { book, at: Date.now() });
        return book;
    } catch (error) {
        console.warn(`[${MODULE_NAME}] could not read lorebook "${name}":`, error);
        return null;
    }
}

function invalidateBookCache(name) {
    if (name) bookCache.delete(name);
    else bookCache.clear();
}

async function loadAllBooks({ force = false } = {}) {
    const context = ctx();
    if (!context) return [];
    const names = context.getWorldInfoNames?.() ?? [];
    const books = [];
    for (const name of names) {
        const book = await loadBookCached(name, { force });
        if (book) books.push({ name, book });
    }
    return books;
}

/** Saves a lorebook and drops it from the cache in one place, so the two cannot diverge. */
async function saveBook(name, book) {
    const context = ctx();
    await context.saveWorldInfo(name, book);
    invalidateBookCache(name);
}

/** Brings the catalogue in line with World Info: renames, orphans, restorations. */
async function syncGroups() {
    const store = await getStorage();
    const discovered = discoverBindings(await loadAllBooks());
    const { manifest, changes } = reconcileGroups(store.manifest, discovered);
    if (!changes.length) return changes;

    Object.assign(store.manifest, manifest);
    console.debug(`[${MODULE_NAME}] groups reconciled:`, changes);
    gallery?.refresh();
    settingsPanel?.refresh();
    return changes;
}

/** Returns or creates the group bound to a lorebook, writing the UUID into the book. */
export async function groupForLorebook(bookName) {
    const book = await loadBookCached(bookName, { force: true });
    const { groupId, created } = ensureGroupId(book, settings().bindingStrategy);
    if (created) await saveBook(bookName, book);

    const store = await getStorage();
    await store.ensureGroup(groupId, bookName);
    return groupId;
}

function pickFile() {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp,image/gif';
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
        input.click();
    });
}

/** Full attach flow: pick a file, store it in the lorebook's group, bind it to the entry. */
async function attachImageToEntry({ entryUid, bookName }) {
    if (!bookName) {
        notify(T('entry.openBookFirst'), 'warning');
        return;
    }

    const file = await pickFile();
    if (!file) return;

    try {
        const store = await getStorage();
        const groupId = await groupForLorebook(bookName);

        const { image, deduplicated } = await store.putImage(groupId, file, {
            originalName: file.name,
            entryUid,
            keepOriginal: settings().keepOriginal,
            maxSide: settings().previewMaxSide,
        });

        // The binding also goes into the entry itself, so it travels with a lorebook export.
        const book = await loadBookCached(bookName, { force: true });
        const entry = Object.values(book.entries || {}).find(e => String(e.uid) === String(entryUid));
        if (entry) {
            writeEntryImage(entry, image);
            await saveBook(bookName, book);
        }

        entryButtons?.refresh();
        gallery?.refresh();
        notify(deduplicated ? T('entry.deduplicated') : T('entry.added'), 'success');
    } catch (error) {
        console.error(`[${MODULE_NAME}] failed to add image:`, error);
        notify(error.message, 'error');
    }
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

/** Current lorebook name, resolved through the adapter's selector chain. */
function currentBookName() {
    return entryButtons?.bookName() ?? wiAdapter().bookName();
}

function downloadBytes(bytes, filename) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    // Revoking immediately can cut the download short in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Exports an archive. Scope is a filter, nothing more: a full backup and a single-lorebook
 * transfer produce the same format through the same code.
 */
export async function exportArchive({ scope = 'full', bookName = '' } = {}) {
    const context = ctx();
    const store = await getStorage();

    const all = await loadAllBooks();
    const selected = scope === 'single'
        ? all.filter(item => item.name === (bookName || currentBookName()))
        : all;

    if (!selected.length) {
        notify(T('entry.openBookFirst'), 'warning');
        return null;
    }

    const lorebooks = selected.map(item => ({
        name: item.name,
        groupId: readGroupId(item.book),
        book: item.book,
    }));

    const estimate = estimateArchiveBytes(store.manifest, lorebooks.map(b => b.groupId).filter(Boolean));
    if (estimate > 128 * 1024 * 1024) {
        // The whole archive is assembled in browser memory before it can be handed over.
        notify(T('archive.sizeWarning', { size: formatBytes(estimate) }), 'warning');
    }

    notify(T('archive.building'));

    const { bytes, skipped } = await buildArchive({
        manifest: store.manifest,
        lorebooks,
        readImage: url => store.readFile(url),
        settings: settings().includeSettingsInArchive === false ? null : settings(),
        includeOriginals: settings().keepOriginal,
        includeOrphaned: scope === 'full',
    });

    const stamp = new Date().toISOString().slice(0, 10);
    downloadBytes(bytes, scope === 'single' ? `lba-${stamp}-${lorebooks[0].name}.zip` : `lba-${stamp}-full.zip`);

    if (skipped.length) notify(T('archive.skippedFiles', { count: skipped.length }), 'warning');
    notify(T('archive.built', { size: formatBytes(bytes.length) }), 'success');
    void context;
    return bytes;
}

/** Opens a file, previews the restore plan, then applies it. */
export async function importArchive() {
    const context = ctx();
    const store = await getStorage();

    const file = await pickArchiveFile();
    if (!file) return null;

    let archive;
    try {
        archive = readArchive(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
        notify(error.message, 'error');
        return null;
    }

    const localBooks = await loadAllBooks();

    const preview = createRestorePreview({
        context,
        archive,
        localBooks,
        onApply: async plan => await applyRestore(plan, archive, {
            loadBook: async name => await loadBookCached(name, { force: true }),
            saveBook: async (name, value) => await saveBook(name, value),
            loadLists: async groupId => store.listsOf(groupId),
            ensureGroup: async (groupId, name) => { await store.ensureGroup(groupId, name); },
            setLists: async (groupId, lists) => { await store.setLists(groupId, lists); },
            putImage: async (record, bytes) => { await store.putImageFromArchive(record, bytes); },
            deleteGroup: async groupId => { await store.deleteGroup(groupId).catch(() => {}); },
        }),
    });

    const report = await preview.show();
    if (!report) return null;

    notify(T('restore.done', {
        created: report.created.length,
        replaced: report.replaced.length,
        merged: report.merged.length,
        separated: report.separated.length,
    }), report.failed.length ? 'warning' : 'success');

    if (report.failed.length) notify(T('restore.failed', { count: report.failed.length }), 'error');

    await syncGroups();
    gallery?.refresh();
    return report;
}

function pickArchiveFile() {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
        input.click();
    });
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function registerCommandsOnce() {
    const context = ctx();
    const { SlashCommandParser, SlashCommand } = context;
    if (!SlashCommandParser || SlashCommandParser.commands?.['lba-gallery']) return;

    const add = (name, callback, helpString) =>
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name, callback, helpString }));

    add('lba-gallery', async () => {
        await gallery.open();
        return '';
    }, 'Opens the lorebook image gallery, grouped by lorebook.');

    add('lba-verify', async () => {
        const report = await (await getStorage()).verify();
        return T('verify.missing', { checked: report.checked, missing: report.missing.length });
    }, 'Cross-checks the manifest against storage and reports how many files are missing.');

    add('lba-explorer', async () => {
        await explorer.open(currentBookName());
        return '';
    }, 'Opens the lorebook explorer: entry lists on the left, entries on the right.');

    add('lba-export', async () => {
        const bytes = await exportArchive({ scope: 'full' });
        return bytes ? String(bytes.length) : '';
    }, 'Exports every lorebook and image into one archive.');

    add('lba-import', async () => {
        const report = await importArchive();
        return report ? String(report.created.length + report.merged.length) : '';
    }, 'Restores from an archive, showing a per-lorebook preview first.');

    add('lba-sync', async () => {
        const changes = await syncGroups();
        return String(changes.length);
    }, 'Re-syncs groups against the current list of lorebooks.');
}

// ---------------------------------------------------------------------------
// Manifest hooks
// ---------------------------------------------------------------------------

/**
 * Finishes any teardown that was cut short last time. A tombstone left in the file store
 * means a previous delete did not manage to remove everything.
 */
export async function onInstall() {
    try {
        const result = await resumePendingCleanup(api());
        if (result) {
            console.log(`[${MODULE_NAME}] resumed cleanup after an interrupted delete: ${result.deleted}/${result.total}`);
        }
    } catch (error) {
        console.error(`[${MODULE_NAME}] resumed cleanup failed:`, error);
    }
}

export async function onUpdate() {
    try {
        const store = await getStorage();
        console.log(`[${MODULE_NAME}] manifest schema ${store.manifest.schema}, rev ${store.manifest.rev}`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] migration failed:`, error);
    }
}

/**
 * Fired by the broom button and when the user ticks "Also clean up extension data".
 *
 * Awaited properly: the broom path does not reload the page, so exceeding
 * callExtensionHook's 5s budget only produces a console warning while work continues.
 */
export async function onClean() {
    const store = await getStorage();
    const totals = store.totals();
    const result = await store.cleanupAll({
        onProgress: (done, total) => {
            if (done % 25 === 0 || done === total) console.log(`[${MODULE_NAME}] deleted ${done}/${total}`);
        },
    });
    const message = result.failed.length
        ? T('cleanup.partial', { deleted: result.deleted, total: result.total, failed: result.failed.length })
        : T('cleanup.done', { total: result.total });
    void totals;
    notify(message);
    console.log(`[${MODULE_NAME}] ${message}`);
}

/**
 * Always fires on deletion, with or without the checkbox, because the requirement is that
 * removing the extension removes its data. Only the tombstone write is awaited — the
 * deletes go out with keepalive and outlive the page reload, so waiting on them would
 * spend the 5s budget for nothing.
 */
/** Removes our filter function from SillyTavern's registry before the module goes away. */
export function onDisable() {
    try {
        wiFilter?.detach();
        entryButtons?.stop();
    } catch (error) {
        console.error(`[${MODULE_NAME}] teardown failed:`, error);
    }
}

export async function onDelete() {
    try {
        const store = await getStorage();
        const count = await store.cleanupFireAndForget();
        console.log(`[${MODULE_NAME}] fired ${count} delete requests (keepalive)`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] cleanup on delete failed:`, error);
    }
}

let activationRetryTimer = null;
let activationRetryCount = 0;
const MAX_ACTIVATION_RETRIES = 40;

/**
 * `activate` can fire before SillyTavern's context object exists. Retrying with a backoff
 * rather than giving up is the difference between the panel appearing and the extension
 * silently doing nothing on a slow load.
 */
function scheduleActivationRetry() {
    if (activationRetryTimer) return;
    if (activationRetryCount >= MAX_ACTIVATION_RETRIES) {
        console.error(`[${MODULE_NAME}] SillyTavern context never became available; giving up`);
        return;
    }
    activationRetryCount += 1;
    activationRetryTimer = setTimeout(() => {
        activationRetryTimer = null;
        onActivate();
    }, Math.min(2500, 100 + activationRetryCount * 125));
}

export function onActivate() {
    const context = ctx();
    if (!context?.eventSource || !context?.event_types) {
        scheduleActivationRetry();
        return;
    }
    activationRetryCount = 0;
    if (activationRetryTimer) { clearTimeout(activationRetryTimer); activationRetryTimer = null; }

    context.eventSource.on(context.event_types.APP_READY, async () => {
        try {
            const store = await getStorage();
            applyLayoutPreset(settings().layoutPreset);

            gallery = createGallery({ storage: store, context, settings });
            settingsPanel = createSettingsPanel({
                storage: store,
                context,
                settings,
                gallery,
                actions: {
                    exportFull: () => exportArchive({ scope: 'full' }),
                    exportSingle: () => exportArchive({ scope: 'single' }),
                    importArchive,
                    openExplorer: () => explorer.open(currentBookName()),
                },
            });
            explorer = createExplorer({
                storage: store,
                context,
                io: {
                    currentBookName,
                    loadBook: name => loadBookCached(name, { force: true }),
                    saveBook: (name, value) => saveBook(name, value),
                    groupIdFor: name => groupForLorebook(name),
                    reconstruct: (lists, entries) => reconstructMissingLists(lists, entries),
                },
            });

            wiFilter = createWiFilter({
                wi: wiAdapter(),
                onExplore: () => explorer.open(currentBookName()),
                io: {
                    /** Lists plus per-entry membership for the lorebook on screen. */
                    readBook: async name => {
                        const book = await loadBookCached(name);
                        if (!book) return null;
                        const groupId = readGroupId(book);
                        return {
                            lists: groupId ? store.listsOf(groupId) : {},
                            entries: entriesWithLists(book),
                        };
                    },
                    imageForEntry: uid => Object.values(store.manifest.images)
                        .find(image => (image.refs || []).some(ref => String(ref.entryUid) === String(uid))) ?? null,
                },
            });

            entryButtons = createEntryButtons({
                storage: store,
                onAttach: attachImageToEntry,
                onOpen: () => gallery.open(),
                // A rescan renders rows unfiltered; re-apply before the user sees them.
                onAfterScan: () => {
                    wiFilter?.mount();
                    wiFilter?.refresh();
                },
            });

            // Each step is isolated: a failing settings panel used to abort the whole
            // handler, taking the entry buttons, slash commands and group sync with it.
            // One broken piece should degrade, not disable the extension.
            for (const [name, step] of [
                ['settings panel', () => settingsPanel.mount()],
                ['world info buttons', () => entryButtons.start()],
                ['slash commands', () => registerCommandsOnce()],
                ['group sync', () => syncGroups()],
            ]) {
                try {
                    await step();
                } catch (error) {
                    console.error(`[${MODULE_NAME}] ${name} failed to initialise:`, error);
                }
            }
        } catch (error) {
            console.error(`[${MODULE_NAME}] initialisation failed:`, error);
        }
    });

    // Renames, deletions and imports of lorebooks all surface here.
    context.eventSource.on(context.event_types.WORLDINFO_UPDATED, () => {
        invalidateBookCache();
        void wiFilter?.reload().catch(error => console.error(`[${MODULE_NAME}] filter reload:`, error));
        void syncGroups().catch(error => console.error(`[${MODULE_NAME}] group sync:`, error));
    });
}

export { ORPHAN_GROUP_ID, MODULE_NAME };
