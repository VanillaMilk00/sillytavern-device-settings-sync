import { AutoJournal, journalDatabaseName, openAutoJournal } from './auto-journal.js';
import { HashClient } from './hash-client.js';
import { StorageObserver } from './storage-observer.js';
import { monitorActivity } from './activity-monitor.js';
import { AUTO_PREFIX } from './auto-core.js';
import { classifyStorageEntry, DEFAULT_MAX_VALUE_BYTES } from './filter.js';
import { isInternalKey, StorageError } from './storage-model.js';

const QUIET_MS = 10_000;
const MAX_MERGE_MS = 15000;
const MIN_BATCH_GAP_MS = 30_000;
const CHUNK_BYTES = 256 * 1024;
const KEEPALIVE_BYTES = 48 * 1024;
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
const randomId = prefix => prefix + '_' + Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
const byteLength = text => new TextEncoder().encode(text).byteLength;
const scopeMode = options => options.fullStorage ? 'full' : options.selectedScope ? 'selected' : 'portable';

function inCurrentScope(key, value, options) {
    return !isInternalKey(key) && classifyStorageEntry(key, value, options).portable;
}

function yieldToPage(win) { return new Promise(resolve => win.setTimeout(resolve, 0)); }

export class IncrementalAutoSync {
    constructor(api, { window: win = window, account, now = () => Date.now() } = {}) {
        this.api = api;
        this.win = win;
        this.storage = win.localStorage;
        this.account = String(account || '');
        this.now = now;
        this.deviceId = '';
        this.prefix = AUTO_PREFIX + encodeURIComponent(this.account) + ':incremental-auto:';
        this.prefKey = this.prefix + 'prefs';
        this.legacyPrefKey = AUTO_PREFIX + encodeURIComponent(this.account) + ':prefs';
        this.streamLock = 'dss-sync:' + this.account;
        this.databaseName = journalDatabaseName(this.account);
        this.journal = null;
        this.hashes = new HashClient(win);
        this.dirty = new Set();
        this.timer = null;
        this.maxTimer = null;
        this.retryTimer = null;
        this.reconcileTimer = null;
        this.observer = null;
        this.activityMonitor = null;
        this.apiActive = new Set();
        this.activityLockReleases = new Map();
        this.activityObservationLimited = false;
        this.waitingForActivity = false;
        this.waitingForOperation = false;
        this.operationInFlight = false;
        this.reconcileRequested = false;
        this.workerRegistration = null;
        this.running = false;
        this.sending = false;
        this.firstDirtyAt = 0;
        this.lastBatchStart = 0;
        this.retryCount = 0;
        this.pendingCount = 0;
        this.status = 'autoOff';
        this.uploadEnabled = false;
        this.downloadEnabled = false;
        this.paused = false;
        this.entryRequested = false;
        this.notifyTimer = null;
        this.error = '';
        this.lastConfirmedAt = 0;
        this.nextAttemptAt = 0;
        this.pagehide = () => this.flushPreparedForClose();
        this.pageshow = () => {
            if ((this.downloadEnabled || this.uploadEnabled) && !this.paused) {
                this.reconcile('pageshow').catch(error => error.code === 'operationBusy' ? this.deferReconcile() : this.pauseFor(error));
            }
        };
        this.serviceWorkerMessage = event => {
            const data = event.data;
            if (data?.type !== 'dss-auto-confirmed' || data.account !== this.account || data.mode !== this.mode()) return;
            this.lastConfirmedAt = Math.max(this.lastConfirmedAt, Number(data.confirmedAt) || 0);
            this.notify('autoConfirmed').catch(() => {});
        };
        this.prefStorageEvent = event => {
            if (event.key !== this.prefKey) return;
            const update = async () => {
                const wasUploadEnabled = this.uploadEnabled;
                const prefs = this.localPrefs();
                this.uploadEnabled = prefs.upload === true;
                this.downloadEnabled = prefs.download === true;
                this.paused = prefs.paused === true;
                if (!this.uploadEnabled || this.paused) {
                    this.clearTimers();
                    this.observer?.destroy(); this.observer = null;
                    await this.openJournal().then(journal => journal.setMeta('uploadEnabled', false));
                    if (!this.uploadEnabled && wasUploadEnabled) await this.disableQueuedWork();
                } else {
                    await this.openJournal().then(journal => journal.setMeta('uploadEnabled', true));
                    await this.startObserver();
                }
                this.ensureActivityMonitor();
                if ((this.uploadEnabled || this.downloadEnabled) && !this.paused) await this.reconcile('resume');
                this.notify(this.uploadEnabled || this.downloadEnabled ? (this.paused ? 'autoPaused' : this.status) : 'autoOff').catch(() => {});
            };
            update().catch(error => this.pauseFor(error));
        };
        win.addEventListener('pagehide', this.pagehide);
        win.addEventListener('pageshow', this.pageshow);
        win.addEventListener('storage', this.prefStorageEvent);
        win.navigator.serviceWorker?.addEventListener('message', this.serviceWorkerMessage);
        this.supported = Boolean(win.isSecureContext && win.navigator.locks?.request && win.navigator.locks?.query
            && win.indexedDB?.open && win.crypto?.subtle && win.Worker && win.PerformanceObserver && win.document?.createElement);
    }

    localPrefs() {
        try {
            const legacy = JSON.parse(this.storage.getItem(this.legacyPrefKey) || '{}');
            return { upload: false, download: legacy.download === true, paused: false,
                ...JSON.parse(this.storage.getItem(this.prefix + 'prefs') || '{}') };
        }
        catch { throw new StorageError('autoMetadataInvalid'); }
    }

    savePrefs(patch) {
        this.storage.setItem(this.prefix + 'prefs', JSON.stringify({ ...this.localPrefs(), ...patch }));
    }

    async openJournal() {
        if (!this.journal) {
            this.journal = new AutoJournal(await openAutoJournal(this.win.indexedDB, this.account), this.mode());
            this.lastBatchStart = await this.journal.getMeta('lastBatchStart', 0) || 0;
        }
        else if (this.journal.namespace !== this.mode()) {
            this.journal.namespace = this.mode();
            this.journal.prefix = this.mode() + '\u0000';
            this.lastBatchStart = await this.journal.getMeta('lastBatchStart', 0) || 0;
            if (this.uploadEnabled && !this.paused) await this.journal.setMeta('uploadEnabled', true);
        }
        return this.journal;
    }

    mode() { return scopeMode(this.api.options()); }
    options() { return this.api.options(); }
    signature() {
        const options = this.options();
        return JSON.stringify({ mode: this.mode(), selectedScope: options.selectedScope || null,
            selectedScopeConfigured: options.selectedScopeConfigured !== false, additionalExcludes: options.additionalExcludes || [],
            maxValueBytes: options.maxValueBytes || DEFAULT_MAX_VALUE_BYTES });
    }
    endpoint(path) { return path + (path.includes('?') ? '&' : '?') + 'mode=' + encodeURIComponent(this.mode()); }

    prefs() { return this.localPrefs(); }

    describe() {
        return { ...this.prefs(), supported: this.supported, status: this.status, active: this.apiActive.size,
            lastEnd: this.lastConfirmedAt, due: this.nextAttemptAt || 0, error: this.error, errorDetail: this.errorDetail || '',
            pending: this.pendingCount, dirty: this.dirty.size, timerPending: Boolean(this.timer),
            lastConfirmedAt: this.lastConfirmedAt, limited: true };
    }

    async notify(status = this.status) {
        this.status = status;
        try { this.pendingCount = (await (await this.openJournal()).listPending()).length; } catch { /* status reports journal failure separately */ }
        this.api.render?.(this.describe());
    }

    async withLock(work) {
        if (!this.win.navigator.locks?.request) throw new StorageError('autoUnsupported');
        return this.win.navigator.locks.request(this.streamLock, { ifAvailable: true }, lock => {
            if (!lock) throw new StorageError('operationBusy');
            return work();
        });
    }

    async start() {
        // Migrate the download preference, but disarm v1.6's idle-timer uploader.
        // The new per-key journal is authoritative for both automatic directions.
        try {
            const legacy = JSON.parse(this.storage.getItem(this.legacyPrefKey) || '{}');
            const current = JSON.parse(this.storage.getItem(this.prefKey) || '{}');
            if (!Object.hasOwn(current, 'download') && legacy.download === true) this.savePrefs({ download: true });
            if (legacy.upload === true || legacy.download === true) {
                this.storage.setItem(this.legacyPrefKey, JSON.stringify({ ...legacy, upload: false, download: false }));
            }
        } catch { throw new StorageError('autoMetadataInvalid'); }
        const prefs = this.localPrefs();
        this.uploadEnabled = prefs.upload === true;
        this.downloadEnabled = prefs.download === true;
        this.paused = prefs.paused === true;
        if ((prefs.upload || prefs.download) && !prefs.paused && this.supported) {
            try {
                const health = await this.api.request('/health');
                if (!health.capabilities?.includes('incremental-localstorage-v1')) throw new StorageError('incrementalBackendMissing');
                await this.openJournal();
                await this.journal.setMeta('uploadEnabled', prefs.upload === true);
                this.lastConfirmedAt = await this.journal.getMeta('lastConfirmedAt', 0) || 0;
                this.lastBatchStart = await this.journal.getMeta('lastBatchStart', 0) || 0;
                if (prefs.upload) await this.startObserver();
                this.ensureActivityMonitor();
                await this.reconcile('resume');
            } catch (error) { if (error.code === 'operationBusy') this.deferReconcile(); else this.pauseFor(error); }
        } else if ((prefs.upload || prefs.download) && !prefs.paused) this.pauseFor(new StorageError('autoUnsupported'));
        else if (prefs.upload || prefs.download) {
            await this.openJournal();
            this.lastConfirmedAt = await this.journal.getMeta('lastConfirmedAt', 0) || 0;
            await this.journal.setMeta('uploadEnabled', false);
        }
        await this.notify(prefs.upload || prefs.download ? (prefs.paused ? 'autoPaused' : this.status) : 'autoOff');
    }

    async setOption(name, enabled) {
        if (name === 'download') {
            if (enabled) {
                if (!this.supported) throw new StorageError('autoUnsupported');
                const health = await this.api.request('/health');
                if (!health.capabilities?.includes('incremental-localstorage-v1')) throw new StorageError('incrementalBackendMissing');
            }
            this.savePrefs({ download: enabled });
            this.downloadEnabled = enabled;
            if (this.localPrefs().upload && !this.paused) await this.startObserver();
            this.ensureActivityMonitor();
            if (enabled && !this.paused) {
                try { await this.reconcile('enable-download'); }
                catch (error) { if (error.code === 'operationBusy') this.deferReconcile(); else { this.pauseFor(error); throw error; } }
            }
            await this.notify(this.uploadEnabled || this.downloadEnabled ? this.status : 'autoOff');
            return;
        }
        if (name !== 'upload') return;
        if (enabled) {
            if (!this.supported) throw new StorageError('autoUnsupported');
            const health = await this.api.request('/health');
            if (!health.capabilities?.includes('incremental-localstorage-v1')) throw new StorageError('incrementalBackendMissing');
            this.deviceId = this.api.persistDevice();
            await this.openJournal();
            await this.journal.setMeta('uploadEnabled', true);
            this.savePrefs({ upload: true, paused: false });
            this.uploadEnabled = true; this.paused = false;
            this.downloadEnabled = this.localPrefs().download === true;
            this.error = '';
            this.errorDetail = '';
            await this.startObserver();
            this.ensureActivityMonitor();
            try { await this.reconcile('enable'); }
            catch (error) {
                if (error.code === 'operationBusy') this.deferReconcile();
                else { this.pauseFor(error); throw error; }
            }
            await this.notify(this.status === 'autoOff' ? 'autoReady' : this.status);
        } else {
            const journal = await this.openJournal();
            await journal.setMeta('uploadEnabled', false);
            this.savePrefs({ upload: false });
            this.uploadEnabled = false;
            this.clearTimers();
            this.observer?.destroy(); this.observer = null;
            if (!this.downloadEnabled) this.stopActivityMonitor();
            await this.disableQueuedWork();
            this.ensureActivityMonitor();
            await this.notify(this.downloadEnabled ? this.status : 'autoOff');
        }
    }

    startObserver() {
        if (this.observer) return this.observer.readyPromise || Promise.resolve();
        this.observer = new StorageObserver({ window: this.win,
            onKey: key => this.noteKey(key),
            onClear: () => this.pauseFor(new StorageError('autoClearDetected')),
            onError: error => this.pauseFor(Object.assign(error, { code: 'autoObserverUnavailable' })),
        });
        const ready = this.observer.start();
        this.registerBackgroundSync().catch(() => {});
        return ready;
    }

    ensureActivityMonitor() {
        if ((!this.uploadEnabled && !this.downloadEnabled) || this.paused) {
            this.stopActivityMonitor();
            return;
        }
        if (this.activityObservationLimited) {
            this.pauseFor(new StorageError('autoActivityObservationLimited'));
            return;
        }
        if (this.activityMonitor) return;
        const monitor = monitorActivity({ window: this.win, ...this.api.events,
            begin: () => this.beginRequestActivity(), end: id => this.endRequestActivity(id),
            limitation: () => this.activityLimitation() });
        if (this.paused) monitor();
        else this.activityMonitor = monitor;
    }

    stopActivityMonitor() {
        this.activityMonitor?.();
        this.activityMonitor = null;
        for (const id of this.apiActive) this.activityLockReleases.get(id)?.();
        this.apiActive.clear();
        this.activityLockReleases.clear();
    }

    activityLimitation() {
        this.activityObservationLimited = true;
        if (this.uploadEnabled || this.downloadEnabled) this.pauseFor(new StorageError('autoActivityObservationLimited'));
    }

    beginRequestActivity(id = randomId('request')) {
        this.apiActive.add(id);
        this.win.navigator.locks.request(this.streamLock, { mode: 'shared' }, lock => {
            if (!lock || !this.apiActive.has(id)) return;
            return new Promise(resolve => this.activityLockReleases.set(id, resolve));
        }).catch(error => this.pauseFor(Object.assign(error, { code: 'autoCoordinationUnavailable' })));
        return id;
    }

    endRequestActivity(id) {
        if (!id || !this.apiActive.delete(id)) return;
        this.activityLockReleases.get(id)?.();
        this.activityLockReleases.delete(id);
        this.resumeAfterActivity();
    }

    async disableQueuedWork() {
        const journal = await this.openJournal();
        await this.win.navigator.locks.request(this.streamLock, async () => {
            await journal.clearAllPending();
            await journal.clearBatches();
        });
    }

    hasActiveRequest() { return this.apiActive.size > 0; }

    resumeAfterActivity() {
        if (this.hasActiveRequest() || (!this.uploadEnabled && !this.downloadEnabled) || this.paused) return;
        this.waitingForActivity = false;
        if (this.uploadEnabled) {
            if (this.dirty.size) this.schedule(QUIET_MS);
            else this.openJournal().then(journal => journal.listPending()).then(rows => {
                if (rows.length) this.schedule(0);
            }).catch(error => this.pauseFor(error));
        }
        if (this.downloadEnabled && this.reconcileRequested) this.deferReconcile(0);
        this.notify('autoPending').catch(() => {});
    }

    operationStateChanged(inFlight) {
        if (inFlight) {
            for (const timer of [this.timer, this.maxTimer]) if (timer) this.win.clearTimeout(timer);
            this.timer = this.maxTimer = null;
            this.operationInFlight = true;
            return;
        }
        if (!this.operationInFlight && !this.waitingForOperation) return;
        this.operationInFlight = false;
        if (this.uploadEnabled && this.dirty.size) {
            const remaining = Math.max(0, MAX_MERGE_MS - (this.now() - this.firstDirtyAt));
            this.maxTimer = this.win.setTimeout(() => this.flushDirty().catch(error => this.pauseFor(error)), remaining);
            this.schedule(QUIET_MS);
        } else if (this.uploadEnabled && this.waitingForOperation) this.schedule(0);
        this.waitingForOperation = false;
        if (this.downloadEnabled && this.reconcileRequested) this.deferReconcile(0);
    }

    async registerBackgroundSync() {
        if (!this.win.navigator.serviceWorker || !this.supported) return;
        try {
            const workerUrl = new URL('../workers/sync-service-worker.js', import.meta.url);
            this.workerRegistration = await this.win.navigator.serviceWorker.register(workerUrl, { type: 'module' });
        } catch { this.workerRegistration = null; }
    }

    scheduleBackground(batch) {
        const tag = 'dss-autosave:' + encodeURIComponent(this.account) + ':' + encodeURIComponent(this.databaseName);
        const register = async () => {
            const registration = this.workerRegistration || await this.win.navigator.serviceWorker?.ready;
            if (registration?.sync?.register) await registration.sync.register(tag);
        };
        // Background Sync is only a best-effort enhancement. In particular,
        // navigator.serviceWorker.ready may never settle on unsupported hosts;
        // never make a foreground save wait for it.
        register().catch(() => {});
    }

    noteKey(key) {
        if (!this.uploadEnabled || this.now() < (this.suppressUntil || 0) || isInternalKey(key)) return;
        this.dirty.add(key);
        if (!this.firstDirtyAt) {
            this.firstDirtyAt = this.now();
            this.maxTimer = this.win.setTimeout(() => this.flushDirty().catch(error => this.pauseFor(error)), MAX_MERGE_MS);
        } else if (!this.maxTimer) {
            const remaining = Math.max(0, MAX_MERGE_MS - (this.now() - this.firstDirtyAt));
            this.maxTimer = this.win.setTimeout(() => this.flushDirty().catch(error => this.pauseFor(error)), remaining);
        }
        this.win.clearTimeout(this.timer);
        const earliest = Math.max(0, this.lastBatchStart + MIN_BATCH_GAP_MS - this.now());
        this.timer = this.win.setTimeout(() => this.flushDirty().catch(error => this.pauseFor(error)), Math.max(QUIET_MS, earliest));
        this.scheduleNotify('autoPending');
    }

    scheduleNotify(status) {
        if (status !== this.status) { this.notify(status).catch(() => {}); return; }
        if (this.notifyTimer) return;
        this.notifyTimer = this.win.setTimeout(() => {
            this.notifyTimer = null;
            this.notify(this.status).catch(() => {});
        }, 1000);
    }

    clearTimers() {
        for (const timer of [this.timer, this.maxTimer, this.retryTimer, this.reconcileTimer]) if (timer) this.win.clearTimeout(timer);
        this.timer = this.maxTimer = this.retryTimer = this.reconcileTimer = null;
        if (this.notifyTimer) this.win.clearTimeout(this.notifyTimer);
        this.notifyTimer = null;
        this.dirty.clear(); this.firstDirtyAt = 0;
    }

    async readLocalSnapshot(options = this.options()) {
        if (options.selectedScope && options.selectedScopeConfigured === false) throw new StorageError('selectedScopeEmpty');
        const keys = [];
        for (let index = 0; index < this.storage.length; index++) {
            const key = this.storage.key(index);
            if (key && !isInternalKey(key)) keys.push(key);
        }
        const values = new Map();
        for (let index = 0; index < keys.length; index++) {
            const key = keys[index];
            const value = this.storage.getItem(key);
            if (value !== null && inCurrentScope(key, value, options)) values.set(key, value);
            if (index && index % 64 === 0) await yieldToPage(this.win);
        }
        return values;
    }

    async hashValues(values) {
        const rows = [];
        let count = 0;
        for (const [key, value] of values) {
            const result = await this.hashes.hash(value);
            rows.push({ key, hash: result.hash, localHash: result.hash, value });
            if (++count % 64 === 0) await yieldToPage(this.win);
        }
        return rows;
    }

    async serverSnapshot() { return this.api.request(this.endpoint('/incremental/snapshot')); }
    async serverMetadata() { return this.api.request(this.endpoint('/incremental/state')); }

    snapshotMap(snapshot, options) {
        const values = new Map();
        for (const [key, item] of Object.entries(snapshot.entries || {})) {
            if (!item?.deleted && typeof item?.value === 'string' && inCurrentScope(key, item.value, options)) values.set(key, item.value);
        }
        return values;
    }

    async baselineRows(local, remote, previous = []) {
        const old = new Map(previous.map(row => [row.key, row]));
        const rows = [];
        const keys = new Set([...local.keys(), ...remote.keys()]);
        for (const key of keys) {
            const remoteValue = remote.get(key);
            const remoteHash = remoteValue === undefined ? null : (await this.hashes.hash(remoteValue)).hash;
            const localValue = local.get(key);
            const localHash = localValue === undefined ? null : (await this.hashes.hash(localValue)).hash;
            rows.push({ key, hash: remoteHash, localHash, value: remoteValue ?? null });
            if (rows.length % 64 === 0) await yieldToPage(this.win);
        }
        return rows;
    }

    async conflictChoice(local, remote) {
        return this.api.conflict({ local: local.size, remote: remote.size,
            changes: [...new Set([...local.keys(), ...remote.keys()])].filter(key => local.get(key) !== remote.get(key)).length });
    }

    async reconcile(reason = 'resume') {
        return this.withLock(async () => {
            const prefs = this.localPrefs();
            if ((!prefs.upload && !prefs.download) || prefs.paused) return;
            if (this.api.busy() || this.hasActiveRequest()) {
                this.waitingForOperation = Boolean(this.api.busy());
                this.waitingForActivity = this.hasActiveRequest();
                this.reconcileRequested = true;
                throw new StorageError('operationBusy');
            }
            this.reconcileRequested = false;
            const journal = await this.openJournal();
            const savedBatches = await journal.listBatches();
            if (savedBatches.length) {
                await this.processQueueLocked({ oneTime: savedBatches[0].oneTime === true });
                if (this.paused || (await journal.listBatches()).length) return;
            }
            const options = this.options();
            const signature = this.signature();
            const local = await this.readLocalSnapshot(options);
            const metadata = await this.serverMetadata();
            const oldBaseline = await journal.listBaseline();
            const oldSignature = await journal.getMeta('signature');
            const oldRevision = await journal.getMeta('revision');
            const baselineInitialized = await journal.getMeta('initialized', false);
            if (!baselineInitialized || oldSignature !== signature || oldRevision === null) {
                const snapshot = await this.serverSnapshot();
                const remote = this.snapshotMap(snapshot, options);
                const differences = [...new Set([...local.keys(), ...remote.keys()])].filter(key => local.get(key) !== remote.get(key));
                if (differences.length) {
                    const choice = await this.conflictChoice(local, remote);
                    if (choice === 'later') {
                        await this.pauseForConflict();
                        return;
                    }
                    if (choice === 'download') {
                        await this.api.applyAutomaticDownload(snapshot, options);
                        this.suppressUntil = this.now() + 2000;
                        await journal.replaceBaseline(await this.baselineRows(remote, remote), snapshot.revision, signature);
                        await this.notify('autoReady');
                        return;
                    }
                    if (choice !== 'upload') return;
                    const pending = [];
                    for (const key of differences) pending.push({ key, value: local.has(key) ? local.get(key) : null,
                        deleted: !local.has(key), beforeHash: remote.has(key) ? (await this.hashes.hash(remote.get(key))).hash : null,
                        previousValue: remote.get(key) ?? null });
                    await journal.replaceBaseline(await this.baselineRows(local, remote), snapshot.revision, signature);
                    await journal.queue(pending);
                    await this.notify('autoPending');
                    if (prefs.upload) this.schedule(0);
                    else await this.processQueueLocked({ oneTime: true });
                    return;
                }
                await journal.replaceBaseline(await this.baselineRows(local, remote), snapshot.revision, signature);
                await journal.setMeta('lastReconcileAt', this.now());
                await this.notify('autoReady');
                return;
            }

            const baseline = new Map(oldBaseline.map(row => [row.key, row]));
            const snapshot = metadata.revision === oldRevision ? null : await this.serverSnapshot();
            const remote = snapshot ? this.snapshotMap(snapshot, options) : null;
            const pending = [];
            const nextBaseline = [];
            const keys = new Set([...local.keys(), ...baseline.keys(), ...(remote ? remote.keys() : [])]);
            let conflictKeys = [];
            const remoteOnlyKeys = [];
            for (const key of keys) {
                const old = baseline.get(key) || { key, hash: null, localHash: null, value: null };
                const currentLocal = local.get(key);
                const localHash = currentLocal === undefined ? null : (await this.hashes.hash(currentLocal)).hash;
                const currentRemote = remote ? remote.get(key) : undefined;
                const remoteHash = remote ? (currentRemote === undefined ? null : (await this.hashes.hash(currentRemote)).hash) : old.hash;
                const localChanged = localHash !== (old.localHash ?? null);
                const remoteChanged = remote ? remoteHash !== (old.hash ?? null) : false;
                if (localChanged && remoteChanged && localHash !== remoteHash) conflictKeys.push(key);
                if (localChanged && prefs.upload && (!remoteChanged || localHash === remoteHash)) {
                    if (localHash !== remoteHash) pending.push({ key, value: currentLocal ?? null, deleted: currentLocal === undefined,
                        beforeHash: remoteHash, previousValue: currentRemote ?? old.value ?? null });
                }
                if (remoteChanged && !localChanged) remoteOnlyKeys.push(key);
                const chosenRemoteValue = remote ? currentRemote : old.value;
                // Upload-only mode must remember an unseen remote change as a
                // per-key conflict. Advancing this key's baseline to the remote
                // value would silently let a later local edit overwrite it.
                const preserveRemoteChange = remoteChanged && !prefs.download;
                nextBaseline.push({ key, hash: preserveRemoteChange ? old.hash ?? null : remoteHash,
                    localHash: remoteChanged && !localChanged && prefs.download ? remoteHash
                        : localChanged && localHash === remoteHash ? localHash : old.localHash,
                    value: preserveRemoteChange ? old.value ?? null : chosenRemoteValue ?? null });
            }
            if (conflictKeys.length) {
                const choice = await this.conflictChoice(local, remote || new Map());
                if (choice === 'later') {
                    await this.pauseForConflict();
                    return;
                }
                if (choice === 'download') {
                    await this.api.applyAutomaticDownload(snapshot, options);
                    this.suppressUntil = this.now() + 2000;
                    const refreshed = this.snapshotMap(snapshot, options);
                    await journal.replaceBaseline(await this.baselineRows(refreshed, refreshed), snapshot.revision, signature);
                    await journal.clearPending();
                    await this.notify('autoReady');
                    return;
                }
                if (choice !== 'upload') return;
                for (const key of conflictKeys) {
                    const localValue = local.get(key);
                    const remoteValue = remote.get(key);
                    pending.push({ key, value: localValue ?? null, deleted: localValue === undefined,
                        beforeHash: remoteValue === undefined ? null : (await this.hashes.hash(remoteValue)).hash,
                        previousValue: remoteValue ?? null, force: true });
                }
            }
            if (prefs.download && remoteOnlyKeys.length) {
                await this.api.applyAutomaticDownload(snapshot, options, new Set(remoteOnlyKeys));
                this.suppressUntil = this.now() + 2000;
            }
            await journal.replaceBaseline(nextBaseline, metadata.revision, signature);
            if (pending.length) {
                await journal.queue(pending);
                await this.notify('autoPending');
                if (prefs.upload) this.schedule(0);
                else await this.processQueueLocked({ oneTime: true });
            } else await this.notify('autoReady');
        });
    }

    async flushDirty() {
        this.win.clearTimeout(this.timer); this.timer = null;
        if (!this.localPrefs().upload || this.localPrefs().paused || !this.dirty.size) return;
        const gap = this.lastBatchStart + MIN_BATCH_GAP_MS - this.now();
        if (gap > 0) { this.schedule(gap); return; }
        const keys = [...this.dirty]; this.dirty.clear();
        this.win.clearTimeout(this.maxTimer); this.maxTimer = null; this.firstDirtyAt = 0;
        try {
            await this.withLock(async () => {
                if (this.api.busy() || this.hasActiveRequest()) {
                    keys.forEach(key => this.dirty.add(key));
                    this.firstDirtyAt ||= this.now();
                    this.waitingForActivity = this.apiActive.size > 0;
                    this.waitingForOperation = Boolean(this.api.busy());
                    await this.notify('autoWaiting');
                    return;
                }
                const options = this.options();
                const journal = await this.openJournal();
                const pending = [];
                for (const key of keys) {
                    if (isInternalKey(key)) continue;
                    const value = this.storage.getItem(key);
                    const baseline = await journal.getBaseline(key);
                    if (value !== null && !inCurrentScope(key, value, options)) continue;
                    if (!baseline && value === null) continue;
                    const localHash = value === null ? null : (await this.hashes.hash(value)).hash;
                    if (localHash === (baseline?.localHash ?? null)) continue;
                    if (localHash === (baseline?.hash ?? null)) {
                        pending.push({ key, cancel: true });
                        await journal.setBaseline([{ key, hash: baseline.hash, localHash, value: value ?? null }], await journal.getMeta('revision'));
                        continue;
                    }
                    pending.push({ key, value: value ?? null, deleted: value === null,
                        beforeHash: baseline?.hash ?? null, previousValue: baseline?.value ?? null });
                }
                if (pending.length) {
                    await journal.queue(pending);
                    await this.notify('autoPending');
                    await this.processQueueLocked();
                } else await this.notify('autoReady');
            });
        } catch (error) {
            if (error.code === 'operationBusy') { keys.forEach(key => this.dirty.add(key)); this.waitingForOperation = true; this.schedule(5000); }
            else this.pauseFor(error);
        }
    }

    schedule(delay = 0) {
        if (!this.uploadEnabled || this.paused) return;
        this.win.clearTimeout(this.timer);
        const gap = Math.max(0, this.lastBatchStart + MIN_BATCH_GAP_MS - this.now());
        const wait = Math.max(delay, gap);
        this.nextAttemptAt = this.now() + wait;
        this.timer = this.win.setTimeout(() => this.runScheduled().catch(error => this.pauseFor(error)), wait);
    }

    async runScheduled() {
        if (this.dirty.size) return this.flushDirty();
        try { await this.withLock(() => this.processQueueLocked()); }
        catch (error) {
            if (error.code === 'operationBusy') this.schedule(5000);
            else this.pauseFor(error);
        }
    }

    async processQueueLocked({ oneTime = false } = {}) {
        const prefs = this.localPrefs();
        if (this.running || (!prefs.upload && !oneTime) || (prefs.paused && !oneTime)) return;
        this.running = true;
        const journal = await this.openJournal();
        try {
            if (this.api.busy() || this.hasActiveRequest()) {
                this.waitingForOperation = Boolean(this.api.busy());
                this.waitingForActivity = this.hasActiveRequest();
                await this.notify('autoWaiting');
                return;
            }
            const batches = await journal.listBatches();
            if (batches.length) { await this.sendBatchLocked(batches[0], { oneTime: batches[0].oneTime === true }); return; }
            const pending = await journal.listPending();
            if (!pending.length) { await this.notify('autoReady'); return; }
            const options = this.options();
            const metadata = await this.serverMetadata();
            const mutations = [];
            const conflicts = [];
            const satisfied = [];
            for (const row of pending) {
                const remoteHash = metadata.entries?.[row.key]?.deleted ? null : (metadata.entries?.[row.key]?.hash ?? null);
                const localValue = row.deleted ? null : row.value;
                const localHash = localValue === null ? null : (await this.hashes.hash(localValue)).hash;
                if (remoteHash !== row.beforeHash && remoteHash !== localHash) { conflicts.push(row.key); continue; }
                if (remoteHash === localHash) { satisfied.push({ ...row, localHash, remoteHash }); continue; }
                const mutation = { key: row.key, beforeHash: remoteHash, afterHash: localHash, deleted: row.deleted === true,
                    localValue };
                if (row.deleted) mutation.afterHash = null;
                else {
                    const prepared = await this.hashes.prepare(row.previousValue, localValue);
                    mutation.afterHash = prepared.afterHash;
                    if (prepared.delta) mutation.delta = prepared.delta;
                    else mutation.value = localValue;
                }
                mutations.push(mutation);
            }
            if (satisfied.length) {
                await journal.queue(satisfied.map(row => ({ key: row.key, cancel: true })));
                await journal.setBaseline(satisfied.map(row => ({ key: row.key, hash: row.remoteHash,
                    localHash: row.localHash, value: row.deleted ? null : row.value, deleted: row.deleted })), metadata.revision);
            }
            if (conflicts.length) {
                const snapshot = await this.serverSnapshot();
                const remote = this.snapshotMap(snapshot, options);
                const local = await this.readLocalSnapshot(options);
                const choice = await this.conflictChoice(local, remote);
                if (choice === 'later') { await this.pauseForConflict(); return; }
                if (choice === 'download') {
                    await this.api.applyAutomaticDownload(snapshot, options);
                    await journal.replaceBaseline(await this.baselineRows(remote, remote), snapshot.revision, this.signature());
                    await journal.clearPending();
                    await this.notify('autoReady'); return;
                }
                for (const row of pending.filter(item => conflicts.includes(item.key))) {
                    const remoteValue = remote.get(row.key);
                    const localValue = row.deleted ? null : row.value;
                    const afterHash = localValue === null ? null : (await this.hashes.hash(localValue)).hash;
                    const prepared = localValue === null ? null : await this.hashes.prepare(remoteValue, localValue);
                    mutations.push({ key: row.key, beforeHash: remoteValue === undefined ? null : (await this.hashes.hash(remoteValue)).hash,
                        afterHash, deleted: localValue === null, localValue,
                        ...(localValue === null ? {} : prepared.delta ? { delta: prepared.delta } : { value: localValue }) });
                }
            }
            const active = mutations;
            if (!active.length) {
                await this.notify('autoReady'); return;
            }
            const operationId = randomId('auto');
            const payload = { account: this.account, deviceId: this.api.persistDevice(), operationId,
                expectedRevision: metadata.revision, mode: this.mode(), automatic: true,
                scope: { mode: this.mode(), selectedScope: options.selectedScope || null,
                    maxValueBytes: options.maxValueBytes || DEFAULT_MAX_VALUE_BYTES,
                    additionalExcludes: options.additionalExcludes || [] },
                mutations: active.map(({ localValue: _localValue, ...mutation }) => mutation) };
            const url = this.endpoint('/incremental/commit');
            const createdAt = this.now();
            const batch = { operationId, account: this.account, databaseName: this.databaseName, payload, url, oneTime,
                confirmations: active.map(({ key, deleted, localValue, afterHash }) => ({ key, deleted: deleted === true, localValue, afterHash })),
                headers: this.api.headers?.() || {}, createdAt, state: 'queued' };
            await journal.putBatch(batch);
            if (!this.localPrefs().upload && !oneTime) { await journal.removeBatch(operationId); return; }
            this.lastBatchStart = createdAt;
            await this.notify('autoSending');
            if (this.localPrefs().upload) await this.scheduleBackground(batch);
            await this.sendBatchLocked(batch, { oneTime });
        } catch (error) {
            await this.handleFailure(error);
        } finally { this.running = false; }
    }

    async encodeBase64(bytes) {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
        return btoa(binary);
    }

    async sendPayload(batch, { keepalive = false } = {}) {
        const text = JSON.stringify(batch.payload);
        const bytes = new TextEncoder().encode(text);
        if (bytes.byteLength <= CHUNK_BYTES) {
            return this.api.request(batch.url, { method: 'POST', headers: batch.headers, body: text, ...(keepalive ? { keepalive: true } : {}) });
        }
        const count = Math.ceil(bytes.byteLength / CHUNK_BYTES);
        const digest = (await this.hashes.hash(text)).hash;
        const mode = batch.payload.mode;
        await this.api.request('/incremental/transfers/start', { method: 'POST', headers: batch.headers,
            body: JSON.stringify({ mode, account: batch.account, operationId: batch.operationId,
                expectedRevision: batch.payload.expectedRevision, chunks: count, bytes: bytes.byteLength, digest }) });
        for (let index = 0; index < count; index++) {
            const slice = bytes.subarray(index * CHUNK_BYTES, Math.min(bytes.length, (index + 1) * CHUNK_BYTES));
            await this.api.request(`/incremental/transfers/${encodeURIComponent(batch.operationId)}/chunks/${index}?mode=${encodeURIComponent(mode)}`,
                { method: 'PUT', headers: batch.headers, body: JSON.stringify({ data: await this.encodeBase64(slice) }) });
        }
        return this.api.request(`/incremental/transfers/${encodeURIComponent(batch.operationId)}/finish?mode=${encodeURIComponent(mode)}`,
            { method: 'POST', headers: batch.headers, body: JSON.stringify({ account: batch.account }) });
    }

    async sendBatchLocked(batch, options = {}) {
        this.sending = true;
        this.activeBatchOperationId = batch.operationId;
        this.failedBatchOperationId = '';
        this.failedBatchOneTime = false;
        try {
            const journal = await this.openJournal();
            if (await journal.getMeta('uploadEnabled') !== true && !options.oneTime && !batch.oneTime) return;
            batch.headers = { ...batch.headers, ...(this.api.headers?.() || {}) };
            const query = '?mode=' + encodeURIComponent(batch.payload.mode);
            let receipt;
            try { receipt = await this.api.request(`/incremental/commits/${encodeURIComponent(batch.operationId)}${query}`); }
            catch (error) { if (error.code !== 'commitNotFound') throw error; }
            if (!receipt && (!this.localPrefs().upload || await journal.getMeta('uploadEnabled') !== true)
                && !options.oneTime && !batch.oneTime) {
                await journal.removeBatch(batch.operationId);
                return;
            }
            if (!receipt) {
                batch.state = 'sending';
                await (await this.openJournal()).putBatch(batch);
                receipt = await this.sendPayload(batch, options);
            }
            await (await this.openJournal()).confirmBatch(batch, receipt.revision);
            this.lastConfirmedAt = this.now();
            this.retryCount = 0;
            this.error = '';
            this.errorDetail = '';
            await this.notify('autoConfirmed');
            const pending = await (await this.openJournal()).listPending();
            if (pending.length && this.localPrefs().upload) this.schedule(MIN_BATCH_GAP_MS);
        } catch (error) {
            this.failedBatchOperationId = batch.operationId;
            this.failedBatchOneTime = batch.oneTime === true || options.oneTime === true;
            throw error;
        } finally { this.sending = false; this.activeBatchOperationId = ''; }
    }

    async handleFailure(error) {
        if (error.code === 'operationBusy') { this.schedule(5000); await this.notify('autoWaiting'); return; }
        if (error.status === 409 || /Conflict/u.test(error.code || '')) {
            if (this.failedBatchOperationId) {
                await this.openJournal().then(journal => journal.removeBatch(this.failedBatchOperationId)).catch(() => {});
                this.failedBatchOperationId = '';
                this.failedBatchOneTime = false;
            }
            await this.pauseForConflict();
            this.api.failure?.(error);
            return;
        }
        const transient = error instanceof TypeError || [408, 429, 500, 502, 503, 504].includes(error.status);
        if (transient && this.retryCount < RETRY_MS.length) {
            const delay = RETRY_MS[this.retryCount++];
            this.error = error.code || error.message;
            this.nextAttemptAt = this.now() + delay;
            this.win.clearTimeout(this.retryTimer);
            const oneTime = this.failedBatchOneTime === true;
            this.retryTimer = this.win.setTimeout(() => this.withLock(() => this.processQueueLocked({ oneTime })).catch(reason => this.pauseFor(reason)), delay);
            await this.notify('autoOffline');
            return;
        }
        this.pauseFor(error);
    }

    async flushPreparedForClose() {
        if (this.sending) return;
        try {
            const batch = (await (await this.openJournal()).listBatches())[0];
            if (!batch || (!this.localPrefs().upload && !batch.oneTime)) return;
            if (byteLength(JSON.stringify(batch.payload)) > KEEPALIVE_BYTES) return;
            await this.withLock(() => this.sendBatchLocked(batch, { keepalive: true, oneTime: batch.oneTime === true }));
        } catch { /* A queued write is not displayed as confirmed; next open retries it. */ }
    }

    async pause() {
        this.savePrefs({ paused: true });
        this.paused = true;
        this.clearTimers();
        await this.openJournal().then(journal => journal.setMeta('uploadEnabled', false));
        this.observer?.destroy(); this.observer = null;
        this.stopActivityMonitor();
        await this.notify('autoPaused');
    }

    async pauseForConflict() {
        this.savePrefs({ paused: true });
        this.paused = true;
        this.clearTimers();
        await this.openJournal().then(journal => journal.setMeta('uploadEnabled', false)).catch(() => {});
        this.observer?.destroy(); this.observer = null;
        this.stopActivityMonitor();
        await this.notify('autoConflict');
    }

    async retry() {
        this.savePrefs({ paused: false });
        this.paused = false;
        this.retryCount = 0;
        this.error = '';
        this.errorDetail = '';
        this.uploadEnabled = this.localPrefs().upload === true;
        this.downloadEnabled = this.localPrefs().download === true;
        await this.openJournal().then(journal => journal.setMeta('uploadEnabled', this.uploadEnabled));
        this.lastBatchStart = await this.journal.getMeta('lastBatchStart', 0) || 0;
        if (this.uploadEnabled) await this.startObserver();
        this.ensureActivityMonitor();
        if (this.uploadEnabled || this.downloadEnabled) {
            await this.reconcile('retry');
            if (this.uploadEnabled) await this.withLock(() => this.processQueueLocked());
            else await this.withLock(() => this.processQueueLocked({ oneTime: true }));
        }
        await this.notify(this.uploadEnabled || this.downloadEnabled ? 'autoReady' : 'autoOff');
    }

    async scopeChanged() {
        if (!this.localPrefs().upload && !this.localPrefs().download) return;
        this.dirty.clear();
        try { await this.reconcile('scope'); }
        catch (error) { if (error.code === 'operationBusy') this.deferReconcile(); else this.pauseFor(error); }
    }

    deferReconcile(delay = 1000) {
        if (this.reconcileTimer || (!this.uploadEnabled && !this.downloadEnabled) || this.paused) return;
        this.reconcileRequested = true;
        if (this.api.busy() || this.hasActiveRequest()) {
            this.waitingForOperation = Boolean(this.api.busy());
            this.waitingForActivity = this.hasActiveRequest();
            this.notify('autoWaiting').catch(() => {});
            return;
        }
        // A different tab can hold the account lock without exposing its local
        // request state. Back off instead of polling the full snapshot every second.
        if (delay === 1000) delay = 5000;
        this.nextAttemptAt = this.now() + delay;
        this.reconcileTimer = this.win.setTimeout(() => {
            this.reconcileTimer = null;
            this.reconcile('resume').catch(error => error.code === 'operationBusy' ? this.deferReconcile() : this.pauseFor(error));
        }, delay);
        this.notify('autoWaiting').catch(() => {});
    }

    pauseFor(error) {
        this.clearTimers();
        this.error = error.code || error.message || 'autoPaused';
        this.errorDetail = error.message || '';
        this.paused = true;
        try { this.savePrefs({ paused: true }); } catch { /* Report the first failure. */ }
        this.openJournal().then(journal => journal.setMeta('uploadEnabled', false)).catch(() => {});
        this.observer?.destroy(); this.observer = null;
        this.stopActivityMonitor();
        this.notify(error.code === 'autoClearDetected' ? 'autoClearDetected' : 'autoPaused').catch(() => {});
        if (error.code !== 'operationBusy') this.api.failure?.(error);
    }

    configure() {
        if (this.localPrefs().upload && !this.localPrefs().paused && !this.observer) this.startObserver().catch(error => this.pauseFor(error));
        else if (!this.localPrefs().upload) { this.observer?.destroy(); this.observer = null; }
        this.ensureActivityMonitor();
        if (this.entryRequested && this.downloadEnabled && !this.paused) {
            this.entryRequested = false;
            this.reconcile('entry').catch(error => error.code === 'operationBusy' ? this.deferReconcile() : this.pauseFor(error));
        }
    }

    state() { return { blocked: this.paused, error: this.error, intent: this.running || this.sending || this.status === 'autoOffline' }; }
    get entry() { return this.entryRequested; }
    set entry(value) { this.entryRequested = Boolean(value); }
    beginActivity() {
        if ((this.uploadEnabled || this.downloadEnabled) && !this.paused) return this.beginRequestActivity();
        return null;
    }
    endActivity(id) {
        if (this.apiActive.has(id)) this.endRequestActivity(id);
    }
    fatal(error) { this.pauseFor(error); }

    async remember(localValues, remoteState) {
        if (!this.localPrefs().upload && !this.localPrefs().download) return;
        const options = this.options();
        const remote = this.api.serverValues ? this.api.serverValues(remoteState, options) : new Map();
        const rows = await this.baselineRows(localValues, remote);
        const journal = await this.openJournal();
        await journal.replaceBaseline(rows, remoteState.revision, this.signature());
    }

    destroy() {
        this.clearTimers();
        this.observer?.destroy(); this.observer = null;
        this.hashes.destroy();
        this.journal?.close(); this.journal = null;
        this.win.removeEventListener('pagehide', this.pagehide);
        this.win.removeEventListener('pageshow', this.pageshow);
        this.win.removeEventListener('storage', this.prefStorageEvent);
        this.win.navigator.serviceWorker?.removeEventListener('message', this.serviceWorkerMessage);
    }
}
