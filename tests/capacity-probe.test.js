import test from 'node:test';
import assert from 'node:assert/strict';
import { probeCapacity } from '../lib/capacity-probe.js';
import { totalBytes, readStorage } from '../lib/storage-model.js';

class Storage {
    constructor(limit = 10000) { this.values = new Map([['existing', '重要😀']]); this.limit = limit; this.writes = []; }
    get length() { return this.values.size; }
    key(index) { return [...this.values.keys()][index] ?? null; }
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) {
        const next = new Map(this.values).set(key, value);
        if (totalBytes(next) > this.limit) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        this.values.set(key, value); this.writes.push(key);
    }
    removeItem(key) { this.values.delete(key); }
}
const options = { key: 'probe_unique', maxBytes: 20000, stepChars: 16, yieldTask: async () => {} };

test('quota measurement brackets capacity, only writes one new key and restores the original data', async () => {
    const storage = new Storage();
    const before = readStorage(storage);
    const result = await probeCapacity(storage, options);
    assert.ok(result.lowerBytes <= storage.limit && result.upperBytes > storage.limit);
    assert.ok(result.upperBytes - result.lowerBytes <= 32);
    assert.deepEqual(readStorage(storage), before);
    assert.deepEqual([...new Set(storage.writes)], ['probe_unique']);
});

test('hitting the safety bound reports a lower bound, never an invented maximum', async () => {
    const storage = new Storage(50000);
    const result = await probeCapacity(storage, { ...options, maxBytes: 4096 });
    assert.equal(result.limited, true);
    assert.equal(result.upperBytes, null);
    assert.equal(storage.length, 1);
});

test('existing probe key collision does not overwrite or remove it', async () => {
    const storage = new Storage();
    storage.values.set(options.key, 'keep');
    await assert.rejects(probeCapacity(storage, options), { code: 'probeCollision' });
    assert.equal(storage.getItem(options.key), 'keep');
    assert.equal(storage.writes.length, 0);
});

test('full or blocked storage reports unavailable and never guesses a maximum', async () => {
    const storage = new Storage(0);
    await assert.rejects(probeCapacity(storage, options), { code: 'probeUnavailable' });
    assert.equal(storage.length, 1);
    storage.setItem = () => { throw Object.assign(new Error('denied'), { name: 'SecurityError' }); };
    await assert.rejects(probeCapacity(storage, options), { name: 'SecurityError' });
});

test('concurrent changes stop the measurement, preserve foreign writes and remove only the test key', async () => {
    const storage = new Storage();
    await assert.rejects(probeCapacity(storage, { ...options, yieldTask: async () => storage.values.set('other-tab', 'keep') }), { code: 'stalePreview' });
    assert.equal(storage.getItem('other-tab'), 'keep');
    assert.equal(storage.getItem(options.key), null);
    assert.equal(storage.getItem('existing'), '重要😀');
});

test('temporary cleanup failure is explicit and never clears unrelated keys', async () => {
    const storage = new Storage();
    storage.removeItem = () => { throw new Error('blocked'); };
    await assert.rejects(probeCapacity(storage, options), error => error.code === 'probeCleanupFailed' && error.details.key === options.key);
    assert.equal(storage.getItem('existing'), '重要😀');
});

test('a foreign value written to the temporary key is not removed', async () => {
    const storage = new Storage();
    await assert.rejects(probeCapacity(storage, { ...options, yieldTask: async () => storage.values.set(options.key, 'foreign') }), { code: 'probeCleanupFailed' });
    assert.equal(storage.getItem(options.key), 'foreign');
});
