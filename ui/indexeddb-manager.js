import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { bytes, msg, errorText } from '../lib/messages.js';
import { MAX_INDEXEDDB_ARCHIVE_BYTES, estimateJsonBytes, parseIndexedDbArchive, serializeIndexedDbArchive, selectIndexedDbArchive } from '../lib/indexeddb-model.js';

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function button(label, action) {
    const node = element('button', label, 'menu_button');
    node.type = 'button'; node.addEventListener('click', action); return node;
}
function download(archive, filename = 'indexedDB-backup.json') {
    const text = serializeIndexedDbArchive(archive);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = element('a'); anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function recordCount(archive) { return archive.databases.reduce((sum, db) => sum + db.stores.reduce((part, store) => part + store.records.length, 0), 0); }
function recordBytes(record) { return estimateJsonBytes(record); }
function keyLabel(key) {
    if (key?.$type === 'date') return key.value || 'Invalid Date';
    if (key?.$type === 'array-buffer') return `ArrayBuffer (${atob(key.value).length} B)`;
    if (key?.$type === 'array') return '[' + key.value.map(keyLabel).join(', ') + ']';
    return String(key);
}
function scopeItems(selected) {
    const items = [...selected.values()].map(item => item.kind === 'database' ? { database: item.database }
        : item.kind === 'store' ? { database: item.database, store: item.store }
            : { database: item.database, store: item.store, keyToken: item.keyToken });
    return items.filter(item => !items.some(parent => parent !== item && parent.database === item.database
        && (parent.store === undefined || (parent.store === item.store && parent.keyToken === undefined))));
}
function token(item) { return JSON.stringify(item); }

async function chooseImportScope(archive, localArchive) {
    const selected = new Map();
    const expandedStores = new Set();
    const recordLimits = new Map();
    const view = element('div', undefined, 'dss_manager dss_import');
    const controls = element('div', undefined, 'dss_toolbar');
    const summary = element('p', undefined, 'dss_summary');
    const tree = element('div', undefined, 'dss_idb_tree');
    const updateSummary = () => {
        const scope = selected.size ? { kind: 'items', items: scopeItems(selected) } : null;
        const preview = scope ? selectIndexedDbArchive(archive, scope) : { databases: [] };
        const existing = new Set(localArchive.databases.flatMap(database => database.stores.flatMap(store => store.records.map(record =>
            JSON.stringify([database.name, store.name, JSON.stringify(record.key)])))));
        const incomingRecords = preview.databases.flatMap(database => database.stores.flatMap(store => store.records.map(record =>
            JSON.stringify([database.name, store.name, JSON.stringify(record.key)]))));
        const overwrites = incomingRecords.filter(key => existing.has(key)).length;
        summary.textContent = msg('indexedDbImportConfirm', { databases: preview.databases.length,
            records: incomingRecords.length, size: bytes(estimateJsonBytes(preview)),
            add: incomingRecords.length - overwrites, overwrite: overwrites });
    };
    const children = item => {
        const database = archive.databases.find(row => row.name === item.database);
        if (!database) return [];
        if (item.kind === 'database') return database.stores.map(store => ({ kind: 'store', database: database.name, store: store.name }));
        if (item.kind === 'store') {
            const store = database.stores.find(row => row.name === item.store);
            return (store?.records || []).map(record => ({ kind: 'record', database: database.name, store: store.name, keyToken: JSON.stringify(record.key) }));
        }
        return [];
    };
    const covered = item => selected.has(token(item))
        || (item.kind !== 'database' && selected.has(token({ kind: 'database', database: item.database })))
        || (item.kind === 'record' && selected.has(token({ kind: 'store', database: item.database, store: item.store })));
    function selectionState(item) {
        if (covered(item)) return { checked: true, indeterminate: false };
        const descendants = children(item);
        if (!descendants.length) return { checked: false, indeterminate: false };
        const states = descendants.map(selectionState);
        return { checked: states.every(state => state.checked), indeterminate: states.some(state => state.checked || state.indeterminate) };
    }
    function addSelection(item, enabled) {
        const id = token(item);
        const dbToken = token({ kind: 'database', database: item.database });
        const storeToken = token({ kind: 'store', database: item.database, store: item.store });
        if (!enabled) {
            if (item.kind === 'database') {
                for (const key of [...selected.keys()]) if (JSON.parse(key).database === item.database) selected.delete(key);
            } else if (item.kind === 'store') {
                const databaseWasSelected = selected.has(dbToken);
                selected.delete(dbToken);
                for (const key of [...selected.keys()]) {
                    const existing = JSON.parse(key);
                    if (existing.database === item.database && existing.store === item.store) selected.delete(key);
                }
                if (databaseWasSelected) for (const sibling of children({ kind: 'database', database: item.database })) {
                    if (sibling.store !== item.store) selected.set(token(sibling), sibling);
                }
            } else {
                const databaseWasSelected = selected.has(dbToken);
                const storeWasSelected = selected.has(storeToken);
                selected.delete(dbToken); selected.delete(storeToken); selected.delete(id);
                if (databaseWasSelected) for (const sibling of children({ kind: 'database', database: item.database })) {
                    if (sibling.store !== item.store) selected.set(token(sibling), sibling);
                }
                if (databaseWasSelected || storeWasSelected) for (const sibling of children({ kind: 'store', database: item.database, store: item.store })) {
                    if (sibling.keyToken !== item.keyToken) selected.set(token(sibling), sibling);
                }
            }
        } else {
            if (item.kind === 'database') {
                for (const key of [...selected.keys()]) if (JSON.parse(key).database === item.database) selected.delete(key);
            } else {
                selected.delete(dbToken);
                if (item.kind === 'record') selected.delete(storeToken);
                for (const key of [...selected.keys()]) {
                    const existing = JSON.parse(key);
                    if (existing.database === item.database && (item.kind === 'store' || existing.store === item.store)) selected.delete(key);
                }
            }
            selected.set(id, item);
        }
        render();
    }
    function render() {
        tree.replaceChildren();
        for (const database of archive.databases) {
            const dbItem = { kind: 'database', database: database.name };
            const dbDetails = element('details', undefined, 'dss_idb_database'); dbDetails.open = true;
            const dbSummary = element('summary');
            const dbState = selectionState(dbItem);
            const dbCheck = element('input'); dbCheck.type = 'checkbox'; dbCheck.checked = dbState.checked; dbCheck.indeterminate = dbState.indeterminate;
            dbCheck.addEventListener('click', event => event.stopPropagation());
            dbCheck.addEventListener('change', () => addSelection(dbItem, dbCheck.checked));
            dbSummary.append(dbCheck, element('strong', database.name), element('small', ` · ${database.stores.length} ${msg('indexedDbStores')}`));
            dbDetails.append(dbSummary);
            for (const store of database.stores) {
                const storeItem = { kind: 'store', database: database.name, store: store.name };
                const storeId = token(storeItem);
                const storeDetails = element('details', undefined, 'dss_idb_store'); storeDetails.open = expandedStores.has(storeId);
                storeDetails.addEventListener('toggle', () => {
                    if (storeDetails.open) expandedStores.add(storeId);
                    else expandedStores.delete(storeId);
                });
                const storeSummary = element('summary');
                const storeState = selectionState(storeItem);
                const storeCheck = element('input'); storeCheck.type = 'checkbox'; storeCheck.checked = storeState.checked; storeCheck.indeterminate = storeState.indeterminate;
                storeCheck.addEventListener('click', event => event.stopPropagation());
                storeCheck.addEventListener('change', () => addSelection(storeItem, storeCheck.checked));
                storeSummary.append(storeCheck, element('span', store.name), element('small', ` · ${store.records.length} ${msg('indexedDbRecords')}`));
                storeDetails.append(storeSummary);
                const limit = recordLimits.get(storeId) || 200;
                const renderedRecords = storeDetails.open ? store.records.slice(0, limit) : [];
                for (const record of renderedRecords) {
                    const item = { kind: 'record', database: database.name, store: store.name, keyToken: JSON.stringify(record.key) };
                    const row = element('label', undefined, 'dss_idb_record');
                    const check = element('input'); check.type = 'checkbox'; check.checked = covered(item);
                    check.addEventListener('change', () => addSelection(item, check.checked));
                    row.append(check, element('span', keyLabel(record.key)), element('small', msg('indexedDbFileType')));
                    storeDetails.append(row);
                }
                if (storeDetails.open && store.records.length > renderedRecords.length) {
                    storeDetails.append(button(msg('indexedDbLoadMore', { count: store.records.length - renderedRecords.length }), () => {
                        recordLimits.set(storeId, limit + 200);
                        render();
                    }));
                }
                dbDetails.append(storeDetails);
            }
            tree.append(dbDetails);
        }
        updateSummary();
    }
    controls.append(button(msg('selectAll'), () => {
        selected.clear();
        for (const database of archive.databases) {
            const item = { kind: 'database', database: database.name };
            selected.set(token(item), item);
        }
        render();
    }), button(msg('clearSelection'), () => { selected.clear(); render(); }));
    view.append(element('p', msg('indexedDbImportPreview'), 'dss_note'), controls, summary, tree);
    render();
    const popup = new Popup(view, POPUP_TYPE.CONFIRM, '', { large: true, wide: true, allowVerticalScrolling: true,
        okButton: msg('apply'), cancelButton: msg('cancel') });
    popup.dlg.classList.add('dss_dialog');
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE || !selected.size) return null;
    const scope = { kind: 'items', items: scopeItems(selected) };
    return { archive: selectIndexedDbArchive(archive, scope), expectedHash: await api.hashIndexedDb(selectIndexedDbArchive(localArchive, scope)) };
}

export async function renderIndexedDbManager({ api, content, status, guard, refresh }) {
    content.replaceChildren();
    status.classList.remove('dss_error');
    status.textContent = msg('indexedDbScanning');
    let archive;
    try { archive = await api.snapshotIndexedDb({ kind: 'all' }, { allowOversize: true, tolerateUnsupported: true }); }
    catch (error) { status.textContent = errorText(error); status.classList.add('dss_error'); return; }
    if (!archive.databases.length) {
        status.textContent = msg('indexedDbNoDatabases');
        content.append(element('p', msg('indexedDbEnumerationHint'), 'dss_note'));
        return;
    }
    const archiveSize = estimateJsonBytes(archive);
    const recordSizes = new Map();
    for (const database of archive.databases) for (const store of database.stores) for (const record of store.records) {
        recordSizes.set(JSON.stringify([database.name, store.name, JSON.stringify(record.key)]), recordBytes(record));
    }
    const sizeOf = (database, store, record) => recordSizes.get(JSON.stringify([database, store, JSON.stringify(record.key)])) || 0;
    const unsupportedValues = archive.databases.reduce((sum, database) => sum + database.stores.reduce((part, store) =>
        part + store.records.filter(record => record.value?.$type === 'unsupported-display').length, 0), 0);

    const toolbar = element('div', undefined, 'dss_toolbar');
    const search = element('input', undefined, 'text_pole'); search.type = 'search'; search.placeholder = msg('indexedDbSearch');
    const selected = new Map();
    const expandedStores = new Set();
    const recordLimits = new Map();
    const list = element('div', undefined, 'dss_idb_tree');
    const summary = element('p', undefined, 'dss_summary');
    const quota = element('p', undefined, 'dss_note');
    const selectedScope = api.indexedDbScope();
    if (selectedScope.kind === 'databases') for (const database of selectedScope.names) {
        const item = { kind: 'database', database }; selected.set(token(item), item);
    }
    if (selectedScope.kind === 'items') for (const saved of selectedScope.items) {
        const item = saved.store === undefined ? { kind: 'database', database: saved.database }
            : saved.keyToken === undefined ? { kind: 'store', database: saved.database, store: saved.store }
                : { kind: 'record', database: saved.database, store: saved.store, keyToken: saved.keyToken };
        selected.set(token(item), item);
    }
    try {
        const total = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
        quota.textContent = msg('indexedDbQuota', { usage: total?.usage ? bytes(total.usage) : '—', quota: total?.quota ? bytes(total.quota) : '—' });
    } catch { quota.textContent = msg('indexedDbQuota', { usage: '—', quota: '—' }); }

    function nodeIsCovered(item) {
        if (selected.has(token(item))) return true;
        if (item.kind !== 'database' && selected.has(token({ kind: 'database', database: item.database }))) return true;
        return item.kind === 'record' && selected.has(token({ kind: 'store', database: item.database, store: item.store }));
    }
    function directChildren(item) {
        const database = archive.databases.find(row => row.name === item.database);
        if (!database) return [];
        if (item.kind === 'database') return database.stores.map(store => ({ kind: 'store', database: database.name, store: store.name }));
        if (item.kind === 'store') {
            const store = database.stores.find(row => row.name === item.store);
            return (store?.records || []).map(record => ({ kind: 'record', database: database.name, store: store.name, keyToken: JSON.stringify(record.key) }));
        }
        return [];
    }
    function selectionState(item) {
        if (nodeIsCovered(item)) return { checked: true, indeterminate: false };
        const children = directChildren(item);
        if (!children.length) return { checked: false, indeterminate: false };
        const states = children.map(selectionState);
        return {
            checked: states.every(state => state.checked),
            indeterminate: states.some(state => state.checked || state.indeterminate),
        };
    }
    function addSelection(item, enabled) {
        const id = token(item);
        if (!enabled) {
            const dbToken = token({ kind: 'database', database: item.database });
            const storeToken = token({ kind: 'store', database: item.database, store: item.store });
            if (item.kind === 'database') {
                for (const key of [...selected.keys()]) if (JSON.parse(key).database === item.database) selected.delete(key);
            } else if (item.kind === 'store') {
                const databaseWasSelected = selected.has(dbToken);
                selected.delete(dbToken);
                for (const key of [...selected.keys()]) {
                    const existing = JSON.parse(key);
                    if (existing.database === item.database && existing.store === item.store) selected.delete(key);
                }
                if (databaseWasSelected) for (const sibling of directChildren({ kind: 'database', database: item.database })) {
                    if (sibling.store !== item.store) selected.set(token(sibling), sibling);
                }
            } else {
                const databaseWasSelected = selected.has(dbToken);
                const storeWasSelected = selected.has(storeToken);
                selected.delete(dbToken); selected.delete(storeToken); selected.delete(id);
                if (databaseWasSelected) {
                    for (const sibling of directChildren({ kind: 'database', database: item.database })) {
                        if (sibling.store !== item.store) selected.set(token(sibling), sibling);
                    }
                }
                if (databaseWasSelected || storeWasSelected) for (const sibling of directChildren({ kind: 'store', database: item.database, store: item.store })) {
                    if (sibling.keyToken !== item.keyToken) selected.set(token(sibling), sibling);
                }
            }
        } else {
            if (item.kind === 'database') {
                for (const key of [...selected.keys()]) if (JSON.parse(key).database === item.database) selected.delete(key);
            } else {
                selected.delete(token({ kind: 'database', database: item.database }));
                if (item.kind === 'record') selected.delete(token({ kind: 'store', database: item.database, store: item.store }));
                for (const key of [...selected.keys()]) {
                    const existing = JSON.parse(key);
                    if (existing.database === item.database && (item.kind === 'store' || existing.store === item.store)) selected.delete(key);
                }
            }
            selected.set(id, item);
        }
        renderTree();
    }
    function renderTree() {
        list.replaceChildren();
        let shownRecords = 0, allRecords = 0;
        for (const database of archive.databases) {
            const dbItem = { kind: 'database', database: database.name };
            const dbDetails = element('details', undefined, 'dss_idb_database');
            dbDetails.open = true;
            const dbSummary = element('summary');
            const dbState = selectionState(dbItem);
            const dbCheck = element('input'); dbCheck.type = 'checkbox'; dbCheck.checked = dbState.checked; dbCheck.indeterminate = dbState.indeterminate;
            dbCheck.addEventListener('click', event => event.stopPropagation());
            dbCheck.addEventListener('change', () => addSelection(dbItem, dbCheck.checked));
            const databaseBytes = database.stores.reduce((sum, store) => sum + store.records.reduce((part, record) => part + sizeOf(database.name, store.name, record), 0), 0);
            dbSummary.append(dbCheck, element('strong', database.name), element('small', ` · v${database.version} · ${database.stores.length} ${msg('indexedDbStores')} · ${bytes(databaseBytes)}`));
            dbDetails.append(dbSummary);
            for (const store of database.stores) {
                const storeItem = { kind: 'store', database: database.name, store: store.name };
                const storeId = token(storeItem);
                const storeDetails = element('details', undefined, 'dss_idb_store');
                storeDetails.open = expandedStores.has(storeId) || Boolean(search.value);
                storeDetails.addEventListener('toggle', () => {
                    if (search.value) return;
                    if (storeDetails.open) expandedStores.add(storeId);
                    else expandedStores.delete(storeId);
                });
                const storeSummary = element('summary');
                const storeState = selectionState(storeItem);
                const storeCheck = element('input'); storeCheck.type = 'checkbox'; storeCheck.checked = storeState.checked; storeCheck.indeterminate = storeState.indeterminate;
                storeCheck.addEventListener('click', event => event.stopPropagation());
                storeCheck.addEventListener('change', () => addSelection(storeItem, storeCheck.checked));
                const storeBytes = store.records.reduce((sum, record) => sum + sizeOf(database.name, store.name, record), 0);
                storeSummary.append(storeCheck, element('span', store.name), element('small', ` · ${store.records.length} ${msg('indexedDbRecords')} · ${bytes(storeBytes)}`));
                storeDetails.append(storeSummary);
                allRecords += store.records.length;
                const matchingRecords = store.records.filter(record => {
                    if (!search.value) return true;
                    const labelText = `${keyLabel(record.key)} · ${bytes(sizeOf(database.name, store.name, record))}`;
                    return `${database.name} ${store.name} ${labelText}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase());
                });
                const limit = recordLimits.get(storeId) || 200;
                const renderedRecords = storeDetails.open ? matchingRecords.slice(0, limit) : [];
                for (const record of renderedRecords) {
                    shownRecords += 1;
                    const labelText = `${keyLabel(record.key)} · ${bytes(sizeOf(database.name, store.name, record))}`;
                    const item = { kind: 'record', database: database.name, store: store.name, keyToken: JSON.stringify(record.key) };
                    const row = element('label', undefined, 'dss_idb_record');
                    const check = element('input'); check.type = 'checkbox'; check.checked = nodeIsCovered(item);
                    check.addEventListener('change', () => addSelection(item, check.checked));
                    row.append(check, element('span', labelText), element('small', msg('indexedDbFileType')));
                    storeDetails.append(row);
                }
                if (storeDetails.open && matchingRecords.length > renderedRecords.length) {
                    storeDetails.append(button(msg('indexedDbLoadMore', { count: matchingRecords.length - renderedRecords.length }), () => {
                        recordLimits.set(storeId, limit + 200);
                        renderTree();
                    }));
                }
                dbDetails.append(storeDetails);
            }
            list.append(dbDetails);
        }
        summary.textContent = msg('indexedDbSummary', { databases: archive.databases.length, count: allRecords,
            size: bytes(archiveSize), selected: selected.size, visible: shownRecords });
    }
    search.addEventListener('input', renderTree);
    toolbar.append(search,
        button(msg('indexedDbSelectAll'), () => { selected.clear(); archive.databases.forEach(db => selected.set(token({ kind: 'database', database: db.name }), { kind: 'database', database: db.name })); renderTree(); }),
        button(msg('clearSelection'), () => { selected.clear(); renderTree(); }),
        button(msg('rescan'), () => guard(async () => { await refresh('indexeddb'); })));
    const actions = element('div', undefined, 'dss_toolbar');
    actions.append(
        button(msg('exportAll'), () => guard(async () => download(await api.snapshotIndexedDb({ kind: 'all' }), `indexedDB-${new Date().toISOString().slice(0, 10)}.json`))),
        button(msg('exportSelected'), () => guard(async () => {
            if (!selected.size) throw { code: 'indexedDbScopeEmpty' };
            const archivePart = await api.snapshotIndexedDb({ kind: 'items', items: scopeItems(selected) });
            download(archivePart, `indexedDB-selected-${new Date().toISOString().slice(0, 10)}.json`);
        })),
        button(msg('importFile'), () => {
            const input = element('input'); input.type = 'file'; input.accept = '.json,application/json';
            input.addEventListener('change', () => guard(async () => {
                const file = input.files?.[0]; if (!file) return;
                if (file.size > MAX_INDEXEDDB_ARCHIVE_BYTES) throw { code: 'indexedDbArchiveTooLarge' };
                const incoming = parseIndexedDbArchive(await file.text());
                const selection = await chooseImportScope(incoming, archive);
                if (!selection) return;
                const records = recordCount(selection.archive);
                await api.importIndexedDb(selection.archive, 'import', selection.expectedHash);
                status.textContent = msg('indexedDbImportSuccess', { count: records });
                await refresh('indexeddb');
            }), { once: true }); input.click();
        }),
        button(msg('remove'), () => guard(async () => {
            if (!selected.size) throw { code: 'indexedDbScopeEmpty' };
            const scope = { kind: 'items', items: scopeItems(selected) };
            const exact = []; let selectedBytes = 0;
            for (const db of archive.databases) for (const store of db.stores) for (const record of store.records) {
                const tokenRecord = { database: db.name, store: store.name, keyToken: JSON.stringify(record.key) };
                const matches = scope.items.some(item => item.database === db.name && (item.store === undefined || item.store === store.name)
                    && (item.keyToken === undefined || item.keyToken === tokenRecord.keyToken));
                if (matches) {
                    exact.push({ database: db.name, store: store.name, keyToken: tokenRecord.keyToken });
                    selectedBytes += recordBytes(record);
                }
            }
            if (!exact.length) return;
            const answer = await new Popup(msg('indexedDbRemoveConfirm', { count: exact.length, size: bytes(selectedBytes) }), POPUP_TYPE.CONFIRM, '', {
                okButton: msg('remove'), cancelButton: msg('cancel'), allowVerticalScrolling: true,
            }).show();
            if (answer !== POPUP_RESULT.AFFIRMATIVE) return;
            await api.removeIndexedDb(exact);
            status.textContent = msg('indexedDbRemoveSuccess', { count: exact.length });
            await refresh('indexeddb');
        })),
        button(msg('useAsSyncScope'), () => guard(async () => {
            if (!selected.size) throw { code: 'indexedDbScopeEmpty' };
            await api.setIndexedDbScope({ kind: 'items', items: scopeItems(selected) });
            status.textContent = msg('indexedDbScopeSaved', { count: selected.size });
        })));
    content.append(element('p', msg('indexedDbHelp'), 'dss_note'));
    if (unsupportedValues) content.append(element('p', msg('indexedDbUnsupportedDisplay', { count: unsupportedValues }), 'dss_note'));
    content.append(quota, toolbar, actions, summary, list);
    renderTree();
}

export async function renderIndexedDbBackups({ api, content, status, guard, refresh }) {
    content.replaceChildren();
    status.classList.remove('dss_error');
    status.textContent = '';
    content.append(element('p', msg('indexedDbBackupHelp'), 'dss_note'));
    const records = await api.listIndexedDbBackups();
    for (let index = 0; index < 5; index += 1) {
        const record = records[index];
        const card = element('section', undefined, 'dss_backup_card');
        card.append(element('h4', msg('slot', { number: index + 1 })));
        if (!record) card.append(element('p', msg('backupEmpty')));
        else {
            card.append(element('p', msg('indexedDbBackupMeta', {
                date: new Date(record.createdAt).toLocaleString(), reason: msg('reason' + record.reason[0].toUpperCase() + record.reason.slice(1)),
                device: record.source?.deviceId?.slice(-8) || record.source?.origin || '—',
                databases: record.databases, stores: record.stores, records: record.records, size: bytes(record.fileBytes),
            })));
            const actions = element('div', undefined, 'dss_toolbar');
            actions.append(button(msg('export'), () => guard(async () => download(await api.getIndexedDbBackup(record.id), `indexedDB-backup-${record.createdAt.slice(0, 10)}.json`))),
                button(msg('restore'), () => guard(async () => {
                    const archive = await api.getIndexedDbBackup(record.id);
                    const answer = await new Popup(msg('indexedDbRestoreConfirm', { count: record.records, size: bytes(record.fileBytes) }), POPUP_TYPE.CONFIRM, '', {
                        okButton: msg('restore'), cancelButton: msg('cancel'), allowVerticalScrolling: true,
                    }).show();
                    if (answer !== POPUP_RESULT.AFFIRMATIVE) return;
                    await api.importIndexedDb(archive, 'restore');
                    status.textContent = msg('indexedDbImportSuccess', { count: record.records });
                    await refresh('indexeddbBackups');
                })));
            card.append(actions);
        }
        content.append(card);
    }
}
