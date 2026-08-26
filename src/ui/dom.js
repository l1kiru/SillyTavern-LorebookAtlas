/** Minimal DOM helpers. Deliberately dependency-free so the UI layer stays testable. */

/**
 * @param {string} tag
 * @param {object} [props] className, textContent, dataset, attrs, style, on
 * @param {Array<Node|string|null|undefined>} [children]
 */
export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(props)) {
        if (value == null) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'style') Object.assign(node.style, value);
        else if (key === 'on') for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
    }

    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }

    return node;
}

/** Font Awesome icon, which is what the rest of SillyTavern's UI uses. */
export function icon(classes, title) {
    return el('i', { class: `fa-fw ${classes}`, title });
}

export function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
}

/** Case- and diacritic-insensitive substring match, good enough for gallery filtering. */
export function matches(haystack, needle) {
    if (!needle) return true;
    const normalize = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return normalize(haystack).includes(normalize(needle));
}

/**
 * Opens the file picker and resolves with the chosen file, or null if the user backed out.
 *
 * The naive version listens only for `change`, which never fires when the dialog is
 * dismissed — so the promise never settles. Anything awaiting it hangs: a spinner started
 * before the call is never cleared, and every further attempt stacks another one.
 *
 * Two signals cover cancellation between them:
 *  - `cancel` on the input, which modern browsers fire when the dialog is dismissed;
 *  - the window regaining focus, the only clue older engines give. `change` is allowed a
 *    moment to arrive first, since it lands just after focus returns on a real pick.
 *
 * @returns {Promise<File|null>}
 */
export function pickFile({
    accept = 'image/*',
    doc = globalThis.document,
    win = globalThis,
    focusGraceMs = 400,
} = {}) {
    return new Promise(resolve => {
        const input = doc.createElement('input');
        input.type = 'file';
        input.accept = accept;

        let settled = false;
        let focusTimer = null;

        const cleanup = () => {
            if (focusTimer) clearTimeout(focusTimer);
            input.removeEventListener('change', onChange);
            input.removeEventListener('cancel', onCancel);
            win.removeEventListener('focus', onFocus);
        };

        const finish = value => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };

        function onChange() { finish(input.files?.[0] ?? null); }
        function onCancel() { finish(null); }
        function onFocus() { focusTimer = setTimeout(() => finish(null), focusGraceMs); }

        input.addEventListener('change', onChange);
        input.addEventListener('cancel', onCancel);
        win.addEventListener('focus', onFocus);
        input.click();
    });
}
