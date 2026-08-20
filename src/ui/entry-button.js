/**
 * Injects the image and list controls into every World Info entry.
 *
 * The entry list is rebuilt wholesale on almost every interaction — filtering, sorting,
 * paging — so a one-shot pass is not enough; a MutationObserver re-applies the controls
 * after each rerender.
 *
 * All DOM knowledge lives in wi-adapter.js, which tries a chain of selectors rather than
 * one. Two details here are load-bearing:
 *
 *  - every injected element goes through bindInteractionBoundary, or a click on it is
 *    seen by SillyTavern as a click outside the popup and closes the World Info window;
 *  - rescans must ignore our own markup, otherwise the pass finds what it just inserted.
 */

import { el, icon } from './dom.js';
import { T } from '../i18n.js';
import { createWiAdapter, bindInteractionBoundary } from './wi-adapter.js';

const CHROME_CLASS = 'lba-entry-chrome';
const PREVIEW_CLASS = 'lba-entry-preview';

export function createEntryButtons({ storage, onAttach, onOpen, onExplore, onAfterScan }) {
    const wi = createWiAdapter();
    let observer = null;
    let bootstrap = null;
    let generation = 0;

    function imageFor(uid) {
        for (const image of Object.values(storage.manifest.images || {})) {
            if ((image.refs || []).some(ref => String(ref.entryUid) === String(uid))) return image;
        }
        return null;
    }

    function buildChrome(entryNode, uid) {
        const image = imageFor(uid);

        const imageButton = el('div', {
            class: `menu_button lba-button--icon lba-entry-button${image ? ' lba-entry-button--set' : ''}`,
            title: image ? T('entry.replace') : T('entry.add'),
            on: {
                click: event => {
                    event.preventDefault();
                    event.stopPropagation();
                    void onAttach({ entryUid: uid, bookName: wi.bookName(), current: image });
                },
            },
        }, [
            image
                ? el('img', { class: 'lba-entry-thumb', src: `/${image.variants.preview || image.variants.original}`, alt: '' })
                : icon('fa-solid fa-image'),
        ]);

        const listButton = el('div', {
            class: 'menu_button lba-button--icon lba-entry-lists',
            title: T('list.explorer'),
            on: {
                click: event => {
                    event.preventDefault();
                    event.stopPropagation();
                    onExplore?.(uid);
                },
            },
        }, [icon('fa-solid fa-list-ul')]);

        const chrome = el('span', { class: CHROME_CLASS, title: T('settings.title') }, [imageButton, listButton]);
        bindInteractionBoundary(chrome);
        void entryNode;
        return chrome;
    }

    /**
     * A full-width preview inside an expanded entry.
     *
     * The 20px thumbnail on the header button is an indicator, not a picture — at that size
     * it is impossible to tell what is actually attached. The preview only exists while the
     * entry is open, so a collapsed list stays compact.
     */
    function renderPreview(entryNode, uid) {
        const existing = entryNode.querySelector(`:scope .${PREVIEW_CLASS}`);
        const image = imageFor(uid);

        if (!image || !wi.isExpanded(entryNode)) {
            existing?.remove();
            return;
        }

        const source = `/${image.variants.original || image.variants.preview}`;
        if (existing) {
            if (existing.dataset.lbaSource === source) return;
            existing.remove();
        }

        const target = wi.formTarget(entryNode);
        if (!target) return;

        const preview = el('div', { class: PREVIEW_CLASS, dataset: { lbaSource: source } }, [
            el('img', {
                class: 'lba-entry-preview__img',
                src: source,
                alt: image.originalName || '',
                loading: 'lazy',
                title: image.originalName || '',
            }),
        ]);
        bindInteractionBoundary(preview);
        target.prepend(preview);
    }

    function decorate(entryNode) {
        const uid = wi.uidOf(entryNode);
        if (!uid) return false;

        const existing = entryNode.querySelector(`:scope .${CHROME_CLASS}`);
        if (existing) {
            // Already decorated. Refresh only if the thumbnail is out of date, so a rescan
            // does not churn the DOM on every mutation.
            if (existing.dataset.lbaImage === String(imageFor(uid)?.id ?? '')) {
                // The chrome is current, but the drawer may have just opened or closed.
                renderPreview(entryNode, uid);
                return true;
            }
            existing.remove();
        }

        const chrome = buildChrome(entryNode, uid);
        chrome.dataset.lbaImage = String(imageFor(uid)?.id ?? '');

        const target = wi.controlsTarget(entryNode);
        // Sit after the drawer toggle where one exists, so the controls do not land in
        // front of SillyTavern's own affordances.
        const toggle = target.querySelector?.(':scope > .inline-drawer-toggle')
            ?? target.querySelector?.('.inline-drawer-toggle');
        if (toggle?.parentElement === target) toggle.insertAdjacentElement('afterend', chrome);
        else target.prepend(chrome);

        entryNode.classList.add('lba-entry-enhanced');
        renderPreview(entryNode, uid);
        return true;
    }

    /**
     * A rescan is cheap but not free, and a slow one must not clobber a newer one — hence
     * the generation guard.
     */
    function scan() {
        const mine = ++generation;
        const entries = wi.entries();
        let decorated = 0;

        for (const node of entries) {
            if (mine !== generation) return decorated;
            if (decorate(node)) decorated += 1;
        }

        if (entries.length && !decorated) {
            console.warn('[lorebook-atlas] World Info entries found but no uid could be read; markup may have changed', wi.diagnostics());
        }

        // Freshly rendered rows arrive unfiltered; whoever owns the filter re-applies it.
        try {
            onAfterScan?.();
        } catch (error) {
            console.error('[lorebook-atlas] post-scan hook failed:', error);
        }

        return decorated;
    }

    return {
        start() {
            const list = wi.entryList();
            if (!list) {
                // The World Info panel is built lazily; watch for it instead of giving up.
                bootstrap?.disconnect();
                bootstrap = new MutationObserver(() => {
                    if (wi.entryList()) {
                        bootstrap.disconnect();
                        bootstrap = null;
                        this.start();
                    }
                });
                bootstrap.observe(document.body, { childList: true, subtree: true });
                return;
            }

            scan();
            observer?.disconnect();
            observer = new MutationObserver(() => scan());
            // Attributes matter as well as children: opening a drawer toggles classes
            // rather than inserting nodes, and that is when the preview must appear.
            observer.observe(list, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'aria-expanded'],
            });
        },

        stop() {
            observer?.disconnect();
            bootstrap?.disconnect();
            observer = null;
            bootstrap = null;
        },

        /** Forces a rebuild after the catalogue changed under us. */
        refresh() {
            for (const chrome of document.querySelectorAll(`.${CHROME_CLASS}`)) chrome.remove();
            for (const preview of document.querySelectorAll(`.${PREVIEW_CLASS}`)) preview.remove();
            scan();
        },

        diagnostics: () => wi.diagnostics(),
        bookName: () => wi.bookName(),
        openGallery: onOpen,
        scan,
    };
}
