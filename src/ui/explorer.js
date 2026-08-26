/**
 * Lorebook explorer — the list tree on the left, entries of the selected node on the right.
 *
 * The counts shown on every node are deliberately two numbers, not one. With nesting and
 * multi-membership the same entry surfaces at several nodes, so "how many entries" only
 * makes sense as "attached here" plus "distinct in this subtree". A single figure would
 * either double-count or hide nested content, and both read as a bug.
 */

import { T } from '../i18n.js';
import {
    buildTree, listLabel, listCounts, entriesOfList, addList, renameList, removeList,
    setParent, computedDefinitions, computedListsFor, isComputed, COMPUTED_LISTS,
    LIST_KIND, distinctListedCount,
} from '../lists.js';
import { readEntryLists, writeEntryLists, addEntryToList, removeEntryFromList, applyMembershipSelection, entriesWithLists, readEntryCrop, applyCropStyle } from '../lorebook-binding.js';
import { imageByRef, groupIdForLorebook } from '../manifest-model.js';
import { debounce } from '../util.js';
import { el, icon, clear, matches } from './dom.js';

const ROOT = '__root__';

export function createExplorer({ storage, context, io }) {
    let bookName = '';
    let book = null;
    let lists = {};
    let selected = ROOT;
    let search = '';
    let root = null;
    let dragging = null;
    let showingTree = true;
    const scheduleEntries = debounce(() => renderEntries(), 180);

    function isMobileExplorer() {
        return window.matchMedia('(max-width: 700px)').matches;
    }

    function selectList(id) {
        selected = id;
        if (isMobileExplorer()) showingTree = false;
        render();
    }

    function notify(message, type = 'info') {
        globalThis.toastr?.[type]?.(message, T('settings.title'));
    }

    function entries() {
        return entriesWithLists(book);
    }

    /** The image backing an entry, needed by the computed lists. */
    function imageFor(entryUid) {
        return imageByRef(storage.manifest, {
            groupId: groupIdForLorebook(storage.manifest, bookName),
            entryUid,
        });
    }

    function visibleEntries() {
        const all = entries();

        let scoped;
        if (selected === ROOT) {
            scoped = all;
        } else if (isComputed(selected)) {
            const predicate = COMPUTED_LISTS[selected].predicate;
            scoped = all.filter(item => predicate({
                entry: item.entry,
                image: imageFor(item.uid),
                membership: item.lists,
            }));
        } else {
            scoped = entriesOfList(all, lists, selected, true);
        }

        return scoped.filter(item => matches(
            `${item.entry.comment ?? ''} ${(item.entry.key || []).join(' ')} ${item.entry.content ?? ''}`,
            search,
        ));
    }

    /**
     * One book object, one save, in that order.
     *
     * Ensuring the group id *after* saving used to write the binding into a different copy
     * of the lorebook: the next save here wrote our stale object back over it, the id was
     * lost, and the call after that minted a new one — stranding every list created so far
     * under a group nothing pointed at any more.
     */
    async function persist() {
        const groupId = await io.groupIdFor(bookName, book);
        await io.saveBook(bookName, book);
        if (groupId) await storage.setLists(groupId, lists);
    }

    // ---------------------------------------------------------------- tree

    function renderNode(node, depth) {
        const counts = listCounts(lists, entries())[node.list.id] ?? { own: 0, total: 0 };
        const isSelected = selected === node.list.id;

        const row = el('div', {
            class: `lba-node${isSelected ? ' lba-node--selected' : ''}`,
            style: { paddingLeft: `${depth * 14 + 6}px` },
            draggable: node.list.kind === LIST_KIND.MANUAL,
            on: {
                click: () => selectList(node.list.id),
                dragstart: event => {
                    dragging = { type: 'list', id: node.list.id };
                    event.stopPropagation();
                },
                // A drag abandoned outside any node never reaches handleDrop, so without
                // this the stale source would be moved by the next drop on any node.
                dragend: () => { dragging = null; },
                dragover: event => { event.preventDefault(); row.classList.add('lba-node--drop'); },
                dragleave: () => row.classList.remove('lba-node--drop'),
                drop: async event => {
                    event.preventDefault();
                    event.stopPropagation();
                    row.classList.remove('lba-node--drop');
                    await handleDrop(node.list.id);
                },
            },
        }, [
            icon(node.children.length ? 'fa-solid fa-folder-tree' : 'fa-solid fa-folder'),
            el('span', { class: 'lba-node__name', text: listLabel(node.list) }),
            el('span', {
                class: 'lba-node__count',
                title: T('list.countTotal', { total: counts.total }),
                text: counts.own === counts.total
                    ? String(counts.own)
                    : `${counts.own} / ${counts.total}`,
            }),
            renderNodeActions(node.list),
        ]);

        return el('div', {}, [row, ...node.children.map(child => renderNode(child, depth + 1))]);
    }

    function renderNodeActions(list) {
        if (list.kind !== LIST_KIND.MANUAL) return el('span');

        return el('span', { class: 'lba-node__actions' }, [
            el('i', {
                class: 'fa-fw fa-solid fa-pen lba-node__action',
                title: T('list.rename'),
                on: {
                    click: async event => {
                        event.stopPropagation();
                        const name = await context.callGenericPopup(T('list.rename'), context.POPUP_TYPE.INPUT, list.name);
                        if (name) { lists = renameList(lists, list.id, name); await persist(); render(); }
                    },
                },
            }),
            el('i', {
                class: 'fa-fw fa-solid fa-trash-can lba-node__action',
                title: T('list.delete'),
                on: {
                    click: async event => {
                        event.stopPropagation();
                        await confirmRemoveList(list);
                    },
                },
            }),
        ]);
    }

    async function confirmRemoveList(list) {
        // Nested lists have to go somewhere: either up to the grandparent or away with the
        // parent. Guessing on the user's behalf would silently reshape their tree.
        const popup = new context.Popup(
            el('p', { text: T('list.delete') + `: ${listLabel(list)}` }),
            context.POPUP_TYPE.CONFIRM,
            '',
            { customInputs: [{ id: 'lba_cascade', label: T('list.deleteChildren'), defaultState: false }] },
        );
        const result = await popup.show();
        if (result !== context.POPUP_RESULT.AFFIRMATIVE) return;

        const cascade = Boolean(popup.inputResults?.get('lba_cascade'));
        lists = removeList(lists, list.id, cascade ? 'cascade' : 'reparent');

        // Membership pointing at a list that no longer exists would linger invisibly.
        for (const item of entries()) {
            const pruned = readEntryLists(item.entry).filter(id => lists[id] || isComputed(id));
            if (pruned.length !== item.lists.length) writeEntryLists(item.entry, pruned);
        }
        // A cascade takes descendants too, so the selection may now point at a list that
        // no longer exists — after which "new list" would fail with "list not found".
        if (selected !== ROOT && !isComputed(selected) && !lists[selected]) selected = ROOT;
        await persist();
        render();
    }

    async function handleDrop(targetListId) {
        if (!dragging) return;

        try {
            if (dragging.type === 'list') {
                if (dragging.id === targetListId) return;
                lists = setParent(lists, dragging.id, targetListId);
            } else {
                const item = entries().find(e => String(e.uid) === String(dragging.uid));
                if (!item) return;
                addEntryToList(item.entry, targetListId);
            }
            await persist();
            render();
        } catch (error) {
            notify(error.message, 'warning');
        } finally {
            dragging = null;
        }
    }

    function renderTree() {
        const all = entries();
        const rootRow = el('div', {
            class: `lba-node${selected === ROOT ? ' lba-node--selected' : ''}`,
            on: { click: () => selectList(ROOT) },
        }, [
            icon('fa-solid fa-book'),
            el('span', { class: 'lba-node__name', text: T('list.rootLabel') }),
            el('span', { class: 'lba-node__count', text: String(all.length) }),
        ]);

        const manual = buildTree(lists, context.getCurrentLocale?.()).map(node => renderNode(node, 1));

        const computed = computedDefinitions().map(list => el('div', {
            class: `lba-node lba-node--computed${selected === list.id ? ' lba-node--selected' : ''}`,
            on: { click: () => selectList(list.id) },
        }, [
            icon('fa-solid fa-wand-magic-sparkles'),
            el('span', { class: 'lba-node__name', text: listLabel(list) }),
        ]));

        const addButton = el('div', {
            class: 'menu_button',
            text: T('list.create'),
            on: {
                click: async () => {
                    const name = await context.callGenericPopup(T('list.create'), context.POPUP_TYPE.INPUT, '');
                    if (!name) return;
                    try {
                        lists = addList(lists, { name, parentId: selected === ROOT || isComputed(selected) ? null : selected });
                        await persist();
                        render();
                    } catch (error) {
                        notify(error.message, 'warning');
                    }
                },
            },
        });

        return el('div', { class: 'lba-tree' }, [rootRow, ...manual, el('hr'), ...computed, addButton]);
    }

    // ---------------------------------------------------------------- entries

    async function editMembership(item) {
        const current = new Set(readEntryLists(item.entry).filter(id => lists[id] && !isComputed(id)));
        const boxes = [];
        const body = el('div', { class: 'lba-membership' }, [
            el('p', { text: item.entry.comment || `#${item.uid}` }),
        ]);

        const walk = (nodes, depth) => {
            for (const node of nodes) {
                const box = el('input', {
                    type: 'checkbox',
                    checked: current.has(node.list.id),
                    dataset: { listId: node.list.id },
                });
                boxes.push(box);
                body.append(el('label', { class: 'checkbox_label' }, [
                    box,
                    el('span', { text: `${'— '.repeat(depth)}${listLabel(node.list)}` }),
                ]));
                walk(node.children, depth + 1);
            }
        };
        walk(buildTree(lists), 0);

        if (!boxes.length) {
            notify(T('list.noLists'), 'info');
            return;
        }

        const answer = await context.callGenericPopup(body, context.POPUP_TYPE.CONFIRM);
        if (answer !== context.POPUP_RESULT.AFFIRMATIVE) return;

        writeEntryLists(item.entry, applyMembershipSelection(
            readEntryLists(item.entry),
            boxes.map(box => box.dataset.listId),
            boxes.filter(box => box.checked).map(box => box.dataset.listId),
        ));
        await persist();
        render();
    }

    function renderEntry(item) {
        const image = imageFor(item.uid);
        const memberships = [...item.lists, ...computedListsFor({ entry: item.entry, image, membership: item.lists })];

        return el('div', {
            class: 'lba-entry',
            draggable: true,
            on: {
                dragstart: event => {
                    dragging = { type: 'entry', uid: item.uid };
                    event.currentTarget.classList.add('lba-entry--dragging');
                },
                dragend: event => event.currentTarget.classList.remove('lba-entry--dragging'),
            },
        }, [
            image
                ? el('span', { class: 'lba-entry__thumb' }, [
                    applyCropStyle(
                        el('img', { src: `/${image.variants.preview || image.variants.original}`, alt: '' }),
                        readEntryCrop(item.entry),
                    ),
                ])
                : el('span', { class: 'lba-entry__thumb lba-entry__thumb--empty' }, [icon('fa-solid fa-image')]),
            el('div', { class: 'lba-entry__body' }, [
                el('div', { class: 'lba-entry__title', text: item.entry.comment || `#${item.uid}` }),
                el('div', { class: 'lba-entry__keys', text: (item.entry.key || []).join(', ') }),
                el('div', { class: 'lba-entry__chips' }, [
                    ...memberships.map(id => renderChip(item, id)),
                    el('span', {
                        class: 'lba-chip lba-chip--add',
                        title: T('list.addTo'),
                        on: {
                            click: event => {
                                event.stopPropagation();
                                void editMembership(item);
                            },
                        },
                    }, [icon('fa-solid fa-plus')]),
                ]),
            ]),
        ]);
    }

    function renderChip(item, listId) {
        const list = lists[listId] ?? { id: listId, kind: LIST_KIND.COMPUTED };
        const removable = !isComputed(listId);

        return el('span', { class: `lba-chip${removable ? '' : ' lba-chip--computed'}` }, [
            el('span', { text: listLabel(list) }),
            removable
                ? el('i', {
                    class: 'fa-solid fa-xmark lba-chip__remove',
                    on: {
                        click: async event => {
                            event.stopPropagation();
                            removeEntryFromList(item.entry, listId);
                            await persist();
                            render();
                        },
                    },
                })
                : null,
        ]);
    }

    // ---------------------------------------------------------------- shell

    function renderEntries() {
        const pane = root?.querySelector('.lba-entries');
        if (!pane) return;
        clear(pane);
        const visible = visibleEntries();
        pane.append(...(visible.length
            ? visible.map(renderEntry)
            : [el('div', { class: 'lba-empty', text: T('list.empty') })]));
    }

    function render() {
        if (!root) return;
        clear(root);

        const searchInput = el('input', {
            class: 'text_pole',
            type: 'search',
            placeholder: T('gallery.search'),
            value: search,
            on: { input: event => { search = event.target.value; scheduleEntries(); } },
        });

        root.className = `lba-explorer${showingTree ? ' lba-explorer--tree' : ' lba-explorer--entries'}`;
        root.append(
            el('div', { class: 'lba-explorer__toolbar' }, [
                el('div', {
                    class: 'menu_button lba-explorer__back',
                    text: T('list.back'),
                    on: { click: () => { showingTree = true; render(); } },
                }),
                el('span', { class: 'lba-explorer__book', text: bookName }),
                searchInput,
                el('span', {
                    class: 'lba-group__meta',
                    text: T('list.countTotal', { total: distinctListedCount(entries()) }),
                }),
            ]),
            el('div', { class: 'lba-explorer__panes' }, [
                renderTree(),
                el('div', { class: 'lba-entries' }),
            ]),
        );
        renderEntries();
    }

    return {
        async open(name) {
            bookName = name || io.currentBookName();
            if (!bookName) {
                notify(T('entry.openBookFirst'), 'warning');
                return;
            }

            book = await io.loadBook(bookName);
            // Same object throughout: the id is written into `book`, not into a second copy.
            const groupId = await io.groupIdFor(bookName, book);
            lists = groupId ? { ...storage.listsOf(groupId) } : {};

            // A lorebook can arrive carrying membership but no definitions.
            const before = Object.keys(lists).length;
            lists = io.reconstruct(lists, entries());
            // Placeholders would otherwise live only in memory and vanish on close.
            if (Object.keys(lists).length !== before) await persist();

            selected = ROOT;
            search = '';
            showingTree = true;
            root = el('div', { class: 'lba-explorer lba-explorer--tree' });
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
        get selectedList() { return selected; },
    };
}
