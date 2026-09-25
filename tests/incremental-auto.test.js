import test from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalAutoSync } from '../lib/incremental-auto-sync.js';

class FakeClock {
    now = 100_000;
    next = 0;
    timers = new Map();
    setTimeout = (callback, delay) => {
        const id = ++this.next;
        this.timers.set(id, { callback, delay, at: this.now + delay });
        return id;
    };
    clearTimeout = id => this.timers.delete(id);
}

function scheduler(clock) {
    const instance = Object.create(IncrementalAutoSync.prototype);
    Object.assign(instance, { win: clock, now: () => clock.now, uploadEnabled: true, paused: false,
        dirty: new Set(), timer: null, maxTimer: null, retryTimer: null, reconcileTimer: null,
        notifyTimer: null, firstDirtyAt: 0, lastBatchStart: 0, status: 'autoPending',
        apiActive: new Set(), activityLockReleases: new Map(),
        storage: { getItem() { throw new Error('notification must not read localStorage'); } } });
    return instance;
}

function reconciliationFixture({ prefs, local, baseline, remote, oldRevision = 1, revision = 2, choice = 'later' }) {
    const instance = Object.create(IncrementalAutoSync.prototype);
    const hash = value => value === undefined || value === null ? null : 'hash:' + value;
    let savedRows = null;
    let queued = [];
    const applied = [];
    const metadata = { revision, seeded: true, entries: Object.fromEntries([...remote].map(([key, value]) => [key, { hash: hash(value), deleted: false }])) };
    const snapshot = { revision, entries: Object.fromEntries([...remote].map(([key, value]) => [key, { value, deleted: false }])) };
    const journal = {
        listBatches: async () => [], listBaseline: async () => baseline,
        getMeta: async key => key === 'signature' ? 'scope' : key === 'revision' ? oldRevision : key === 'initialized' ? true : null,
        replaceBaseline: async rows => { savedRows = rows; },
        queue: async rows => { queued = rows; }, clearPending: async () => { queued = []; },
        setMeta: async () => {}, listPending: async () => queued,
    };
    Object.assign(instance, {
        api: { busy: () => false, applyAutomaticDownload: async (_snapshot, _options, allowed) => applied.push(allowed ? [...allowed] : null) },
        apiActive: new Set(), win: { setTimeout }, now: () => 10_000, withLock: work => work(),
        localPrefs: () => prefs, prefs: () => prefs, uploadEnabled: prefs.upload, downloadEnabled: prefs.download, paused: false,
        options: () => ({ fullStorage: true }), signature: () => 'scope', readLocalSnapshot: async () => new Map(local),
        serverMetadata: async () => metadata, serverSnapshot: async () => snapshot,
        hashes: { hash: async value => ({ hash: hash(value) }) }, openJournal: async () => journal,
        notify: async () => {}, schedule: () => {}, conflictChoice: async () => choice,
        pauseForConflict: async () => { instance.paused = true; },
    });
    return { instance, applied, get savedRows() { return savedRows; }, get queued() { return queued; }, snapshot };
}

test('native change notifications only coalesce key names and debounce for ten seconds', () => {
    const clock = new FakeClock();
    const instance = scheduler(clock);
    instance.noteKey('extension:theme');
    assert.deepEqual([...instance.dirty], ['extension:theme']);
    assert.equal(clock.timers.get(instance.timer).delay, 10_000);
    assert.equal(clock.timers.get(instance.maxTimer).delay, 15000);
    clock.now += 250;
    instance.noteKey('extension:theme');
    assert.deepEqual([...instance.dirty], ['extension:theme']);
    assert.equal(clock.timers.get(instance.timer).delay, 10_000);
    assert.equal(clock.timers.get(instance.maxTimer).delay, 15000);
});

test('one thousand writes to one key remain one dirty item without reading its value', () => {
    const clock = new FakeClock();
    const instance = scheduler(clock);
    let reads = 0;
    instance.storage = { getItem() { reads++; throw new Error('notifications must not read values'); } };
    instance.notify = async () => {};
    for (let index = 0; index < 1000; index++) instance.noteKey('extension:rapid-change');
    assert.deepEqual([...instance.dirty], ['extension:rapid-change']);
    assert.equal(reads, 0);
    assert.equal(clock.timers.get(instance.timer).delay, 10_000);
    assert.equal(clock.timers.get(instance.maxTimer).delay, 15000);
});

test('maximum merge time and minimum batch gap bound work without scanning idle storage', () => {
    const clock = new FakeClock();
    const instance = scheduler(clock);
    instance.lastBatchStart = clock.now - 1000;
    instance.noteKey('extension:a');
    assert.equal(clock.timers.get(instance.timer).delay, 29_000);
    assert.equal(clock.timers.get(instance.maxTimer).delay, 15000);
    instance.noteKey('extension:b');
    assert.deepEqual([...instance.dirty].sort(), ['extension:a', 'extension:b']);
    assert.equal(clock.timers.get(instance.timer).delay, 29_000);
    assert.equal(clock.timers.get(instance.maxTimer).delay, 15000);
});

test('a ready batch still waits until thirty seconds have elapsed since the prior batch', async () => {
    const clock = new FakeClock();
    const instance = scheduler(clock);
    let reads = 0;
    let scheduledDelay = null;
    instance.lastBatchStart = clock.now - 1000;
    instance.dirty.add('extension:changed');
    instance.localPrefs = () => ({ upload: true, paused: false });
    instance.schedule = delay => { scheduledDelay = delay; };
    instance.storage = { getItem() { reads++; return 'changed'; } };
    await instance.flushDirty();
    assert.equal(scheduledDelay, 29_000);
    assert.equal(reads, 0);
    assert.deepEqual([...instance.dirty], ['extension:changed']);
});

test('a change batch reads and hashes only named keys, never unrelated large localStorage values', async () => {
    const clock = new FakeClock();
    const instance = scheduler(clock);
    const reads = [];
    const queued = [];
    instance.dirty.add('extension:changed');
    instance.storage = { getItem(key) { reads.push(key); return key === 'extension:changed' ? 'new' : 'other'.repeat(500_000); } };
    instance.localPrefs = () => ({ upload: true, paused: false });
    instance.api = { busy: () => false };
    instance.legacy = { active: new Set() };
    instance.options = () => ({ fullStorage: true });
    instance.withLock = work => work();
    instance.openJournal = async () => ({
        getBaseline: async key => key === 'extension:changed' ? { localHash: 'hash:old', hash: 'hash:old', value: 'old' } : null,
        queue: async rows => queued.push(...rows),
    });
    instance.hashes = { hash: async value => ({ hash: 'hash:' + value }) };
    instance.notify = async () => {};
    instance.processQueueLocked = async () => {};
    await instance.flushDirty();
    assert.deepEqual(reads, ['extension:changed']);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].key, 'extension:changed');
    assert.equal(queued[0].value, 'new');
});

test('upload-only reconciliation retains a changed remote key as a conflict baseline', async () => {
    const instance = Object.create(IncrementalAutoSync.prototype);
    const previousHash = 'hash:previous';
    let savedRows;
    Object.assign(instance, {
        api: { busy: () => false }, win: { setTimeout }, now: () => 1_000,
        apiActive: new Set(),
        withLock: work => work(), options: () => ({ fullStorage: true }), signature: () => 'scope',
        localPrefs: () => ({ upload: true, download: false, paused: false }),
        prefs: () => ({ upload: true, download: false, paused: false }), readLocalSnapshot: async () => new Map([['user-key', 'previous']]),
        serverMetadata: async () => ({ revision: 2, entries: { 'user-key': { hash: 'hash:remote', deleted: false } } }),
        serverSnapshot: async () => ({ revision: 2, entries: { 'user-key': { value: 'remote', deleted: false } } }),
        hashes: { hash: async value => ({ hash: 'hash:' + value }) },
        baselineRows: async () => [], notify: async () => {}, schedule: () => {},
        openJournal: async () => ({
            listBatches: async () => [], listBaseline: async () => [{ key: 'user-key', hash: previousHash, localHash: previousHash, value: 'previous' }],
            getMeta: async key => key === 'signature' ? 'scope' : key === 'revision' ? 1 : key === 'initialized' ? true : null,
            replaceBaseline: async rows => { savedRows = rows; },
        }),
    });
    await instance.reconcile();
    assert.deepEqual(savedRows, [{ key: 'user-key', hash: previousHash, localHash: previousHash, value: 'previous' }]);
});

test('download-only reconciliation applies only remote-only keys and preserves local-only edits', async () => {
    const harness = reconciliationFixture({
        prefs: { upload: false, download: true, paused: false },
        local: [['remote-key', 'remote-old'], ['local-key', 'local-new']],
        baseline: [
            { key: 'remote-key', hash: 'hash:remote-old', localHash: 'hash:remote-old', value: 'remote-old' },
            { key: 'local-key', hash: 'hash:local-old', localHash: 'hash:local-old', value: 'local-old' },
        ],
        remote: new Map([['remote-key', 'remote-new'], ['local-key', 'local-old']]),
    });
    await harness.instance.reconcile();
    assert.deepEqual(harness.applied, [['remote-key']]);
    assert.deepEqual(harness.queued, []);
    assert.equal(harness.savedRows.find(row => row.key === 'local-key').localHash, 'hash:local-old');
    assert.equal(harness.savedRows.find(row => row.key === 'remote-key').localHash, 'hash:remote-new');
});

test('download mode does not rescan storage after unrelated model requests', () => {
    const instance = Object.create(IncrementalAutoSync.prototype);
    let checks = 0;
    Object.assign(instance, {
        uploadEnabled: false, downloadEnabled: true, paused: false,
        apiActive: new Set(), dirty: new Set(), notify: async () => {},
        deferReconcile: () => { checks++; },
    });
    instance.resumeAfterActivity();
    assert.equal(checks, 0);
    instance.reconcileRequested = true;
    instance.resumeAfterActivity();
    assert.equal(checks, 1, 'a check explicitly deferred by an active request must resume');
});

test('an unavailable background worker never blocks the foreground save path', async () => {
    const instance = Object.create(IncrementalAutoSync.prototype);
    Object.assign(instance, { account: 'tester', databaseName: 'journal', workerRegistration: null,
        win: { navigator: { serviceWorker: { ready: new Promise(() => {}) } } } });
    const result = await Promise.race([
        Promise.resolve(instance.scheduleBackground({})).then(() => 'returned'),
        new Promise(resolve => setTimeout(() => resolve('blocked'), 25)),
    ]);
    assert.equal(result, 'returned');
});

test('automatic switches off performs no reconciliation; two-sided changes pause for a decision', async () => {
    let reads = 0;
    const disabled = reconciliationFixture({ prefs: { upload: false, download: false, paused: false },
        local: [], baseline: [], remote: new Map() });
    disabled.instance.serverMetadata = async () => { reads++; return { revision: 1, entries: {} }; };
    await disabled.instance.reconcile();
    assert.equal(reads, 0);

    const conflict = reconciliationFixture({ prefs: { upload: true, download: true, paused: false },
        local: [['user-key', 'local-new']],
        baseline: [{ key: 'user-key', hash: 'hash:old', localHash: 'hash:old', value: 'old' }],
        remote: new Map([['user-key', 'remote-new']]), choice: 'later' });
    await conflict.instance.reconcile();
    assert.equal(conflict.instance.paused, true);
    assert.equal(conflict.savedRows, null);
    assert.deepEqual(conflict.queued, []);
    assert.deepEqual(conflict.applied, []);
});
