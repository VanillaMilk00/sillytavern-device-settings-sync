const DB_VERSION = 1;
const STORES = ['meta', 'baseline', 'pending', 'batches'];

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Automatic sync journal request failed'));
    });
}

export function journalDatabaseName(account) {
    return 'device-settings-sync-internal:' + encodeURIComponent(String(account || ''));
}

export function openAutoJournal(factory = globalThis.indexedDB, account = '') {
    if (!factory?.open) return Promise.reject(Object.assign(new Error('IndexedDB is unavailable'), { code: 'autoJournalUnavailable' }));
    const name = journalDatabaseName(account);
    return new Promise((resolve, reject) => {
        const request = factory.open(name, DB_VERSION);
        request.onupgradeneeded = () => {
            for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) {
                request.result.createObjectStore(store, { keyPath: store === 'batches' ? 'operationId' : store === 'meta' ? 'key' : 'id' });
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            resolve(db);
        };
        request.onerror = () => reject(request.error || Object.assign(new Error('Could not open automatic sync journal'), { code: 'autoJournalUnavailable' }));
        request.onblocked = () => reject(Object.assign(new Error('Automatic sync journal is blocked by another tab'), { code: 'autoJournalUnavailable' }));
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Automatic sync journal transaction failed'));
        transaction.onabort = () => reject(transaction.error || new Error('Automatic sync journal transaction was aborted'));
    });
}

export class AutoJournal {
    constructor(db, namespace = 'portable') { this.db = db; this.namespace = namespace; this.prefix = namespace + '\u0000'; }

    async getMeta(key, fallback = null) {
        const tx = this.db.transaction('meta', 'readonly');
        const row = await requestResult(tx.objectStore('meta').get(this.namespace + ':' + key));
        return row ? row.value : fallback;
    }

    async setMeta(key, value) {
        const tx = this.db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ key: this.namespace + ':' + key, value });
        await transactionDone(tx);
    }

    async getBaseline(key) {
        const tx = this.db.transaction('baseline', 'readonly');
        const row = await requestResult(tx.objectStore('baseline').get(this.prefix + key));
        return row ? { ...row, key } : null;
    }

    async listBaseline() {
        const tx = this.db.transaction('baseline', 'readonly');
        return (await requestResult(tx.objectStore('baseline').getAll()))
            .filter(row => row.id.startsWith(this.prefix)).map(row => ({ ...row, key: row.key }));
    }

    async replaceBaseline(rows, revision, signature) {
        const tx = this.db.transaction(['baseline', 'meta'], 'readwrite');
        const store = tx.objectStore('baseline');
        const oldRows = await requestResult(store.getAll());
        for (const row of oldRows) if (row.id.startsWith(this.prefix)) store.delete(row.id);
        for (const row of rows) store.put({ ...row, id: this.prefix + row.key });
        tx.objectStore('meta').put({ key: this.namespace + ':revision', value: revision });
        tx.objectStore('meta').put({ key: this.namespace + ':signature', value: signature });
        tx.objectStore('meta').put({ key: this.namespace + ':initialized', value: true });
        await transactionDone(tx);
    }

    async setBaseline(rows, revision) {
        const tx = this.db.transaction(['baseline', 'meta'], 'readwrite');
        const store = tx.objectStore('baseline');
        for (const row of rows) row.deleted ? store.delete(this.prefix + row.key) : store.put({ ...row, id: this.prefix + row.key });
        tx.objectStore('meta').put({ key: this.namespace + ':revision', value: revision });
        await transactionDone(tx);
    }

    async queue(rows) {
        const tx = this.db.transaction('pending', 'readwrite');
        const store = tx.objectStore('pending');
        for (const row of rows) row.cancel ? store.delete(this.prefix + row.key) : store.put({ ...row, id: this.prefix + row.key });
        await transactionDone(tx);
    }

    async listPending() {
        const tx = this.db.transaction('pending', 'readonly');
        return (await requestResult(tx.objectStore('pending').getAll()))
            .filter(row => row.id.startsWith(this.prefix)).map(row => ({ ...row, key: row.key }));
    }

    async clearPending() {
        const tx = this.db.transaction('pending', 'readwrite');
        const store = tx.objectStore('pending');
        const rows = await requestResult(store.getAll());
        for (const row of rows) if (row.id.startsWith(this.prefix)) store.delete(row.id);
        await transactionDone(tx);
    }

    async clearAllPending() {
        const tx = this.db.transaction('pending', 'readwrite');
        const store = tx.objectStore('pending');
        for (const row of await requestResult(store.getAll())) store.delete(row.id);
        await transactionDone(tx);
    }

    async clearBatches() {
        const tx = this.db.transaction('batches', 'readwrite');
        const store = tx.objectStore('batches');
        for (const batch of await requestResult(store.getAll())) store.delete(batch.operationId);
        await transactionDone(tx);
    }

    async putBatch(batch) {
        const tx = this.db.transaction(['batches', 'meta'], 'readwrite');
        tx.objectStore('batches').put(batch);
        tx.objectStore('meta').put({ key: this.namespace + ':lastBatchStart', value: batch.createdAt });
        await transactionDone(tx);
    }

    async listBatches() {
        const tx = this.db.transaction('batches', 'readonly');
        const rows = await requestResult(tx.objectStore('batches').getAll());
        return rows.sort((a, b) => a.createdAt - b.createdAt);
    }

    async removeBatch(operationId) {
        const tx = this.db.transaction('batches', 'readwrite');
        tx.objectStore('batches').delete(operationId);
        await transactionDone(tx);
    }

    async confirmBatch(batch, revision) {
        const tx = this.db.transaction(['baseline', 'pending', 'batches', 'meta'], 'readwrite');
        const baseline = tx.objectStore('baseline');
        const pending = tx.objectStore('pending');
        const confirmations = batch.confirmations || batch.payload.mutations.map(mutation => ({ ...mutation,
            localValue: Object.hasOwn(mutation, 'localValue') ? mutation.localValue : mutation.value }));
        const rows = await Promise.all(confirmations.map(async mutation => ({
            mutation, current: await requestResult(pending.get(this.prefix + mutation.key)),
        })));
        for (const { mutation, current } of rows) {
            const value = mutation.localValue;
            const unchanged = current && current.deleted === (mutation.deleted === true) && current.value === value;
            if (unchanged) pending.delete(this.prefix + mutation.key);
            if (mutation.deleted) baseline.delete(this.prefix + mutation.key);
            else baseline.put({ id: this.prefix + mutation.key, key: mutation.key, hash: mutation.afterHash,
                localHash: mutation.afterHash, value });
        }
        tx.objectStore('batches').delete(batch.operationId);
        tx.objectStore('meta').put({ key: this.namespace + ':revision', value: revision });
        tx.objectStore('meta').put({ key: this.namespace + ':lastConfirmedAt', value: Date.now() });
        await transactionDone(tx);
    }

    close() { this.db.close(); }
}

export { requestResult, transactionDone };
