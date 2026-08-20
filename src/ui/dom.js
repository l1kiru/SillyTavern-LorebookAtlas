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
