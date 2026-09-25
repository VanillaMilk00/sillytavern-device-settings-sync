import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { classifyStorageEntry } from '../lib/filter.js';
import {
    readStorage, createArchive, serializeArchive, parseArchive, entryBytes, totalBytes,
    buildTree, layoutTreemap, planImport, planDelete, MAX_ARCHIVE_BYTES, inScope, intersectScope,
} from '../lib/storage-model.js';
import { analyzeCleanup, classifyCleanup, planCleanup, describeEntry } from '../lib/storage-analysis.js';
import { REFERENCE_CAPACITY_BYTES } from '../lib/capacity-probe.js';
import { msg, bytes, errorText } from '../lib/messages.js';
import { renderIndexedDbBackups, renderIndexedDbManager } from './indexeddb-manager.js';

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function button(label, action) {
    const node = element('button', label, 'menu_button');
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
}

function checkbox(label, checked = false) {
    const root = element('label', undefined, 'dss_check');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = checked;
    root.append(input, element('span', label));
    return { root, input };
}

function largePopup(content, type, options) {
    const popup = new Popup(content, type, '', { large: true, wide: true, allowVerticalScrolling: true, ...options });
    popup.dlg.classList.add('dss_dialog');
    return popup.show();
}

function download(archive) {
    const text = serializeArchive(archive);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = element('a');
    anchor.href = url;
    anchor.download = 'localStorage-' + new Date().toISOString().replace(/[:.]/gu, '-') + '.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function scopeLabel(scope) {
    if (scope.kind === 'full') return msg('scopeFull');
    if (scope.kind === 'prefix') return msg('scopePrefix', scope);
    return msg('scopeKeys', { count: scope.keys.length });
}

function classification(key, value, options) {
    const reason = classifyStorageEntry(key, value, options).reason;
    return msg({
        'portable-setting': 'portable', 'sync-internal': 'internal', 'data-or-cache': 'dataCache',
        'custom-exclude': 'customExclude', 'binary-value': 'binary', 'too-large': 'tooLarge', 'invalid-key': 'invalidKey',
        'full-sync': 'fullSync', 'selected-sync': 'selectedSync', 'not-selected': 'notSelected',
    }[reason]);
}

class StorageTree {
    constructor(values, filterOptions, onSelection = () => {}, cleanup = false) {
        this.values = values;
        this.filterOptions = filterOptions;
        this.onSelection = onSelection;
        this.cleanup = cleanup;
        this.analysis = new Map(analyzeCleanup(values).map((item, index) => [item.key, { ...item, largest: index < 10 }]));
        this.types = new Map([...values].map(([key, value]) => [key, describeEntry(key, value)]));
        this.root = buildTree(values);
        this.selected = new Set();
        this.scopeHint = null;
        this.expanded = new Set();
        this.mapRoot = this.root;
        this.node = element('div', undefined, 'dss_explorer');
        this.controls = element('div', undefined, 'dss_toolbar');
        this.search = element('input', undefined, 'text_pole');
        this.search.type = 'search';
        this.search.placeholder = msg('search');
        this.search.setAttribute('aria-label', msg('search'));
        this.search.addEventListener('input', () => this.render());
        this.sort = element('select', undefined, 'text_pole');
        for (const [value, label] of [['size', 'sortSize'], ['name', 'sortName']]) {
            const option = element('option', msg(label));
            option.value = value;
            this.sort.append(option);
        }
        this.sort.addEventListener('change', () => this.render());
        this.controls.append(this.search, this.sort,
            button(msg('selectAll'), () => { this.scopeHint = null; this.visibleKeys().filter(key => this.selectable(key)).forEach(key => this.selected.add(key)); this.changed(); }),
            button(msg('clearSelection'), () => { this.scopeHint = null; this.selected.clear(); this.changed(); }),
            button(msg('expandAll'), () => { this.walk(node => { if (node.type === 'folder') this.expanded.add(node.id); }); this.render(); }),
            button(msg('collapseAll'), () => { this.expanded.clear(); this.render(); }));
        this.summary = element('p', undefined, 'dss_summary');
        this.layout = element('div', undefined, 'dss_explorer_layout');
        this.tableWrap = element('div', undefined, 'dss_tree_scroll');
        this.table = element('table', undefined, 'dss_tree');
        const head = element('thead');
        const header = element('tr');
        for (const key of ['name', 'size', 'percent', 'keys', 'extension', cleanup ? 'cleanupClassification' : 'classification']) header.append(element('th', msg(key)));
        head.append(header);
        this.body = element('tbody');
        this.table.append(head, this.body);
        this.tableWrap.append(this.table);
        this.mapPanel = element('div', undefined, 'dss_map_panel');
        this.mapPath = button('localStorage', () => { this.mapRoot = this.root; this.render(); });
        this.map = element('div', undefined, 'dss_treemap');
        this.mapPanel.append(this.mapPath, this.map);
        this.layout.append(this.tableWrap, this.mapPanel);
        this.node.append(this.controls, this.summary, this.layout);
        this.render();
    }

    walk(fn, node = this.root) {
        fn(node);
        if (node.children) node.children.forEach(child => this.walk(fn, child));
    }

    visibleKeys() {
        const query = this.search.value.toLocaleLowerCase();
        return [...this.values.keys()].filter(key => key.toLocaleLowerCase().includes(query));
    }

    selectable(key) { return !this.cleanup || this.analysis.get(key).category !== 'protected'; }

    selectRecommended() {
        this.search.value = '';
        this.selected = new Set([...this.analysis.values()].filter(item => item.category === 'recommended').map(item => item.key));
        this.scopeHint = null;
        this.walk(node => { if (node.type === 'folder') this.expanded.add(node.id); });
        this.changed();
    }

    scope() {
        // Only an explicit whole-folder selection carries prefix replacement authority.
        const folder = this.scopeHint;
        return folder && folder.keys.length === this.selected.size && folder.keys.every(key => this.selected.has(key))
            ? { kind: 'prefix', prefix: folder.prefix } : { kind: 'keys', keys: [...this.selected] };
    }

    changed() {
        this.render();
        this.onSelection();
    }

    locate(key) {
        this.search.value = '';
        this.selected = new Set(this.selectable(key) ? [key] : []);
        this.scopeHint = null;
        this.walk(node => { if (node.type === 'folder' && node.keys.includes(key)) this.expanded.add(node.id); });
        this.changed();
        this.rows.get(key)?.scrollIntoView({ block: 'nearest' });
    }

    render() {
        const visible = new Set(this.visibleKeys());
        const selectedBytes = [...this.selected].reduce((sum, key) => sum + entryBytes(key, this.values.get(key)), 0);
        this.summary.textContent = msg('total', { count: this.values.size, size: bytes(this.root.bytes), selected: bytes(selectedBytes) });
        this.body.replaceChildren();
        this.rows = new Map();
        const query = Boolean(this.search.value);
        const renderNode = (node, depth) => {
            const keys = node.keys.filter(key => visible.has(key));
            const selectableKeys = keys.filter(key => this.selectable(key));
            if (!keys.length) return;
            const row = element('tr');
            row.dataset.nodeId = node.id;
            const cell = element('td');
            const label = element('div', undefined, 'dss_tree_name');
            label.style.paddingInlineStart = (depth * 14) + 'px';
            const check = element('input');
            check.type = 'checkbox';
            check.setAttribute('aria-label', node.type === 'file' ? node.key : node.prefix);
            check.disabled = !selectableKeys.length;
            check.checked = selectableKeys.length > 0 && selectableKeys.every(key => this.selected.has(key));
            check.indeterminate = !check.checked && selectableKeys.some(key => this.selected.has(key));
            check.addEventListener('change', () => {
                this.scopeHint = check.checked && node.type === 'folder' && keys.length === node.keys.length ? node : null;
                selectableKeys.forEach(key => check.checked ? this.selected.add(key) : this.selected.delete(key));
                this.changed();
            });
            const open = this.expanded.has(node.id) || query;
            const name = node.type === 'file' && node.key === '' ? msg('emptyKey') : node.name;
            const caption = button((node.type === 'folder' ? (open ? '▾ ' : '▸ ') : '') + name, () => {
                if (node.type === 'folder') {
                    if (this.expanded.has(node.id)) this.expanded.delete(node.id);
                    else this.expanded.add(node.id);
                    this.mapRoot = node;
                    this.render();
                } else {
                    this.selected = new Set(this.selectable(node.key) ? [node.key] : []);
                    this.scopeHint = null;
                    this.changed();
                }
            });
            caption.title = node.type === 'folder' ? node.prefix : node.key;
            if (node.type === 'folder') caption.setAttribute('aria-expanded', String(open));
            label.append(check, caption);
            cell.append(label);
            const filteredBytes = keys.reduce((sum, key) => sum + entryBytes(key, this.values.get(key)), 0);
            const type = this.types.get(node.key);
            const typeCell = element('td', type ? type.extension + (type.inferred ? ' (' + msg('inferred') + ')' : '') + ' · ' + msg(type.type) : '');
            typeCell.className = 'dss_type';
            const advice = this.analysis.get(node.key);
            const reason = this.cleanup && advice ? msg('cleanup' + advice.category[0].toUpperCase() + advice.category.slice(1)) + ' · ' + msg(advice.reason)
                + (advice.largest ? ' · ' + msg('largestBadge') : '')
                : node.type === 'file' ? classification(node.key, this.values.get(node.key), this.filterOptions) : '';
            row.append(cell, element('td', bytes(filteredBytes)),
                element('td', (this.root.bytes ? 100 * filteredBytes / this.root.bytes : 0).toFixed(1) + '%'),
                element('td', String(keys.length)), typeCell, element('td', reason));
            if (this.cleanup && advice) row.classList.add('dss_category_' + advice.category);
            row.classList.toggle('dss_selected', check.checked);
            this.body.append(row);
            if (node.type === 'file') this.rows.set(node.key, row);
            if (node.children && open) sorted(node.children).forEach(child => renderNode(child, depth + 1));
        };
        const sorted = children => [...children].sort((a, b) => this.sort.value === 'name'
            ? a.name.localeCompare(b.name) : b.bytes - a.bytes || a.name.localeCompare(b.name));
        sorted(this.root.children).forEach(node => renderNode(node, 0));
        this.table.hidden = !visible.size;
        this.map.replaceChildren();
        this.mapPath.textContent = 'localStorage / ' + (this.mapRoot.prefix || '');
        const nodes = (this.mapRoot.children || [this.mapRoot]).map(node => ({
            ...node,
            keys: node.keys.filter(key => visible.has(key)),
            bytes: node.keys.filter(key => visible.has(key)).reduce((sum, key) => sum + entryBytes(key, this.values.get(key)), 0),
        })).filter(node => node.keys.length);
        layoutTreemap(nodes).forEach(({ node, x, y, width, height }, index) => {
            const name = node.type === 'file' && node.key === '' ? msg('emptyKey') : node.name;
            const box = button(name + '\n' + bytes(node.bytes), () => {
                this.selected = new Set(node.keys.filter(key => this.selectable(key)));
                this.scopeHint = node.type === 'folder' && !query ? node : null;
                this.changed();
            });
            box.className = 'dss_map_box';
            box.title = (node.prefix || node.key || node.name) + ' · ' + bytes(node.bytes);
            box.style.cssText = 'left:' + x + '%;top:' + y + '%;width:' + width + '%;height:' + height + '%;--tile-hue:' + ((index * 47 + 190) % 360);
            const selectableKeys = node.keys.filter(key => this.selectable(key));
            const selected = selectableKeys.length > 0 && selectableKeys.every(key => this.selected.has(key));
            box.classList.toggle('dss_selected', selected);
            box.setAttribute('aria-pressed', String(selected));
            box.addEventListener('dblclick', () => { if (node.type === 'folder') { this.mapRoot = node; this.render(); } });
            this.map.append(box);
        });
        if (!visible.size) this.map.append(element('p', msg('empty')));
    }
}

export async function openStorageManager(api, { initialTab = 'local' } = {}) {
    let disposed = false;
    let activeTab = ['local', 'backups', 'serverVersions', 'cleanup', 'indexeddb', 'indexedDbBackups'].includes(initialTab) ? initialTab : 'local';
    let currentTree;
    let viewGeneration = 0;
    let pending = false;
    let capacityResult = null;
    const root = element('div', undefined, 'dss_manager');
    const heading = element('h3', msg('manager'));
    const status = element('p', '', 'dss_feedback');
    status.setAttribute('role', 'status');
    const tabs = element('div', undefined, 'dss_toolbar');
    const content = element('div');
    const setting = checkbox(msg('beforeChanges'), api.getSettings().backupBeforeChanges === true);
    setting.input.addEventListener('change', () => api.setBackupBeforeChanges(setting.input.checked));
    const reload = button(msg('reload'), () => location.reload());
    reload.hidden = true;
    const capacityPanel = element('section', undefined, 'dss_capacity_panel');
    const capacityUsed = element('p');
    const capacityActual = element('p');
    capacityPanel.append(element('strong', msg('capacityTitle')), capacityUsed,
        element('p', msg('capacityReference', { size: bytes(REFERENCE_CAPACITY_BYTES) }), 'dss_note'), capacityActual,
        button(msg('probe'), () => guard(async () => {
            const result = await new Popup(msg('probeWarning'), POPUP_TYPE.CONFIRM, '', {
                okButton: msg('probe'), cancelButton: msg('cancel'), allowVerticalScrolling: true,
            }).show();
            if (result !== POPUP_RESULT.AFFIRMATIVE) return;
            capacityResult = null;
            capacityActual.textContent = msg('probing');
            try { capacityResult = await api.measureCapacity(); }
            finally { updateCapacity(); }
        })));
    root.append(heading, capacityPanel, element('p', msg('estimateNote'), 'dss_note'),
        element('p', msg('extensionHint'), 'dss_note'), setting.root, tabs, status, reload, content);

    function updateCapacity() {
        const values = readStorage(localStorage);
        capacityUsed.textContent = msg('capacity', { count: values.size, size: bytes(totalBytes(values)) });
        capacityActual.textContent = !capacityResult ? msg('capacityUnknown') : msg(capacityResult.limited ? 'capacityAtLeast' : 'capacityMeasured', {
            low: bytes(capacityResult.lowerBytes), high: bytes(capacityResult.upperBytes || 0),
            remaining: bytes(Math.max(0, capacityResult.lowerBytes - capacityResult.usedBytes)),
            date: new Date(capacityResult.testedAt).toLocaleString(),
        });
    }

    async function guard(work) {
        if (pending || api.isBusy()) return;
        pending = true;
        root.classList.add('dss_pending');
        try { await work(); }
        catch (error) {
            if (error.code === 'rollbackFailed' || error.code === 'writeRolledBack') {
                api.onChanged();
                if (activeTab === 'local') renderLocal();
                if (activeTab === 'cleanup') renderCleanup();
            }
            status.textContent = errorText(error);
            status.classList.add('dss_error');
        }
        finally { pending = false; root.classList.remove('dss_pending'); }
    }

    function source() { return api.source(); }

    function clearFeedback() {
        status.textContent = '';
        status.classList.remove('dss_error');
    }

    function localChanged(count) {
        status.classList.remove('dss_error');
        status.textContent = msg('changeSuccess', { count });
        reload.hidden = false;
        api.onChanged();
        updateCapacity();
    }

    async function chooseFile(scope) {
        const input = element('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', () => guard(async () => {
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > MAX_ARCHIVE_BYTES) throw { code: 'archiveTooLarge' };
            const archive = parseArchive(await file.text());
            await previewImport(archive, 'import', scope);
        }), { once: true });
        input.click();
    }

    async function previewImport(archive, reason, targetScope = archive.scope) {
        const before = readStorage(localStorage);
        const incoming = new Map(archive.entries.filter(item => inScope(item.key, targetScope)).map(item => [item.key, item.value]));
        const tree = new StorageTree(incoming, api.filterOptions(), updatePreview);
        tree.selected = new Set(incoming.keys());
        const view = element('div', undefined, 'dss_manager dss_import');
        const mode = element('select', undefined, 'text_pole');
        for (const value of ['merge', 'replace']) {
            const option = element('option', msg(value));
            option.value = value;
            mode.append(option);
        }
        const internal = checkbox(msg('includeInternal'));
        const counts = element('p', undefined, 'dss_summary');
        const scopeText = element('p');
        const deletions = element('details');
        deletions.append(element('summary', msg('deletionList')));
        const deletionList = element('ul', undefined, 'dss_deletion_list');
        deletions.append(deletionList);
        let plan;
        function updatePreview() {
            const scope = tree.selected.size !== incoming.size || tree.scopeHint
                ? intersectScope(targetScope, tree.scope()) : targetScope;
            scopeText.textContent = scopeLabel(intersectScope(archive.scope, scope));
            plan = planImport(before, archive, { mode: mode.value, selectedKeys: tree.selected, scope, includeInternal: internal.input.checked });
            const add = plan.changes.filter(change => change.before === null).length;
            const remove = plan.changes.filter(change => change.after === null).length;
            counts.textContent = msg('previewCounts', { add, remove, overwrite: plan.changes.length - add - remove, skip: incoming.size - plan.changes.filter(change => change.after !== null).length });
            deletionList.replaceChildren(...plan.changes.filter(change => change.after === null).map(change => element('li', change.key)));
            deletions.hidden = remove === 0;
        }
        mode.addEventListener('change', updatePreview);
        internal.input.addEventListener('change', updatePreview);
        view.append(element('h3', msg('preview')), scopeText,
            element('p', msg('selectionScope'), 'dss_note'), mode, internal.root, counts, deletions, tree.node,
            element('p', msg('localOnly'), 'dss_note'),
            element('p', msg(api.getSettings().backupBeforeChanges ? 'automaticBackup' : 'noAutomaticBackup'), 'dss_note'));
        tree.render();
        updatePreview();
        const result = await largePopup(view, POPUP_TYPE.CONFIRM, { okButton: msg('apply'), cancelButton: msg('cancel') });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        if (!plan.changes.length) { status.textContent = msg('noChanges'); return; }
        const count = await api.applyLocalPlan(plan, reason);
        localChanged(count);
        await showTab('local');
    }

    function renderLocal() {
        content.replaceChildren();
        updateCapacity();
        const values = readStorage(localStorage);
        currentTree = new StorageTree(values, api.filterOptions());
        const toolbar = element('div', undefined, 'dss_toolbar');
        const internal = checkbox(msg('includeInternal'));
        toolbar.append(
            button(msg('rescan'), () => guard(async () => { renderLocal(); clearFeedback(); })),
            button(msg('useAsSyncScope'), () => guard(async () => {
                if (!currentTree.selected.size) { status.textContent = msg('selectedScopeEmpty'); return; }
                const scope = currentTree.scope();
                await api.setSyncScope(scope);
                status.classList.remove('dss_error');
                status.textContent = msg('syncScopeSaved', { count: currentTree.selected.size });
                renderLocal();
            })),
            button(msg('exportAll'), () => guard(async () => download(createArchive(readStorage(localStorage), { kind: 'full' }, source())))),
            button(msg('exportSelected'), () => guard(async () => {
                if (currentTree.selected.size) download(createArchive(readStorage(localStorage), currentTree.scope(), source()));
            })),
            button(msg('importFile'), () => { if (!pending && !api.isBusy()) chooseFile(currentTree.selected.size ? currentTree.scope() : undefined); }),
            button(msg('remove'), () => guard(async () => {
                // A changed tree must never silently expand a folder deletion.
                const plan = planDelete(currentTree.values, currentTree.selected, internal.input.checked);
                if (!plan.changes.length) { status.textContent = msg('noChanges'); return; }
                const info = element('div');
                info.append(element('p', msg('confirmDelete', {
                    count: plan.changes.length,
                    size: bytes(plan.changes.reduce((sum, change) => sum + entryBytes(change.key, change.before), 0)),
                })), element('p', msg('localOnly')),
                element('p', msg(api.getSettings().backupBeforeChanges ? 'automaticBackup' : 'noAutomaticBackup')));
                const list = element('ul', undefined, 'dss_deletion_list');
                plan.changes.forEach(change => list.append(element('li', change.key)));
                info.append(list);
                const result = await new Popup(info, POPUP_TYPE.CONFIRM, '', { okButton: msg('remove'), cancelButton: msg('cancel') }).show();
                if (result !== POPUP_RESULT.AFFIRMATIVE) return;
                // api performs another full comparison immediately before writing.
                localChanged(await api.applyLocalPlan(plan, 'delete'));
                renderLocal();
            })));
        content.append(toolbar, internal.root, element('p', msg('credentialsNote'), 'dss_note'), currentTree.node);
    }

    function renderCleanup() {
        content.replaceChildren();
        updateCapacity();
        const values = readStorage(localStorage);
        const advice = analyzeCleanup(values);
        const summary = element('div', undefined, 'dss_cleanup_summary');
        for (const category of ['recommended', 'protected', 'review']) {
            const items = advice.filter(item => item.category === category);
            const card = element('div', undefined, 'dss_category_' + category);
            card.append(element('strong', msg('cleanup' + category[0].toUpperCase() + category.slice(1))),
                element('p', msg('cleanupGroup', { count: items.length, size: bytes(items.reduce((sum, item) => sum + item.bytes, 0)) })));
            summary.append(card);
        }
        const toolbar = element('div', undefined, 'dss_toolbar');
        const clean = button(msg('backupClean'), () => guard(async () => {
            // Classify again at the mutation boundary; never trust a checkbox alone.
            const plan = planCleanup(tree.values, tree.selected);
            if (!plan.changes.length) { status.textContent = msg('noChanges'); return; }
            const beforeSize = totalBytes(plan.before);
            const info = element('div');
            info.append(element('p', msg('confirmDelete', { count: plan.changes.length,
                size: bytes(plan.changes.reduce((sum, change) => sum + entryBytes(change.key, change.before), 0)),
            })), element('p', msg('automaticBackup')), element('p', msg('credentialsNote')), element('p', msg('localOnly')));
            const list = element('ul', undefined, 'dss_deletion_list');
            plan.changes.forEach(change => list.append(element('li', change.key + ' · ' + msg(classifyCleanup(change.key).reason))));
            info.append(list);
            const result = await new Popup(info, POPUP_TYPE.CONFIRM, '', {
                okButton: msg('backupClean'), cancelButton: msg('cancel'), allowVerticalScrolling: true,
            }).show();
            if (result !== POPUP_RESULT.AFFIRMATIVE) return;
            const count = await api.applyLocalPlan(plan, 'delete', { forceBackup: true });
            localChanged(count);
            const afterSize = totalBytes(readStorage(localStorage));
            status.textContent = msg('cleanupResult', { count, before: bytes(beforeSize), after: bytes(afterSize), freed: bytes(Math.max(0, beforeSize - afterSize)) });
            renderCleanup();
        }));
        const tree = new StorageTree(values, api.filterOptions(), () => { clean.disabled = !tree.selected.size; }, true);
        tree.expanded = new Set();
        tree.walk(node => { if (node.type === 'folder') tree.expanded.add(node.id); });
        tree.render();
        clean.disabled = true;
        currentTree = tree;
        toolbar.append(button(msg('analyze'), () => guard(async () => { renderCleanup(); clearFeedback(); })),
            button(msg('selectRecommended'), () => tree.selectRecommended()), clean,
            button(msg('locate'), () => guard(async () => {
                const keys = [...tree.selected];
                if (!keys.length) return;
                await showTab('local');
                currentTree.locate(keys[0]);
                currentTree.selected = new Set(keys);
                currentTree.changed();
            })));
        content.append(element('p', msg('cleanupIntro')), summary, toolbar, tree.node);
    }

    async function showTab(tab) {
        activeTab = tab;
        const generation = ++viewGeneration;
        for (const node of tabs.children) node.classList.toggle('dss_active', node.dataset.tab === tab);
        content.replaceChildren();
        if (tab === 'local') return renderLocal();
        if (tab === 'cleanup') return renderCleanup();
        if (tab === 'indexeddb') return renderIndexedDbManager({ api, content, status, guard, refresh: showTab });
        if (tab === 'indexeddbBackups') return renderIndexedDbBackups({ api, content, status, guard, refresh: showTab });
        if (tab === 'serverVersions') {
            content.append(element('p', msg('serverVersionsHelp')), element('p', msg('credentialsNote'), 'dss_note'));
            const options = api.filterOptions();
            const mode = options.fullStorage ? 'full' : options.selectedScope ? 'selected' : 'portable';
            const records = await api.listServerVersions(mode);
            if (disposed || generation !== viewGeneration) return;
            if (!records.length) content.append(element('p', msg('serverVersionsEmpty')));
            for (let index = 0; index < 5; index++) {
                const record = records[index];
                const card = element('section', undefined, 'dss_backup_card');
                card.append(element('h4', msg('slot', { number: index + 1 })));
                if (!record) card.append(element('p', msg('backupEmpty')));
                else {
                    card.append(element('p', msg('serverVersionMeta', {
                        date: new Date(record.createdAt).toLocaleString(),
                        device: record.source?.deviceId?.slice(-8) || msg('unknownDevice'),
                        mode: msg(record.mode === 'full' ? 'modeFull' : record.mode === 'selected' ? 'modeSelected' : 'modePortable'),
                        count: record.keys,
                        revision: record.revision,
                    })));
                    const actions = element('div', undefined, 'dss_toolbar');
                    const readVersion = () => api.getServerVersion(record.id, mode);
                    actions.append(
                        button(msg('browse'), () => guard(async () => {
                            const archive = await readVersion();
                            const tree = new StorageTree(new Map(archive.entries.map(item => [item.key, item.value])), api.filterOptions());
                            const view = element('div', undefined, 'dss_manager');
                            view.append(button(msg('exportAll'), () => download(archive)), tree.node);
                            await largePopup(view, POPUP_TYPE.TEXT, { okButton: msg('close') });
                        })),
                        button(msg('export'), () => guard(async () => download(await readVersion()))),
                        button(msg('restoreToServer'), () => guard(async () => {
                            const archive = await readVersion();
                            const accepted = await new Popup(msg('serverVersionRestoreConfirm', { count: archive.entries.length,
                                date: new Date(record.createdAt).toLocaleString() }), POPUP_TYPE.CONFIRM, '', {
                                okButton: msg('restoreToServer'), cancelButton: msg('cancel'), allowVerticalScrolling: true,
                            }).show();
                            if (accepted !== POPUP_RESULT.AFFIRMATIVE) return;
                            await api.restoreServerVersion(record.id, mode);
                            status.classList.remove('dss_error');
                            status.textContent = msg('serverVersionRestoreSuccess');
                            await showTab('serverVersions');
                        })));
                    card.append(actions);
                }
                content.append(card);
            }
            return;
        }
        content.append(element('p', msg('backupHelp')), element('p', msg('credentialsNote'), 'dss_note'));
        const records = await api.listBackups();
        if (disposed || generation !== viewGeneration) return;
        for (let index = 0; index < 5; index++) {
            const card = element('section', undefined, 'dss_backup_card');
            const record = records[index];
            card.append(element('h4', msg('slot', { number: index + 1 })));
            if (!record) card.append(element('p', msg('backupEmpty')));
            else {
                card.append(element('p', msg('backupMeta', {
                    date: new Date(record.createdAt).toLocaleString(),
                    reason: msg('reason' + record.reason[0].toUpperCase() + record.reason.slice(1)),
                    device: record.source.deviceId.slice(-8) || record.source.origin,
                    count: record.keys, size: bytes(record.bytes),
                })), element('p', msg('fileSize', { size: bytes(record.fileBytes) }), 'dss_note'));
                const actions = element('div', undefined, 'dss_toolbar');
                actions.append(
                    button(msg('browse'), () => guard(async () => {
                        const archive = await api.getBackup(record.id);
                        const tree = new StorageTree(new Map(archive.entries.map(item => [item.key, item.value])), api.filterOptions());
                        const view = element('div', undefined, 'dss_manager');
                        const bar = element('div', undefined, 'dss_toolbar');
                        bar.append(button(msg('exportAll'), () => download(archive)),
                            button(msg('exportSelected'), () => {
                                if (tree.selected.size) download(createArchive(tree.values, tree.scope(), archive.source));
                            }));
                        view.append(bar, tree.node);
                        await largePopup(view, POPUP_TYPE.TEXT, { okButton: msg('close') });
                    })),
                    button(msg('export'), () => guard(async () => download(await api.getBackup(record.id)))),
                    button(msg('restore'), () => guard(async () => {
                        // Hold the archive in memory before a rescue backup can evict this slot.
                        const archive = await api.getBackup(record.id);
                        await previewImport(archive, 'restore');
                    })));
                card.append(actions);
            }
            content.append(card);
        }
    }
    for (const tab of ['local', 'backups', 'serverVersions', 'cleanup', 'indexeddb', 'indexeddbBackups']) {
        const labelKey = tab === 'indexeddbBackups' ? 'indexedDbBackups' : tab;
        const node = button(msg(labelKey), () => guard(() => showTab(tab)));
        node.dataset.tab = tab;
        tabs.append(node);
    }
    const storageListener = () => {
        if (!disposed) {
            status.textContent = msg('stalePreview');
            api.onChanged();
            updateCapacity();
        }
    };
    window.addEventListener('storage', storageListener);
    try {
        await showTab(activeTab);
        await largePopup(root, POPUP_TYPE.TEXT, {
            okButton: msg('close'),
            onClosing: () => !pending && !api.isBusy(),
        });
    } finally {
        disposed = true;
        window.removeEventListener('storage', storageListener);
    }
}
