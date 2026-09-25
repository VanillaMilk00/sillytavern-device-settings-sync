import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { HashClient } from '../lib/hash-client.js';
import { StorageObserver } from '../lib/storage-observer.js';
import { journalDatabaseName } from '../lib/auto-journal.js';
import { INTERNAL_SYNC_DATABASE_PREFIX } from '../lib/indexeddb-model.js';

class EventTargetMock {
    listeners = new Map();
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatch(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
}

test('storage observer listens to native key and clear events from an isolated same-origin context', async () => {
    const child = new EventTargetMock();
    child.origin = 'https://st.example';
    child.location = { origin: 'null' };
    const frame = new EventTargetMock();
    frame.style = {};
    frame.contentWindow = child;
    frame.contentDocument = { readyState: 'complete' };
    frame.setAttribute = () => {};
    frame.remove = () => { frame.isConnected = false; };
    const root = new EventTargetMock();
    root.location = { origin: 'https://st.example' };
    root.navigator = {};
    root.document = { body: { append: element => { element.isConnected = true; } },
        createElement: () => frame };
    root.setTimeout = setTimeout;
    root.clearTimeout = clearTimeout;
    const keys = [];
    let clearCount = 0;
    const observer = new StorageObserver({ window: root, onKey: key => keys.push(key), onClear: () => clearCount++ });
    await observer.start();
    child.dispatch('storage', { key: '設定:😺' });
    child.dispatch('storage', { key: null });
    assert.deepEqual(keys, ['設定:😺']);
    assert.equal(clearCount, 1);
    assert.equal(frame.style.cssText, 'display:none!important;width:0;height:0;border:0');
    assert.equal(frame.src, undefined, 'the inherited initial about:blank document must not be re-navigated');
    observer.destroy();
    assert.equal(child.listeners.get('storage').size, 0);
});

test('fallback hashing and large Unicode delta comparison do not change localStorage strings', async () => {
    const client = new HashClient({ crypto: webcrypto });
    const before = '🙂'.repeat(150_000) + 'old';
    const after = '🙂'.repeat(150_000) + 'new🧪';
    const prepared = await client.prepare(before, after);
    assert.equal(prepared.afterHash.length, 64);
    assert.ok(prepared.delta);
    assert.equal(before.endsWith('old'), true);
    assert.equal(after.endsWith('new🧪'), true);
    client.destroy();
});

test('automatic journal database has a private namespace hidden from user IndexedDB management', async () => {
    const name = journalDatabaseName('帳戶:name');
    assert.ok(name.startsWith(INTERNAL_SYNC_DATABASE_PREFIX));
    assert.ok(name.includes(encodeURIComponent('帳戶:name')));
    const source = await fs.readFile(new URL('../lib/indexeddb-model.js', import.meta.url), 'utf8');
    assert.match(source, /INTERNAL_SYNC_DATABASE_PREFIX/u);
    assert.match(source, /filter\(row\s*=>\s*typeof row\.name === 'string' && !row\.name\.startsWith\(INTERNAL_SYNC_DATABASE_PREFIX\)\)/u);
});
