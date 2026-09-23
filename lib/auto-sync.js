import { AUTO_PREFIX, IDLE_MS, RETRY_MS, fingerprint, decideSync, planRemote, isTransient, sortedEntries } from './auto-core.js';
import { readStorage, applyPlan, StorageError } from './storage-model.js';
import { snapshotPortableStorage, serverStateToPortableValues, diffSnapshots } from './sync-core.js';
import { monitorActivity } from './activity-monitor.js';

const uid = () => 'auto_' + Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
const dataOnly = values => new Map([...values].filter(([key]) => !key.startsWith(AUTO_PREFIX)));

export class AutoSync {
    constructor(api, { window: win = window, account, now = () => Date.now() }) {
        this.api = api;
        this.win = win;
        this.storage = win.localStorage;
        this.session = win.sessionStorage;
        this.now = now;
        // localStorage already isolates origin and browser device. Do not use a
        // provisional device ID: two pristine tabs may not have persisted it yet.
        // ':' cannot occur in encodeURIComponent(account), so scopes cannot overlap.
        this.key = AUTO_PREFIX + encodeURIComponent(account) + ':';
        this.lock = 'dss-sync:' + account;
        this.tab = uid();
        this.active = new Set();
        this.entry = false;
        this.timer = null;
        this.running = false;
        this.monitor = null;
        this.supported = Boolean(win.isSecureContext && win.navigator.locks?.request && win.navigator.locks?.query && win.crypto?.subtle && win.PerformanceObserver);
        this.row = { active: 0, lastEnd: 0, cycle: '', started: 0 };
        this.status = 'autoOff';
        this.storageEvent = event => {
            if (!event.key?.startsWith(this.key)) return;
            this.configure(false);
        };
        this.resumeEvent = () => { if (this.enabled()) this.configure(false); };
        this.visibilityEvent = () => { if (win.document.visibilityState === 'visible') this.resumeEvent(); };
        this.pagehideEvent = () => this.suspend();
        win.addEventListener('storage', this.storageEvent);
        win.addEventListener('online', this.resumeEvent);
        win.addEventListener('pageshow', this.resumeEvent);
        win.addEventListener('pagehide', this.pagehideEvent);
        win.document.addEventListener('visibilitychange', this.visibilityEvent);
    }

    read(name, fallback = {}) {
        const value = this.storage.getItem(this.key + name);
        if (!value) return fallback;
        try { return JSON.parse(value); } catch { throw new StorageError('autoMetadataInvalid'); }
    }
    write(name, value) { this.storage.setItem(this.key + name, JSON.stringify(value)); }
    prefs() { return { upload: false, download: false, paused: false, ...this.read('prefs') }; }
    enabled() { const p = this.prefs(); return p.upload || p.download; }
    state() { return this.read('state'); }
    saveState(patch) { this.write('state', { ...this.state(), ...patch }); }
    notify(status = this.status) { this.status = status; this.api.render?.(this.describe()); }
    describe() {
        const p = this.prefs();
        const state = this.state();
        return { ...p, supported: this.supported, status: this.status, active: this.sharedActive || 0,
            lastEnd: this.lastEnd || 0, due: state.retryAt || this.due || 0, error: state.error || '', limited: true };
    }
    schedule(delay = 0) {
        this.win.clearTimeout(this.timer);
        if (!this.enabled() || !this.supported) return;
        this.timer = this.win.setTimeout(() => this.tick().catch(error => this.fatal(error)), Math.max(0, delay));
    }
    fatal(error) {
        this.win.clearTimeout(this.timer);
        this.status = 'autoPaused';
        try { this.saveState({ blocked: true, error: error.code || error.message }); this.notify(); }
        catch { this.api.failure?.(error); }
    }
    async start() {
        // A marker is one-shot and tab-local, so normal future visits still check.
        let skip = false;
        try {
            const marker = JSON.parse(this.session.getItem(this.key + 'reload') || 'null');
            skip = marker && this.now() >= marker.at && this.now() - marker.at < 60000;
        } catch { /* A stale/invalid marker never suppresses a normal visit. */ }
        this.session.removeItem(this.key + 'reload');
        this.entry = this.prefs().download && !skip;
        this.configure(false);
    }
    async setOption(name, enabled) {
        if (!['upload', 'download'].includes(name)) return;
        if (enabled && !this.supported) throw new StorageError('autoUnsupported');
        this.api.persistDevice();
        const p = this.prefs();
        this.write('prefs', { ...p, [name]: enabled, ...(name === 'upload' && enabled ? { armedAfter: this.now() } : {}) });
        if (!enabled && name === 'download') this.entry = false;
        if (!enabled && name === 'upload') {
            // Disabling consumes the previous idle cycle, but not a sent commit.
            try {
                await this.withLock(async () => {
                    const activity = await this.activity();
                    this.saveState({ doneCycle: activity.cycle, retryAt: 0, retryCount: 0 });
                });
            } catch (error) { if (error.code !== 'operationBusy') throw error; }
        }
        if (enabled && name === 'download') this.entry = true;
        this.configure(false);
    }
    async pause() {
        this.write('prefs', { ...this.prefs(), paused: true });
        this.configure(false);
    }
    async retry() {
        this.write('prefs', { ...this.prefs(), paused: false });
        await this.withLock(async () => this.saveState({ blocked: false, error: '', retryAt: 0, retryCount: 0 }));
        if (this.prefs().download) this.entry = true;
        this.configure(false);
    }
    configure() {
        this.win.clearTimeout(this.timer);
        const p = this.prefs();
        if (!this.enabled() || !this.supported) {
            this.stopMonitor();
            this.notify(!this.supported ? 'autoUnsupported' : 'autoOff');
            return;
        }
        if (!this.monitor) {
            // Lifetime lock lets surviving tabs distinguish closed tabs from
            // frozen/background tabs, without guessing based on a heartbeat.
            const life = this.life = {};
            this.win.navigator.locks.request(this.lock + ':live:' + this.tab, () => {
                if (this.life !== life) return;
                return new Promise(resolve => { this.releaseLife = resolve; });
            }).catch(error => this.fatal(error));
            this.monitor = (this.api.observe || monitorActivity)({ window: this.win, ...this.api.events,
                begin: () => this.beginActivity(), end: id => this.endActivity(id) });
        }
        if (p.paused || this.state().blocked) { this.notify('autoPaused'); return; }
        this.schedule();
    }
    stopMonitor() {
        this.monitor?.();
        this.monitor = null;
        this.active.clear();
        this.life = null;
        this.releaseLife?.();
        this.releaseLife = null;
    }
    suspend() {
        this.stopMonitor();
        this.win.clearTimeout(this.timer);
    }
    destroy() {
        this.suspend();
        this.win.removeEventListener('storage', this.storageEvent);
        this.win.removeEventListener('online', this.resumeEvent);
        this.win.removeEventListener('pageshow', this.resumeEvent);
        this.win.removeEventListener('pagehide', this.pagehideEvent);
        this.win.document.removeEventListener('visibilitychange', this.visibilityEvent);
    }
    beginActivity() {
        if (!this.enabled() || !this.supported) return null;
        const id = uid();
        this.active.add(id);
        this.row = { ...this.row, started: this.now(), active: this.active.size };
        try { this.write('tab_' + this.tab, this.row); this.schedule(); }
        catch (error) { this.fatal(error); }
        return id;
    }
    endActivity(id) {
        if (!id || !this.active.delete(id)) return;
        this.row = { ...this.row, active: this.active.size, lastEnd: this.now(), cycle: uid() };
        try { this.write('tab_' + this.tab, this.row); this.schedule(); }
        catch (error) { this.fatal(error); }
    }
    async activity() {
        const locks = await this.win.navigator.locks.query();
        const live = new Set([...locks.held, ...(locks.pending || [])].map(lock => lock.name));
        let active = 0, lastEnd = 0, cycle = '';
        const inactive = [];
        const keys = [...readStorage(this.storage).keys()].filter(key => key.startsWith(this.key + 'tab_'));
        for (const key of keys) {
            let row = JSON.parse(this.storage.getItem(key));
            const tab = key.slice((this.key + 'tab_').length);
            if (row.active && tab !== this.tab && !live.has(this.lock + ':live:' + tab)) {
                row = { ...row, active: 0, lastEnd: this.now(), cycle: uid() };
                this.storage.setItem(key, JSON.stringify(row));
            }
            active += Math.max(0, Number(row.active) || 0);
            if (!row.active && tab !== this.tab && !live.has(this.lock + ':live:' + tab)) inactive.push({ key, cycle: row.cycle });
            if (row.lastEnd > lastEnd || (row.lastEnd === lastEnd && row.cycle > cycle)) {
                lastEnd = row.lastEnd; cycle = row.cycle;
            }
        }
        // Retain the newest durable cycle, but not an ever-growing history of closed tabs.
        for (const row of inactive) if (row.cycle !== cycle) this.storage.removeItem(row.key);
        this.sharedActive = active; this.lastEnd = lastEnd;
        return { active, lastEnd, cycle };
    }
    async withLock(work) {
        if (!this.win.navigator.locks?.request) return work();
        return this.win.navigator.locks.request(this.lock, { ifAvailable: true }, lock => {
            if (!lock) throw new StorageError('operationBusy');
            return work();
        });
    }
    async remember(local, remote) {
        this.saveState({ baseline: {
            localHash: await fingerprint(local), remoteHash: await fingerprint(serverStateToPortableValues(remote, this.api.options())),
            revision: remote.revision, filter: JSON.stringify(this.api.options()),
        }, blocked: false, error: '' });
    }
    async reloadWhenIdle() {
        if (!this.pendingReload || this.api.busy() || (await this.activity()).active) return false;
        this.session.setItem(this.key + 'reload', JSON.stringify({ revision: this.pendingReload, at: this.now() }));
        this.pendingReload = null;
        this.api.reload();
        return true;
    }
    async tick() {
        if (this.running || !this.enabled() || !this.supported) return;
        const prefs = this.prefs();
        if (prefs.paused || this.state().blocked) { this.notify('autoPaused'); return; }
        this.running = true;
        let completed = false;
        try {
            await this.withLock(async () => {
                const activity = await this.activity();
                const state = this.state();
                this.due = activity.lastEnd ? activity.lastEnd + IDLE_MS : 0;
                if (activity.active || this.api.busy()) { this.notify('autoWaiting'); return; }
                if (this.pendingReload) { await this.reloadWhenIdle(); return; }
                if (state.retryAt > this.now()) { this.notify('autoRetrying'); return; }
                const pendingUpload = prefs.upload && activity.cycle && activity.lastEnd >= (prefs.armedAfter || 0)
                    && activity.cycle !== state.doneCycle && this.now() >= this.due;
                // Recover an uncertain upload before downloading over its source.
                const direction = state.intent ? 'upload' : this.entry && prefs.download ? 'download' : pendingUpload ? 'upload' : null;
                if (!direction) { this.notify(this.due > this.now() && prefs.upload ? 'autoCountdown' : 'autoReady'); return; }
                const performed = await this.perform(direction, activity);
                if (performed) {
                    if (direction === 'download') this.entry = false;
                    else this.saveState({ doneCycle: performed.cycle || activity.cycle });
                    this.saveState({ retryAt: 0, retryCount: 0, error: '' });
                    completed = true;
                    this.notify('autoReady');
                }
            });
        } catch (error) {
            if (error.code === 'operationBusy') this.notify('autoWaiting');
            else if (isTransient(error)) {
                const count = this.state().retryCount || 0;
                if (count < RETRY_MS.length) {
                    this.saveState({ retryAt: this.now() + RETRY_MS[count], retryCount: count + 1, error: error.code || error.message });
                    this.notify('autoRetrying');
                } else this.fatal(error);
            } else this.fatal(error);
        } finally {
            this.running = false;
            if (this.enabled() && !this.prefs().paused && !this.state().blocked) {
                // No timer while fully idle. Waiting work rechecks without network polling.
                const activity = await this.activity();
                if (this.pendingReload || this.entry || this.state().intent || (this.prefs().upload && this.lastEnd >= (this.prefs().armedAfter || 0)
                    && activity.cycle && this.state().doneCycle !== activity.cycle)) {
                    this.schedule(completed ? 0 : 2000);
                }
            }
        }
    }
    async checkLocal(before, direction, activity, force = false) {
        if (!force && (!this.prefs()[direction] || this.prefs().paused)) throw new StorageError('operationBusy');
        if (this.api.busy() || (await this.activity()).active) throw new StorageError('operationBusy');
        if ((await this.activity()).cycle !== activity.cycle) throw new StorageError('operationBusy');
        if (!same(dataOnly(before), dataOnly(readStorage(this.storage)))) throw new StorageError('stalePreview');
    }
    async perform(direction, activity) {
        let health;
        try { health = await this.api.request('/health'); }
        catch (error) { if (error.status === 404) throw new StorageError('autoBackendMissing'); throw error; }
        if (!health.capabilities?.includes('atomic-sync-v1')) throw new StorageError('autoBackendMissing');
        let intent = this.state().intent;
        if ((this.api.options().fullStorage || intent?.fullStorage) && !health.capabilities?.includes('full-storage-v1')) throw new StorageError('fullBackendMissing');
        if (intent && direction === 'upload') {
            let receipt;
            try { receipt = await this.api.request('/commits/' + intent.operationId, {}, intent.fullStorage === true); }
            catch (error) { if (error.code !== 'commitNotFound') throw error; }
            if (receipt) {
                this.saveState({ baseline: { localHash: intent.localHash, remoteHash: intent.localHash, revision: receipt.revision, filter: intent.filter }, intent: null, doneCycle: intent.cycle });
                return { cycle: intent.cycle };
            }
            if (!this.prefs().upload) throw new StorageError('autoConflict');
        }
        const before = readStorage(this.storage);
        const options = this.api.options();
        const local = snapshotPortableStorage(this.storage, options).values;
        const remote = await this.api.request('/state');
        const remoteValues = serverStateToPortableValues(remote, options);
        const localHash = await fingerprint(local);
        const remoteHash = await fingerprint(remoteValues);
        let baseline = this.state().baseline;
        if (baseline?.filter !== JSON.stringify(options)) baseline = null;
        let decision = decideSync(direction, baseline, localHash, remoteHash, remote.seeded);
        if (direction === 'upload' && baseline && baseline.revision !== remote.revision && localHash !== remoteHash) decision = 'conflict';
        let force = false;
        if (intent && (intent.localHash !== localHash || intent.expectedRevision !== remote.revision || intent.filter !== JSON.stringify(options))) decision = 'conflict';
        await this.checkLocal(before, direction, activity);
        if (JSON.stringify(this.api.options()) !== JSON.stringify(options)) throw new StorageError('stalePreview');
        if (decision === 'conflict') {
            this.notify('autoConflict');
            const choice = await this.api.conflict({ local: local.size, remote: remoteValues.size, changes: diffSnapshots(remoteValues, local).length });
            if (!['upload', 'download'].includes(choice)) {
                this.saveState({ blocked: true, error: 'autoConflict' });
                return false;
            }
            direction = choice; decision = choice; force = true;
            intent = null;
            this.saveState({ intent: null });
            await this.checkLocal(before, direction, activity, true);
        }
        if (decision === 'equal') { await this.remember(local, remote); return true; }
        if (decision === 'empty' || decision === 'unchanged') return true;
        const changes = direction === 'upload' ? diffSnapshots(new Map(sortedEntries(remoteValues)), new Map(sortedEntries(local))) : planRemote(before, remote, options).changes;
        if (!changes.length) { await this.remember(local, remote); return true; }
        this.notify(direction === 'upload' ? 'autoUploading' : 'autoDownloading');
        // Keep an identical rescue body in memory across transport retries.
        const rescueHash = await fingerprint(dataOnly(before));
        if (!this.rescue || this.rescue.hash !== rescueHash || this.rescue.direction !== direction) {
            this.rescue = { hash: rescueHash, direction, payload: this.api.makeBackup(direction) };
        }
        if (!intent) await this.api.backup(this.rescue.payload);
        await this.checkLocal(before, direction, activity, force);
        if (JSON.stringify(this.api.options()) !== JSON.stringify(options)) throw new StorageError('stalePreview');
        if (direction === 'upload') {
            if (!intent) {
                intent = { operationId: uid(), expectedRevision: remote.revision, localHash, remoteHash,
                    filter: JSON.stringify(options), fullStorage: options.fullStorage === true, cycle: activity.cycle };
                // A small durable journal, never a duplicate of credential values.
                this.saveState({ intent });
            }
            const body = options.fullStorage ? {
                operationId: intent.operationId, expectedRevision: intent.expectedRevision,
                deviceId: this.api.persistDevice(), entries: sortedEntries(local).map(([key, value]) => ({ key, value })),
            } : {
                operationId: intent.operationId, expectedRevision: intent.expectedRevision,
                deviceId: this.api.persistDevice(), mutations: changes,
            };
            const receipt = await this.api.request('/commit', { method: 'POST', body: JSON.stringify(body) });
            this.saveState({ baseline: { localHash, remoteHash: localHash, revision: receipt.revision, filter: intent.filter }, intent: null });
        } else {
            const latest = await this.api.request('/state');
            if (latest.revision !== remote.revision) throw new StorageError('autoConflict');
            await this.checkLocal(before, direction, activity, force);
            // Own metadata may change while awaiting the network. Verify user data
            // above, then use a fresh full snapshot for the synchronous rollback plan.
            const plan = { before: readStorage(this.storage), changes };
            applyPlan(this.storage, plan);
            await this.remember(snapshotPortableStorage(this.storage, options).values, remote);
            this.pendingReload = remote.revision;
            await this.reloadWhenIdle();
        }
        this.rescue = null;
        this.api.changed();
        return true;
    }
}
