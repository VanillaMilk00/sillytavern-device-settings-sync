import { getRequestHeaders, saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { translate } from '../../../i18n.js';
import { POPUP_RESULT, Popup } from '../../../popup.js';
import { DEFAULT_MAX_VALUE_BYTES, parseAdditionalExcludes } from './lib/filter.js';
import { readStorage, createArchive, serializeArchive, totalBytes, assertUnchanged, applyPlan, StorageError } from './lib/storage-model.js';
import { msg, errorText, bytes } from './lib/messages.js';
import { openStorageManager } from './ui/storage-manager.js';
import { probeCapacity } from './lib/capacity-probe.js';
import {
    applyServerState,
    diffSnapshots,
    serverStateToPortableValues,
    snapshotPortableStorage,
} from './lib/sync-core.js';

const VERSION = '1.5.2';
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
    pushedMutations: 0,
    pulledChanges: 0,
    failedWrites: 0,
    lastAction: '',
    lastSyncAt: '',
    lastError: '',
};

let operationInFlight = false;
let managerOpen = false;
let provisionalDeviceId;

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

function filterOptions() {
    const settings = getSettings();
    return {
        maxValueBytes: settings.maxValueBytes,
        additionalExcludes: parseAdditionalExcludes(settings.additionalExcludes),
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
        if (body?.code) throw new StorageError(body.code);
        if (response.status === 404 && path.startsWith('/backups')) throw new StorageError('backupBackendMissing');
        if (response.status === 404) {
            throw new Error(tr(
                'dss.error.backendMissing',
                'The settings sync server plugin was not found (HTTP 404). If you installed the Docker extension for yourself, use the auto-detect installation command in the README, then restart the container.',
            ));
        }
        throw new Error(body?.error || `Settings sync HTTP ${response.status}`);
    }
    return body;
}

function refreshSnapshot() {
    const snapshot = snapshotPortableStorage(localStorage, filterOptions());
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

async function backupCurrentStorage(reason) {
    const archive = createArchive(readStorage(localStorage), { kind: 'full' }, archiveSource());
    serializeArchive(archive);
    const body = JSON.stringify({ operationId: randomId('operation'), reason, archive });
    // Keep the same operation ID and payload on a transport retry.
    try {
        return await request('/backups', { method: 'POST', body });
    } catch (error) {
        if (error instanceof TypeError) return request('/backups', { method: 'POST', body });
        throw error;
    }
}

async function applyLocalPlan(plan, reason, { forceBackup = false } = {}) {
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
            measureCapacity: async () => {
                if (operationInFlight) throw new StorageError('operationBusy');
                setOperationState('probing', true);
                try { return await probeCapacity(localStorage); }
                finally { setOperationState('manual-ready', false); refreshSnapshot(); }
            },
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
        tr(
            'dss.pull.confirmMessage',
            'This will overwrite syncable settings on this device with the server settings. Local changes that have not been uploaded may be lost, and the page will reload automatically when complete. A full localStorage snapshot, including caches and credentials, will first be saved to this account on the server. Continue?',
        ),
        tr('dss.pull.confirmButton', 'Sync now'),
    );
}

async function confirmManualPush() {
    return confirmManualAction(
        tr('dss.push.title', 'Upload local settings'),
        tr(
            'dss.push.confirmMessage',
            'This will replace the server sync data with settings from this device. Portable settings that exist on the server but were deleted locally will also be deleted. A full localStorage snapshot, including caches and credentials, will first be saved to this account on the server. Continue?',
        ),
        tr('dss.push.confirmButton', 'Upload now'),
    );
}

async function manualPull({ reload = true } = {}) {
    if (operationInFlight) return { ...diagnostics };
    setOperationState('downloading', true);
    try {
        await backupCurrentStorage('download');
        const state = await request('/state');
        const result = applyServerState(localStorage, state, filterOptions());
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
    if (operationInFlight) return { ...diagnostics };
    setOperationState('saving', true);
    try {
        await backupCurrentStorage('upload');
        // SillyTavern's native account settings and extension_settings live in the
        // normal account settings file. Save them first, then upload portable
        // browser-only settings in the same explicit button action.
        await saveSettings();
        const snapshot = refreshSnapshot();
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
        'manual-ready': tr('dss.status.manualReady', 'Manual mode (ready)'),
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

    excludes.addEventListener('change', () => {
        settings.additionalExcludes = excludes.value;
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
        const safe = { ...diagnostics, device: getDeviceId().slice(-8) };
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
                <label for="dss_excludes" data-i18n="dss.panel.excludesLabel">Additional localStorage keys to exclude (one per line; * wildcards supported)</label>
                <textarea id="dss_excludes" rows="3" placeholder="example-cache:*" data-i18n="[placeholder]dss.panel.excludesPlaceholder"></textarea>
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
    return true;
}

globalThis.DeviceSettingsSync = {
    syncNow: manualPull,
    pullFromServer: manualPull,
    pushCurrentDevice: manualPush,
    getDiagnostics: () => ({ ...diagnostics }),
    openManager: showManager,
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
