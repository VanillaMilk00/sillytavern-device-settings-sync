import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { decideSync, fingerprint, requestCategory, planRemote, isTransient } from '../lib/auto-core.js';
import { commitMutations, findCommit } from '../server-plugin/commit.js';
import { createInitialState, mergeMutations } from '../server-plugin/state.js';

const input = (revision = 0, mutations = [{ key: 'theme', value: 'dark' }]) => ({
    expectedRevision: revision, operationId: 'operation_123', deviceId: 'device_123', mutations,
});
test('atomic commit handles more than one legacy batch and records one replayable receipt', () => {
    const request = input(0, Array.from({ length: 1001 }, (_, i) => ({ key: 'key' + i, value: String(i) })));
    const initial = createInitialState();
    const result = commitMutations(initial, request);
    assert.equal(Object.keys(result.state.entries).length, 1001);
    assert.equal(result.state.autoCommits.length, 1);
    assert.equal(initial.revision, 0);
    const newer = mergeMutations(result.state, { deviceId: 'device_other', mutations: [{ key: 'theme', value: 'newer' }] });
    const replay = commitMutations(newer, request);
    assert.equal(replay.replayed, true);
    assert.equal(replay.state.entries.theme.value, 'newer');
    assert.equal(replay.receipt.revision, result.receipt.revision);
    assert.deepEqual(findCommit(newer, request.operationId), result.receipt);
});
test('version races, reused IDs and malformed complete commits fail before any mutation', () => {
    const first = commitMutations(createInitialState(), input()).state;
    const before = JSON.stringify(first);
    assert.throws(() => commitMutations(first, { ...input(), operationId: 'other_operation' }), { code: 'autoConflict' });
    assert.throws(() => commitMutations(first, input(0, [{ key: 'theme', value: 'different' }])), { code: 'commitConflict' });
    const invalid = [...Array.from({ length: 1000 }, (_, i) => ({ key: 'key' + i, value: 'good' })), { key: 'bad', value: 10 }];
    assert.throws(() => commitMutations(first, input(first.revision, invalid)));
    assert.equal(JSON.stringify(first), before);
    assert.throws(() => commitMutations(first, { ...input(), operationId: 12345678 }), { code: 'invalidCommit' });
    assert.throws(() => commitMutations(first, input(first.revision, [{ key: 'sillytavern_settings_sync_device_id', value: 'no' }])), { code: 'invalidCommit' });
});
test('atomic commits preserve special keys and reject per-key and total size excess', () => {
    const result = commitMutations(createInitialState(), input(0, [{ key: '__proto__', value: 'string' }]));
    assert.equal(JSON.parse(JSON.stringify(result.state)).entries.__proto__.value, 'string');
    assert.throws(() => commitMutations(createInitialState(), input(0, [{ key: 'big', value: 'x'.repeat(256 * 1024 + 1) }])), RangeError);
    assert.throws(() => commitMutations(createInitialState(), input(0, Array.from({ length: 22 }, (_, i) => ({ key: 'big' + i, value: 'x'.repeat(256 * 1024) })))), RangeError);
});
test('sync decisions protect first-run and two-sided changes without coupling switches', () => {
    const baseline = { localHash: 'base', remoteHash: 'base' };
    assert.equal(decideSync('download', null, 'local', 'remote', true), 'conflict');
    assert.equal(decideSync('upload', null, 'local', 'remote', true), 'conflict');
    assert.equal(decideSync('download', baseline, 'local', 'base', true), 'unchanged');
    assert.equal(decideSync('download', baseline, 'base', 'remote', true), 'download');
    assert.equal(decideSync('download', baseline, 'local', 'remote', true), 'conflict');
    assert.equal(decideSync('upload', baseline, 'local', 'base', true), 'upload');
    assert.equal(decideSync('upload', baseline, 'base', 'remote', true), 'conflict');
    assert.equal(decideSync('upload', null, 'local', 'empty', false), 'conflict');
    assert.equal(decideSync('download', null, 'local', 'empty', false), 'empty');
    assert.equal(decideSync('upload', null, 'same', 'same', true), 'equal');
});
test('fingerprints are order-independent and include original Unicode string values', async () => {
    const a = new Map([['中文😀', ''], ['__proto__', 'text']]);
    assert.equal(await fingerprint(a, webcrypto), await fingerprint(new Map([...a].reverse()), webcrypto));
    assert.notEqual(await fingerprint(a, webcrypto), await fingerprint(new Map(a).set('中文😀', 'x'), webcrypto));
});
test('model endpoint detection excludes sync, health and generic API traffic', () => {
    for (const url of ['/api/backends/chat-completions/generate', '/api/plugins/openai-responses/generate', 'https://provider.test/v1/responses?key=secret', '/v1/messages', '/models/gemini:streamGenerateContent']) assert.equal(requestCategory(url, 'POST'), 'generation');
    assert.equal(requestCategory('/v1/embeddings', 'POST'), 'retrieval');
    for (const url of ['/api/plugins/device-settings-sync/commit', '/api/settings/save', '/api/backends/chat-completions/status', '/v1/models', '/health']) assert.equal(requestCategory(url, 'POST'), null);
    assert.equal(requestCategory('/v1/responses', 'GET'), null);
});
test('download plans retain excluded and absent keys while honoring explicit tombstones', () => {
    const before = new Map([['theme', 'old'], ['absent', 'keep'], ['draft', 'keep'], ['remove', 'old'], ['sillytavern_settings_sync_device_id', 'keep']]);
    const entries = { theme: { value: 'new' }, remove: { deleted: true }, draft: { deleted: true }, sillytavern_settings_sync_device_id: { value: 'foreign' } };
    const plan = planRemote(before, { entries });
    assert.deepEqual(plan.changes.map(x => x.key), ['theme', 'remove']);
    assert.equal(before.get('theme'), 'old');
});
test('only transient network errors are automatically retried', () => {
    assert.ok(isTransient(new TypeError('network')));
    assert.ok(isTransient({ status: 503 }));
    for (const status of [400, 401, 403, 404, 409, 413, 500]) assert.equal(isTransient({ status }), false);
});
