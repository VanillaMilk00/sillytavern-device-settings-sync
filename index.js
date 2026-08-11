import { getRequestHeaders, saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { DEFAULT_MAX_VALUE_BYTES, parseAdditionalExcludes } from './lib/filter.js';
import {
    applyServerState,
    diffSnapshots,
    serverStateToPortableValues,
    snapshotPortableStorage,
} from './lib/sync-core.js';

const VERSION = '1.3.0';
const SETTINGS_KEY = 'deviceSettingsSync';
const API_BASE = '/api/plugins/device-settings-sync';
const DEVICE_KEY = 'sillytavern_settings_sync_device_id';
const PULL_RESULT_KEY = 'sillytavern_settings_sync_manual_pull_result';
const OBSOLETE_SETTINGS = ['enabled', 'pollSeconds', 'autoReloadInitial', 'autoReloadRemote'];
const DEFAULT_SETTINGS = Object.freeze({
    mode: 'manual',
    maxValueBytes: DEFAULT_MAX_VALUE_BYTES,
    additionalExcludes: '',
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

function randomId(prefix) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `${prefix}_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function getDeviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[a-zA-Z0-9_-]{8,80}$/u.test(id)) {
        id = randomId('device');
        localStorage.setItem(DEVICE_KEY, id);
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
    if (!response.ok) throw new Error(body?.error || `Settings sync HTTP ${response.status}`);
    return body;
}

function refreshSnapshot() {
    const snapshot = snapshotPortableStorage(localStorage, filterOptions());
    diagnostics.portableKeys = snapshot.values.size;
    diagnostics.excludedKeys = snapshot.excluded.size;
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
        diagnostics.lastError = result.failed ? `${result.failed} 個設定無法寫入瀏覽器儲存空間` : '';
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

async function manualPull({ reload = true } = {}) {
    if (operationInFlight) return { ...diagnostics };
    setOperationState('downloading', true);
    try {
        const state = await request('/state');
        const result = applyServerState(localStorage, state, filterOptions());
        const at = new Date().toISOString();
        diagnostics.revision = Math.max(0, Number(state.revision) || 0);
        diagnostics.pulledChanges += result.changed;
        diagnostics.failedWrites += result.failed;
        diagnostics.lastAction = 'download';
        diagnostics.lastSyncAt = at;
        diagnostics.lastError = result.failed ? `${result.failed} 個設定無法寫入瀏覽器儲存空間` : '';
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
            globalThis.toastr?.success('已下載伺服器設定，正在重新載入以完整套用。', '跨裝置設定同步');
            setTimeout(() => location.reload(), 350);
        } else {
            setOperationState('manual-ready', false);
        }
        return { ...diagnostics };
    } catch (error) {
        diagnostics.lastError = error?.message || String(error);
        setOperationState('error', false);
        globalThis.toastr?.error(diagnostics.lastError, '跨裝置設定同步');
        throw error;
    }
}

async function manualPush() {
    if (operationInFlight) return { ...diagnostics };
    setOperationState('saving', true);
    try {
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
        globalThis.toastr?.success(`已上傳 ${mutations.length} 個可攜式設定。`, '跨裝置設定同步');
        return { ...diagnostics };
    } catch (error) {
        diagnostics.lastError = error?.message || String(error);
        setOperationState('error', false);
        globalThis.toastr?.error(diagnostics.lastError, '跨裝置設定同步');
        throw error;
    }
}

function renderStatus() {
    const target = document.querySelector('#dss_status');
    if (!target) return;
    const labels = {
        'manual-ready': '手動模式（待命）',
        downloading: '正在從伺服器下載',
        saving: '正在儲存並上傳',
        reloading: '正在重新載入套用',
        error: '錯誤',
    };
    target.textContent = [
        `狀態：${labels[diagnostics.status] || diagnostics.status}`,
        `伺服器版本：${diagnostics.revision}　可同步設定：${diagnostics.portableKeys}　已排除：${diagnostics.excludedKeys}`,
        diagnostics.lastAction ? `最近動作：${diagnostics.lastAction === 'upload' ? '上傳本機設定' : '從伺服器同步'}` : '',
        diagnostics.lastSyncAt ? `最近手動同步：${new Date(diagnostics.lastSyncAt).toLocaleString()}` : '',
        diagnostics.lastError ? `最近錯誤：${diagnostics.lastError}` : '',
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
    document.querySelector('#dss_pull')?.addEventListener('click', () => manualPull().catch(() => {}));
    document.querySelector('#dss_push')?.addEventListener('click', () => manualPush().catch(() => {}));
    document.querySelector('#dss_reload')?.addEventListener('click', () => location.reload());
    document.querySelector('#dss_copy')?.addEventListener('click', async () => {
        const safe = { ...diagnostics, device: getDeviceId().slice(-8) };
        await navigator.clipboard.writeText(JSON.stringify(safe, null, 2));
        globalThis.toastr?.success('已複製診斷資料（不包含設定值）。', '跨裝置設定同步');
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
                <b>跨裝置設定同步</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="dss_manual_notice">
                    <b>純手動模式</b><br>
                    載入頁面時不會下載、上傳、輪詢或監聽設定變更。只有按下方同步按鈕時才會連線。
                </div>
                <small>「上傳本機設定」會先儲存目前的 SillyTavern 帳戶與擴充設定，再上傳可攜式瀏覽器設定。「從伺服器同步」會下載設定並重新載入一次以完整套用。OAuth／登入憑證會包含在可攜式 localStorage 中；HttpOnly 登入 Cookie 無法同步。</small>
                <label for="dss_excludes">額外排除的 localStorage 鍵（每行一個，可用 *）</label>
                <textarea id="dss_excludes" rows="3" placeholder="example-cache:*"></textarea>
                <div class="dss_actions">
                    <button id="dss_pull" class="menu_button">從伺服器同步</button>
                    <button id="dss_push" class="menu_button">上傳本機設定</button>
                    <button id="dss_reload" class="menu_button">重新載入套用</button>
                    <button id="dss_copy" class="menu_button">複製診斷資料</button>
                </div>
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
