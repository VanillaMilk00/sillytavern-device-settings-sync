import { openAutoJournal, requestResult, transactionDone } from './auto-journal.js';
import { StorageError } from './storage-model.js';

export const LEASE_MS = 30_000;
export const RENEW_MS = 5_000;
export const LEASE_KEY = '@coord:lease';
const ACTIVITY_PREFIX = '@coord:activity:';

// The IDB transaction serializes acquisition. Its epoch also fences every journal
// write after a suspended tab loses ownership. Server CAS/receipts fence commits.
export class OperationCoordinator {
    constructor(win, account, { now = () => Date.now() } = {}) {
        this.win = win; this.account = account; this.now = now;
        this.name = 'dss-sync:' + account;
        this.native = Boolean(win.navigator?.locks?.request);
        this.owner = [...win.crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16)).join('-');
        this.dbPromise = null; this.held = null; this.busy = false;
        this.activities = new Map(); this.activityTimer = null;
    }

    database() {
        if (!this.dbPromise) this.dbPromise = openAutoJournal(this.win.indexedDB, this.account).catch(error => { this.dbPromise = null; throw error; });
        return this.dbPromise;
    }

    async probe() {
        if (this.native) {
            try { await this.win.navigator.locks.request(this.name + ':probe:' + this.owner, () => {}); }
            catch { this.native = false; }
        }
        const db = await this.database();
        const tx = db.transaction('meta', 'readwrite');
        const done = transactionDone(tx);
        const key = '@coord:probe:' + this.owner;
        tx.objectStore('meta').put({ key, value: true });
        tx.objectStore('meta').delete(key);
        await done;
    }

    async editMeta(work) {
        const db = await this.database();
        const tx = db.transaction('meta', 'readwrite');
        const done = transactionDone(tx);
        try { const result = await work(tx.objectStore('meta')); await done; return result; }
        catch (error) { try { tx.abort(); } catch { /* already complete */ } await done.catch(() => {}); throw error; }
    }

    async assertOwned(tx = null) {
        if (this.native || this.localFallback) return;
        const lease = this.held;
        if (!lease || this.lost) throw new StorageError('autoLeaseLost');
        const db = tx ? null : await this.database();
        const transaction = tx || db.transaction('meta', 'readonly');
        const row = await requestResult(transaction.objectStore('meta').get(LEASE_KEY));
        if (!row || row.owner !== this.owner || row.epoch !== lease.epoch || this.held?.epoch !== lease.epoch || row.expires <= this.now()) throw new StorageError('autoLeaseLost');
    }

    async acquire() {
        return this.editMeta(async store => {
            const current = await requestResult(store.get(LEASE_KEY));
            if (current?.owner && current.expires > this.now()) throw new StorageError('operationBusy');
            const records = await requestResult(store.getAll());
            for (const row of records) if (row.key.startsWith(ACTIVITY_PREFIX)) {
                if (row.expires <= this.now()) throw new StorageError('autoActivityUncertain');
                throw new StorageError('operationBusy');
            }
            const lease = { key: LEASE_KEY, owner: this.owner, epoch: (current?.epoch || 0) + 1, expires: this.now() + LEASE_MS };
            store.put(lease); return lease;
        });
    }

    async renew() {
        return this.editMeta(async store => {
            const row = await requestResult(store.get(LEASE_KEY));
            if (!row || row.owner !== this.owner || row.epoch !== this.held?.epoch || row.expires <= this.now()) throw new StorageError('autoLeaseLost');
            store.put({ ...row, expires: this.now() + LEASE_MS });
        });
    }

    async withLock(work, { manual = false } = {}) {
        if (this.busy) throw new StorageError('operationBusy');
        this.busy = true;
        let timer;
        let renewing = true;
        try {
            if (this.native) {
                let entered = false;
                try {
                    return await this.win.navigator.locks.request(this.name, { ifAvailable: true }, lock => {
                        if (!lock) throw new StorageError('operationBusy');
                        entered = true; return work();
                    });
                } catch (error) {
                    if (entered || !['SecurityError', 'NotSupportedError'].includes(error.name)) throw error;
                    this.native = false;
                }
            }
            // Only manual actions may fall back to a single-page mutex.
            try { await this.database(); } catch (error) {
                if (!manual) throw new StorageError('autoCoordinationUnavailable');
                this.localFallback = true; return await work();
            }
            try { this.held = await this.acquire(); }
            catch (error) {
                if (['operationBusy', 'autoActivityUncertain'].includes(error.code)) throw error;
                if (!manual) throw new StorageError('autoCoordinationUnavailable');
                this.localFallback = true; return await work();
            }
            const renew = async () => {
                try { await this.renew(); }
                catch { this.lost = true; return; }
                if (renewing) timer = this.win.setTimeout(renew, RENEW_MS);
            };
            timer = this.win.setTimeout(renew, RENEW_MS);
            const result = await work();
            await this.assertOwned();
            return result;
        } finally {
            renewing = false;
            if (timer) this.win.clearTimeout(timer);
            if (this.held) {
                const epoch = this.held.epoch;
                await this.editMeta(async store => {
                    const row = await requestResult(store.get(LEASE_KEY));
                    if (row?.owner === this.owner && row.epoch === epoch) store.put({ ...row, owner: '', expires: 0 });
                }).catch(() => {});
            }
            this.held = null; this.localFallback = false; this.lost = false; this.busy = false;
        }
    }

    beginActivity(id, onError) {
        if (this.native) {
            const state = {};
            this.activities.set(id, state);
            this.win.navigator.locks.request(this.name, { mode: 'shared' }, () => {
                if (!this.activities.has(id)) return;
                return new Promise(resolve => { state.release = resolve; });
            }).catch(onError);
            return;
        }
        const state = { key: ACTIVITY_PREFIX + this.owner + ':' + id };
        this.activities.set(id, state);
        state.ready = this.editMeta(store => {
            if (this.activities.has(id)) store.put({ key: state.key, owner: this.owner, expires: this.now() + LEASE_MS });
        }).catch(onError);
        if (!this.activityTimer) {
            const renew = async () => {
                this.activityTimer = null;
                if (!this.activities.size) return;
                try {
                    await this.editMeta(store => {
                        for (const item of this.activities.values()) store.put({ key: item.key, owner: this.owner, expires: this.now() + LEASE_MS });
                    });
                } catch (error) { onError(error); return; }
                if (this.activities.size) this.activityTimer = this.win.setTimeout(renew, RENEW_MS);
            };
            this.activityTimer = this.win.setTimeout(renew, RENEW_MS);
        }
    }

    endActivity(id) {
        const state = this.activities.get(id);
        if (!state) return;
        this.activities.delete(id);
        state.release?.();
        const cleanup = this.native ? Promise.resolve() : Promise.resolve(state.ready).then(() => this.editMeta(store => store.delete(state.key))).catch(() => {});
        if (!this.activities.size && this.activityTimer) { this.win.clearTimeout(this.activityTimer); this.activityTimer = null; }
        return cleanup;
    }

    async resetStaleActivities() {
        if (this.native) return;
        await this.editMeta(async store => {
            for (const row of await requestResult(store.getAll())) if (row.key.startsWith(ACTIVITY_PREFIX) && row.expires <= this.now()) store.delete(row.key);
        });
    }

    async destroy() {
        await Promise.all([...this.activities.keys()].map(id => this.endActivity(id)));
        await this.dbPromise?.then(db => db.close()).catch(() => {});
    }
}
