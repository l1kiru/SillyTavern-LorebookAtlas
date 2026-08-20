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
import { closeLayer, bindOverlay, bindDismiss, placeMenu, previewAspectRatio } from './overlay.js';

const CHROME_CLASS = 'lba-entry-chrome';
const MENU_CLASS = 'lba-thumb-menu';
const CROP_CLASS = 'lba-crop';

function cropSig(crop) {
    const next = normalizeCrop(crop);
    return `${next.x}:${next.y}:${next.zoom}`;
}

/** Pointer delta as a fraction of the preview box, scaled by zoom. */
export function panCrop(crop, dxRatio, dyRatio) {
    const next = normalizeCrop(crop);
    return normalizeCrop({
        x: next.x - dxRatio / next.zoom,
        y: next.y - dyRatio / next.zoom,
        zoom: next.zoom,
    });
}

/** World Info's popup uses backdrop-filter, which on mobile paints above body-level fixed layers. */
function cropHost() {
    return document.getElementById('world_popup') || document.body;
}

/**
 * Map a viewport clip onto a position:absolute overlay inside `host`.
 * The lorebook list usually scrolls on `#world_popup_entries_list` or the parent
 * `#WorldInfo.drawer-content`, so `host.scrollTop` is 0 even after the user has scrolled.
 */
export function cropOverlayBox(hostRect, clipRect, scrollTop = 0, scrollLeft = 0) {
    const top = Math.max(hostRect.top, clipRect.top);
    const left = Math.max(hostRect.left, clipRect.left);
    const bottom = Math.min(hostRect.bottom, clipRect.bottom);
    const right = Math.min(hostRect.right, clipRect.right);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    if (!width || !height) {
        return {
            top: scrollTop,
            left: scrollLeft,
            width: Math.max(0, hostRect.right - hostRect.left),
            height: Math.max(0, hostRect.bottom - hostRect.top),
        };
    }
    return {
        top: top - hostRect.top + scrollTop,
        left: left - hostRect.left + scrollLeft,
        width,
        height,
    };
}

function ancestorClip(host) {
    const clip = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
    for (let node = host.parentElement; node && node !== document.body; node = node.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(node);
        if (!/(auto|scroll|hidden)/.test(overflowY) && !/(auto|scroll|hidden)/.test(overflowX)) continue;
        const rect = node.getBoundingClientRect();
        clip.top = Math.max(clip.top, rect.top);
        clip.left = Math.max(clip.left, rect.left);
        clip.bottom = Math.min(clip.bottom, rect.bottom);
        clip.right = Math.min(clip.right, rect.right);
    }
    return clip;
}

function applyCropOverlayBox(overlay, box) {
    overlay.style.top = `${box.top}px`;
    overlay.style.left = `${box.left}px`;
    overlay.style.width = `${box.width}px`;
    overlay.style.height = `${box.height}px`;
    overlay.style.right = 'auto';
}

function mountCropOverlay(overlay) {
    const host = cropHost();
    host.append(overlay);
    if (host === document.body) {
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100dvh';
        return;
    }
    const place = () => {
        applyCropOverlayBox(
            overlay,
            cropOverlayBox(host.getBoundingClientRect(), ancestorClip(host), host.scrollTop, host.scrollLeft),
        );
    };
    place();
    window.addEventListener('scroll', place, true);
    overlay._lbaScrollCleanup = () => window.removeEventListener('scroll', place, true);
}

function slider(label, min, max, step, value) {
    const id = `lba-crop-${label.replace(/\W+/g, '').toLowerCase() || 'field'}`;
    const output = el('output', { text: String(value), for: id, 'aria-live': 'polite' });
    const input = el('input', {
        id,
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

        const paintWorking = next => {
            working = normalizeCrop(next);
            x.input.value = String(Math.round(working.x * 100));
            y.input.value = String(Math.round(working.y * 100));
            zoom.input.value = working.zoom.toFixed(2);
            x.output.textContent = x.input.value;
            y.output.textContent = y.input.value;
            zoom.output.textContent = zoom.input.value;
            applyCropStyle(preview, working);
        };

        const sync = () => paintWorking({
            x: Number(x.input.value) / 100,
            y: Number(y.input.value) / 100,
            zoom: Number(zoom.input.value),
        });
        for (const input of [x.input, y.input, zoom.input]) input.addEventListener('input', sync);

        let drag = null;
        preview.addEventListener('pointerdown', event => {
            if (event.button) return;
            preview.setPointerCapture(event.pointerId);
            const rect = preview.getBoundingClientRect();
            drag = { x: event.clientX, y: event.clientY, crop: { ...working }, w: rect.width, h: rect.height };
        });
        preview.addEventListener('pointermove', event => {
            if (!drag) return;
            paintWorking(panCrop(drag.crop, (event.clientX - drag.x) / drag.w, (event.clientY - drag.y) / drag.h));
        });
        const endDrag = () => { drag = null; };
        preview.addEventListener('pointerup', endDrag);
        preview.addEventListener('pointercancel', endDrag);

        const frame = el('div', { class: 'lba-crop__preview', style: { aspectRatio: previewAspectRatio(image.width, image.height) } }, [preview]);
        const overlay = el('div', { class: CROP_CLASS, role: 'dialog', 'aria-label': T('entry.crop') }, [
            el('div', { class: 'lba-crop__panel' }, [
                frame,
                el('small', { class: 'lba-hint', text: T('entry.cropHelp') }),
                x.row, y.row, zoom.row,
                el('div', { class: 'lba-crop__actions' }, [
                    el('div', {
                        class: 'menu_button',
                        text: T('entry.cropReset'),
                        on: { click: () => paintWorking(CROP_DEFAULT) },
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
        mountCropOverlay(overlay);
        bindOverlay(overlay, { className: CROP_CLASS, initial: x.input, lockFrom: cropHost() });
    }

    function openThumbMenu(anchor, uid, image) {
        closeLayer(MENU_CLASS);
        const menu = el('div', { class: MENU_CLASS, role: 'menu' }, [
            el('div', {
                class: 'menu_button',
                role: 'menuitem',
                on: {
                    click: () => {
                        closeLayer(MENU_CLASS);
                        void runAttach(anchor, { entryUid: uid, bookName: wi.bookName(), current: image });
                    },
                },
            }, [icon('fa-solid fa-rotate'), el('span', { text: T('entry.menuReplace') })]),
            el('div', {
                class: 'menu_button',
                role: 'menuitem',
                on: { click: () => openCropEditor(uid, image) },
            }, [icon('fa-solid fa-crop-simple'), el('span', { text: T('entry.crop') })]),
        ]);
        bindInteractionBoundary(menu);
        document.body.append(menu);
        const rect = anchor.getBoundingClientRect();
        placeMenu(menu, { x: rect.left, y: rect.bottom + 4 });
        bindDismiss(menu, MENU_CLASS);
        bindOverlay(menu, { className: MENU_CLASS, initial: menu.querySelector('.menu_button') });
    }

    async function runAttach(button, payload) {
        button.classList.add('lba-entry-button--loading');
        button.setAttribute('aria-busy', 'true');
        const spin = icon('fa-solid fa-spinner fa-spin');
        button.append(spin);
        try {
            await onAttach(payload);
        } finally {
            spin.remove();
            button.classList.remove('lba-entry-button--loading');
            button.removeAttribute('aria-busy');
        }
    }

    function buildChrome(entryNode, uid) {
        const image = imageFor(uid);

        const imageButton = el('div', {
            class: `menu_button lba-button--icon lba-entry-button${image ? ' lba-entry-button--set' : ''}`,
            title: image ? T('entry.replace') : T('entry.add'),
            role: 'button',
            tabIndex: 0,
            'aria-label': image ? T('entry.replace') : T('entry.add'),
            on: {
                click: event => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (image) openThumbMenu(event.currentTarget, uid, image);
                    else void runAttach(event.currentTarget, { entryUid: uid, bookName: wi.bookName(), current: image });
                },
                keydown: event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.currentTarget.click();
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
    function scan(immediate = false) {
        const mine = ++generation;
        const run = () => {
            if (mine !== generation) return;
            const entries = wi.entries();
            let decorated = 0;

            for (const node of entries) {
                if (mine !== generation) return;
                if (decorate(node)) decorated += 1;
            }

            if (entries.length && !decorated) {
                console.warn('[lorebook-atlas] World Info entries found but no uid could be read; markup may have changed', wi.diagnostics());
            }

            try {
                onAfterScan?.();
            } catch (error) {
                console.error('[lorebook-atlas] post-scan hook failed:', error);
            }
        };
        if (immediate || typeof requestIdleCallback !== 'function') run();
        else requestIdleCallback(run, { timeout: 100 });
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

            scan(true);
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
            scan(true);
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
