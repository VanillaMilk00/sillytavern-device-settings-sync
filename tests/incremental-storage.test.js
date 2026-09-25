import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IncrementalStateStore, incrementalDelta, applyIncrementalDelta, incrementalHash } from '../server-plugin/incremental.js';

const identity = (operationId, expectedRevision, mutations, extra = {}) => ({
    account: 'tester', deviceId: 'device_0001', operationId, expectedRevision, mode: 'full', automatic: true,
    scope: { mode: 'full' }, mutations, ...extra,
});

async function withStore(stream, work) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-incremental-'));
    try { return await work(root, new IncrementalStateStore(root, stream)); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('large-value splice deltas preserve Unicode and are used only when materially smaller', () => {
    const before = '🧋'.repeat(4) + 'a'.repeat(300_000) + '尾端';
    const after = before.slice(0, -2) + '🧪新';
    const delta = incrementalDelta(before, after);
    assert.ok(delta);
    assert.equal(applyIncrementalDelta(before, delta), after);
    assert.equal(incrementalDelta('old🧋', 'a wholly different new value'), null);
});

test('atomic incremental commit preserves special keys and operation retries are idempotent', async () => {
    await withStore('full', async (_root, store) => {
        const raw = '繁體中文 🧋\\u0000';
        const emptyKeyValue = 'empty-key value';
        const first = identity('operation_0001', 0, [
            { key: '__proto__', beforeHash: null, afterHash: incrementalHash(raw), value: raw },
            { key: '', beforeHash: null, afterHash: incrementalHash(emptyKeyValue), value: emptyKeyValue },
        ]);
        const receipt = await store.commit(first);
        assert.equal(receipt.revision, 1);
        assert.deepEqual(await store.commit(first), { ...receipt, replayed: true });
        const snapshot = await store.snapshot();
        assert.equal(Object.getPrototypeOf(snapshot.entries), null);
        assert.equal(snapshot.entries.__proto__.value, raw);
        assert.equal(snapshot.entries.__proto__.deleted, false);
        assert.equal(snapshot.entries[''].value, emptyKeyValue);
        await assert.rejects(store.commit({ ...first, mutations: [{ ...first.mutations[0], value: 'different' }] }),
            error => error.code === 'incrementalCommitConflict');
        await store.commit(identity('operation_delete_empty', 1, [
            { key: '', beforeHash: incrementalHash(emptyKeyValue), afterHash: null, deleted: true },
        ]));
        assert.equal((await store.snapshot()).entries[''].deleted, true);
    });
    await withStore('portable', async (_root, store) => {
        await assert.rejects(store.commit({ ...identity('operation_empty_portable', 0, [
            { key: '', beforeHash: null, afterHash: incrementalHash('not portable'), value: 'not portable' },
        ]), mode: 'portable', scope: { mode: 'portable' } }), error => error.code === 'incrementalScopeViolation');
    });
    await withStore('full', async (_root, store) => {
        const value = 'explicitly selected empty key';
        await store.commit({ ...identity('operation_empty_selected', 0, [
            { key: '', beforeHash: null, afterHash: incrementalHash(value), value },
        ]), mode: 'selected', scope: { mode: 'selected', selectedScope: { kind: 'keys', keys: [''] } } });
        assert.equal((await store.snapshot()).entries[''].value, value);
    });
});

test('duplicate mutations and stale per-key hashes fail without publishing any partial state', async () => {
    await withStore('full', async (_root, store) => {
        const value = 'first';
        await store.commit(identity('operation_0002', 0, [{ key: 'setting', beforeHash: null, afterHash: incrementalHash(value), value }]));
        const before = await store.snapshot();
        await assert.rejects(store.commit(identity('operation_0003', 1, [
            { key: 'setting', beforeHash: incrementalHash(value), afterHash: incrementalHash('second'), value: 'second' },
            { key: 'setting', beforeHash: incrementalHash(value), afterHash: incrementalHash('third'), value: 'third' },
        ])), error => error.code === 'incrementalInvalidRequest');
        await assert.rejects(store.commit(identity('operation_0004', 1, [
            { key: 'setting', beforeHash: incrementalHash('stale'), afterHash: incrementalHash('new'), value: 'new' },
        ])), error => error.code === 'incrementalKeyConflict');
        assert.deepEqual(await store.snapshot(), before);
    });
});

test('automatic server versions merge for thirty minutes, then retain only the newest five', async () => {
    await withStore('full', async (_root, store) => {
        let revision = 0;
        const first = await store.commit(identity('auto_round_0001', revision, [
            { key: 'value', beforeHash: null, afterHash: incrementalHash('v1'), value: 'v1' },
        ]), { now: new Date(0) });
        revision = first.revision;
        const initialVersion = (await store.listVersions())[0];
        const second = await store.commit(identity('auto_round_0002', revision, [
            { key: 'value', beforeHash: incrementalHash('v1'), afterHash: incrementalHash('v2'), value: 'v2' },
        ]), { now: new Date(10 * 60_000) });
        revision = second.revision;
        assert.equal((await store.listVersions()).length, 1);
        for (let index = 0; index < 6; index++) {
            const oldValue = `v${index + 2}`;
            const newValue = `v${index + 3}`;
            const result = await store.commit(identity(`auto_round_${String(index + 3).padStart(4, '0')}`, revision, [
                { key: 'value', beforeHash: incrementalHash(oldValue), afterHash: incrementalHash(newValue), value: newValue },
            ]), { now: new Date((31 + index * 31) * 60_000) });
            revision = result.revision;
        }
        const versions = await store.listVersions();
        assert.equal(versions.length, 5);
        assert.equal(versions.some(item => item.id === initialVersion.id), false);
        const archive = await store.getVersion(versions[0].id);
        assert.equal(archive.entries[0].value, 'v7');
    });
});

test('legacy state migrates to immutable content storage without deleting the source file', async () => {
    await withStore('portable', async (root, store) => {
        const legacyPath = path.join(root, 'device-settings-sync.json');
        const legacy = { schema: 1, revision: 7, seeded: true, updatedAt: '2026-09-25T00:00:00.000Z', entries: {
            'extensions:中文': { value: '😺', deleted: false, revision: 7, updatedAt: '2026-09-25T00:00:00.000Z', deviceId: 'device_0001' },
        } };
        await fs.writeFile(legacyPath, JSON.stringify(legacy));
        const snapshot = await store.snapshot();
        assert.equal(snapshot.revision, 7);
        assert.equal(snapshot.entries['extensions:中文'].value, '😺');
        assert.equal(JSON.parse(await fs.readFile(legacyPath, 'utf8')).revision, 7);
        assert.ok((await fs.stat(store.manifestPath)).isFile());
    });
});

test('chunk staging resumes identical chunks and publishes only after complete digest validation', async () => {
    await withStore('full', async (_root, store) => {
        const value = 'a'.repeat(300_000);
        const payload = identity('transfer_0001', 0, [
            { key: 'large', beforeHash: null, afterHash: incrementalHash(value), value },
        ]);
        const encoded = Buffer.from(JSON.stringify(payload));
        const chunkSize = 256 * 1024;
        const count = Math.ceil(encoded.length / chunkSize);
        await store.startTransfer({ operationId: payload.operationId, expectedRevision: 0, mode: 'full', account: 'tester',
            chunks: count, bytes: encoded.length, digest: incrementalHash(encoded.toString('utf8')) });
        const pieces = Array.from({ length: count }, (_, index) => encoded.subarray(index * chunkSize, Math.min(encoded.length, (index + 1) * chunkSize)));
        await store.putTransferChunk(payload.operationId, 0, { data: pieces[0].toString('base64') });
        await store.putTransferChunk(payload.operationId, 0, { data: pieces[0].toString('base64') });
        await assert.rejects(store.finishTransfer(payload.operationId, 'tester'), error => error.code === 'incrementalTransferIncomplete');
        for (let index = 1; index < pieces.length; index++) await store.putTransferChunk(payload.operationId, index, { data: pieces[index].toString('base64') });
        assert.equal((await store.finishTransfer(payload.operationId, 'tester')).revision, 1);
        assert.equal((await store.snapshot()).entries.large.value, value);
    });
});
