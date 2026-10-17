import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { HashClient, safeHashFailure } from '../lib/hash-client.js';
import { Sha256 } from '../lib/sha256.js';
import { downloadIndexedDbArchive, indexedDbHashDiagnostics, preflightIndexedDbTransfer } from '../lib/indexeddb-transfer.js';
import { INDEXEDDB_CHUNK_BYTES } from '../lib/indexeddb-model.js';

const bundle = await fs.readFile(new URL('../workers/hash-worker-classic.js', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
const hash = input => createHash('sha256').update(input).digest('hex');

function environment({ mode = () => '', fault = () => '' } = {}) {
    const stats = { created: [], messages: [], maxChunk: 0, transferred: 0, active: 0 };
    class Worker {
        constructor(_url, { type }) {
            this.type = type;
            this.listeners = new Map();
            this.mode = mode(type, stats.created.length);
            stats.created.push(this);
            if (this.mode === 'throw') throw new DOMException('private-url/token', 'SecurityError');
            stats.active++;
            if (this.mode === 'load-error') { queueMicrotask(() => this.emit('error', { message: 'private-url/token', preventDefault() {} })); return; }
            const self = {
                addEventListener: (_type, handler) => { this.receive = handler; },
                postMessage: data => {
                    if (this.mode === 'bad-probe' && data.protocol) data.hash = '0'.repeat(64);
                    queueMicrotask(() => this.emit('message', { data: structuredClone(data) }));
                },
            };
            vm.runInNewContext(bundle, { self, TextEncoder, Uint8Array, Uint32Array, ArrayBuffer, DataView, crypto: {} });
        }
        addEventListener(type, listener) {
            const group = this.listeners.get(type) || new Set(); group.add(listener); this.listeners.set(type, group);
        }
        removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
        emit(type, event) { if (!this.terminated) for (const listener of this.listeners.get(type) || []) listener(event); }
        postMessage(data, transfer = []) {
            const size = data.bytes?.byteLength || 0;
            stats.messages.push({ workerType: this.type, type: data.type, size });
            stats.maxChunk = Math.max(stats.maxChunk, size);
            const action = fault(this, data);
            if (action === 'throw') throw new DOMException('private data', 'DataCloneError');
            const cloned = structuredClone(data, { transfer });
            if (transfer.length) { assert.equal(data.bytes.buffer.byteLength, 0); stats.transferred++; }
            if (action === 'hang' || (this.mode === 'hang-probe' && data.type === 'probe')) return;
            queueMicrotask(() => {
                if (this.terminated) return;
                if (action === 'error' || action === 'messageerror') { this.emit(action, { message: 'secret value', preventDefault() {} }); return; }
                if (action === 'bad-ack') { this.emit('message', { data: { id: data.id, received: -1 } }); return; }
                this.receive({ data: cloned });
            });
        }
        terminate() { if (!this.terminated) { this.terminated = true; stats.active--; } }
    }
    return { Worker, crypto: {}, stats };
}

test('incremental SHA-256 preserves arbitrary chunk boundaries, binary views and finalization', () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1025]) {
        const input = Uint8Array.from({ length: size + 20 }, (_, i) => i % 256).subarray(7, size + 7);
        for (const step of [1, 3, 63, 64, 127, 263]) {
            const digest = new Sha256();
            for (let offset = 0; offset < input.length; offset += step) {
                const chunk = input.subarray(offset, offset + step);
                digest.update(new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            }
            assert.equal(digest.digestHex(), hash(input));
            assert.equal(digest.digestHex(), hash(input));
            assert.throws(() => digest.update(new Uint8Array()), /finalized/u);
        }
    }
});

test('classic fallback is self-contained and works after module construction or asynchronous load failure', async () => {
    assert.doesNotMatch(bundle, /^\s*(?:import|export)\s/mu);
    for (const broken of ['throw', 'load-error', 'hang-probe', 'bad-probe']) {
        const win = environment({ mode: type => type === 'module' ? broken : '' });
        const client = new HashClient(win, { startupTimeoutMs: 20 });
        await client.probe({ requireWorker: true });
        assert.equal((await client.hash('中文🙂\ud800')).hash, hash(new TextEncoder().encode('中文🙂\ud800')));
        assert.equal(client.describe().workerType, 'classic');
        assert.equal(win.stats.active, 1);
        assert.equal(win.stats.created.length, 2);
        assert.ok(!JSON.stringify(client.describe()).includes('private-url'));
        client.destroy(); assert.equal(win.stats.active, 0);
    }
});

test('large bytes are transferred in bounded chunks without detaching or changing the source buffer', async () => {
    const win = environment(); const client = new HashClient(win);
    const input = Uint8Array.from({ length: 3 * 1024 * 1024 + 71 }, (_, i) => i % 251);
    const expected = hash(input);
    assert.equal((await client.bytes(input)).hash, expected);
    assert.equal(hash(input), expected);
    assert.equal(input.byteLength, 3 * 1024 * 1024 + 71);
    assert.equal(win.stats.maxChunk, 256 * 1024);
    assert.equal(win.stats.transferred, 13);
    assert.equal(client.describe().progress.completedBytes, input.byteLength);
    assert.ok(!win.stats.messages.some(item => item.type === 'bytes'));
    client.destroy();
});

test('streaming byte hashing preserves subarray offsets and handles empty input', async () => {
    const win = environment(); const client = new HashClient(win);
    const input = Uint8Array.from({ length: 1000 }, (_, i) => i % 256).subarray(11, 900);
    assert.equal((await client.bytes(new DataView(input.buffer, input.byteOffset, input.byteLength))).hash, hash(input));
    assert.equal((await client.bytes(new Uint8Array())).hash, hash(new Uint8Array()));
    client.destroy();
});

test('a mid-stream worker failure restarts from the original bytes in a new classic worker', async () => {
    let chunks = 0;
    const win = environment({ fault: (worker, data) => worker.type === 'module' && data.type === 'bytes-chunk' && ++chunks === 2 ? 'error' : '' });
    const client = new HashClient(win);
    const input = new TextEncoder().encode('漢🙂'.repeat(200_000));
    assert.equal((await client.bytes(input)).hash, hash(input));
    assert.equal(client.describe().recoveries, 1);
    assert.equal(client.describe().workerType, 'classic');
    assert.equal(win.stats.active, 1);
    assert.equal((await client.hash('next')).hash, hash('next'));
    client.destroy();
});

test('postMessage failure, messageerror and a bad acknowledgement recover without skipping validation', async () => {
    for (const action of ['throw', 'messageerror', 'bad-ack']) {
        let failed = false;
        const win = environment({ fault: (_worker, data) => {
            if (!failed && data.type === 'bytes-chunk') { failed = true; return action; } return '';
        } });
        const client = new HashClient(win);
        const input = new TextEncoder().encode('intact bytes');
        assert.equal((await client.bytes(input)).hash, hash(input));
        assert.equal(client.describe().recoveries, 1);
        client.destroy();
    }
});

test('chunk timeouts have bounded retry, retain the source and permit a later explicit retry', async () => {
    let hang = true;
    const win = environment({ fault: (_worker, data) => hang && data.type === 'bytes-chunk' ? 'hang' : '' });
    const client = new HashClient(win, { chunkTimeoutMs: 5 });
    const input = new TextEncoder().encode('unchanged');
    await assert.rejects(client.bytes(input), error => error.code === 'autoHashUnavailable'
        && error.details.reason === 'worker-timeout' && error.details.phase === 'bytes-chunk');
    assert.equal(win.stats.created.length, 2);
    assert.equal(win.stats.active, 0);
    assert.equal(new TextDecoder().decode(input), 'unchanged');
    hang = false;
    assert.equal((await client.bytes(input)).hash, hash(input));
    assert.equal(win.stats.created.length, 3);
    client.destroy();
});

test('concurrent callers are serialized, and destroying a client cancels pending and future work', async () => {
    const win = environment(); const client = new HashClient(win);
    const data = new TextEncoder().encode('serialized');
    const results = await Promise.all([client.bytes(data), client.bytes(data), client.hash('last')]);
    assert.equal(results[0].hash, hash(data)); assert.equal(results[1].hash, hash(data)); assert.equal(results[2].hash, hash('last'));
    assert.equal(win.stats.created.length, 1);
    client.destroy();
    await assert.rejects(client.hash('never run'), error => error.details.reason === 'worker-stopped');
    assert.equal(win.stats.active, 0);
});

test('HTTP without either worker fails clearly; HTTPS retains native hashing without a worker', async () => {
    const client = new HashClient({ crypto: {} });
    await assert.rejects(client.probe({ requireWorker: true }), error => error.details.reason === 'worker-unavailable');
    await assert.rejects(client.hash('no UI-thread pure JS hashing'), { code: 'autoHashUnavailable' });
    const secure = new HashClient({ crypto: webcrypto });
    assert.equal((await secure.hash('native')).hash, hash('native'));
    client.destroy(); secure.destroy();
});

test('a failed self-test in both candidates never runs a job; a later retry can recover', async () => {
    let broken = true;
    const win = environment({ mode: () => broken ? 'bad-probe' : '' });
    const client = new HashClient(win);
    await assert.rejects(client.bytes(new Uint8Array([1, 2, 3])), error => error.details.reason === 'worker-self-test');
    assert.equal(win.stats.active, 0);
    assert.ok(win.stats.messages.every(item => item.type === 'probe'));
    broken = false;
    assert.equal((await client.hash('recovered')).hash, hash('recovered'));
    client.destroy();
});

test('destroy during a pending job rejects it and queued jobs without resurrecting the worker', async () => {
    let started;
    const signal = new Promise(resolve => { started = resolve; });
    const win = environment({ fault: (_worker, data) => {
        if (data.type === 'hash') { started(); return 'hang'; } return '';
    } });
    const client = new HashClient(win);
    const active = client.hash('pending'); const queued = client.bytes(new Uint8Array([1]));
    const settled = Promise.allSettled([active, queued]);
    await signal; client.destroy();
    for (const result of await settled) {
        assert.equal(result.status, 'rejected'); assert.equal(result.reason.details.reason, 'worker-stopped');
    }
    assert.equal(client.pending.size, 0);
    assert.equal(win.stats.created.length, 1);
    assert.equal(win.stats.active, 0);
});

test('diagnostic details contain only whitelisted classifications and counters', () => {
    assert.deepEqual(safeHashFailure({ reason: 'worker-timeout', phase: 'bytes-chunk', workerType: 'classic',
        timeoutMs: 5, completedBytes: 12, totalBytes: 100, value: 'secret', key: 'private', url: 'http://secret/token' }),
    { reason: 'worker-timeout', phase: 'bytes-chunk', workerType: 'classic', timeoutMs: 5, completedBytes: 12, totalBytes: 100 });
    assert.deepEqual(safeHashFailure({ reason: 'secret', phase: 'private', totalBytes: -1 }), {});
});

test('actual IndexedDB download verifies multiple chunks using the HTTP classic worker fallback', async t => {
    const win = environment({ mode: type => type === 'module' ? 'throw' : '' });
    const descriptors = Object.fromEntries(['Worker', 'crypto', 'indexedDB'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries({ Worker: win.Worker, crypto: {}, indexedDB: { open() {}, databases: async () => [] } })) {
        Object.defineProperty(globalThis, key, { value, configurable: true });
    }
    t.after(() => { for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    } });
    await preflightIndexedDbTransfer();
    const archive = { format: 'sillytavern-indexeddb-backup', version: 1, createdAt: '', scope: { kind: 'all' }, databases: [
        { name: 'test', version: 1, stores: [{ name: 'records', keyPath: null, autoIncrement: false, indexes: [], records: [{ key: '中文', value: '🙂'.repeat(300_000) }] }] },
    ] };
    const encoded = Buffer.from(JSON.stringify(archive));
    const digest = hash(encoded);
    const metadata = { size: encoded.length, chunks: Math.ceil(encoded.length / INDEXEDDB_CHUNK_BYTES), digest };
    const request = async route => {
        const index = Number(route);
        return { index, chunks: metadata.chunks, digest, chunk: encoded.subarray(index * INDEXEDDB_CHUNK_BYTES, (index + 1) * INDEXEDDB_CHUNK_BYTES).toString('base64') };
    };
    const result = await downloadIndexedDbArchive(request, { metadata, chunkPath: String });
    assert.deepEqual(result.archive.databases, archive.databases);
    assert.equal(indexedDbHashDiagnostics().workerType, 'classic');
    assert.ok(win.stats.maxChunk <= 256 * 1024);
    await assert.rejects(downloadIndexedDbArchive(async () => ({ index: 0, chunks: metadata.chunks, digest, chunk: 'YQ==' }),
        { metadata, chunkPath: String }), { code: 'indexedDbTransferDigestMismatch' });
    await assert.rejects(downloadIndexedDbArchive(async route => ({ ...await request(route), digest: '0'.repeat(64) }),
        { metadata: { ...metadata, digest: '0'.repeat(64) }, chunkPath: String }),
    error => error.code === 'indexedDbTransferDigestMismatch' && error.operationStage === 'indexeddb-verify-download');
});

test('cleanup requests preserve the failed operation stage, and partial uploads are labelled explicitly', async () => {
    const entry = source.slice(source.indexOf('async function fetchIndexedDbState('), source.indexOf('function indexedDbScopeContains('));
    const failure = Object.assign(new Error('hash failed'), { operationStage: 'indexeddb-verify-download' });
    const context = { diagnostics: { stage: '' }, downloadIndexedDbArchive: async () => { throw failure; },
        request: async (_path, options) => { context.diagnostics.stage = options.method === 'DELETE' ? 'DELETE cleanup' : 'POST scoped'; return { id: 'test' }; } };
    vm.runInNewContext(entry + '; result = fetchIndexedDbState({});', context);
    await assert.rejects(context.result, error => error === failure);
    assert.equal(context.diagnostics.stage, 'POST scoped');
    const finish = source.slice(source.indexOf('async function finishManualIndexedDbUpload('), source.indexOf('async function manualPushLocked('));
    const step = { indexedDbConfig: () => ({ enabled: true }), syncIndexedDb: async () => { throw failure; } };
    vm.runInNewContext(finish + '; result = finishManualIndexedDbUpload();', step);
    await assert.rejects(step.result, error => error.localStorageUploaded === true);
});
