/**
 * Shared chrome for crop, thumb menus, and the gallery context menu:
 * z-index, Escape, focus trap, restore-focus, dismiss, optional scroll lock.
 */

const FOCUSABLE = 'input, button, select, textarea, [tabindex]:not([tabindex="-1"]), .menu_button';
let overlayZ = 10040;

export function nextOverlayZ() {
    overlayZ += 10;
    return overlayZ;
}

export function closeLayer(className) {
    for (const node of document.querySelectorAll(`.${className}`)) {
        node._lbaDismiss && document.removeEventListener('pointerdown', node._lbaDismiss, true);
        node._lbaScrollCleanup?.();
        node._lbaKeyCleanup?.();
        node._lbaLockCleanup?.();
        const restore = node._lbaRestoreFocus;
        node.remove();
        restore?.();
    }
}

export function clipsOverflow(value) {
    return value === 'auto' || value === 'scroll' || value === 'hidden' || value === 'clip';
}

export function lockScroll(from) {
    const stored = [];
    const freeze = node => {
        stored.push([node, node.style.overflowY]);
        node.style.overflowY = 'hidden';
    };
    freeze(document.documentElement);
    for (let node = from; node && node !== document.documentElement; node = node.parentElement) {
        const { overflowY } = getComputedStyle(node);
        if (overflowY === 'auto' || overflowY === 'scroll') freeze(node);
    }
    return () => {
        for (const [node, value] of stored) node.style.overflowY = value;
    };
}

export function bindOverlay(layer, { className, initial, lockFrom } = {}) {
    const previous = document.activeElement;
    layer.style.zIndex = String(nextOverlayZ());

    const onKey = event => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            closeLayer(className);
            return;
        }
        if (event.key !== 'Tab') return;
        const items = [...layer.querySelectorAll(FOCUSABLE)].filter(node => node.tabIndex !== -1);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };
    document.addEventListener('keydown', onKey);
    layer._lbaKeyCleanup = () => document.removeEventListener('keydown', onKey);
    layer._lbaRestoreFocus = () => previous?.focus?.();
    if (lockFrom) layer._lbaLockCleanup = lockScroll(lockFrom);
    queueMicrotask(() => (initial || layer.querySelector(FOCUSABLE))?.focus?.());
}

export function bindDismiss(layer, className) {
    const dismiss = event => {
        if (layer.contains(event.target)) return;
        closeLayer(className);
    };
    layer._lbaDismiss = dismiss;
    document.addEventListener('pointerdown', dismiss, true);
    const onScroll = () => closeLayer(className);
    window.addEventListener('scroll', onScroll, true);
    const previous = layer._lbaScrollCleanup;
    layer._lbaScrollCleanup = () => {
        window.removeEventListener('scroll', onScroll, true);
        previous?.();
    };
}

/** Keep a floating menu inside the viewport, flipping above the point if needed. */
export function anchoredPosition(menuSize, viewport, point, pad = 8) {
    let left = point.x;
    let top = point.y;
    if (left + menuSize.width > viewport.width - pad) left = viewport.width - menuSize.width - pad;
    if (top + menuSize.height > viewport.height - pad) top = point.y - menuSize.height;
    if (top < pad) top = pad;
    if (left < pad) left = pad;
    return { left, top };
}

export function placeMenu(menu, point) {
    const box = menu.getBoundingClientRect();
    const pos = anchoredPosition(
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
        point,
    );
    menu.style.left = `${Math.round(pos.left)}px`;
    menu.style.top = `${Math.round(pos.top)}px`;
}

/** Crop preview box follows the stored image, not a square thumb. */
export function previewAspectRatio(width, height) {
    const w = Number(width);
    const h = Number(height);
    return w > 0 && h > 0 ? `${w} / ${h}` : '1';
}
