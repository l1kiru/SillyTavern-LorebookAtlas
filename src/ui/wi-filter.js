/**
 * Filtering SillyTavern's own World Info entry list by our lists.
 *
 * This is what makes lists worth having: a lorebook of three hundred entries is unusable
 * as a flat list, and filtering a copy of it in some popup of ours would not help — the
 * editing happens in SillyTavern's list, so that is the list that has to shrink.
 *
 * Two modes, in order of preference:
 *
 *  1. **Data filter (correct).** SillyTavern's `worldInfoFilter` reduces the entry array
 *     through `Object.values(filterFunctions)` before paginating. Adding one function to
 *     that object means our filter runs at the same stage as its own search: page counts,
 *     page contents and the entry counter all come out right.
 *
 *  2. **Hiding rows (fallback).** Used only when the module cannot be imported. This is
 *     *not* equivalent: the list is paginated at 25 entries per page, so hiding operates
 *     on one page at a time and a list whose members are scattered across pages appears
 *     nearly empty. When that happens the bar says so rather than quietly lying.
 *
 * Entries are never reordered in either mode. SillyTavern runs a sortable over this list
 * and writes the order back into the lorebook.
 */

import { T } from '../i18n.js';
import { buildTree, listLabel, isComputed, COMPUTED_LISTS, descendantsOf } from '../lists.js';
import { readEntryLists } from '../lorebook-binding.js';
import { el, clear } from './dom.js';
import { bindInteractionBoundary } from './wi-adapter.js';

export const ALL = '__all__';
export const UNLISTED = '__unlisted__';

/** Key under which our function lives in SillyTavern's filter registry. */
export const FILTER_KEY = 'lorebook_atlas_list';

const BAR_CLASS = 'lba-filter-bar';
const HIDDEN_CLASS = 'lba-entry-filtered-out';

/**
 * Decides whether one entry passes, given a selection.
 * Pure and exported so the interesting part is testable without a browser.
 *
 * @param {object} params
 * @param {string} params.selected list id, ALL or UNLISTED
 * @param {string[]} params.membership list ids the entry belongs to
 * @param {object} params.lists list definitions, for resolving nested lists
 * @param {object|null} params.image the image backing the entry, for computed lists
 */
export function entryPasses({ selected, membership = [], lists = {}, image = null, entry = null }) {
    if (!selected || selected === ALL) return true;
    if (selected === UNLISTED) return membership.length === 0;

    if (isComputed(selected)) {
        return Boolean(COMPUTED_LISTS[selected]?.predicate({ entry, image, membership }));
    }

    // A parent list shows everything nested below it, matching the counts the explorer
    // reports; anything else reads as entries having gone missing.
    const wanted = new Set([selected, ...descendantsOf(lists, selected)]);
    return membership.some(id => wanted.has(id));
}

export function createWiFilter({ wi, io, onExplore }) {
    let selected = ALL;
    let lists = {};
    let bar = null;
    let bookName = '';

    /** SillyTavern's FilterHelper for World Info, when we managed to reach it. */
    let host = null;
    let hostAttempted = false;

    /** uid -> list ids. Only needed by the fallback; the data filter reads entries directly. */
    let membership = new Map();

    function passes({ uid, membershipIds, entry }) {
        return entryPasses({
            selected,
            membership: membershipIds,
            lists,
            image: io.imageForEntry(uid),
            entry,
        });
    }

    // ---------------------------------------------------------------- host mode

    /**
     * Reaches into world-info.js for its FilterHelper.
     *
     * The documentation warns that importing SillyTavern modules directly is unreliable,
     * and there is no getContext equivalent for this object — hence the try/catch and the
     * fallback rather than an assumption that it worked.
     */
    async function attachToHost() {
        if (hostAttempted) return Boolean(host);
        hostAttempted = true;

        try {
            const module = await import('../../../../world-info.js');
            const filter = module.worldInfoFilter;
            if (!filter?.filterFunctions || typeof filter.setFilterData !== 'function') return false;

            filter.filterFunctions[FILTER_KEY] = data => {
                if (!Array.isArray(data) || selected === ALL) return data;
                return data.filter(entry => passes({
                    uid: String(entry?.uid ?? ''),
                    membershipIds: readEntryLists(entry),
                    entry,
                }));
            };

            host = filter;
            return true;
        } catch (error) {
            console.warn('[lorebook-atlas] could not hook SillyTavern\'s World Info filter; '
                + 'falling back to hiding rows, which only covers the current page', error);
            return false;
        }
    }

    /** Asks SillyTavern to re-filter and re-render. */
    function applyViaHost() {
        // The value itself is unused by the function above — it reads `selected` — but
        // setting it is what triggers onDataChanged, and it keeps hasAnyFilter() honest.
        const value = selected === ALL ? '' : selected;
        if (typeof host.getFilterData === 'function' && host.getFilterData(FILTER_KEY) === value) return;
        host.setFilterData(FILTER_KEY, value);
    }

    // ---------------------------------------------------------------- fallback mode

    function applyViaHiding() {
        let shown = 0;
        for (const node of wi.entries()) {
            const uid = String(wi.uidOf(node));
            const hide = !passes({ uid, membershipIds: membership.get(uid) ?? [], entry: null });
            node.classList.toggle(HIDDEN_CLASS, hide);
            if (!hide) shown += 1;
        }
        return shown;
    }

    function hasPagination() {
        const pager = document.querySelector('#world_info_pagination');
        return Boolean(pager) && pager.querySelectorAll('li').length > 1;
    }

    // ---------------------------------------------------------------- shared

    function updateBar(shown) {
        if (!bar) return;
        bar.querySelector('.lba-filter-bar__count').textContent = String(shown);
        bar.classList.toggle('lba-filter-bar--active', selected !== ALL);

        // Only meaningful in fallback mode: the data filter runs before pagination.
        const misleading = !host && selected !== ALL && hasPagination();
        const warning = bar.querySelector('.lba-filter-bar__warning');
        warning.textContent = misleading ? T('filter.pageOnly') : '';
        warning.classList.toggle('lba-hidden', !misleading);
    }

    function apply() {
        if (host) {
            applyViaHost();
            updateBar(NaN);
            const counter = bar?.querySelector('.lba-filter-bar__count');
            // The real count is whatever SillyTavern renders; do not invent one.
            if (counter) counter.textContent = selected === ALL ? '' : '·';
            return;
        }
        updateBar(applyViaHiding());
    }

    function optionsFor() {
        const options = [
            { value: ALL, label: T('list.rootLabel') },
            { value: UNLISTED, label: T('list.computedUnlisted') },
        ];

        // A <select> has no tree, so depth is rendered as an indent prefix.
        const walk = (nodes, depth) => {
            for (const node of nodes) {
                options.push({ value: node.list.id, label: `${'— '.repeat(depth)}${listLabel(node.list)}` });
                walk(node.children, depth + 1);
            }
        };
        walk(buildTree(lists), 0);

        for (const id of Object.keys(COMPUTED_LISTS)) {
            options.push({ value: id, label: listLabel({ id, kind: 'computed' }) });
        }

        return options;
    }

    /** Re-reads the lorebook. Done on book change, not on every rescan. */
    async function reload() {
        await attachToHost();

        bookName = wi.bookName();
        membership = new Map();
        lists = {};

        if (bookName) {
            const data = await io.readBook(bookName);
            if (data) {
                lists = data.lists;
                for (const item of data.entries) membership.set(String(item.uid), item.lists);
            }
        }

        if (bar) {
            const select = bar.querySelector('select');
            const available = optionsFor();
            clear(select);
            for (const option of available) {
                select.append(el('option', { value: option.value, text: option.label }));
            }
            // A list can disappear between reloads; fall back rather than filter to nothing.
            if (!available.some(o => o.value === selected)) selected = ALL;
            select.value = selected;
        }

        apply();
    }

    function buildBar() {
        const select = el('select', {
            class: 'text_pole lba-filter-bar__select',
            title: T('filter.label'),
            on: {
                change: event => {
                    selected = event.target.value;
                    apply();
                },
            },
        });

        const reset = el('div', {
            class: 'menu_button lba-button--icon',
            title: T('list.clearFilter'),
            on: {
                click: () => {
                    selected = ALL;
                    select.value = ALL;
                    apply();
                },
            },
        }, [el('i', { class: 'fa-fw fa-solid fa-filter-circle-xmark' })]);

        const explore = onExplore
            ? el('div', {
                class: 'menu_button lba-button--icon',
                title: T('list.explorer'),
                on: { click: () => onExplore() },
            }, [el('i', { class: 'fa-fw fa-solid fa-list-ul' })])
            : null;

        const node = el('div', { class: BAR_CLASS }, [
            el('span', { class: 'lba-filter-bar__label', text: T('filter.label') }),
            select,
            el('span', { class: 'lba-filter-bar__count', text: '' }),
            reset,
            explore,
            el('span', { class: 'lba-filter-bar__warning lba-hidden' }),
        ]);

        // Same hazard as the entry buttons: a click here must not read as a click outside
        // the World Info popup, or SillyTavern closes it.
        bindInteractionBoundary(node);
        return node;
    }

    return {
        /** Inserts the bar above the entry list, if it is not already there. */
        mount() {
            const list = wi.entryList();
            if (!list?.parentElement) return false;
            if (list.parentElement.querySelector(`:scope > .${BAR_CLASS}`)) return true;

            bar = buildBar();
            list.parentElement.insertBefore(bar, list);
            void reload();
            return true;
        },

        /** Called after every rescan; only the fallback needs to re-apply. */
        refresh() {
            if (wi.bookName() !== bookName) {
                void reload();
                return;
            }
            if (!host) updateBar(applyViaHiding());
        },

        /** Removes our function from SillyTavern's registry. */
        detach() {
            if (!host) return;
            delete host.filterFunctions[FILTER_KEY];
            host.setFilterData(FILTER_KEY, '');
            host = null;
        },

        reload,
        apply,
        attachToHost,
        get usesHostFilter() { return Boolean(host); },
        get selected() { return selected; },
        set selected(value) { selected = value; apply(); },
        setLists(value) { lists = value; },
        setMembership(value) { membership = value; },
        passesFor(uid) { return passes({ uid, membershipIds: membership.get(String(uid)) ?? [], entry: null }); },
    };
}
