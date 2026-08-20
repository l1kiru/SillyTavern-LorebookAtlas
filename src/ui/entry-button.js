/**
 * Injects the image control into every World Info entry.
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
import { CROP_DEFAULT, normalizeCrop, applyCropStyle } from '../lorebook-binding.js';
import { imageByRef, groupIdForLorebook } from '../manifest-model.js';

const CHROME_CLASS = 'lba-entry-chrome';
const MENU_CLASS = 'lba-thumb-menu';
const CROP_CLASS = 'lba-crop';

function cropSig(crop) {
    const next = normalizeCrop(crop);
    return `${next.x}:${next.y}:${next.zoom}`;
}

function closeLayer(className) {
    for (const node of document.querySelectorAll(`.${className}`)) {
        node._lbaDismiss && document.removeEventListener('pointerdown', node._lbaDismiss, true);
        node.remove();
    }
}

function slider(label, min, max, step, value) {
    const output = el('output', { text: String(value) });
    const input = el('input', {
        type: 'range',
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(value),
        on: { input: () => { output.textContent = input.value; } },
    });
    return { input, output, row: el('label', { class: 'lba-crop__row' }, [el('span', { text: label }), input, output]) };
}

export function createEntryButtons({ storage, onAttach, onCrop, onOpen, onAfterScan }) {
    const wi = createWiAdapter();
    let observer = null;
    let bootstrap = null;
    let generation = 0;
    let crops = Object.create(null);

    function imageFor(uid) {
        return imageByRef(storage.manifest, {
            groupId: groupIdForLorebook(storage.manifest, wi.bookName()),
            entryUid: uid,
        });
    }

    function cropFor(uid) {
        return crops[String(uid)] || CROP_DEFAULT;
    }

    function paintThumb(img, uid) {
        if (img) applyCropStyle(img, cropFor(uid));
        return img;
    }

    function openCropEditor(uid, image) {
        closeLayer(MENU_CLASS);
        closeLayer(CROP_CLASS);
        const src = `/${image.variants.preview || image.variants.original}`;
        let working = normalizeCrop(cropFor(uid));
        const preview = el('img', { class: 'lba-entry-thumb', src, alt: '' });
        applyCropStyle(preview, working);

        const x = slider(T('entry.cropX'), 0, 100, 1, Math.round(working.x * 100));
        const y = slider(T('entry.cropY'), 0, 100, 1, Math.round(working.y * 100));
        const zoom = slider(T('entry.cropZoom'), 1, 4, 0.01, working.zoom.toFixed(2));

        const sync = () => {
            working = normalizeCrop({
                x: Number(x.input.value) / 100,
                y: Number(y.input.value) / 100,
                zoom: Number(zoom.input.value),
            });
            applyCropStyle(preview, working);
        };
        for (const input of [x.input, y.input, zoom.input]) input.addEventListener('input', sync);

        const overlay = el('div', { class: CROP_CLASS }, [
            el('div', { class: 'lba-crop__panel' }, [
                el('div', { class: 'lba-crop__preview' }, [preview]),
                el('small', { class: 'lba-hint', text: T('entry.cropHelp') }),
                x.row, y.row, zoom.row,
                el('div', { class: 'lba-crop__actions' }, [
                    el('div', {
                        class: 'menu_button',
                        text: T('entry.cropReset'),
                        on: {
                            click: () => {
                                working = { ...CROP_DEFAULT };
                                x.input.value = '50';
                                y.input.value = '50';
                                zoom.input.value = '1';
                                x.output.textContent = '50';
                                y.output.textContent = '50';
                                zoom.output.textContent = '1';
                                applyCropStyle(preview, working);
                            },
                        },
                    }),
                    el('div', { class: 'menu_button', text: T('entry.cropCancel'), on: { click: () => closeLayer(CROP_CLASS) } }),
                    el('div', {
                        class: 'menu_button',
                        text: T('entry.cropApply'),
                        on: {
                            click: () => {
                                closeLayer(CROP_CLASS);
                                void onCrop?.({ entryUid: uid, bookName: wi.bookName(), crop: working });
                            },
                        },
                    }),
                ]),
            ]),
        ]);
        bindInteractionBoundary(overlay);
        overlay.addEventListener('pointerdown', event => {
            if (event.target === overlay) closeLayer(CROP_CLASS);
        });
        document.body.append(overlay);
    }

    function openThumbMenu(anchor, uid, image) {
        closeLayer(MENU_CLASS);
        const menu = el('div', { class: MENU_CLASS }, [
            el('div', {
                class: 'menu_button',
                text: T('entry.menuReplace'),
                on: {
                    click: () => {
                        closeLayer(MENU_CLASS);
                        void onAttach({ entryUid: uid, bookName: wi.bookName(), current: image });
                    },
                },
            }),
            el('div', {
                class: 'menu_button',
                text: T('entry.crop'),
                on: { click: () => openCropEditor(uid, image) },
            }),
        ]);
        bindInteractionBoundary(menu);
        document.body.append(menu);
        const rect = anchor.getBoundingClientRect();
        const box = menu.getBoundingClientRect();
        const pad = 8;
        let left = rect.left;
        let top = rect.bottom + 4;
        if (left + box.width > window.innerWidth - pad) left = window.innerWidth - box.width - pad;
        if (top + box.height > window.innerHeight - pad) top = rect.top - box.height - 4;
        if (top < pad) top = pad;
        if (left < pad) left = pad;
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
        const dismiss = event => {
            if (menu.contains(event.target)) return;
            closeLayer(MENU_CLASS);
        };
        menu._lbaDismiss = dismiss;
        document.addEventListener('pointerdown', dismiss, true);
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
                    if (image) openThumbMenu(event.currentTarget, uid, image);
                    else void onAttach({ entryUid: uid, bookName: wi.bookName(), current: image });
                },
            },
        }, [
            image
                ? paintThumb(el('img', { class: 'lba-entry-thumb', src: `/${image.variants.preview || image.variants.original}`, alt: '' }), uid)
                : icon('fa-solid fa-image'),
        ]);

        const chrome = el('span', { class: CHROME_CLASS, title: T('settings.title') }, [imageButton]);
        bindInteractionBoundary(chrome);
        void entryNode;
        return chrome;
    }

    function decorate(entryNode) {
        const uid = wi.uidOf(entryNode);
        if (!uid) return false;

        const existing = entryNode.querySelector(`:scope .${CHROME_CLASS}`);
        const signature = `${imageFor(uid)?.id ?? ''}:${cropSig(cropFor(uid))}`;
        if (existing) {
            // Already decorated. Refresh only if the thumbnail is out of date, so a rescan
            // does not churn the DOM on every mutation.
            if (existing.dataset.lbaImage === signature) return true;
            existing.remove();
        }

        const chrome = buildChrome(entryNode, uid);
        chrome.dataset.lbaUid = String(uid);
        chrome.dataset.lbaImage = signature;

        const target = wi.controlsTarget(entryNode);
        // After the kill-switch so the mobile grid is toggle | kill | icon | title.
        const killSwitch = target.querySelector?.(':scope > .killSwitch')
            ?? target.querySelector?.('.killSwitch');
        const toggle = target.querySelector?.(':scope > .inline-drawer-toggle')
            ?? target.querySelector?.('.inline-drawer-toggle');
        if (killSwitch?.parentElement === target) killSwitch.insertAdjacentElement('afterend', chrome);
        else if (toggle?.parentElement === target) toggle.insertAdjacentElement('afterend', chrome);
        else target.prepend(chrome);

        entryNode.classList.add('lba-entry-enhanced');
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
            observer.observe(list, { childList: true, subtree: true });
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
            scan();
        },

        diagnostics: () => wi.diagnostics(),
        bookName: () => wi.bookName(),
        openGallery: onOpen,
        scan,

        setCrops(next) {
            crops = Object.create(null);
            for (const [uid, crop] of Object.entries(next || {})) crops[String(uid)] = normalizeCrop(crop);
            for (const chrome of document.querySelectorAll(`.${CHROME_CLASS}`)) {
                const uid = chrome.dataset.lbaUid;
                if (!uid) continue;
                paintThumb(chrome.querySelector('.lba-entry-thumb'), uid);
                chrome.dataset.lbaImage = `${imageFor(uid)?.id ?? ''}:${cropSig(cropFor(uid))}`;
            }
        },

        setCrop(uid, crop) {
            this.setCrops({ ...crops, [String(uid)]: crop });
        },
    };
}
