import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyServerState,
    diffSnapshots,
    serverStateToPortableValues,
    snapshotPortableStorage,
} from '../lib/sync-core.js';

class MemoryStorage {
    constructor(values = {}) { this.values = new Map(Object.entries(values)); }
    get length() { return this.values.size; }
    key(index) { return Array.from(this.values.keys())[index] ?? null; }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
}

test('snapshots portable values and produces per-key mutations', () => {
    const storage = new MemoryStorage({ settingA: '1', 'widget-cache:item': 'x' });
    const first = snapshotPortableStorage(storage);
    assert.deepEqual(Object.fromEntries(first.values), { settingA: '1' });
    assert.equal(first.excluded.size, 1);

    const second = new Map([['settingB', '2']]);
    assert.deepEqual(diffSnapshots(first.values, second), [
        { key: 'settingB', value: '2', deleted: false },
        { key: 'settingA', deleted: true },
    ]);
});

test('applies remote values, credentials and tombstones', () => {
    const storage = new MemoryStorage({ old: 'value', keep: 'local' });
    const result = applyServerState(storage, {
        entries: {
            old: { deleted: true },
            keep: { value: 'remote', deleted: false },
            'oauth_access_token': { value: 'portable-token', deleted: false },
        },
    });
    assert.deepEqual(result, { changed: 3, skipped: 0, failed: 0 });
    assert.equal(storage.getItem('old'), null);
    assert.equal(storage.getItem('keep'), 'remote');
    assert.equal(storage.getItem('oauth_access_token'), 'portable-token');
});

test('builds a portable remote snapshot for replacement uploads', () => {
    const values = serverStateToPortableValues({
        entries: {
            theme: { value: 'dark', deleted: false },
            obsolete: { deleted: true },
            'chat-history': { value: 'large', deleted: false },
            oauth_access_token: { value: 'portable-token', deleted: false },
        },
    });

    assert.deepEqual(Array.from(values), [
        ['theme', 'dark'],
        ['oauth_access_token', 'portable-token'],
    ]);
});
