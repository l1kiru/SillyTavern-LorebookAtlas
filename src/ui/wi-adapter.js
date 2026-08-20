/**
 * Adapter over SillyTavern's World Info DOM.
 *
 * Every lookup is a *list* of selectors tried in order rather than a single one, so a
 * markup change upstream degrades to a slightly worse match instead of a dead panel.
 * SillyTavern reshuffles this markup between releases; a single selector does not survive it.
 *
 * Three details here are hard-won rather than obvious:
 *
 *  - queries are scoped to the editor root and explicitly exclude our own injected markup,
 *    otherwise a rescan finds the controls it just inserted;
 *  - the uid is read from four different places, falling back to parsing "UID: 12" out of
 *    the visible text, because it is not always an attribute;
 *  - "is this entry expanded" needs computed style, not just a class: the insertion point
 *    for controls differs between the collapsed header and the open body.
 */

export const WI_SELECTORS = Object.freeze({
    editorRoot: [
        '#WorldInfo',
        '#world_popup',
        '#world_info',
        '#world_editor',
        '#WorldInfoEditor',
    ],
    bookSelect: [
        '#world_editor_select',
        'select[name="world_info"]',
        'select[id*="world"][id*="select"]',
    ],
    entryList: [
        '#world_popup_entries_list',
        '[data-lba-entry-list]',
    ],
    entry: [
        '.world_entry',
        '[data-uid].world_entry',
        '[data-world-entry]',
    ],
    header: [
        ':scope > .inline-drawer > .inline-drawer-toggle',
        ':scope > .inline-drawer > .inline-drawer-header',
        '.inline-drawer-toggle',
        '.inline-drawer-header',
    ],
    controls: [
        ':scope .world_entry_thin_controls',
        '.world_entry_thin_controls',
        ':scope .inline-drawer-header',
        '.inline-drawer-header',
    ],
    outlet: [
        '.inline-drawer-outlet .world_entry_edit',
        '.inline-drawer-outlet',
        '.world_entry_edit',
        '.inline-drawer-content',
    ],
    // Where a full-width preview belongs. The form is the widest stable block inside an
    // expanded entry, so sizing against it is what "as wide as the entry" actually means.
    form: [
        '.world_entry_form',
        '.inline-drawer-outlet .world_entry_edit',
        '.inline-drawer-outlet',
        '.world_entry_edit',
    ],
    uidText: [
        '.world_entry_form_uid_value',
        '[data-lba-uid-text]',
    ],
});

/** Anything of ours that a rescan must not mistake for SillyTavern markup. */
const OWN_MARKUP = '.lba-entry-chrome, .lba-explorer, .lba-gallery, .lba-settings';

export function firstMatching(root, selectors) {
    for (const selector of selectors) {
        try {
            const found = root.querySelector(selector);
            if (found) return found;
        } catch {
            // `:scope` and other modern syntax can throw on older engines; try the next one.
        }
    }
    return null;
}

export function allMatching(root, selectors) {
    const seen = new Set();
    const result = [];
    for (const selector of selectors) {
        try {
            for (const node of root.querySelectorAll(selector)) {
                if (seen.has(node)) continue;
                seen.add(node);
                result.push(node);
            }
        } catch {
            // Same as above.
        }
    }
    return result;
}

/** Pulls a uid out of visible text such as "UID: 12". */
export function parseUidFromText(text) {
    const value = String(text || '');
    const match = value.match(/UID:\s*(\d+)/i) || value.match(/\b(\d{1,10})\b/);
    return match?.[1] ?? '';
}

export function createWiAdapter(doc = globalThis.document) {
    let root = null;

    function getRoot() {
        if (root && doc.contains(root)) return root;
        root = firstMatching(doc, WI_SELECTORS.editorRoot) || doc.body;
        return root;
    }

    return {
        get root() { return getRoot(); },

        /** Name of the lorebook currently open in the editor. */
        bookName() {
            const select = firstMatching(getRoot(), WI_SELECTORS.bookSelect)
                || firstMatching(doc, WI_SELECTORS.bookSelect);
            const option = select?.selectedOptions?.[0];
            const name = option?.textContent?.trim() ?? '';
            // Placeholder rows ("--- None ---") and numeric index values are not names.
            if (!name || name.startsWith('---') || /^\d+$/.test(name)) return '';
            return name;
        },

        entryList() {
            return firstMatching(getRoot(), WI_SELECTORS.entryList);
        },

        entries() {
            const list = this.entryList() || getRoot();
            return allMatching(list, WI_SELECTORS.entry)
                .filter(node => !node.closest?.(OWN_MARKUP));
        },

        /**
         * The uid is not reliably an attribute, so four sources are tried before giving up.
         */
        uidOf(entryNode) {
            if (!entryNode) return '';

            const direct = entryNode.getAttribute?.('uid')
                ?? entryNode.dataset?.uid
                ?? entryNode.dataset?.entryUid
                ?? entryNode.dataset?.worldEntryUid;
            if (direct) return String(direct);

            const nested = entryNode.querySelector?.('[data-uid], [data-entry-uid], [data-world-entry-uid]');
            const nestedUid = nested?.dataset?.uid ?? nested?.dataset?.entryUid ?? nested?.dataset?.worldEntryUid;
            if (nestedUid) return String(nestedUid);

            for (const selector of WI_SELECTORS.uidText) {
                const parsed = parseUidFromText(entryNode.querySelector?.(selector)?.textContent);
                if (parsed) return parsed;
            }

            return '';
        },

        /** Where compact controls belong: the header row, or the entry itself as a fallback. */
        controlsTarget(entryNode) {
            return firstMatching(entryNode, WI_SELECTORS.controls)
                || firstMatching(entryNode, WI_SELECTORS.header)
                || entryNode;
        },

        /** The body of an expanded entry, if it is open. */
        outlet(entryNode) {
            return firstMatching(entryNode, WI_SELECTORS.outlet);
        },

        /** The block a full-width preview should be sized and inserted against. */
        formTarget(entryNode) {
            return firstMatching(entryNode, WI_SELECTORS.form);
        },

        /**
         * A class alone is not enough — SillyTavern animates the drawer, so the markers and
         * the actual visibility disagree mid-transition.
         */
        isExpanded(entryNode) {
            const outlet = this.outlet(entryNode);
            if (outlet) {
                const style = globalThis.getComputedStyle?.(outlet);
                const visible = (outlet.getClientRects?.().length || outlet.offsetParent !== null)
                    && style?.display !== 'none'
                    && style?.visibility !== 'hidden'
                    && style?.opacity !== '0';
                if (visible) return true;
            }
            return Boolean(entryNode.querySelector?.('[aria-expanded="true"], .inline-drawer-icon.up, .inline-drawer.open'));
        },

        /** Snapshot for the diagnostics screen and for reporting a markup change upstream. */
        diagnostics() {
            const entries = this.entries();
            return {
                rootFound: Boolean(firstMatching(doc, WI_SELECTORS.editorRoot)),
                listFound: Boolean(this.entryList()),
                bookName: this.bookName(),
                entries: entries.length,
                withUid: entries.filter(node => this.uidOf(node)).length,
                expanded: entries.filter(node => this.isExpanded(node)).length,
            };
        },
    };
}

// ---------------------------------------------------------------------------
// Event isolation
// ---------------------------------------------------------------------------

/**
 * Keeps SillyTavern's outside-click handlers from treating a click on our controls as a
 * click outside the World Info popup — which closes the popup out from under the user.
 *
 * The pointer events matter more than `click`: outside-click handlers commonly listen on
 * pointerdown or mousedown, so stopping only `click` is too late.
 *
 * Note what is *not* done here: stopImmediatePropagation. The boundary listener runs
 * before the button's own handler, so suppressing the rest of the chain would silence the
 * button itself. Stopping bubbling is enough.
 */
const BOUNDARY_EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'dblclick'];

export function bindInteractionBoundary(element) {
    if (!element || element.dataset.lbaBoundary === '1') return element;
    element.dataset.lbaBoundary = '1';

    for (const name of BOUNDARY_EVENTS) {
        element.addEventListener(name, event => event.stopPropagation());
    }
    element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') event.stopPropagation();
    });

    return element;
}
