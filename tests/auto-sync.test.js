import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AutoSync } from '../lib/auto-sync.js';
import { IDLE_MS, RETRY_MS } from '../lib/auto-core.js';
import { createInitialState, mergeMutations } from '../server-plugin/state.js';
import { commitMutations, findCommit } from '../server-plugin/commit.js';
import { commitFullState, fullReceipt, initialFullState } from '../server-plugin/full-state.js';
import { StorageError } from '../lib/storage-model.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
class Storage {
    constructor() { this.map = new Map(); }
    get length() { return this.map.size; }
    key(i) { return [...this.map.keys()][i] ?? null; }
    getItem(k) { return this.map.get(k) ?? null; }
    setItem(k, v) { this.map.set(k, String(v)); }
    removeItem(k) { this.map.delete(k); }
}
function fixture() {
    const storage = new Storage();
    storage.setItem('theme', 'base');
    let now = 1000;
    const timers = new Map();
    const held = new Set();
    let counter = 0;
    const locks = {
        async query() { return { held: [...held].map(name => ({ name })) }; },
        async request(name, options, callback) {
            const work = callback || options;
            if (held.has(name)) return work(null);
            held.add(name);
            try { return await work({ name }); } finally { held.delete(name); }
        },
    };
    const events = () => ({ addEventListener() {}, removeEventListener() {} });
    const win = { ...events(), localStorage: storage, sessionStorage: new Storage(), isSecureContext: true, navigator: { locks }, crypto: webcrypto,
        PerformanceObserver: function() {}, document: { ...events(), visibilityState: 'visible' },
        setTimeout(fn, delay) { const id = ++counter; timers.set(id, { fn, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    const calls = [];
    let server = mergeMutations(createInitialState(), { deviceId: 'device_seed', seed: true, mutations: [{ key: 'theme', value: 'base' }] });
    let full = commitFullState(initialFullState(), { operationId: 'initial_full_123', deviceId: 'device_seed', expectedRevision: 0,
        entries: [{ key: 'theme', value: 'base' }] }).state;
    const f = { storage, win, calls, timers, held, reloads: 0, observed: 0, backups: 0, choice: 'later', busy: false, fullMode: false,
        advance(ms) { now += ms; }, get now() { return now; }, get server() { return server; },
        remote(value) {
            if (f.fullMode) full = commitFullState(full, { operationId: 'remote_full_' + (++counter), deviceId: 'device_other',
                expectedRevision: full.revision, entries: [{ key: 'theme', value }] }).state;
            else server = mergeMutations(server, { deviceId: 'device_other', mutations: [{ key: 'theme', value }] });
        },
        get fullServer() { return full; },
    };
    const api = {
        async request(path, options, receiptFullStorage) {
            calls.push(path);
            if (f.requestFailure) throw f.requestFailure;
            if (path === '/health') return { capabilities: f.oldBackend ? [] : ['atomic-sync-v1', 'full-storage-v1'] };
            if (path === '/state') return f.fullMode ? { ...structuredClone(full),
                entries: Object.fromEntries(Object.entries(full.entries).map(([key, value]) => [key, { value, deleted: false }])) }
                : structuredClone(server);
            if (path.startsWith('/commits/')) {
                const receipt = (receiptFullStorage ?? f.fullMode) ? fullReceipt(full, path.slice('/commits/'.length))
                    : findCommit(server, path.slice('/commits/'.length));
                if (!receipt) throw new StorageError('commitNotFound');
                return receipt;
            }
            if (path === '/commit') {
                if (f.beforeCommit) f.beforeCommit();
                const result = f.fullMode ? commitFullState(full, JSON.parse(options.body)) : commitMutations(server, JSON.parse(options.body));
                if (f.fullMode) full = result.state; else server = result.state;
                if (f.lostResponse) { f.lostResponse = false; throw new TypeError('network'); }
                return result.receipt;
            }
            throw new Error('Unexpected request ' + path);
        },
        options: () => f.fullMode ? { fullStorage: true } : {}, persistDevice: () => 'device_local', busy: () => f.busy,
        observe() { f.observed++; return () => { f.observed--; }; },
        makeBackup: direction => ({ direction }),
        async backup() { f.backups++; if (f.backupFailure) throw f.backupFailure; if (f.afterBackup) await f.afterBackup(); },
        async conflict() { f.conflicts = (f.conflicts || 0) + 1; return f.choice; },
        render() {}, failure(error) { f.failure = error; }, changed() {}, reload() { f.reloads++; },
    };
    f.sync = new AutoSync(api, { window: win, account: 'user', deviceId: 'device_local', now: () => now });
    f.api = api;
    f.enable = async (upload, download) => {
        f.sync.write('prefs', { upload, download });
        await f.sync.start();
    };
    f.baseline = () => f.sync.remember(new Map([['theme', 'base']]), server);
    f.cycle = () => { const id = f.sync.beginActivity(); f.sync.endActivity(id); f.advance(IDLE_MS); };
    return f;
}

test('all four independent switch combinations preserve their own trigger boundaries', async () => {
    for (const [upload, download] of [[false, false], [true, false], [false, true], [true, true]]) {
        const f = fixture();
        await f.baseline();
        await f.enable(upload, download);
        await f.sync.tick();
        assert.equal(f.calls.includes('/state'), download);
        assert.equal(f.calls.includes('/commit'), false);
        assert.equal(f.observed, upload || download ? 1 : 0);
        f.calls.length = 0;
        f.storage.setItem('theme', 'changed');
        f.cycle();
        await f.sync.tick();
        assert.equal(f.calls.includes('/commit'), upload);
        assert.equal(f.reloads, 0);
        f.sync.destroy();
    }
});
test('upload waits for the final request to end and 15 fresh idle minutes, then runs only once', async () => {
    const f = fixture();
    await f.baseline(); await f.enable(true, false);
    f.storage.setItem('theme', 'changed');
    const one = f.sync.beginActivity(), two = f.sync.beginActivity();
    f.sync.endActivity(one); f.advance(IDLE_MS * 2);
    await f.sync.tick(); assert.equal(f.backups, 0);
    f.sync.endActivity(two); f.advance(IDLE_MS - 1);
    await f.sync.tick(); assert.equal(f.backups, 0);
    f.advance(1); await f.sync.tick();
    assert.equal(f.server.entries.theme.value, 'changed');
    assert.equal(f.backups, 1);
    await f.sync.tick(); f.advance(IDLE_MS); await f.sync.tick();
    assert.equal(f.backups, 1);
    f.sync.destroy();
});
test('settings edits without API activity and unchanged idle cycles do not upload or back up', async () => {
    const f = fixture();
    await f.baseline(); await f.enable(true, false);
    f.cycle(); await f.sync.tick();
    assert.equal(f.backups, 0);
    f.storage.setItem('theme', 'changed');
    f.advance(IDLE_MS); await f.sync.tick();
    assert.equal(f.backups, 0);
    f.sync.destroy();
});
test('entry download applies server-only changes once and writes a tab-local reload guard', async () => {
    const f = fixture();
    await f.baseline(); f.remote('newer'); await f.enable(false, true);
    await f.sync.tick();
    assert.equal(f.storage.getItem('theme'), 'newer');
    assert.equal(f.backups, 1); assert.equal(f.reloads, 1);
    assert.ok(f.win.sessionStorage.getItem(f.sync.key + 'reload'));
    f.sync.entry = false;
    f.sync.resumeEvent(); await f.sync.tick();
    assert.equal(f.reloads, 1);
    f.sync.destroy();
});
test('local-only entry changes are kept, and first-run or two-sided differences ask before writing', async () => {
    for (const baseline of [true, false]) {
        const f = fixture();
        if (baseline) await f.baseline();
        f.storage.setItem('theme', 'local');
        await f.enable(false, true); await f.sync.tick();
        assert.equal(f.storage.getItem('theme'), 'local');
        assert.equal(f.backups, 0);
        assert.equal(f.conflicts || 0, baseline ? 0 : 1);
        if (baseline) { f.remote('remote'); f.sync.entry = true; await f.sync.tick(); assert.equal(f.conflicts, 1); }
        f.sync.destroy();
    }
});
test('explicit conflict upload works with upload switch off without enabling it', async () => {
    const f = fixture();
    f.choice = 'upload'; f.storage.setItem('theme', 'local');
    await f.enable(false, true); await f.sync.tick();
    assert.equal(f.server.entries.theme.value, 'local');
    assert.equal(f.sync.prefs().upload, false);
    assert.equal(f.backups, 1);
    f.sync.destroy();
});
test('backup failure, concurrent local changes and generation starting during backup abort writes', async () => {
    for (const mode of ['backup', 'local', 'activity']) {
        const f = fixture();
        await f.baseline(); await f.enable(true, false);
        f.storage.setItem('theme', 'local'); f.cycle();
        if (mode === 'backup') f.backupFailure = new StorageError('archiveTooLarge');
        if (mode === 'local') f.afterBackup = () => f.storage.setItem('theme', 'edited-again');
        if (mode === 'activity') f.afterBackup = () => f.sync.beginActivity();
        await f.sync.tick();
        assert.equal(f.calls.includes('/commit'), false);
        assert.equal(f.server.entries.theme.value, 'base');
        f.sync.destroy();
    }
});
test('server race fails atomically and does not overwrite the newer remote value', async () => {
    const f = fixture();
    await f.baseline(); await f.enable(true, false);
    f.storage.setItem('theme', 'local'); f.cycle();
    f.beforeCommit = () => f.remote('winner');
    await f.sync.tick();
    assert.equal(f.server.entries.theme.value, 'winner');
    assert.equal(f.sync.state().blocked, true);
    f.sync.destroy();
});
test('lost commit response recovers by receipt without another backup or successful upload', async () => {
    const f = fixture();
    await f.baseline(); await f.enable(true, false);
    f.storage.setItem('theme', 'local'); f.cycle(); f.lostResponse = true;
    await f.sync.tick();
    assert.ok(f.sync.state().intent);
    f.advance(RETRY_MS[0]); await f.sync.tick();
    assert.equal(f.sync.state().intent, null);
    assert.equal(f.server.autoCommits.length, 1); assert.equal(f.backups, 1);
    assert.equal(f.calls.filter(path => path === '/commit').length, 1);
    f.sync.destroy();
});
test('bounded network retry uses 1/5/15-minute delays, then pauses', async () => {
    const f = fixture(); await f.enable(false, true);
    f.requestFailure = new TypeError('network');
    for (let i = 0; i < RETRY_MS.length; i++) {
        await f.sync.tick();
        assert.equal(f.sync.state().retryAt, f.now + RETRY_MS[i]);
        const count = f.calls.length; await f.sync.tick(); assert.equal(f.calls.length, count);
        f.advance(RETRY_MS[i]);
    }
    await f.sync.tick(); assert.equal(f.sync.state().blocked, true);
    f.sync.destroy();
});
test('old backend and permanent errors stop without backup, retry storms or mutation', async () => {
    for (const status of [null, 401, 403, 413]) {
        const f = fixture();
        if (status) f.requestFailure = Object.assign(new Error('denied'), { status });
        else f.oldBackend = true;
        await f.enable(false, true); await f.sync.tick();
        assert.equal(f.sync.state().blocked, true); assert.equal(f.backups, 0);
        const count = f.calls.length; await f.sync.tick(); assert.equal(f.calls.length, count);
        f.sync.destroy();
    }
});
test('busy manager or another tab lock defers automatic actions without network calls', async () => {
    const f = fixture(); await f.enable(false, true);
    f.busy = true; await f.sync.tick(); assert.equal(f.calls.length, 0);
    f.busy = false; f.held.add(f.sync.lock); await f.sync.tick(); assert.equal(f.calls.length, 0);
    f.held.delete(f.sync.lock); await f.sync.tick(); assert.ok(f.calls.length > 0);
    f.sync.destroy();
});
test('disable cancels queued work and unsupported environments never monitor or transfer', async () => {
    const f = fixture(); await f.enable(true, true);
    await f.sync.setOption('upload', false); await f.sync.setOption('download', false);
    assert.equal(f.timers.size, 0); assert.equal(f.observed, 0);
    await f.sync.tick(); assert.equal(f.calls.length, 0);
    f.sync.supported = false;
    await assert.rejects(f.sync.setOption('upload', true), { code: 'autoUnsupported' });
    f.sync.destroy();
});

test('an unsent upload intent is canceled when upload is disabled but download remains enabled', async () => {
    const f = fixture();
    await f.baseline();
    f.remote('server-new');
    await f.enable(false, true);
    f.sync.saveState({ intent: { operationId: 'auto_unsent_123', cycle: 'old-cycle' } });
    await f.sync.tick();
    assert.equal(f.sync.state().intent, null);
    assert.equal(f.storage.getItem('theme'), 'server-new');
    assert.equal(f.calls.includes('/commit'), false);
    assert.equal(f.sync.state().blocked, false);
    f.sync.destroy();
});

test('re-enabling upload never schedules an old activity cycle', async () => {
    const f = fixture(); await f.baseline(); await f.enable(true, false);
    f.storage.setItem('theme', 'local'); f.cycle();
    await f.sync.setOption('upload', false); f.advance(10);
    await f.sync.setOption('upload', true);
    f.timers.clear(); await f.sync.tick();
    assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
    f.cycle(); await f.sync.tick(); assert.equal(f.backups, 1);
    f.sync.destroy();
});

test('reload guards are one-shot, tab-local and expire after one minute', async () => {
    const f = fixture(); await f.enable(false, true);
    const key = f.sync.key + 'reload';
    f.win.sessionStorage.setItem(key, JSON.stringify({ revision: 1, at: f.now }));
    await f.sync.start(); assert.equal(f.sync.entry, false);
    assert.equal(f.win.sessionStorage.getItem(key), null);
    await f.sync.start(); assert.equal(f.sync.entry, true);
    f.win.sessionStorage.setItem(key, JSON.stringify({ revision: 1, at: f.now }));
    f.advance(60001); await f.sync.start(); assert.equal(f.sync.entry, true);
    f.sync.destroy();
});

test('closed-tab activity recovers conservatively, while frozen live tabs continue blocking', async () => {
    const f = fixture(); await f.baseline(); await f.enable(true, false);
    f.storage.setItem('theme', 'local');
    const key = 'tab_other';
    f.sync.write(key, { active: 1, lastEnd: 0, cycle: '', started: f.now });
    f.held.add(f.sync.lock + ':live:other');
    f.advance(IDLE_MS * 2); await f.sync.tick(); assert.equal(f.calls.length, 0);
    f.held.delete(f.sync.lock + ':live:other');
    await f.sync.tick(); assert.equal(f.calls.length, 0);
    f.advance(IDLE_MS); await f.sync.tick(); assert.equal(f.backups, 1);
    f.sync.destroy();
});

test('receipt recovery preserves a newer pending activity cycle', async () => {
    const f = fixture(); await f.baseline(); await f.enable(true, false);
    f.storage.setItem('theme', 'first'); f.cycle(); f.lostResponse = true;
    await f.sync.tick();
    const first = f.sync.state().intent.cycle;
    f.storage.setItem('theme', 'second'); f.cycle();
    await f.sync.tick(); assert.equal(f.sync.state().doneCycle, first);
    await f.sync.tick(); assert.equal(f.server.entries.theme.value, 'second');
    assert.equal(f.server.autoCommits.length, 2);
    f.sync.destroy();
});

test('same-value server revision changes still stop an automatic overwrite', async () => {
    const f = fixture(); await f.baseline(); await f.enable(true, false);
    f.storage.setItem('theme', 'local'); f.remote('base'); f.cycle();
    await f.sync.tick();
    assert.equal(f.conflicts, 1); assert.equal(f.backups, 0);
    f.sync.destroy();
});

test('download quota errors preserve the original value and do not reload', async () => {
    const f = fixture(); await f.baseline(); f.remote('newer'); await f.enable(false, true);
    const set = f.storage.setItem.bind(f.storage);
    f.storage.setItem = (key, value) => {
        if (key === 'theme' && value === 'newer') throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
        set(key, value);
    };
    await f.sync.tick();
    assert.equal(f.storage.getItem('theme'), 'base'); assert.equal(f.reloads, 0);
    assert.equal(f.sync.state().blocked, true); assert.equal(f.backups, 1);
    f.sync.destroy();
});

test('a model request beginning after apply defers reload until it ends', async () => {
    const f = fixture(); await f.baseline(); f.remote('newer'); await f.enable(false, true);
    const remember = f.sync.remember.bind(f.sync);
    let active;
    f.sync.remember = async (...args) => { await remember(...args); active = f.sync.beginActivity(); };
    await f.sync.tick();
    assert.equal(f.storage.getItem('theme'), 'newer'); assert.equal(f.reloads, 0);
    f.sync.endActivity(active); await f.sync.tick(); assert.equal(f.reloads, 1);
    f.sync.destroy();
});

test('pristine tabs share preferences without a persisted device ID and account prefixes never overlap', () => {
    const f = fixture();
    const other = new AutoSync(f.api, { window: f.win, account: 'user', deviceId: 'another_provisional' });
    assert.equal(other.key, f.sync.key);
    const separate = new AutoSync(f.api, { window: f.win, account: 'user:tab_other' });
    assert.equal(separate.key.startsWith(f.sync.key), false);
    f.sync.write('prefs', { upload: true, download: false });
    assert.equal(other.prefs().upload, true); assert.equal(separate.prefs().upload, false);
    other.destroy(); separate.destroy(); f.sync.destroy();
});

test('automatic full upload commits large cache values with a rescue backup', async () => {
    const f = fixture(); f.fullMode = true;
    await f.sync.remember(new Map([['theme', 'base']]), await f.api.request('/state'));
    f.calls.length = 0; await f.enable(true, false);
    f.storage.setItem('history:chat', 'x'.repeat(300000));
    f.storage.setItem('sillytavern_settings_sync_device_id', 'this-device');
    f.cycle(); await f.sync.tick();
    assert.equal(f.fullServer.entries['history:chat'].length, 300000);
    assert.equal(Object.hasOwn(f.fullServer.entries, 'sillytavern_settings_sync_device_id'), false);
    assert.equal(f.backups, 1); assert.equal(f.calls.filter(path => path === '/commit').length, 1);
    f.sync.destroy();
});

test('lost full-upload responses recover from the full receipt even after the mode changes', async () => {
    const f = fixture(); f.fullMode = true;
    await f.sync.remember(new Map([['theme', 'base']]), await f.api.request('/state'));
    await f.enable(true, false);
    f.storage.setItem('cache:large', 'x'.repeat(300000));
    f.lostResponse = true; f.cycle(); await f.sync.tick();
    assert.equal(f.fullServer.entries['cache:large'].length, 300000);
    assert.equal(f.sync.state().intent.fullStorage, true);
    f.fullMode = false; f.advance(RETRY_MS[0]); await f.sync.tick();
    assert.equal(f.sync.state().intent, null);
    assert.equal(f.backups, 1);
    assert.equal(f.calls.filter(path => path === '/commit').length, 1);
    f.sync.destroy();
});

test('automatic full download removes absent cache keys while keeping local device metadata', async () => {
    const f = fixture(); f.fullMode = true;
    f.storage.setItem('sillytavern_settings_sync_device_id', 'this-device');
    await f.sync.remember(new Map([['theme', 'base']]), await f.api.request('/state'));
    f.storage.setItem('cache:old', 'remove');
    f.remote('server-new'); await f.enable(false, true); await f.sync.tick();
    assert.equal(f.sync.state().blocked, true); // Both local and remote changed; ask first.
    assert.equal(f.storage.getItem('cache:old'), 'remove');
    f.sync.destroy();

    const other = fixture(); other.fullMode = true;
    await other.sync.remember(new Map([['theme', 'base']]), await other.api.request('/state'));
    other.storage.setItem('cache:old', 'remove');
    other.remote('server-new'); other.choice = 'download'; await other.enable(false, true); await other.sync.tick();
    assert.equal(other.storage.getItem('cache:old'), null);
    assert.equal(other.storage.getItem('theme'), 'server-new');
    assert.equal(other.conflicts, 1); assert.equal(other.backups, 1); assert.equal(other.reloads, 1);
    other.sync.destroy();
});
