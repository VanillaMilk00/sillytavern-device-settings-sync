import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateJsonBytes, mergeArchiveObjects, selectIndexedDbArchive } from '../lib/indexeddb-model.js';

function archive(databases, scope = { kind: 'all' }) {
    return { format: 'sillytavern-indexeddb-backup', version: 1, createdAt: '2026-09-24T00:00:00.000Z', scope, databases };
}

function store(name, records = [], indexes = []) {
    return { name, keyPath: null, autoIncrement: false, indexes, records: records.map(([key, value]) => ({ key, value })) };
}

test('selected IndexedDB records merge without touching other stores or local-only records', () => {
    const current = archive([{ name: 'app', version: 1, stores: [
        store('chats', [['same', { value: 'old' }], ['local-only', { value: 'keep' }]]),
        store('preferences', [['theme', { value: 'dark' }]]),
    ] }]);
    const scope = { kind: 'items', items: [{ database: 'app', store: 'chats', keyToken: '"same"' }] };
    const incoming = archive([{ name: 'app', version: 8, stores: [
        store('chats', [['same', { value: 'new' }], ['server-extra', { value: 'keep' }]]),
        store('preferences', [['theme', { value: 'light' }]]),
    ] }], scope);

    const result = mergeArchiveObjects(current, incoming, scope);
    const chats = result.databases[0].stores.find(item => item.name === 'chats');
    const preferences = result.databases[0].stores.find(item => item.name === 'preferences');
    assert.deepEqual(chats.records, [
        { key: 'same', value: { value: 'new' } },
        { key: 'local-only', value: { value: 'keep' } },
    ]);
    assert.deepEqual(preferences.records, [{ key: 'theme', value: { value: 'dark' } }]);
});

test('selected store imports do not add unselected object stores', () => {
    const current = archive([{ name: 'app', version: 1, stores: [store('selected')] }]);
    const scope = { kind: 'items', items: [{ database: 'app', store: 'selected' }] };
    const incoming = archive([{ name: 'app', version: 3, stores: [
        store('selected', [['one', { ok: true }]]),
        store('not-selected', [['secret', { ok: false }]]),
    ] }], scope);

    const result = mergeArchiveObjects(current, incoming, scope);
    assert.deepEqual(result.databases[0].stores.map(item => item.name), ['selected']);
    assert.deepEqual(result.databases[0].stores[0].records, [{ key: 'one', value: { ok: true } }]);
});

test('selected archive export filters records by full IndexedDB primary-key token', () => {
    const input = archive([{ name: 'app', version: 1, stores: [store('items', [['a', 1], ['b', 2]])] }]);
    const selected = selectIndexedDbArchive(input, { kind: 'items', items: [{ database: 'app', store: 'items', keyToken: '"b"' }] });
    assert.deepEqual(selected.databases[0].stores[0].records, [{ key: 'b', value: 2 }]);
});

test('IndexedDB JSON size estimation matches UTF-8 serialization without building a combined archive string', () => {
    const value = {
        database: '角色🙂',
        values: ['quote: "', 'slash: \\', 'control: \u0001\n', 'lone surrogate: \ud800', 123.5, null, true],
        nested: { empty: [], object: {} },
    };
    assert.equal(estimateJsonBytes(value), new TextEncoder().encode(JSON.stringify(value)).byteLength);
    assert.equal(estimateJsonBytes('🙂'), 6);
});
