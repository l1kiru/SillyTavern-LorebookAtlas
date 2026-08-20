/**
 * Restore preview.
 *
 * A table, not a checkbox. With a dozen lorebooks of which three collide, one
 * archive-wide switch would force the user to import twice; the policy is therefore a
 * per-row decision seeded by a global default.
 *
 * The table is rendered straight from planRestore()'s output and edits feed straight back
 * into it, so what is reviewed and what is executed are the same object — there is no
 * second code path that could disagree with the preview.
 */

import { T } from '../i18n.js';
import { POLICY, planRestore, suggestRestoredName } from '../restore.js';
import { formatBytes } from '../util.js';
import { el, clear } from './dom.js';

const POLICY_LABELS = {
    [POLICY.CREATE]: 'restore.policyCreate',
    [POLICY.SEPARATE]: 'restore.policySeparate',
    [POLICY.REPLACE]: 'restore.policyReplace',
    [POLICY.MERGE]: 'restore.policyMerge',
};

export function createRestorePreview({ context, archive, localBooks, onApply }) {
    let defaultPolicy = POLICY.MERGE;
    let markLists = true;
    const overrides = {};
    let plan = null;
    let root = null;

    function rebuild() {
        plan = planRestore({ archive, localBooks, defaultPolicy, overrides, markLists });
    }

    function localOf(name) {
        return localBooks.find(item => item.name === name) ?? null;
    }

    function renderPolicySelect(item) {
        const options = item.hasLocal
            ? [POLICY.MERGE, POLICY.REPLACE, POLICY.SEPARATE]
            : [POLICY.CREATE];

        const select = el('select', {
            class: 'text_pole lba-restore__policy',
            on: {
                change: event => {
                    const value = event.target.value;
                    overrides[item.name] = value === 'skip'
                        ? { skip: true }
                        : { policy: value, targetName: undefined };
                    rebuild();
                    renderRows();
                },
            },
        }, [
            ...options.map(policy => el('option', { value: policy, text: T(POLICY_LABELS[policy]) })),
            el('option', { value: 'skip', text: T('restore.policySkip') }),
        ]);

        select.value = item.skip ? 'skip' : item.policy;
        return select;
    }

    function renderNameCell(item) {
        // Editable only where a new lorebook is actually created. Making the suffix an
        // editable field also sidesteps the question of which language to bake into a name.
        if (item.skip || item.policy !== POLICY.SEPARATE) {
            return el('span', { class: 'lba-restore__name', text: item.skip ? '—' : item.targetName });
        }

        return el('input', {
            class: 'text_pole lba-restore__name-input',
            value: item.targetName,
            on: {
                change: event => {
                    const taken = localBooks.map(b => b.name);
                    const value = event.target.value.trim() || suggestRestoredName(item.name, taken);
                    overrides[item.name] = { ...overrides[item.name], policy: POLICY.SEPARATE, targetName: value };
                    rebuild();
                    renderRows();
                },
            },
        });
    }

    function renderLocalCell(item) {
        const local = localOf(item.name);
        if (!local) return el('span', { class: 'lba-restore__muted', text: T('restore.noLocal') });

        const count = Object.keys(local.book?.entries || {}).length;
        return el('span', { text: T('restore.localEntries', { count }) });
    }

    function renderSummary(item) {
        if (item.skip || item.policy !== POLICY.MERGE) return null;

        const parts = [el('div', {
            class: 'lba-restore__summary',
            text: T('restore.mergeSummary', {
                matched: item.entries.matched,
                incoming: item.entries.incomingOnly,
                local: item.entries.localOnly,
            }),
        })];

        // Low-confidence pairs were matched on body text alone. Worth flagging: that is
        // where a wrong pairing would hide.
        if (item.entries.lowConfidence) {
            parts.push(el('div', {
                class: 'lba-restore__warning',
                text: T('restore.lowConfidence', { count: item.entries.lowConfidence }),
            }));
        }

        return el('div', {}, parts);
    }

    function renderRows() {
        const body = root?.querySelector('.lba-restore__body');
        if (!body) return;
        clear(body);

        for (const item of plan.items) {
            body.append(el('div', { class: `lba-restore__row${item.skip ? ' lba-restore__row--skipped' : ''}` }, [
                el('div', { class: 'lba-restore__cell', dataset: { label: T('restore.columnArchive') }, text: item.name }),
                el('div', { class: 'lba-restore__cell', dataset: { label: T('restore.columnLocal') } }, [renderLocalCell(item)]),
                el('div', { class: 'lba-restore__cell', dataset: { label: T('restore.columnAction') } }, [renderPolicySelect(item)]),
                el('div', { class: 'lba-restore__cell', dataset: { label: T('restore.columnName') } }, [renderNameCell(item)]),
                el('div', { class: 'lba-restore__cell lba-restore__cell--wide' }, [renderSummary(item)]),
            ]));
        }
    }

    function renderHeader() {
        const defaultSelect = el('select', {
            class: 'text_pole',
            on: {
                change: event => {
                    defaultPolicy = event.target.value;
                    // Rows the user has already touched keep their override.
                    rebuild();
                    renderRows();
                },
            },
        }, [POLICY.MERGE, POLICY.REPLACE, POLICY.SEPARATE].map(policy =>
            el('option', { value: policy, text: T(POLICY_LABELS[policy]) })));
        defaultSelect.value = defaultPolicy;

        const markToggle = el('label', { class: 'checkbox_label' }, [
            el('input', {
                type: 'checkbox',
                checked: markLists,
                on: {
                    change: event => {
                        markLists = event.target.checked;
                        rebuild();
                        renderRows();
                    },
                },
            }),
            el('span', { text: T('restore.markLists') }),
        ]);

        return el('div', { class: 'lba-restore__header' }, [
            el('label', {}, [el('span', { text: `${T('restore.defaultPolicy')}: ` }), defaultSelect]),
            markToggle,
        ]);
    }

    function renderColumns() {
        return el('div', { class: 'lba-restore__row lba-restore__row--head' }, [
            el('div', { class: 'lba-restore__cell', text: T('restore.columnArchive') }),
            el('div', { class: 'lba-restore__cell', text: T('restore.columnLocal') }),
            el('div', { class: 'lba-restore__cell', text: T('restore.columnAction') }),
            el('div', { class: 'lba-restore__cell', text: T('restore.columnName') }),
            el('div', { class: 'lba-restore__cell lba-restore__cell--wide' }),
        ]);
    }

    return {
        async show() {
            rebuild();
            root = el('div', { class: 'lba-restore' }, [
                renderHeader(),
                el('div', { class: 'lba-restore__table' }, [renderColumns(), el('div', { class: 'lba-restore__body' })]),
                el('div', {
                    class: 'lba-restore__totals',
                    text: `${plan.totals.lorebooks} · ${plan.totals.images} · ${formatBytes(0).replace(/^0\s*/, '')}`.trim(),
                }),
            ]);
            renderRows();

            const popup = new context.Popup(root, context.POPUP_TYPE.TEXT, '', {
                wide: true,
                large: true,
                allowVerticalScrolling: true,
                okButton: T('restore.apply'),
                cancelButton: true,
                customButtons: [{ text: T('restore.dryRun'), result: 20 }],
            });

            const result = await popup.show();

            if (result === 20) {
                // Dry run: print the very same plan that Apply would execute.
                console.table(plan.items.map(item => ({
                    archive: item.name,
                    action: item.skip ? 'skip' : item.policy,
                    result: item.targetName,
                    matched: item.entries.matched,
                    fromArchive: item.entries.incomingOnly,
                    localOnly: item.entries.localOnly,
                })));
                globalThis.toastr?.info(T('restore.dryRun'), T('settings.title'));
                return null;
            }

            if (result !== context.POPUP_RESULT.AFFIRMATIVE) return null;
            return await onApply(plan);
        },

        get plan() { return plan; },
    };
}
