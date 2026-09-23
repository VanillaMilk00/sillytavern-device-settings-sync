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
import { AUTO_PREFIX, planRemote, sortedEntries } from './lib/auto-core.js';
import {
    applyServerState,
    diffSnapshots,
    serverStateToPortableValues,
    snapshotPortableStorage,
} from './lib/sync-core.js';

const VERSION = '1.7.0';
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

function fullStorageKey() { return AUTO_PREFIX + encodeURIComponent(getCurrentUserHandle() || '') + ':full-mode'; }
function isFullStorage() { return localStorage.getItem(fullStorageKey()) === '1'; }

function filterOptions() {
    const settings = getSettings();
    const fullStorage = isFullStorage();
    return {
        maxValueBytes: settings.maxValueBytes,
        additionalExcludes: fullStorage ? [] : parseAdditionalExcludes(settings.additionalExcludes),
        fullStorage,
    };
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
        if (body?.code) throw Object.assign(new StorageError(body.code), { status: response.status });
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
    if (!fullStorage) return request(path, options);
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
        diagnostics.lastError = result.failed
            ? formatText('dss.error.storageWriteFailed', '{count} settings could not be written to browser storage.', { count: result.failed })
            : '';
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

async function showManager() {
    if (managerOpen || operationInFlight) return;
    managerOpen = true;
    try {
        await openStorageManager({
            getSettings, filterOptions, source: archiveSource,
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
        });
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
    return confirmManualAction(
        tr('dss.pull.title', 'Sync from server'),
        isFullStorage() ? msg('fullPullConfirm') : tr(
            'dss.pull.confirmMessage',
            'This will overwrite syncable settings on this device with the server settings. Local changes that have not been uploaded may be lost, and the page will reload automatically when complete. A full localStorage snapshot, including caches and credentials, will first be saved to this account on the server. Continue?',
        ),
        tr('dss.pull.confirmButton', 'Sync now'),
    );
}

async function confirmManualPush() {
    return confirmManualAction(
        tr('dss.push.title', 'Upload local settings'),
        isFullStorage() ? msg('fullPushConfirm') : tr(
            'dss.push.confirmMessage',
            'This will replace the server sync data with settings from this device. Portable settings that exist on the server but were deleted locally will also be deleted. A full localStorage snapshot, including caches and credentials, will first be saved to this account on the server. Continue?',
        ),
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
        if (options.fullStorage) await requireFullSupport();
        const original = options.fullStorage ? readStorage(localStorage) : null;
        await backupCurrentStorage('download');
        const state = options.fullStorage ? await requestFullState() : await request('/state');
        let result;
        if (options.fullStorage) {
            const before = readStorage(localStorage);
            const sameUserData = [...original].every(([key, value]) => isInternalKey(key) || before.get(key) === value)
                && [...before].every(([key, value]) => isInternalKey(key) || original.get(key) === value);
            if (!sameUserData || filterOptions().fullStorage !== options.fullStorage) throw new StorageError('stalePreview');
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

        if (reload) {
            sessionStorage.setItem(PULL_RESULT_KEY, JSON.stringify({
                revision: diagnostics.revision,
                changed: result.changed,
                failed: result.failed,
                at,
            }));
            diagnostics.status = 'reloading';
            renderStatus();
            globalThis.toastr?.success(
                tr('dss.toast.pullSuccess', 'Server settings downloaded. Reloading to apply them completely.'),
                tr('dss.panel.title', 'Device Settings Sync'),
            );
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
        if (options.fullStorage) await requireFullSupport();
        await backupCurrentStorage('upload');
        // SillyTavern's native account settings and extension_settings live in the
        // normal account settings file. Save them first, then upload portable
        // browser-only settings in the same explicit button action.
        await saveSettings();
        if (JSON.stringify(filterOptions()) !== JSON.stringify(options)) throw new StorageError('stalePreview');
        const snapshot = refreshSnapshot();
        if (options.fullStorage) {
            const remote = await requestFullState();
            const remoteValues = serverStateToPortableValues(remote, options);
            const changes = diffSnapshots(remoteValues, snapshot.values);
            const state = changes.length || !remote.seeded
                ? await request('/full-commit', { method: 'POST', body: JSON.stringify({
                    operationId: randomId('operation'), expectedRevision: remote.revision, deviceId: getDeviceId(),
                    entries: sortedEntries(snapshot.values).map(([key, value]) => ({ key, value })),
                }) }) : remote;
            diagnostics.revision = state.revision;
            diagnostics.pushedMutations += changes.length;
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
    const menu = document.querySelector('#dss_settings_menu');
    const toggle = document.querySelector('#dss_settings_toggle');
    toggle?.addEventListener('click', () => {
        excludes.value = getSettings().additionalExcludes;
        document.querySelector('#dss_full_storage').checked = isFullStorage();
        document.querySelector('#dss_before_changes').checked = getSettings().backupBeforeChanges === true;
        menu.hidden = !menu.hidden;
        settingsOpen = !menu.hidden;
        toggle.setAttribute('aria-expanded', String(settingsOpen));
        if (!settingsOpen) automatic?.configure();
    });
    const full = document.querySelector('#dss_full_storage');
    full.checked = isFullStorage();
    full.addEventListener('change', async () => {
        const checked = full.checked;
        full.disabled = true;
        try {
            if (operationInFlight || automatic?.running || automatic?.state().intent) throw new StorageError('operationBusy');
            if (checked && !(await confirmManualAction(msg('fullStorageTitle'), msg('fullStorageConsent'), msg('fullStorageTitle')))) return;
            localStorage.setItem(fullStorageKey(), checked ? '1' : '0');
            refreshSnapshot();
            if (automatic?.prefs().download) { automatic.entry = true; automatic.configure(); }
        } catch (error) { globalThis.toastr?.error(errorText(error)); }
        finally { full.checked = isFullStorage(); full.disabled = false; }
    });
    const before = document.querySelector('#dss_before_changes');
    before.checked = settings.backupBeforeChanges === true;
    before.addEventListener('change', () => { getSettings().backupBeforeChanges = before.checked; saveSettingsDebounced(); });

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
                    <label class="dss_check"><input id="dss_full_storage" type="checkbox"><span data-i18n="dss.manager.fullStorageTitle">Sync all localStorage</span></label>
                    <small data-i18n="dss.manager.fullStorageHint">Includes cache, history and large values; sync-internal keys stay on this device. Separate server data, 32 MiB limit.</small>
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
                </div>
                <p id="dss_capacity"></p>
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
    const description = document.createElement('p'); description.textContent = msg('autoConflictDetails', counts); root.append(description);
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
