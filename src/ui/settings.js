/**
 * Settings panel, rendered from templates/settings.html through
 * renderExtensionTemplateAsync — which gives DOMPurify sanitisation and data-i18n
 * handling for free, unlike building the markup by hand.
 */

import { EXTENSION_FOLDER, TEMPLATE_ID } from '../constants.js';
import { T } from '../i18n.js';
import { formatBytes } from '../util.js';
import { el } from './dom.js';

export function createSettingsPanel({ storage, context, settings, gallery, actions = {} }) {
    function notify(message, type = 'info') {
        globalThis.toastr?.[type]?.(message, T('settings.title'));
    }

    function updateSummary(container) {
        const totals = storage.totals();
        const node = container.querySelector('#lba_summary');
        if (!node) return;

        const parts = [T('gallery.totals', {
            images: totals.images,
            groups: totals.groups,
            files: totals.files,
            size: formatBytes(totals.bytes),
        })];
        if (totals.locked) parts.push(T('settings.summaryLocked', { count: totals.locked }));

        node.textContent = parts.join(' · ');
    }

    async function confirmCleanup(container) {
        const totals = storage.totals();
        if (!totals.files) {
            notify(T('cleanup.alreadyEmpty'));
            return;
        }

        const body = el('div', {}, [
            el('p', {
                text: T('cleanup.confirm', {
                    files: totals.files,
                    images: totals.images,
                    size: formatBytes(totals.bytes),
                }),
            }),
            el('p', { text: T('cleanup.warning') }),
        ]);

        const answer = await context.callGenericPopup(body, context.POPUP_TYPE.CONFIRM);
        if (answer !== context.POPUP_RESULT.AFFIRMATIVE) return;

        const bar = el('div', { class: 'lba-progress__bar', style: { width: '0%' } });
        container.querySelector('#lba_summary')?.replaceChildren(el('div', { class: 'lba-progress' }, [bar]));

        const result = await storage.cleanupAll({
            onProgress: (done, total) => {
                bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
            },
        });

        updateSummary(container);
        gallery.refresh?.();

        if (result.failed.length) {
            notify(T('cleanup.partial', { deleted: result.deleted, total: result.total, failed: result.failed.length }), 'warning');
        } else {
            notify(T('cleanup.done', { total: result.total }), 'success');
        }
    }

    return {
        async mount(host = document.getElementById('extensions_settings2')) {
            // The template carries English source text plus data-i18n keys; SillyTavern's
            // observer swaps in the active locale automatically.
            //
            // The id is a path relative to the extension folder, not a bare name: SillyTavern
            // builds `scripts/extensions/<folder>/<id>.html` by plain concatenation.
            const html = await context.renderExtensionTemplateAsync(EXTENSION_FOLDER, TEMPLATE_ID, {
                keepOriginal: settings().keepOriginal,
                previewMaxSide: settings().previewMaxSide,
            });

            const wrapper = el('div');
            // renderTemplateAsync swallows its own errors and resolves to undefined, so a
            // missing template arrives here as silence. Say what happened instead of
            // throwing on a null child three lines later.
            wrapper.innerHTML = typeof html === 'string' ? html : '';
            const container = wrapper.firstElementChild;
            if (!container) {
                throw new Error(`Could not render ${EXTENSION_FOLDER}/${TEMPLATE_ID}.html — the file is missing or empty`);
            }
            // Same class of silence as the template 404: without the host the panel simply
            // never appears and nothing says why.
            if (!host) {
                throw new Error('SillyTavern settings container #extensions_settings2 was not found');
            }
            host.append(container);

            container.querySelector('#lba_binding_strategy').value = settings().bindingStrategy;

            container.querySelector('#lba_open_gallery')?.addEventListener('click', () => gallery.open());

            container.querySelector('#lba_verify')?.addEventListener('click', async () => {
                const report = await storage.verify();
                const text = report.missing.length
                    ? T('verify.missing', { checked: report.checked, missing: report.missing.length })
                    : T('verify.ok', { checked: report.checked });
                await context.callGenericPopup(el('p', { text }), context.POPUP_TYPE.TEXT);
            });

            container.querySelector('#lba_keep_original')?.addEventListener('change', event => {
                settings().keepOriginal = event.target.checked;
                context.saveSettingsDebounced();
            });

            container.querySelector('#lba_preview_side')?.addEventListener('change', event => {
                const value = Number(event.target.value);
                settings().previewMaxSide = Number.isFinite(value) ? Math.min(2048, Math.max(128, value)) : 512;
                event.target.value = settings().previewMaxSide;
                context.saveSettingsDebounced();
            });

            container.querySelector('#lba_binding_strategy')?.addEventListener('change', event => {
                settings().bindingStrategy = event.target.value;
                context.saveSettingsDebounced();
            });

            container.querySelector('#lba_cleanup')?.addEventListener('click', () => confirmCleanup(container));

            container.querySelector('#lba_explorer')?.addEventListener('click', () => actions.openExplorer?.());
            container.querySelector('#lba_export_full')?.addEventListener('click', () => actions.exportFull?.());
            container.querySelector('#lba_export_single')?.addEventListener('click', () => actions.exportSingle?.());
            container.querySelector('#lba_import')?.addEventListener('click', () => actions.importArchive?.());

            updateSummary(container);
            this.container = container;
            return container;
        },

        refresh() {
            if (this.container) updateSummary(this.container);
        },
    };
}
