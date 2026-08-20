/**
 * The storage browser.
 *
 * Every view of stored images is split by group, which is the point of the rewrite:
 * one accordion block per lorebook, orphaned lorebooks below the live ones, and the
 * system "without lorebook" group pinned to the bottom.
 *
 * Group captions come from groupLabel(), never from the stored displayName directly —
 * an orphaned group's caption is localized at render time rather than baked into the file.
 */

import { ORPHAN_GROUP_ID } from '../constants.js';
import { sortGroups, isDeletable, groupLabel } from '../groups.js';
import { T } from '../i18n.js';
import * as model from '../manifest-model.js';
import { formatBytes, debounce } from '../util.js';
import { el, icon, clear, matches } from './dom.js';
import { closeLayer, bindOverlay, bindDismiss, placeMenu } from './overlay.js';

const FILTER = Object.freeze({
    ALL: 'all',
    LOCKED: 'locked',
    ORPHANED: 'orphaned',
    UNUSED: 'unused',
});

export function createGallery({ storage, context, settings, onPick }) {
    let search = '';
    let filter = FILTER.ALL;
    let root = null;
    const scheduleList = debounce(() => renderList(), 180);

    const collapsed = () => new Set(settings().collapsedGroups || []);

    function toggleCollapsed(groupId) {
        const set = collapsed();
        set.has(groupId) ? set.delete(groupId) : set.add(groupId);
        settings().collapsedGroups = [...set];
        context.saveSettingsDebounced();
    }

    function notify(message, type = 'info') {
        globalThis.toastr?.[type]?.(message, T('settings.title'));
    }

    function visibleImages(groupId) {
        return model.imagesOfGroup(storage.manifest, groupId).filter(image => {
            if (filter === FILTER.LOCKED && !image.locked) return false;
            if (filter === FILTER.UNUSED && (image.refs || []).length) return false;
            return matches(`${image.originalName} ${image.id}`, search);
        });
    }

    // ---------------------------------------------------------------- tiles

    function renderTile(image) {
        const img = el('img', {
            class: 'lba-tile__img',
            src: `/${image.variants.preview || image.variants.original || ''}`,
            loading: 'lazy',
            alt: image.originalName || '',
            on: { load: () => img.classList.add('lba-tile__img--ready') },
        });

        const tile = el('div', {
            class: `lba-tile${image.locked ? ' lba-tile--locked' : ''}`,
            role: 'button',
            tabIndex: 0,
            'aria-pressed': image.locked ? 'true' : 'false',
            title: [
                image.originalName || image.id,
                `${image.width}×${image.height}`,
                formatBytes(image.bytes),
                image.movedFrom ? T('image.movedFromShort', { name: image.movedFrom }) : null,
                (image.refs || []).length
                    ? T('image.usedInShort', { count: image.refs.length })
                    : T('image.unused'),
            ].filter(Boolean).join('\n'),
            on: {
                click: event => {
                    if (event.currentTarget.dataset.lbaSkipClick) {
                        delete event.currentTarget.dataset.lbaSkipClick;
                        return;
                    }
                    openImageActions(image);
                },
                contextmenu: event => {
                    event.preventDefault();
                    event.stopPropagation();
                    event.currentTarget.dataset.lbaSkipClick = '1';
                    openTileMenu(event, image);
                },
                keydown: event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    openImageActions(image);
                },
            },
        }, [img]);

        if (image.locked) {
            tile.append(el('span', { class: 'lba-tile__lock' }, [icon('fa-solid fa-lock')]));
        }

        return tile;
    }

    async function toggleLock(image) {
        await storage.setLock(image.id, !image.locked);
        render();
    }

    async function confirmDelete(image) {
        if (image.locked) {
            notify(T('image.lockedWarning'), 'warning');
            return;
        }
        const confirmed = await context.callGenericPopup(
            el('p', { text: T('image.confirmDelete', { name: image.originalName || image.id }) }),
            context.POPUP_TYPE.CONFIRM,
        );
        if (confirmed === context.POPUP_RESULT.AFFIRMATIVE) {
            await storage.deleteImage(image.id);
            render();
        }
    }

    async function copyImageId(image) {
        try {
            await navigator.clipboard.writeText(image.id);
            notify(T('image.idCopied'), 'success');
        } catch {
            notify(image.id, 'info');
        }
    }

    function openTileMenu(event, image) {
        closeLayer('lba-thumb-menu');
        const menu = el('div', { class: 'lba-thumb-menu', role: 'menu' }, [
            el('div', {
                class: 'menu_button',
                role: 'menuitem',
                on: { click: () => { closeLayer('lba-thumb-menu'); void toggleLock(image); } },
            }, [icon(image.locked ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock'), el('span', { text: image.locked ? T('image.unlock') : T('image.lock') })]),
            el('div', {
                class: 'menu_button',
                role: 'menuitem',
                on: { click: () => { closeLayer('lba-thumb-menu'); void copyImageId(image); } },
            }, [icon('fa-solid fa-copy'), el('span', { text: T('image.copyId') })]),
            el('div', {
                class: 'menu_button lba-button--danger',
                role: 'menuitem',
                on: { click: () => { closeLayer('lba-thumb-menu'); void confirmDelete(image); } },
            }, [icon('fa-solid fa-trash-can'), el('span', { text: T('image.delete') })]),
        ]);
        document.body.append(menu);
        placeMenu(menu, { x: event.clientX, y: event.clientY });
        bindDismiss(menu, 'lba-thumb-menu');
        bindOverlay(menu, { className: 'lba-thumb-menu', initial: menu.querySelector('.menu_button') });
    }

    async function openImageActions(image) {
        const { Popup } = context;
        const previous = document.activeElement;

        const body = el('div', { class: 'lba-detail' }, [
            el('img', { class: 'lba-detail__img', src: `/${image.variants.original || image.variants.preview}` }),
            el('div', { class: 'lba-detail__meta' }, [
                el('div', { text: image.originalName || T('image.noName') }),
                el('div', { text: `${image.width}×${image.height}, ${formatBytes(image.bytes)}` }),
                el('div', {
                    text: (image.refs || []).length
                        ? T('image.usedIn', { count: image.refs.length })
                        : T('image.notUsed'),
                }),
                image.movedFrom ? el('div', { text: T('image.movedFrom', { name: image.movedFrom }) }) : null,
            ]),
        ]);

        const popup = new Popup(body, POPUP_TYPE.TEXT, '', {
            okButton: T('gallery.close'),
            customButtons: [
                { text: image.locked ? T('image.unlock') : T('image.lock'), result: 10 },
                { text: T('image.delete'), result: 11, classes: ['lba-button--danger'] },
                onPick ? { text: T('image.bindToEntry'), result: 12 } : null,
            ].filter(Boolean),
        });

        const result = await popup.show();
        previous?.focus?.();

        if (result === 10) await toggleLock(image);
        else if (result === 11) await confirmDelete(image);
        else if (result === 12) onPick?.(image);
    }

    // ---------------------------------------------------------------- groups

    function groupBadges(group, stats) {
        const badges = [];
        if (group.orphanedAt) badges.push(el('span', { class: 'lba-badge lba-badge--orphan', text: T('group.badgeDeleted') }));
        if (group.system) badges.push(el('span', { class: 'lba-badge', text: T('group.badgeSystem') }));
        if (stats.locked) badges.push(el('span', { class: 'lba-badge', text: T('group.badgeLocked', { count: stats.locked }) }));
        return badges;
    }

    function renderGroup(group) {
        const images = visibleImages(group.id);
        const stats = model.groupStats(storage.manifest, group.id);
        const isCollapsed = collapsed().has(group.id);

        // While a search is running, keep empty headers visible so it stays obvious
        // which lorebook a result belongs to.
        if (!images.length && !search && filter !== FILTER.ALL) return null;
        if (filter === FILTER.ORPHANED && !group.orphanedAt && !group.system) return null;

        const bodyId = `lba-g-${String(group.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const header = el('div', {
            class: 'lba-group__header',
            role: 'button',
            tabIndex: 0,
            'aria-controls': bodyId,
            on: {
                click: event => {
                    if (event.target.closest('.lba-group__actions')) return;
                    toggleCollapsed(group.id);
                    render();
                },
                keydown: event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    toggleCollapsed(group.id);
                    render();
                },
            },
        }, [
            icon(isCollapsed ? 'fa-solid fa-circle-chevron-right' : 'fa-solid fa-circle-chevron-down'),
            el('span', { class: 'lba-group__name', text: groupLabel(group) }),
            ...groupBadges(group, stats),
            el('span', { class: 'lba-group__meta', text: `${stats.count} · ${formatBytes(stats.bytes)}` }),
            renderGroupActions(group, stats),
        ]);

        const body = el('div', { class: 'lba-group__body', id: bodyId },
            images.length
                ? images.map(renderTile)
                : [el('div', { class: 'lba-empty', text: search ? T('gallery.notFound') : T('gallery.emptyGroup') })]);

        return el('div', {
            class: [
                'lba-group',
                group.orphanedAt ? 'lba-group--orphaned' : '',
                group.system ? 'lba-group--system' : '',
            ].filter(Boolean).join(' '),
            'aria-expanded': String(!isCollapsed),
        }, [header, body]);
    }

    function renderGroupActions(group, stats) {
        const actions = el('div', { class: 'lba-group__actions' });

        if (stats.locked) {
            actions.append(el('div', {
                class: 'menu_button lba-button--icon',
                title: T('group.unlockAll'),
                on: {
                    click: async () => {
                        for (const image of model.imagesOfGroup(storage.manifest, group.id)) {
                            if (image.locked) await storage.setLock(image.id, false);
                        }
                        render();
                    },
                },
            }, [icon('fa-solid fa-lock-open')]));
        }

        if (isDeletable(storage.manifest, group.id)) {
            actions.append(el('div', {
                class: 'menu_button lba-button--icon lba-button--danger',
                title: T('group.delete'),
                on: { click: () => confirmGroupDeletion(group) },
            }, [icon('fa-solid fa-trash-can')]));
        }

        return actions;
    }

    /**
     * Deletion is shown as a plan before it runs. Locked images and images shared with
     * another lorebook survive, and the dialog says so explicitly — silently keeping or
     * silently destroying either would be equally surprising.
     */
    async function confirmGroupDeletion(group) {
        const plan = storage.planGroupDeletion(group.id);
        const locked = plan.keep.filter(k => k.reason === 'locked').length;
        const shared = plan.keep.filter(k => k.reason === 'cross-ref').length;

        const body = el('div', {}, [
            el('p', { text: T('delete.confirmGroup', { name: groupLabel(group) }) }),
            el('ul', {}, [
                el('li', { text: T('delete.willRemove', { count: plan.remove.length, size: formatBytes(plan.bytes) }) }),
                locked ? el('li', { text: T('delete.keepLocked', { count: locked }) }) : null,
                shared ? el('li', { text: T('delete.keepShared', { count: shared }) }) : null,
                plan.keep.length ? el('li', { text: T('delete.keepMoveTo') }) : null,
            ].filter(Boolean)),
        ]);

        const result = await context.callGenericPopup(body, context.POPUP_TYPE.CONFIRM);
        if (result !== context.POPUP_RESULT.AFFIRMATIVE) return;

        const outcome = await storage.deleteGroup(group.id);
        if (outcome.failed.length) {
            notify(T('delete.partial', {
                deleted: outcome.deleted - outcome.failed.length,
                total: outcome.deleted,
                failed: outcome.failed.length,
            }), 'warning');
        } else {
            notify(T('delete.done', { deleted: outcome.deleted, moved: outcome.moved }), 'success');
        }
        render();
    }

    // ---------------------------------------------------------------- shell

    function renderToolbar() {
        const searchInput = el('input', {
            class: 'text_pole',
            type: 'search',
            placeholder: T('gallery.search'),
            value: search,
            on: {
                input: event => {
                    search = event.target.value;
                    scheduleList();
                },
            },
        });

        const filterSelect = el('select', {
            class: 'text_pole',
            on: {
                change: event => {
                    filter = event.target.value;
                    renderList();
                },
            },
        }, [
            el('option', { value: FILTER.ALL, text: T('gallery.filterAll') }),
            el('option', { value: FILTER.LOCKED, text: T('gallery.filterLocked') }),
            el('option', { value: FILTER.ORPHANED, text: T('gallery.filterOrphaned') }),
            el('option', { value: FILTER.UNUSED, text: T('gallery.filterUnused') }),
        ]);
        filterSelect.value = filter;

        const verifyButton = el('div', {
            class: 'menu_button',
            text: T('gallery.verify'),
            on: { click: () => runVerify() },
        });

        return el('div', { class: 'lba-toolbar' }, [searchInput, filterSelect, verifyButton]);
    }

    async function runVerify() {
        const report = await storage.verify();
        const body = report.missing.length
            ? el('div', {}, [
                el('p', { text: T('verify.missing', { checked: report.checked, missing: report.missing.length }) }),
                el('p', { text: T('verify.affected', { count: report.affectedImages.length }) }),
            ])
            : el('p', { text: T('verify.ok', { checked: report.checked }) });
        await context.callGenericPopup(body, context.POPUP_TYPE.TEXT);
    }

    function renderList() {
        const list = root?.querySelector('.lba-groups');
        if (!list) return;
        clear(list);
        const locale = context.getCurrentLocale?.();
        const blocks = sortGroups(storage.manifest, locale).map(renderGroup).filter(Boolean);
        list.append(...(blocks.length ? blocks : [el('div', { class: 'lba-empty', text: T('gallery.emptyStorage') })]));
    }

    function render() {
        if (!root) return;
        clear(root);
        const totals = storage.totals();
        root.append(
            renderToolbar(),
            el('div', { class: 'lba-groups' }),
            el('div', {
                class: 'lba-totals',
                text: T('gallery.totals', {
                    images: totals.images,
                    groups: totals.groups,
                    files: totals.files,
                    size: formatBytes(totals.bytes),
                }),
            }),
        );
        renderList();
    }

    return {
        /** Renders into an existing container, for embedding in a settings drawer. */
        mount(container) {
            root = container;
            render();
            return root;
        },

        /** Opens the browser as a standalone popup. */
        async open() {
            if (!storage.isLoaded) await storage.load();
            root = el('div', { class: 'lba-gallery' });
            render();
            await context.callGenericPopup(root, context.POPUP_TYPE.TEXT, '', {
                wide: true,
                large: true,
                allowVerticalScrolling: true,
                okButton: T('gallery.close'),
            });
            root = null;
        },

        refresh: render,
        FILTER,
        ORPHAN_GROUP_ID,
    };
}
