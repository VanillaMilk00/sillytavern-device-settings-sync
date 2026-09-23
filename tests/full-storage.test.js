import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStorageEntry } from '../lib/filter.js';
import { planRemote } from '../lib/auto-core.js';
import { commitFullState, fullReceipt, initialFullState } from '../server-plugin/full-state.js';
import { applyPlan } from '../lib/storage-model.js';

const request = (revision, entries) => ({
    operationId: 'full_operation_123', deviceId: 'device_123', expectedRevision: revision, entries,
});

test('full mode includes caches, large values and unusual keys but preserves internal identifiers', () => {
    const options = { fullStorage: true };
    for (const key of ['history:chat', '', 'k'.repeat(700)]) {
        assert.equal(classifyStorageEntry(key, '😀'.repeat(200000), options).portable, true);
    }
    assert.equal(classifyStorageEntry('sillytavern_settings_sync_device_id', 'x', options).portable, false);
    assert.equal(classifyStorageEntry('history:chat', 'x').portable, false);
});

test('full snapshot CAS is atomic, replayable and preserves special keys', () => {
    const entries = [{ key: '', value: '' }, { key: '__proto__', value: '中文😀' }, { key: 'history', value: 'x'.repeat(300000) }];
    const first = commitFullState(initialFullState(), request(0, entries));
    assert.equal(first.state.entries[''], '');
    assert.equal(JSON.parse(JSON.stringify(first.state)).entries.__proto__, '中文😀');
    assert.equal(first.state.entries.history.length, 300000);
    assert.deepEqual(fullReceipt(first.state, 'full_operation_123'), first.receipt);
    assert.equal(commitFullState(first.state, request(0, entries)).replayed, true);
    assert.throws(() => commitFullState(first.state, { ...request(0, entries), operationId: 'another_operation' }), { code: 'autoConflict' });
    assert.throws(() => commitFullState(first.state, request(0, [{ key: 'x', value: 'different' }])), { code: 'commitConflict' });
    assert.throws(() => commitFullState(first.state, request(1, [{ key: 'allowed', value: 'x' }, { key: 'sillytavern_settings_sync_device_id', value: 'forbidden' }])), { code: 'invalidCommit' });
    assert.equal(first.state.revision, 1);
});

test('oversized full snapshots are rejected without replacing the previous revision', () => {
    const current = commitFullState(initialFullState(), request(0, [{ key: 'keep', value: 'safe' }])).state;
    assert.throws(() => commitFullState(current, { ...request(1, [{ key: 'large', value: 'x'.repeat(32 * 1024 * 1024) }]),
        operationId: 'oversized_operation_123' }), { code: 'archiveTooLarge' });
    assert.equal(current.revision, 1);
    assert.equal(current.entries.keep, 'safe');
});

test('full downloads replace absent user keys and roll back quota failures', () => {
    const before = new Map([['history', 'old'], ['cache', 'remove'], ['sillytavern_settings_sync_device_id', 'this-device']]);
    const state = { seeded: true, entries: { history: { value: 'new', deleted: false } } };
    const plan = planRemote(before, state, { fullStorage: true });
    assert.deepEqual(plan.changes.map(item => [item.key, item.after]), [['cache', null], ['history', 'new']]);
    const storage = {
        map: new Map(before), get length() { return this.map.size; }, key(i) { return [...this.map.keys()][i] ?? null; },
        getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); }, removeItem(k) { this.map.delete(k); },
    };
    assert.equal(applyPlan(storage, plan), 2);
    assert.equal(storage.getItem('cache'), null);
    assert.equal(storage.getItem('sillytavern_settings_sync_device_id'), 'this-device');
    assert.equal(storage.getItem('history'), 'new');
});
