import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { sha256 } from '../lib/sha256.js';
import { connectionInfo } from '../lib/environment.js';
import { OperationCoordinator } from '../lib/operation-coordinator.js';
import { IncrementalAutoSync } from '../lib/incremental-auto-sync.js';

test('HTTP domains and public IPs remain eligible; LAN detection is informational', () => {
    for (const host of ['192.168.1.12', '10.0.0.1', '172.16.0.1', '[fd00::1]', 'st.example', '203.0.113.5']) {
        const location = new URL('http://' + host + ':11451');
        const info = connectionInfo({ location, isSecureContext: false });
        assert.equal(info.mode, 'http');
        assert.equal(info.privateIP, ['192.168.1.12', '10.0.0.1', '172.16.0.1', '[fd00::1]'].includes(host));
    }
    assert.equal(connectionInfo({ location: new URL('http://localhost'), isSecureContext: true }).mode, 'secure');
    assert.equal(connectionInfo({ location: new URL('https://st.example'), isSecureContext: true }).mode, 'secure');
    assert.equal(connectionInfo({ location: new URL('http://192.168.100.example'), isSecureContext: false }).privateIP, false);
});

test('HTTP worker SHA-256 matches server bytes at padding boundaries and for Unicode', () => {
    const cases = ['', 'abc', '中文🙂🧪', '\ud800a\udfff', 'x'.repeat(1_000_000)];
    for (const size of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 4097]) cases.push('a'.repeat(size));
    for (const value of cases) {
        const bytes = new TextEncoder().encode(value);
        assert.equal(sha256(bytes), createHash('sha256').update(bytes).digest('hex'));
    }
    const bytes = Uint8Array.from({ length: 2048 }, (_, i) => i % 256).subarray(7, 1800);
    assert.equal(sha256(bytes), createHash('sha256').update(bytes).digest('hex'));
});

test('without Web Locks or IndexedDB, manual work runs once while automatic work fails clearly', async () => {
    const win = { navigator: {}, crypto: webcrypto, setTimeout, clearTimeout };
    const coordinator = new OperationCoordinator(win, 'http-user');
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const first = coordinator.withLock(() => blocked, { manual: true });
    await assert.rejects(coordinator.withLock(() => {} , { manual: true }), { code: 'operationBusy' });
    release(42);
    assert.equal(await first, 42);
    await assert.rejects(coordinator.withLock(() => {}), { code: 'autoCoordinationUnavailable' });
    assert.equal(await coordinator.withLock(() => 'still works', { manual: true }), 'still works');
});

test('native coordination keeps the existing account lock and rejects concurrent actions', async () => {
    const win = { navigator: { locks: { request: async (name, options, work) => {
        assert.equal(name, 'dss-sync:alice'); assert.equal(options.ifAvailable, true); return work(null);
    } } }, crypto: webcrypto, setTimeout, clearTimeout };
    const coordinator = new OperationCoordinator(win, 'alice');
    await assert.rejects(coordinator.withLock(() => assert.fail('must not run')), { code: 'operationBusy' });
    assert.equal(coordinator.busy, false);
});

test('an exposed but blocked Web Locks API does not prevent an explicit manual operation', async () => {
    const win = { navigator: { locks: { request: async () => { throw new DOMException('Blocked', 'SecurityError'); } } },
        crypto: webcrypto, setTimeout, clearTimeout };
    const coordinator = new OperationCoordinator(win, 'blocked-locks');
    let executions = 0;
    await coordinator.withLock(() => { executions++; }, { manual: true });
    assert.equal(executions, 1);
    assert.equal(coordinator.native, false);
});

test('another tab recent batch start enforces the shared thirty-second gap without network reads', async () => {
    let scheduled, networkReads = 0;
    const sync = Object.assign(Object.create(IncrementalAutoSync.prototype), {
        running: false, apiActive: new Set(), now: () => 100_000,
        localPrefs: () => ({ upload: true }), api: { busy: () => false },
        openJournal: async () => ({ listBatches: async () => [], getMeta: async () => 99_000 }),
        schedule: delay => { scheduled = delay; }, serverMetadata: async () => { networkReads++; },
    });
    await sync.processQueueLocked();
    assert.equal(scheduled, 29_000);
    assert.equal(networkReads, 0);
    assert.equal(sync.running, false);
});

function savedBatchFixture(receipt) {
    const batch = { operationId: 'saved', scopeSignature: 'old-scope', payload: { mode: 'portable' } };
    let removed = 0, confirmed = 0, sent = 0;
    const journal = { namespace: 'portable', getMeta: async () => false, removeBatch: async () => { removed++; },
        confirmBatch: async () => { confirmed++; }, listPending: async () => [] };
    const sync = Object.assign(Object.create(IncrementalAutoSync.prototype), {
        api: { request: async () => { if (receipt) return receipt; throw Object.assign(new Error(), { code: 'commitNotFound' }); } },
        openJournal: async () => journal, signature: () => 'new-scope', mode: () => 'portable',
        localPrefs: () => ({ upload: true }), deferReconcile() {}, notify: async () => {}, lastConfirmedAt: 0,
        sendPayload: async () => { sent++; },
    });
    return { sync, batch, counts: () => ({ removed, confirmed, sent }) };
}

test('reopening with a different range never resends an unconfirmed old-range batch', async () => {
    const fixture = savedBatchFixture(null);
    await fixture.sync.sendBatchLocked(fixture.batch);
    assert.deepEqual(fixture.counts(), { removed: 1, confirmed: 0, sent: 0 });
});

test('an already committed batch recovers its receipt even when its old mode was disabled', async () => {
    const fixture = savedBatchFixture({ revision: 3, createdAt: '2026-10-15T00:00:00Z' });
    await fixture.sync.sendBatchLocked(fixture.batch);
    assert.deepEqual(fixture.counts(), { removed: 0, confirmed: 1, sent: 0 });
    assert.equal(fixture.sync.lastConfirmedAt, Date.parse('2026-10-15T00:00:00Z'));
});

test('revoked HTTP permission prevents close-time transmission without touching the saved queue', async () => {
    const sync = Object.assign(Object.create(IncrementalAutoSync.prototype), {
        sending: false, paused: false, connection: { mode: 'http' }, localPrefs: () => ({ allowHttp: false }),
        openJournal: () => assert.fail('must preserve the queue without attempting transmission'),
    });
    await sync.flushPreparedForClose();
});

test('an IndexedDB lease-write failure preserves manual fallback but stops automatic work', async () => {
    const coordinator = new OperationCoordinator({ navigator: {}, crypto: webcrypto, setTimeout, clearTimeout }, 'quota');
    coordinator.database = async () => ({});
    coordinator.acquire = async () => { throw new DOMException('Full', 'QuotaExceededError'); };
    assert.equal(await coordinator.withLock(() => 7, { manual: true }), 7);
    await assert.rejects(coordinator.withLock(() => assert.fail('must not run')), { code: 'autoCoordinationUnavailable' });
});
