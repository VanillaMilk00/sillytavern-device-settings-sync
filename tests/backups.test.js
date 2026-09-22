import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackupStore } from '../server-plugin/backups.js';
import { createArchive, MAX_ARCHIVE_BYTES } from '../lib/storage-model.js';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-backup-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, store: new BackupStore(root) };
}

function payload(index, value = String(index)) {
    return { operationId: 'operation_' + index, reason: 'upload',
        archive: createArchive(new Map([['cache:large', value]]), { kind: 'full' }, { deviceId: 'device_' + index }) };
}

test('six successful snapshots retain the newest five and remove the evicted file', async t => {
    const { root, store } = await fixture(t);
    const records = [];
    for (let i = 0; i < 6; i++) records.push(await store.create(payload(i)));
    assert.deepEqual((await store.list()).map(item => item.operationId), ['operation_5', 'operation_4', 'operation_3', 'operation_2', 'operation_1']);
    await assert.rejects(store.get(records[0].id), { code: 'backupNotFound' });
    await assert.rejects(fs.stat(path.join(root, 'device-settings-sync-backups', records[0].id + '.json')), { code: 'ENOENT' });
    assert.equal((await store.get(records[5].id)).entries[0].value, '5');
});

test('transport retries deduplicate but conflicting operation data is rejected', async t => {
    const { store } = await fixture(t);
    const data = payload(1);
    const first = await store.create(data);
    const second = await store.create(data);
    assert.equal(first.id, second.id);
    assert.equal((await store.list()).length, 1);
    const conflicting = structuredClone(data);
    conflicting.archive.entries[0].value = 'different';
    await assert.rejects(store.create(conflicting), { code: 'backupConflict' });
});

test('independent store instances serialize concurrent requests for one account', async t => {
    const { root, store } = await fixture(t);
    await Promise.all(Array.from({ length: 12 }, (_, index) => new BackupStore(root).create(payload(index))));
    const records = await store.list();
    assert.equal(records.length, 5);
    assert.equal(new Set(records.map(item => item.id)).size, 5);
    assert.deepEqual(records.map(item => item.operationId), ['operation_11', 'operation_10', 'operation_9', 'operation_8', 'operation_7']);
    for (const record of records) await store.get(record.id);
});

test('accounts have isolated histories and backup IDs cannot traverse paths', async t => {
    const { root } = await fixture(t);
    const a = new BackupStore(path.join(root, 'a'));
    const b = new BackupStore(path.join(root, 'b'));
    const saved = await a.create(payload(1));
    assert.deepEqual(await b.list(), []);
    await assert.rejects(b.get(saved.id), { code: 'backupNotFound' });
    assert.throws(() => a.get('../index'), { code: 'backupNotFound' });
});

test('an index publication failure leaves all previous snapshots intact', async t => {
    const { store, root } = await fixture(t);
    for (let i = 0; i < 5; i++) await store.create(payload(i));
    const before = await store.list();
    class FailingStore extends BackupStore {
        async atomicWrite(file, text) {
            if (file === this.indexPath) throw new Error('disk failure');
            return super.atomicWrite(file, text);
        }
    }
    await assert.rejects(new FailingStore(root).create(payload(6)), /disk failure/u);
    assert.deepEqual(await store.list(), before);
    for (const record of before) await store.get(record.id);
    assert.equal((await fs.readdir(store.root)).filter(name => name.endsWith('.json')).length, 6);
});

test('a restore can retain a loaded oldest archive even when a rescue backup evicts it', async t => {
    const { store } = await fixture(t);
    const oldest = await store.create(payload(0, 'oldest'));
    for (let i = 1; i < 5; i++) await store.create(payload(i));
    const held = await store.get(oldest.id);
    await store.create({ ...payload(6), reason: 'restore' });
    await assert.rejects(store.get(oldest.id), { code: 'backupNotFound' });
    assert.equal(held.entries[0].value, 'oldest');
});

test('backups allow values larger than the ordinary sync limit and return metadata only in lists', async t => {
    const { store } = await fixture(t);
    const saved = await store.create(payload(1, 'x'.repeat(512 * 1024)));
    assert.equal((await store.get(saved.id)).entries[0].value.length, 512 * 1024);
    assert.equal(Object.hasOwn((await store.list())[0], 'entries'), false);
    assert.equal(Object.hasOwn((await store.list())[0], 'digest'), false);
});

test('invalid, partial and oversized backups cannot change the existing history', async t => {
    const { store } = await fixture(t);
    await store.create(payload(1));
    const before = await store.list();
    for (const data of [null, [], {}, { ...payload(2), archive: createArchive(new Map(), { kind: 'keys', keys: [] }) }]) {
        assert.throws(() => store.create(data), { code: 'invalidArchive' });
    }
    assert.throws(() => store.create(payload(3, 'x'.repeat(MAX_ARCHIVE_BYTES))), { code: 'archiveTooLarge' });
    assert.deepEqual(await store.list(), before);
});

test('simultaneous retries reserve exactly one slot', async t => {
    const { root, store } = await fixture(t);
    const data = payload(1);
    const results = await Promise.all(Array.from({ length: 8 }, () => new BackupStore(root).create(data)));
    assert.equal(new Set(results.map(item => item.id)).size, 1);
    assert.equal((await store.list()).length, 1);
});

test('a delayed retry after eviction and store restart does not consume a new slot', async t => {
    const { root, store } = await fixture(t);
    const data = payload(0);
    const original = await store.create(data);
    for (let i = 1; i <= 6; i++) await store.create(payload(i));
    const before = await store.list();
    const reopened = new BackupStore(root);
    const retry = await reopened.create(data);
    assert.equal(retry.id, original.id);
    assert.equal(retry.retained, false);
    assert.deepEqual(await reopened.list(), before);
    await assert.rejects(reopened.create({ ...data, reason: 'delete' }), { code: 'backupConflict' });
});
