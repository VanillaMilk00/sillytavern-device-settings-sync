import { getRequestHeaders, saveSettings, saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { getCurrentUserHandle } from '../../../user.js';
import { extension_settings } from '../../../extensions.js';
import { translate } from '../../../i18n.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import { DEFAULT_MAX_VALUE_BYTES, parseAdditionalExcludes } from './lib/filter.js';
import { readStorage, createArchive, serializeArchive, totalBytes, assertUnchanged, applyPlan, StorageError, isInternalKey } from './lib/storage-model.js';
import { msg, errorText, bytes } from './lib/messages.js';
import { openStorageManager } from './ui/storage-manager.js';
import { probeCapacity } from './lib/capacity-probe.js';
import { AutoSync } from './lib/auto-sync.js';
import { IndexedDbError, snapshotIndexedDB, serializeIndexedDbArchive, mergeIndexedDbArchive, mergeArchiveObjects, deleteIndexedDbItems, selectIndexedDbArchive } from './lib/indexeddb-model.js';
import { uploadIndexedDbArchive, downloadIndexedDbArchive, digestHex } from './lib/indexeddb-transfer.js';
import { AUTO_PREFIX, planRemote, sortedEntries } from './lib/auto-core.js';
import {
    applyServerState,
    diffSnapshots,
    serverStateToPortableValues,
    snapshotPortableStorage,
} from './lib/sync-core.js';

const VERSION = '1.8.1';
const SETTINGS_KEY = 'deviceSettingsSync';
const API_BASE = '/api/plugins/device-settings-sync';
const DEVICE_KEY = 'sillytavern_settings_sync_device_id';
const PULL_RESULT_KEY = 'sillytavern_settings_sync_manual_pull_result';
const OBSOLETE_SETTINGS = ['enabled', 'pollSeconds', 'autoReloadInitial', 'autoReloadRemote'];
const DEFAULT_SETTINGS = Object.freeze({
    mode: 'manual',
    maxValueBytes: DEFAULT_MAX_VALUE_BYTES,
    additionalExcludes: '',
    backupBeforeChanges: true,
});

const diagnostics = {
    version: VERSION,
    mode: 'manual',
    status: 'manual-ready',
    revision: 0,
    portableKeys: 0,
    excludedKeys: 0,
    fullStorage: false,
    pushedMutations: 0,
    pulledChanges: 0,
    failedWrites: 0,
    lastAction: '',
    lastSyncAt: '',
    lastError: '',
};

let operationInFlight = false;
let managerOpen = false;
let settingsOpen = false;
let provisionalDeviceId;
let automatic;

function tr(key, fallback) {
    return translate(fallback, key);
}

function formatText(key, fallback, values) {
    return tr(key, fallback).replace(/\{(\w+)\}/gu, (match, name) => (
        Object.hasOwn(values, name) ? String(values[name]) : match
    ));
}

function randomId(prefix) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `${prefix}_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function getDeviceId(persist = true) {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[a-zA-Z0-9_-]{8,80}$/u.test(id)) {
        id = provisionalDeviceId ||= randomId('device');
        if (persist) localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
}

function getSettings() {
    const existing = extension_settings[SETTINGS_KEY];
    const settings = existing && typeof existing === 'object' ? existing : {};

    // Migrate old automatic-sync options in memory. They are persisted only after
    // a user action, so merely loading the page never triggers a settings save.
    for (const key of OBSOLETE_SETTINGS) delete settings[key];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) settings[key] = value;
    }
    settings.mode = 'manual';
    settings.maxValueBytes = Math.min(
        256 * 1024,
        Math.max(1024, Number(settings.maxValueBytes) || DEFAULT_MAX_VALUE_BYTES),
    );
    extension_settings[SETTINGS_KEY] = settings;
    return settings;
}

function fullStorageKey() { return AUTO_PREFIX + encodeURIComponent(getCurrentUserHandle() || '') + ':localstorage-mode'; }
function localStorageMode() {
    const value = localStorage.getItem(fullStorageKey());
    if (['portable', 'selected', 'full'].includes(value)) return value;
    const legacy = localStorage.getItem(AUTO_PREFIX + encodeURIComponent(getCurrentUserHandle() || '') + ':full-mode');
    return legacy === '1' ? 'full' : 'portable';
}
function selectedScopeKey() { return AUTO_PREFIX + encodeURIComponent(getCurrentUserHandle() || '') + ':localstorage-scope'; }
function selectedStorageScope() {
    try {
        const scope = JSON.parse(localStorage.getItem(selectedScopeKey()) || 'null');
        if (scope?.kind === 'prefix' && typeof scope.prefix === 'string' && scope.prefix.length) return scope;
        if (scope?.kind === 'keys' && Array.isArray(scope.keys)) {
            const keys = [...new Set(scope.keys.filter(key => typeof key === 'string' && !isInternalKey(key)))];
            return { kind: 'keys', keys };
        }
    } catch { /* An invalid scope must never broaden synchronization. */ }
    return { kind: 'keys', keys: [] };
}

function filterOptions() {
    const settings = getSettings();
    const mode = localStorageMode();
    const fullStorage = mode === 'full';
    const selectedScope = mode === 'selected' ? selectedStorageScope() : null;
    return {
        maxValueBytes: settings.maxValueBytes,
        additionalExcludes: fullStorage || selectedScope ? [] : parseAdditionalExcludes(settings.additionalExcludes),
        fullStorage,
        selectedScope,
        selectedScopeConfigured: mode !== 'selected' || selectedScopeKeyExists(),
    };
}

function selectedScopeKeyExists() {
    const scope = selectedStorageScope();
    return scope.kind === 'prefix' ? scope.prefix.length > 0 : scope.keys.length > 0;
}

function indexedDbConfigKey() { return AUTO_PREFIX + encodeURIComponent(getCurrentUserHandle() || '') + ':indexeddb-config'; }
function indexedDbScopeKey() { return AUTO_PREFIX + encodeURIComponent(getCurrentUserHandle() || '') + ':indexeddb-scope'; }
function indexedDbConfig() {
    try {
        const value = JSON.parse(localStorage.getItem(indexedDbConfigKey()) || 'null');
        return { enabled: value?.enabled === true, scopeMode: value?.scopeMode === 'all' ? 'all' : 'selected' };
    } catch { return { enabled: false, scopeMode: 'selected' }; }
}
function selectedIndexedDbScope() {
    try {
        const scope = JSON.parse(localStorage.getItem(indexedDbScopeKey()) || 'null');
        if (scope?.kind === 'databases' && Array.isArray(scope.names)) return { kind: 'databases', names: [...new Set(scope.names.filter(name => typeof name === 'string'))] };
        if (scope?.kind === 'items' && Array.isArray(scope.items)) return { kind: 'items', items: scope.items.filter(item => item
            && typeof item.database === 'string' && (item.store === undefined || typeof item.store === 'string')
            && (item.keyToken === undefined || typeof item.keyToken === 'string')) };
    } catch { /* Invalid selection stays empty instead of expanding to all databases. */ }
    return { kind: 'items', items: [] };
}
function indexedDbScope() {
    return indexedDbConfig().scopeMode === 'all' ? { kind: 'all' } : selectedIndexedDbScope();
}
function indexedDbScopeConfigured(scope = indexedDbScope()) {
    return scope.kind === 'all' || (scope.kind === 'databases' && scope.names.length > 0)
        || (scope.kind === 'items' && scope.items.length > 0);
}
function indexedDbBaselineKey() { return AUTO_PREFIX + encodeURIComponent(getCurrentUserHandle() || '') + ':indexeddb-baseline'; }
function indexedDbCommitIntentKey() { return AUTO_PREFIX + encodeURIComponent(getCurrentUserHandle() || '') + ':indexeddb-commit-intent'; }
function indexedDbBackupIntentKey() { return AUTO_PREFIX + encodeURIComponent(getCurrentUserHandle() || '') + ':indexeddb-backup-intent'; }
function readIndexedDbBaseline() {
    try { return JSON.parse(localStorage.getItem(indexedDbBaselineKey()) || 'null'); } catch { return null; }
}
function writeIndexedDbBaseline(value) { localStorage.setItem(indexedDbBaselineKey(), JSON.stringify(value)); }
function indexedDbArchiveCount(archive) {
    return archive.databases.reduce((sum, db) => sum + db.stores.reduce((storeSum, store) => storeSum + store.records.length, 0), 0);
}
async function indexedDbArchiveHash(archive) {
    const stable = { ...archive, createdAt: '' };
    return digestHex(new TextEncoder().encode(serializeIndexedDbArchive(stable)));
}
async function indexedDbSyncHash(archive) {
    // Native database versions are device-local migration counters. The
    // transferable schema (stores/indexes) is fingerprinted separately, so a
    // harmless version-number difference does not create a false conflict.
    const stable = { ...archive, createdAt: '', databases: archive.databases.map(({ version, ...database }) => database) };
    return digestHex(new TextEncoder().encode(serializeIndexedDbArchive(stable)));
}
async function backupIndexedDbArchive(archive, reason) {
    const archiveHash = await indexedDbArchiveHash(archive);
    let intent;
    try { intent = JSON.parse(localStorage.getItem(indexedDbBackupIntentKey()) || 'null'); } catch { intent = null; }
    if (!intent || intent.reason !== reason || intent.archiveHash !== archiveHash) {
        intent = { reason, archiveHash, operationId: randomId('idb_backup') };
        localStorage.setItem(indexedDbBackupIntentKey(), JSON.stringify(intent));
    }
    const submit = async () => {
        try {
            return await uploadIndexedDbArchive(request, archive, { kind: 'backup', reason, operationId: intent.operationId, source: archiveSource() });
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            return uploadIndexedDbArchive(request, archive, { kind: 'backup', reason, operationId: intent.operationId, source: archiveSource() });
        }
    };
    let result = await submit();
    // An uncertain retry can arrive after five newer backups have evicted the
    // original slot. Do not proceed as if a rescue snapshot still existed.
    if (result.retained === false) {
        intent = { reason, archiveHash, operationId: randomId('idb_backup') };
        localStorage.setItem(indexedDbBackupIntentKey(), JSON.stringify(intent));
        result = await submit();
    }
    if (result.retained === false) throw new IndexedDbError('indexedDbBackupNotFound');
    localStorage.removeItem(indexedDbBackupIntentKey());
    return result;
}
async function fetchIndexedDbState() {
    return downloadIndexedDbArchive(request, { metadataPath: '/indexeddb/state', chunkPath: index => `/indexeddb/state/chunks/${index}` });
}

function indexedDbScopeContains(scope, database, store, keyToken) {
    if (!scope || scope.kind === 'all') return true;
    if (scope.kind === 'databases') return scope.names.includes(database);
    return scope.kind === 'items' && scope.items.some(item => item.database === database
        && (item.store === undefined || item.store === store) && (item.keyToken === undefined || item.keyToken === keyToken));
}

async function rollbackIndexedDbSnapshot(before, scope) {
    const current = await snapshotIndexedDB({ scope, allowOversize: true, tolerateUnsupported: true });
    const previous = new Set(before.databases.flatMap(database => database.stores.flatMap(store => store.records.map(record =>
        JSON.stringify([database.name, store.name, JSON.stringify(record.key)])))));
    const additions = current.databases.flatMap(database => database.stores.flatMap(store => store.records
        .filter(record => indexedDbScopeContains(scope, database.name, store.name, JSON.stringify(record.key))
            && !previous.has(JSON.stringify([database.name, store.name, JSON.stringify(record.key)])))
        .map(record => ({ database: database.name, store: store.name, keyToken: JSON.stringify(record.key) }))));
    if (additions.length) await deleteIndexedDbItems(additions);
    await mergeIndexedDbArchive(before, { scope });
    const restored = await snapshotIndexedDB({ scope, allowOversize: true, tolerateUnsupported: true });
    const schema = archive => JSON.stringify(archive.databases.map(database => ({ name: database.name, stores: database.stores.map(store => ({
        name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: store.indexes,
    })) })));
    if (schema(before) !== schema(restored)) throw new IndexedDbError('indexedDbRollbackFailed', { reason: 'schema-cannot-be-removed' });
}

async function syncIndexedDb(direction, { automaticRun = false, force = false, scopeOverride, onApplied, onBeforeApply } = {}) {
    if (!indexedDbConfig().enabled && !force) return { skipped: 'disabled' };
    if (!['upload', 'download'].includes(direction)) throw new IndexedDbError('indexedDbInvalidTransfer');
    const scope = scopeOverride || indexedDbScope();
    if (!indexedDbScopeConfigured(scope)) throw new IndexedDbError('indexedDbScopeEmpty');
    const health = await request('/health');
    if (!health.capabilities?.includes('indexeddb-sync-v1') || !health.capabilities?.includes('indexeddb-chunks-v1')) throw new IndexedDbError('indexedDbBackendMissing');
    const before = await snapshotIndexedDB({ scope: { kind: 'all' } });
    const local = selectIndexedDbArchive(before, scope);
    const remoteTransfer = await fetchIndexedDbState();
    const remote = selectIndexedDbArchive(remoteTransfer.archive, scope);
    const archiveHash = await indexedDbArchiveHash(local);
    const localHash = await indexedDbSyncHash(local);
    const remoteHash = await indexedDbSyncHash(remote);
    let baseline = readIndexedDbBaseline();
    if (baseline?.scope !== JSON.stringify(scope)) baseline = null;
    if (localHash === remoteHash) {
        writeIndexedDbBaseline({ scope: JSON.stringify(scope), localHash, remoteHash, revision: remoteTransfer.metadata.revision, updatedAt: new Date().toISOString() });
        return { skipped: 'equal' };
    }
    const localChanged = baseline ? baseline.localHash !== localHash : indexedDbArchiveCount(local) > 0;
    const remoteChanged = baseline ? baseline.remoteHash !== remoteHash : indexedDbArchiveCount(remote) > 0;

    if (automaticRun && baseline && localChanged && remoteChanged && localHash !== remoteHash) {
        const choice = await resolveAutoConflict({ local: indexedDbArchiveCount(local), remote: indexedDbArchiveCount(remote), changes: Math.max(indexedDbArchiveCount(local), indexedDbArchiveCount(remote)), indexeddb: true });
        if (choice === 'later') throw new IndexedDbError('indexedDbConflict');
        direction = choice;
    } else if (automaticRun && !baseline && localChanged && remoteChanged && localHash !== remoteHash) {
        const choice = await resolveAutoConflict({ local: indexedDbArchiveCount(local), remote: indexedDbArchiveCount(remote), changes: Math.max(indexedDbArchiveCount(local), indexedDbArchiveCount(remote)), indexeddb: true });
        if (choice === 'later') throw new IndexedDbError('indexedDbConflict');
        direction = choice;
    } else if (automaticRun && direction === 'upload' && baseline && remoteChanged && localHash !== remoteHash) {
        const choice = await resolveAutoConflict({ local: indexedDbArchiveCount(local), remote: indexedDbArchiveCount(remote), changes: Math.max(indexedDbArchiveCount(local), indexedDbArchiveCount(remote)), indexeddb: true });
        if (choice === 'later') throw new IndexedDbError('indexedDbConflict');
        direction = choice;
    } else if (automaticRun && direction === 'download' && baseline && localChanged && remoteChanged && localHash !== remoteHash) {
        const choice = await resolveAutoConflict({ local: indexedDbArchiveCount(local), remote: indexedDbArchiveCount(remote), changes: Math.max(indexedDbArchiveCount(local), indexedDbArchiveCount(remote)), indexeddb: true });
        if (choice === 'later') throw new IndexedDbError('indexedDbConflict');
        direction = choice;
    }

    if (automaticRun && direction === 'download' && baseline && localChanged && !remoteChanged) {
        // Keep the old baseline so a later automatic-upload choice still sees this local-only change.
        return { skipped: 'local-only-change' };
    }
    if (automaticRun && direction === 'upload' && !localChanged) return { skipped: 'unchanged' };
    if (automaticRun && direction === 'download' && !remoteChanged) return { skipped: 'unchanged' };
    if (automaticRun && !baseline && direction === 'upload' && indexedDbArchiveCount(local) === 0) return { skipped: 'empty' };
    if (automaticRun && !baseline && direction === 'download' && indexedDbArchiveCount(remote) === 0) return { skipped: 'empty' };

    // Preflight the post-merge archive before writing a rescue backup or
    // mutating either side. Downloads retain local-only rows, so checking only
    // the transferred server archive would miss a locally oversized result.
    const mergedPreview = direction === 'upload'
        ? mergeArchiveObjects(remoteTransfer.archive, local, scope)
        : mergeArchiveObjects(before, remoteTransfer.archive, scope);
    serializeIndexedDbArchive(mergedPreview);

    await onBeforeApply?.(direction);
    await backupIndexedDbArchive(before, direction);
    let committedRevision = remoteTransfer.metadata.revision;
    if (direction === 'upload') {
        const current = await request('/indexeddb/state');
        if (current.revision !== remoteTransfer.metadata.revision || current.digest !== remoteTransfer.metadata.digest) throw new IndexedDbError('indexedDbRevisionConflict');
        let intent;
        try { intent = JSON.parse(localStorage.getItem(indexedDbCommitIntentKey()) || 'null'); } catch { intent = null; }
        if (!intent || intent.archiveHash !== archiveHash || intent.scope !== JSON.stringify(scope)) {
            intent = { archiveHash, scope: JSON.stringify(scope), operationId: randomId('idb_commit'), expectedRevision: current.revision };
            localStorage.setItem(indexedDbCommitIntentKey(), JSON.stringify(intent));
        }
        let receipt;
        try {
            receipt = await uploadIndexedDbArchive(request, local, { kind: 'commit', reason: 'upload', operationId: intent.operationId,
                expectedRevision: intent.expectedRevision, source: archiveSource(), beforeFinish: () => onBeforeApply?.(direction) });
        } catch (error) {
            if (error instanceof TypeError) {
                try {
                    receipt = await uploadIndexedDbArchive(request, local, { kind: 'commit', reason: 'upload', operationId: intent.operationId,
                        expectedRevision: intent.expectedRevision, source: archiveSource(), beforeFinish: () => onBeforeApply?.(direction) });
                } catch (retryError) {
                    if (retryError.code === 'indexedDbRevisionConflict') localStorage.removeItem(indexedDbCommitIntentKey());
                    throw retryError;
                }
            } else {
                if (error.code === 'indexedDbRevisionConflict') localStorage.removeItem(indexedDbCommitIntentKey());
                throw error;
            }
        }
        if (receipt.revision !== intent.expectedRevision + 1
            || (current.revision !== intent.expectedRevision && current.revision !== receipt.revision)) {
            localStorage.removeItem(indexedDbCommitIntentKey());
            throw new IndexedDbError('indexedDbRevisionConflict');
        }
        committedRevision = receipt.revision;
        localStorage.removeItem(indexedDbCommitIntentKey());
    } else {
        const latest = await request('/indexeddb/state');
        if (latest.revision !== remoteTransfer.metadata.revision || latest.digest !== remoteTransfer.metadata.digest) throw new IndexedDbError('indexedDbRevisionConflict');
        await onBeforeApply?.(direction);
        try { await mergeIndexedDbArchive(remoteTransfer.archive, { scope }); }
        catch (error) {
            try { await rollbackIndexedDbSnapshot(before, scope); }
            catch (rollbackError) {
                throw new IndexedDbError('indexedDbRollbackFailed', {
                    cause: error?.code || error?.message, rollback: rollbackError?.code || rollbackError?.message,
                });
            }
            throw error;
        }
    }
    const after = direction === 'upload' ? local : await snapshotIndexedDB({ scope });
    const afterHash = direction === 'upload' ? localHash : await indexedDbSyncHash(after);
    const changed = direction === 'download' && afterHash !== localHash;
    if (changed) onApplied?.(remoteTransfer.metadata.revision);
    const remoteAfter = direction === 'upload' ? mergedPreview : remoteTransfer.archive;
    writeIndexedDbBaseline({ scope: JSON.stringify(scope), localHash: afterHash,
        remoteHash: await indexedDbSyncHash(selectIndexedDbArchive(remoteAfter, scope)), revision: committedRevision,
        updatedAt: new Date().toISOString() });
    const status = document.querySelector('#dss_indexeddb_status');
    if (status) status.textContent = msg(direction === 'upload' ? 'indexedDbUploadSuccess' : 'indexedDbDownloadSuccess', { count: indexedDbArchiveCount(after) });
    return { direction, records: indexedDbArchiveCount(after), revision: committedRevision,
        changed };
}

async function mutateIndexedDb(work, reason, scope = { kind: 'all' }, expectedHash = '') {
    return coordinated(async () => {
        if (operationInFlight) throw new StorageError('operationBusy');
        setOperationState('applying', true);
        let before, mutationStarted = false;
        try {
            const fullRescue = getSettings().backupBeforeChanges;
            before = await snapshotIndexedDB({ scope: fullRescue ? { kind: 'all' } : scope });
            if (expectedHash && await indexedDbSyncHash(selectIndexedDbArchive(before, scope)) !== expectedHash) {
                throw new IndexedDbError('indexedDbStalePreview');
            }
            if (fullRescue) await backupIndexedDbArchive(before, reason);
            mutationStarted = true;
            return await work(before);
        } catch (error) {
            if (before && mutationStarted) {
                try { await rollbackIndexedDbSnapshot(before, scope); }
                catch (rollbackError) {
                    throw new IndexedDbError('indexedDbRollbackFailed', { cause: error?.code || error?.message, rollback: rollbackError?.code || rollbackError?.message });
                }
            }
            throw error;
        } finally {
            setOperationState('manual-ready', false);
        }
    });
}

async function request(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        cache: 'no-store',
        ...options,
        headers: {
            ...getRequestHeaders(),
            ...(options.headers ?? {}),
        },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (body?.code) throw Object.assign(new StorageError(body.code, body.details || {}), { status: response.status });
        if (response.status === 404 && path.startsWith('/backups')) throw new StorageError('backupBackendMissing');
        if (response.status === 404) {
            throw Object.assign(new Error(tr(
                'dss.error.backendMissing',
                'The settings sync server plugin was not found (HTTP 404). If you installed the Docker extension for yourself, use the auto-detect installation command in the README, then restart the container.',
            )), { status: response.status });
        }
        throw Object.assign(new Error(body?.error || `Settings sync HTTP ${response.status}`), { status: response.status });
    }
    return body;
}

async function requireFullSupport() {
    const health = await request('/health');
    if (!health.capabilities?.includes('full-storage-v1')) throw new StorageError('fullBackendMissing');
}

async function requestFullState() {
    const state = await request('/full-state');
    const entries = Object.create(null);
    for (const [key, value] of Object.entries(state.entries || {})) {
        Object.defineProperty(entries, key, { enumerable: true, value: { value, deleted: false } });
    }
    return { ...state, entries };
}

async function syncRequest(path, options = {}, fullStorage = filterOptions().fullStorage) {
    if (!fullStorage && !filterOptions().selectedScope) return request(path, options);
    if (path === '/state') return requestFullState();
    if (path.startsWith('/commits/')) return request(path.replace('/commits/', '/full-commits/'), options);
    if (path === '/commit') return request('/full-commit', options);
    return request(path, options);
}

function refreshSnapshot() {
    const options = filterOptions();
    const snapshot = snapshotPortableStorage(localStorage, options);
    diagnostics.fullStorage = options.fullStorage;
    diagnostics.portableKeys = snapshot.values.size;
    diagnostics.excludedKeys = snapshot.excluded.size;
    const all = readStorage(localStorage);
    const capacity = document.querySelector('#dss_capacity');
    if (capacity) capacity.textContent = msg('capacity', { count: all.size, size: bytes(totalBytes(all)) });
    renderStatus();
    return snapshot;
}

function restorePullResult() {
    try {
        const value = sessionStorage.getItem(PULL_RESULT_KEY);
        if (!value) return;
        sessionStorage.removeItem(PULL_RESULT_KEY);
        const result = JSON.parse(value);
        diagnostics.revision = Math.max(0, Number(result.revision) || 0);
        diagnostics.pulledChanges = Math.max(0, Number(result.changed) || 0);
        diagnostics.failedWrites = Math.max(0, Number(result.failed) || 0);
        diagnostics.lastAction = 'download';
        diagnostics.lastSyncAt = String(result.at || '');
        diagnostics.lastError = [
            result.failed ? formatText('dss.error.storageWriteFailed', '{count} settings could not be written to browser storage.', { count: result.failed }) : '',
            String(result.indexedDbError || ''),
        ].filter(Boolean).join('\n');
    } catch {
        sessionStorage.removeItem(PULL_RESULT_KEY);
    }
}

function setOperationState(status, inFlight) {
    diagnostics.status = status;
    operationInFlight = inFlight;
    for (const button of document.querySelectorAll('#device_settings_sync_panel button')) {
        button.disabled = inFlight;
    }
    renderStatus();
}

function saveIndexedDbConfig(patch) {
    const value = { ...indexedDbConfig(), ...patch };
    localStorage.setItem(indexedDbConfigKey(), JSON.stringify(value));
    const enabled = document.querySelector('#dss_indexeddb_enabled');
    const mode = document.querySelector('#dss_indexeddb_scope_mode');
    if (enabled) enabled.checked = value.enabled;
    if (mode) mode.value = value.scopeMode;
}

function archiveSource() {
    return { origin: location.origin, deviceId: getDeviceId(false) };
}

function makeBackup(reason) {
    const archive = createArchive(readStorage(localStorage), { kind: 'full' }, archiveSource());
    serializeArchive(archive);
    return JSON.stringify({ operationId: randomId('operation'), reason, archive });
}

async function sendBackup(body) {
    // Keep the same operation ID and payload on a transport retry.
    try {
        return await request('/backups', { method: 'POST', body });
    } catch (error) {
        if (error instanceof TypeError) return request('/backups', { method: 'POST', body });
        throw error;
    }
}

function backupCurrentStorage(reason) { return sendBackup(makeBackup(reason)); }

async function coordinated(work) {
    try { return automatic ? await automatic.withLock(work) : await work(); }
    catch (error) {
        if (error.code === 'operationBusy') globalThis.toastr?.warning(msg('operationBusy'));
        throw error;
    }
}

function applyLocalPlan(plan, reason, options) {
    return coordinated(() => applyLocalPlanLocked(plan, reason, options));
}

async function applyLocalPlanLocked(plan, reason, { forceBackup = false } = {}) {
    if (operationInFlight) throw new StorageError('operationBusy');
    setOperationState('applying', true);
    try {
        assertUnchanged(localStorage, plan.before);
        if (forceBackup || getSettings().backupBeforeChanges) await backupCurrentStorage(reason);
        const count = applyPlan(localStorage, plan);
        refreshSnapshot();
        return count;
    } finally {
        setOperationState('manual-ready', false);
    }
}

async function showManager(initialTab = 'local') {
    if (managerOpen || operationInFlight) return;
    managerOpen = true;
    try {
        await openStorageManager({
            getSettings, filterOptions, source: archiveSource,
            setSyncScope: scope => {
                if (scope.kind === 'keys') {
                    scope = { kind: 'keys', keys: [...new Set(scope.keys.filter(key => !isInternalKey(key)))] };
                    if (!scope.keys.length) throw new StorageError('selectedScopeEmpty');
                }
                localStorage.setItem(selectedScopeKey(), JSON.stringify(scope));
                localStorage.setItem(fullStorageKey(), 'selected');
                const mode = document.querySelector('#dss_storage_mode');
                if (mode) mode.value = 'selected';
                refreshSnapshot();
            },
            snapshotIndexedDb: (scope, options) => snapshotIndexedDB({ scope, ...options }),
            indexedDbScope,
            setIndexedDbScope: scope => {
                if (scope?.kind !== 'items' || !Array.isArray(scope.items) || !scope.items.length) throw new IndexedDbError('indexedDbScopeEmpty');
                localStorage.setItem(indexedDbScopeKey(), JSON.stringify(scope));
                saveIndexedDbConfig({ scopeMode: 'selected' });
            },
            listIndexedDbBackups: () => request('/indexeddb/backups'),
            getIndexedDbBackup: async id => (await downloadIndexedDbArchive(request, {
                metadataPath: `/indexeddb/backups/${encodeURIComponent(id)}`,
                chunkPath: index => `/indexeddb/backups/${encodeURIComponent(id)}/chunks/${index}`,
            })).archive,
            importIndexedDb: (archive, reason = 'import', expectedHash = '') => mutateIndexedDb(async () => mergeIndexedDbArchive(archive, { scope: archive.scope }), reason, archive.scope, expectedHash),
            hashIndexedDb: indexedDbSyncHash,
            removeIndexedDb: items => mutateIndexedDb(async () => deleteIndexedDbItems(items), 'delete', {
                kind: 'items', items: items.map(({ database, store, keyToken }) => ({ database, store, keyToken })),
            }),
            isBusy: () => operationInFlight,
            setBackupBeforeChanges: value => { getSettings().backupBeforeChanges = value; saveSettingsDebounced(); },
            applyLocalPlan,
            measureCapacity: () => coordinated(async () => {
                if (operationInFlight) throw new StorageError('operationBusy');
                setOperationState('probing', true);
                try { return await probeCapacity(localStorage); }
                finally { setOperationState('manual-ready', false); refreshSnapshot(); }
            }),
            listBackups: () => request('/backups'),
            getBackup: id => request('/backups/' + encodeURIComponent(id)),
            onChanged: refreshSnapshot,
        }, { initialTab });
    } catch (error) {
        globalThis.toastr?.error(errorText(error), tr('dss.panel.title', 'Device Settings Sync'));
    } finally { managerOpen = false; }
}

async function confirmManualAction(title, message, okButton) {
    const result = await Popup.show.confirm(title, message, {
        okButton,
        cancelButton: tr('dss.common.cancel', 'Cancel'),
        allowVerticalScrolling: true,
    });
    return result === POPUP_RESULT.AFFIRMATIVE;
}

async function confirmManualPull() {
    const extra = indexedDbConfig().enabled ? '\n\n' + msg('indexedDbSyncConfirmation') : '';
    return confirmManualAction(
        tr('dss.pull.title', 'Sync from server'),
        (localStorageMode() === 'full' ? msg('fullPullConfirm') : localStorageMode() === 'selected' ? msg('selectedPullConfirm') : tr(
            'dss.pull.confirmMessage',
            'This will overwrite syncable settings on this device with the server settings. Local changes that have not been uploaded may be lost, and the page will reload automatically when complete. A full localStorage snapshot, including caches and credentials, will first be saved to this account on the server. Continue?',
        )) + extra,
        tr('dss.pull.confirmButton', 'Sync now'),
    );
}

async function confirmManualPush() {
    const extra = indexedDbConfig().enabled ? '\n\n' + msg('indexedDbSyncConfirmation') : '';
    return confirmManualAction(
        tr('dss.push.title', 'Upload local settings'),
        (localStorageMode() === 'full' ? msg('fullPushConfirm') : localStorageMode() === 'selected' ? msg('selectedPushConfirm') : tr(
            'dss.push.confirmMessage',
            'This will replace the server sync data with settings from this device. Portable settings that exist on the server but were deleted locally will also be deleted. A full localStorage snapshot, including caches and credentials, will first be saved to this account on the server. Continue?',
        )) + extra,
        tr('dss.push.confirmButton', 'Upload now'),
    );
}

async function manualPull(options = {}) {
    return coordinated(() => manualPullLocked(options));
}

async function manualPullLocked({ reload = true } = {}) {
    if (operationInFlight) return { ...diagnostics };
    setOperationState('downloading', true);
    try {
        const options = filterOptions();
        if (!options.selectedScopeConfigured) throw new StorageError('selectedScopeEmpty');
        if (options.fullStorage || options.selectedScope) await requireFullSupport();
        const scopedStorage = options.fullStorage || options.selectedScope;
        const original = scopedStorage ? readStorage(localStorage) : null;
        await backupCurrentStorage('download');
        const state = scopedStorage ? await requestFullState() : await request('/state');
        let result;
        if (scopedStorage) {
            const before = readStorage(localStorage);
            const sameUserData = [...original].every(([key, value]) => isInternalKey(key) || before.get(key) === value)
                && [...before].every(([key, value]) => isInternalKey(key) || original.get(key) === value);
            if (!sameUserData || JSON.stringify(filterOptions()) !== JSON.stringify(options)) throw new StorageError('stalePreview');
            const changes = planRemote(before, state, options).changes;
            result = { changed: changes.length, skipped: 0, failed: 0 };
            if (changes.length) applyPlan(localStorage, { before, changes });
        } else result = applyServerState(localStorage, state, options);
        const at = new Date().toISOString();
        diagnostics.revision = Math.max(0, Number(state.revision) || 0);
        diagnostics.pulledChanges += result.changed;
        diagnostics.failedWrites += result.failed;
        diagnostics.lastAction = 'download';
        diagnostics.lastSyncAt = at;
        diagnostics.lastError = result.failed
            ? formatText('dss.error.storageWriteFailed', '{count} settings could not be written to browser storage.', { count: result.failed })
            : '';
        refreshSnapshot();
        if (!result.failed) await automatic?.remember(snapshotPortableStorage(localStorage, options).values, state).catch(error => automatic.fatal(error));
        let indexedDbError = null;
        if (indexedDbConfig().enabled) {
            try { await syncIndexedDb('download'); }
            catch (error) {
                indexedDbError = error;
                if (!reload) throw error;
            }
        }

        if (reload) {
            sessionStorage.setItem(PULL_RESULT_KEY, JSON.stringify({
                revision: diagnostics.revision,
                changed: result.changed,
                failed: result.failed,
                indexedDbError: indexedDbError ? errorText(indexedDbError) : '',
                at,
            }));
            diagnostics.status = 'reloading';
            if (indexedDbError) diagnostics.lastError = [diagnostics.lastError, errorText(indexedDbError)].filter(Boolean).join('\n');
            renderStatus();
            if (indexedDbError) globalThis.toastr?.warning(msg('pullPartialIndexedDb', { error: errorText(indexedDbError) }), tr('dss.panel.title', 'Device Settings Sync'));
            else globalThis.toastr?.success(tr('dss.toast.pullSuccess', 'Server settings downloaded. Reloading to apply them completely.'), tr('dss.panel.title', 'Device Settings Sync'));
            setTimeout(() => location.reload(), 350);
        } else {
            setOperationState('manual-ready', false);
        }
        return { ...diagnostics };
    } catch (error) {
        diagnostics.lastError = errorText(error);
        setOperationState('error', false);
        globalThis.toastr?.error(diagnostics.lastError, tr('dss.panel.title', 'Device Settings Sync'));
        throw error;
    }
}

async function manualPush() {
    return coordinated(manualPushLocked);
}

async function manualPushLocked() {
    if (operationInFlight) return { ...diagnostics };
    setOperationState('saving', true);
    try {
        const options = filterOptions();
        if (!options.selectedScopeConfigured) throw new StorageError('selectedScopeEmpty');
        if (options.fullStorage || options.selectedScope) await requireFullSupport();
        await backupCurrentStorage('upload');
        // SillyTavern's native account settings and extension_settings live in the
        // normal account settings file. Save them first, then upload portable
        // browser-only settings in the same explicit button action.
        await saveSettings();
        if (JSON.stringify(filterOptions()) !== JSON.stringify(options)) throw new StorageError('stalePreview');
        const snapshot = refreshSnapshot();
        if (options.fullStorage || options.selectedScope) {
            const remote = await requestFullState();
            const remoteValues = serverStateToPortableValues(remote, options);
            const changes = diffSnapshots(remoteValues, snapshot.values);
                const state = changes.length || !remote.seeded
                ? await request('/full-commit', { method: 'POST', body: JSON.stringify({
                    operationId: randomId('operation'), expectedRevision: remote.revision, deviceId: getDeviceId(),
                    scope: options.selectedScope || { kind: 'full' },
                    entries: sortedEntries(snapshot.values).map(([key, value]) => ({ key, value })),
                }) }) : remote;
            diagnostics.revision = state.revision;
            diagnostics.pushedMutations += changes.length;
            if (indexedDbConfig().enabled) await syncIndexedDb('upload');
            diagnostics.lastAction = 'upload';
            diagnostics.lastSyncAt = new Date().toISOString();
            diagnostics.lastError = '';
            await automatic?.remember(snapshot.values, { ...remote, revision: state.revision,
                seeded: true, entries: Object.fromEntries([...snapshot.values].map(([key, value]) => [key, { value }])) })
                .catch(error => automatic.fatal(error));
            setOperationState('manual-ready', false);
            globalThis.toastr?.success(formatText('dss.toast.pushSuccess', 'Uploaded {count} portable settings.', { count: changes.length }));
            return { ...diagnostics };
        }
        const remote = await request('/state');
        const remoteValues = serverStateToPortableValues(remote, filterOptions());
        const mutations = diffSnapshots(remoteValues, snapshot.values);
        const chunks = [];
        for (let index = 0; index < mutations.length; index += 500) {
            chunks.push(mutations.slice(index, index + 500));
        }
        if (!chunks.length) chunks.push([]);

        let state;
        for (let index = 0; index < chunks.length; index += 1) {
            state = await request('/merge', {
                method: 'POST',
                body: JSON.stringify({
                    deviceId: getDeviceId(),
                    seed: index === 0,
                    mutations: chunks[index],
                }),
            });
        }

        diagnostics.revision = Math.max(0, Number(state?.revision) || diagnostics.revision);
        diagnostics.pushedMutations += mutations.length;
        if (indexedDbConfig().enabled) await syncIndexedDb('upload');
        diagnostics.lastAction = 'upload';
        diagnostics.lastSyncAt = new Date().toISOString();
        diagnostics.lastError = '';
        await automatic?.remember(snapshot.values, state).catch(error => automatic.fatal(error));
        setOperationState('manual-ready', false);
        globalThis.toastr?.success(
            formatText('dss.toast.pushSuccess', 'Uploaded {count} portable settings.', { count: mutations.length }),
            tr('dss.panel.title', 'Device Settings Sync'),
        );
        return { ...diagnostics };
    } catch (error) {
        diagnostics.lastError = errorText(error);
        setOperationState('error', false);
        globalThis.toastr?.error(diagnostics.lastError, tr('dss.panel.title', 'Device Settings Sync'));
        throw error;
    }
}

function renderStatus() {
    const target = document.querySelector('#dss_status');
    if (!target) return;
    const labels = {
        'manual-ready': diagnostics.mode === 'automatic' ? msg(automatic?.status || 'autoReady') : tr('dss.status.manualReady', 'Manual mode (ready)'),
        downloading: tr('dss.status.downloading', 'Downloading from server'),
        saving: tr('dss.status.saving', 'Saving and uploading'),
        reloading: tr('dss.status.reloading', 'Reloading to apply'),
        error: tr('dss.status.error', 'Error'),
        applying: msg('applying'),
        probing: msg('probing'),
    };
    const action = diagnostics.lastAction === 'upload'
        ? tr('dss.push.title', 'Upload local settings')
        : tr('dss.pull.title', 'Sync from server');
    target.textContent = [
        formatText('dss.status.line', 'Status: {status}', { status: labels[diagnostics.status] || diagnostics.status }),
        formatText(
            'dss.status.serverLine',
            'Server revision: {revision}  Syncable settings: {portable}  Excluded: {excluded}',
            {
                revision: diagnostics.revision,
                portable: diagnostics.portableKeys,
                excluded: diagnostics.excludedKeys,
            },
        ),
        diagnostics.lastAction
            ? formatText('dss.status.lastActionLine', 'Last action: {action}', { action })
            : '',
        diagnostics.lastSyncAt
            ? formatText('dss.status.lastSyncLine', 'Last manual sync: {date}', { date: new Date(diagnostics.lastSyncAt).toLocaleString() })
            : '',
        diagnostics.lastError
            ? formatText('dss.status.lastErrorLine', 'Last error: {error}', { error: diagnostics.lastError })
            : '',
    ].filter(Boolean).join('\n');
}

function bindPanel() {
    const excludes = document.querySelector('#dss_excludes');
    if (!excludes) return;
    const settings = getSettings();
    excludes.value = settings.additionalExcludes;
    const initialIdbConfig = indexedDbConfig();
    document.querySelector('#dss_indexeddb_enabled').checked = initialIdbConfig.enabled;
    document.querySelector('#dss_indexeddb_scope_mode').value = initialIdbConfig.scopeMode;
    const menu = document.querySelector('#dss_settings_menu');
    const toggle = document.querySelector('#dss_settings_toggle');
    toggle?.addEventListener('click', () => {
        excludes.value = getSettings().additionalExcludes;
        document.querySelector('#dss_storage_mode').value = localStorageMode();
        document.querySelector('#dss_before_changes').checked = getSettings().backupBeforeChanges === true;
        menu.hidden = !menu.hidden;
        settingsOpen = !menu.hidden;
        toggle.setAttribute('aria-expanded', String(settingsOpen));
        if (!settingsOpen) automatic?.configure();
    });
    const mode = document.querySelector('#dss_storage_mode');
    mode.value = localStorageMode();
    mode.addEventListener('change', async () => {
        const selected = mode.value;
        mode.disabled = true;
        try {
            if (operationInFlight || automatic?.running || automatic?.state().intent) throw new StorageError('operationBusy');
            if (selected === 'full' && !(await confirmManualAction(msg('fullStorageTitle'), msg('fullStorageConsent'), msg('fullStorageTitle')))) return;
            if (selected === 'selected' && !(await confirmManualAction(msg('selectedStorageTitle'), msg('selectedStorageConsent'), msg('selectedStorageTitle')))) return;
            localStorage.setItem(fullStorageKey(), selected);
        if (selected === 'selected' && !selectedScopeKeyExists()) globalThis.toastr?.warning(msg('selectedScopeEmpty'));
            refreshSnapshot();
            if (automatic?.prefs().download) { automatic.entry = true; automatic.configure(); }
        } catch (error) { globalThis.toastr?.error(errorText(error)); }
        finally { mode.value = localStorageMode(); mode.disabled = false; }
    });
    const before = document.querySelector('#dss_before_changes');
    before.checked = settings.backupBeforeChanges === true;
    before.addEventListener('change', () => { getSettings().backupBeforeChanges = before.checked; saveSettingsDebounced(); });

    const idbEnabled = document.querySelector('#dss_indexeddb_enabled');
    idbEnabled.addEventListener('change', async () => {
        const enabled = idbEnabled.checked;
        idbEnabled.disabled = true;
        try {
            if (enabled && !(await confirmManualAction(msg('indexedDbTitle'), msg('indexedDbConsent'), msg('indexedDbTitle')))) return;
            if (enabled) {
                const health = await request('/health');
                if (!health.capabilities?.includes('indexeddb-sync-v1') || !health.capabilities?.includes('indexeddb-chunks-v1')) {
                    throw new IndexedDbError('indexedDbBackendMissing');
                }
                if (!indexedDbScopeConfigured()) {
                    showManager('indexeddb').catch(error => globalThis.toastr?.error(errorText(error)));
                    throw new IndexedDbError('indexedDbScopeEmpty');
                }
            }
            saveIndexedDbConfig({ enabled });
        } catch (error) { globalThis.toastr?.error(errorText(error)); }
        finally { idbEnabled.disabled = false; idbEnabled.checked = indexedDbConfig().enabled; }
    });
    const idbScopeMode = document.querySelector('#dss_indexeddb_scope_mode');
    idbScopeMode.addEventListener('change', () => {
        const scopeMode = idbScopeMode.value === 'all' ? 'all' : 'selected';
        if (scopeMode === 'selected' && !indexedDbScopeConfigured(selectedIndexedDbScope())) {
            saveIndexedDbConfig({ scopeMode, enabled: false });
            globalThis.toastr?.warning(msg('indexedDbScopeEmpty'));
            showManager('indexeddb').catch(error => globalThis.toastr?.error(errorText(error)));
            return;
        }
        saveIndexedDbConfig({ scopeMode });
    });

    excludes.addEventListener('change', () => {
        getSettings().additionalExcludes = excludes.value;
        saveSettingsDebounced();
        refreshSnapshot();
    });
    document.querySelector('#dss_pull')?.addEventListener('click', async () => {
        if (await confirmManualPull()) manualPull().catch(() => {});
    });
    document.querySelector('#dss_push')?.addEventListener('click', async () => {
        if (await confirmManualPush()) manualPush().catch(() => {});
    });
    document.querySelector('#dss_manage')?.addEventListener('click', showManager);
    document.querySelector('#dss_idb_manage')?.addEventListener('click', () => showManager('indexeddb'));
    document.querySelector('#dss_reload')?.addEventListener('click', () => location.reload());
    document.querySelector('#dss_copy')?.addEventListener('click', async () => {
        const safe = { ...diagnostics, automatic: automatic?.describe(), device: getDeviceId(false).slice(-8) };
        await navigator.clipboard.writeText(JSON.stringify(safe, null, 2));
        globalThis.toastr?.success(
            tr('dss.toast.copySuccess', 'Diagnostics copied (no setting values included).'),
            tr('dss.panel.title', 'Device Settings Sync'),
        );
    });
}

function createPanel() {
    if (document.querySelector('#device_settings_sync_panel')) return true;
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!container) return false;
    const panel = document.createElement('div');
    panel.id = 'device_settings_sync_panel';
    panel.className = 'extension_container';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b data-i18n="dss.panel.title">Device Settings Sync</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="dss_manual_notice">
                    <b data-i18n="dss.panel.manualHeading">Manual mode</b><br>
                    <span data-i18n="dss.panel.manualNotice">No settings are downloaded, uploaded, polled, or monitored when the page loads. The extension connects only when you use a sync button below.</span>
                </div>
                <small data-i18n="dss.panel.description">“Upload local settings” first saves the current SillyTavern account and extension settings, then uploads portable browser settings. “Sync from server” downloads settings and reloads the page once to apply them completely. OAuth and login credentials stored in localStorage are included; HttpOnly login cookies cannot be synchronized.</small>
                <button id="dss_settings_toggle" class="menu_button" type="button" aria-expanded="false" aria-controls="dss_settings_menu" data-i18n="dss.manager.settingsTitle">Settings</button>
                <div id="dss_settings_menu" hidden>
                    <div id="dss_auto"></div>
                    <label for="dss_storage_mode" data-i18n="dss.manager.storageMode">localStorage synchronization range</label>
                    <select id="dss_storage_mode" class="text_pole">
                        <option value="portable" data-i18n="dss.manager.modePortable">Portable settings only</option>
                        <option value="selected" data-i18n="dss.manager.modeSelected">Only selected keys / folders</option>
                        <option value="full" data-i18n="dss.manager.modeFull">All localStorage</option>
                    </select>
                    <small data-i18n="dss.manager.fullStorageHint">Includes cache, history and large values; sync-internal keys stay on this device. Separate server data, 32 MiB limit.</small>
                    <label class="dss_check"><input id="dss_indexeddb_enabled" type="checkbox"><span data-i18n="dss.manager.indexedDbEnable">Enable IndexedDB synchronization</span></label>
                    <label for="dss_indexeddb_scope_mode" data-i18n="dss.manager.indexedDbScopeMode">IndexedDB scope</label>
                    <select id="dss_indexeddb_scope_mode" class="text_pole">
                        <option value="selected" data-i18n="dss.manager.indexedDbSelected">Selected databases/items</option>
                        <option value="all" data-i18n="dss.manager.indexedDbAll">All same-origin databases</option>
                    </select>
                    <small data-i18n="dss.manager.indexedDbHint">Merge-only; local-only records are preserved. 128 MiB per archive using 1 MiB chunks.</small>
                    <label class="dss_check"><input id="dss_before_changes" type="checkbox"><span data-i18n="dss.manager.beforeChanges">Also back up before import, restore or removal</span></label>
                    <label for="dss_excludes" data-i18n="dss.panel.excludesLabel">Additional localStorage keys to exclude (one per line; * wildcards supported)</label>
                    <textarea id="dss_excludes" rows="3" placeholder="example-cache:*" data-i18n="[placeholder]dss.panel.excludesPlaceholder"></textarea>
                </div>
                <div class="dss_actions">
                    <button id="dss_pull" class="menu_button" data-i18n="dss.pull.title">Sync from server</button>
                    <button id="dss_push" class="menu_button" data-i18n="dss.push.title">Upload local settings</button>
                    <button id="dss_reload" class="menu_button" data-i18n="dss.panel.reloadButton">Reload to apply</button>
                    <button id="dss_copy" class="menu_button" data-i18n="dss.panel.copyButton">Copy diagnostics</button>
                    <button id="dss_manage" class="menu_button" data-i18n="dss.manager.manager">Manage localStorage</button>
                    <button id="dss_idb_manage" class="menu_button" data-i18n="dss.manager.indexedDbManager">Manage IndexedDB</button>
                </div>
                <p id="dss_capacity"></p>
                <p id="dss_indexeddb_status" role="status"></p>
                <pre id="dss_status"></pre>
            </div>
        </div>`;
    container.append(panel);
    bindPanel();
    restorePullResult();
    refreshSnapshot();
    renderStatus();
    if (automatic) renderAuto(automatic.describe());
    return true;
}

function renderAuto(state) {
    const root = document.querySelector('#dss_auto');
    if (!root) return;
    diagnostics.mode = state.upload || state.download ? 'automatic' : 'manual';
    renderStatus();
    const notice = document.querySelector('#device_settings_sync_panel .dss_manual_notice');
    if (notice) notice.hidden = state.upload || state.download;
    if (!root.children.length) {
        for (const [name, key] of [['upload', 'autoUpload'], ['download', 'autoDownload']]) {
            const label = document.createElement('label');
            label.className = 'dss_check';
            const input = document.createElement('input');
            input.type = 'checkbox'; input.dataset.auto = name;
            const text = document.createElement('span'); text.textContent = msg(key);
            label.append(input, text); root.append(label);
            input.addEventListener('change', async () => {
                const checked = input.checked;
                input.disabled = true;
                try {
                    if (checked && !(await confirmManualAction(msg(key), msg('autoConsent'), msg(key)))) return;
                    await automatic.setOption(name, checked);
                } catch (error) { globalThis.toastr?.error(errorText(error)); }
                finally { renderAuto(automatic.describe()); }
            });
        }
        const note = document.createElement('p'); note.className = 'dss_note'; note.textContent = msg('autoLimits'); root.append(note);
        const status = document.createElement('p'); status.id = 'dss_auto_status'; status.setAttribute('role', 'status'); root.append(status);
        const actions = document.createElement('div'); actions.className = 'dss_actions'; root.append(actions);
        for (const [key, action] of [['autoPause', () => automatic.pause()], ['autoRetry', () => automatic.retry()]]) {
            const button = document.createElement('button'); button.className = 'menu_button'; button.textContent = msg(key);
            button.addEventListener('click', () => action().catch(error => globalThis.toastr?.error(errorText(error)))); actions.append(button);
        }
    }
    for (const input of root.querySelectorAll('input')) {
        input.checked = state[input.dataset.auto];
        input.disabled = !state.supported;
    }
    root.querySelector('#dss_auto_status').textContent = msg(state.status) + '\n' + msg('autoDetails', {
        count: state.active, last: state.lastEnd ? new Date(state.lastEnd).toLocaleString() : '—',
        due: state.due ? new Date(state.due).toLocaleString() : '—',
    }) + (state.error ? '\n' + errorText({ code: state.error, message: state.error }) : '');
}

async function resolveAutoConflict(counts) {
    const root = document.createElement('div');
    const description = document.createElement('p');
    description.textContent = msg(counts.indexeddb ? 'indexedDbAutoConflictDetails' : 'autoConflictDetails', counts);
    root.append(description);
    let choice = 'later';
    const popup = new Popup(root, POPUP_TYPE.TEXT, '', { okButton: msg('autoLater'), allowVerticalScrolling: true });
    for (const [value, label] of [['upload', 'autoKeepLocal'], ['download', 'autoUseServer']]) {
        const button = document.createElement('button'); button.className = 'menu_button'; button.textContent = msg(label);
        button.addEventListener('click', () => { choice = value; popup.complete(POPUP_RESULT.AFFIRMATIVE); });
        root.append(button);
    }
    await popup.show();
    return choice;
}

async function initializeAutomatic() {
    if (automatic) return;
    try {
        automatic = new AutoSync({
            request: syncRequest, options: filterOptions, persistDevice: () => getDeviceId(),
            busy: () => operationInFlight || managerOpen || settingsOpen,
            makeBackup, backup: sendBackup, conflict: resolveAutoConflict,
            syncIndexedDb: (direction, options) => syncIndexedDb(direction, options),
            events: { eventSource, eventTypes: event_types },
            render: renderAuto, changed: refreshSnapshot,
            failure: error => globalThis.toastr?.error(errorText(error)),
            reload: () => { setOperationState('reloading', true); location.reload(); },
        }, { account: getCurrentUserHandle() });
        await automatic.start();
        renderAuto(automatic.describe());
    } catch (error) { globalThis.toastr?.error(errorText(error)); }
}

eventSource.on(event_types.APP_READY, initializeAutomatic);

globalThis.DeviceSettingsSync = {
    syncNow: manualPull,
    pullFromServer: manualPull,
    pushCurrentDevice: manualPush,
    getDiagnostics: () => ({ ...diagnostics, automatic: automatic?.describe() }),
    openManager: showManager,
    // Cooperative bridge for workers/custom transports: report lifecycle only.
    beginModelActivity: () => automatic?.beginActivity(),
    endModelActivity: id => automatic?.endActivity(id),
};

function mountPanel() {
    if (createPanel()) return;
    const observer = new MutationObserver(() => {
        if (createPanel()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
} else {
    mountPanel();
}
