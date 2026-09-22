// Requires a disposable local installation with enableUserAccounts: true.
// Creates one passwordless QA account, never use against your real data.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createArchive, MAX_ARCHIVE_BYTES } from '../lib/storage-model.js';

const url = new URL(process.env.DSS_QA_URL || 'http://127.0.0.1:18765');
assert.equal(process.env.DSS_QA_ALLOW_MUTATION, '1', 'Set DSS_QA_ALLOW_MUTATION=1 only for an isolated test account');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
const { request } = await import(process.env.DSS_PLAYWRIGHT_MODULE
    ? pathToFileURL(path.resolve(process.env.DSS_PLAYWRIGHT_MODULE)).href : 'playwright');
const contexts = [];
const base = '/api/plugins/device-settings-sync';
let passed = 0;
function pass(label) { console.log('PASS ' + (++passed) + ' ' + label); }
async function client(handle) {
    const context = await request.newContext({ baseURL: url.origin });
    contexts.push(context);
    const { token } = await (await context.get('/csrf-token')).json();
    const post = (endpoint, data) => context.post(endpoint, { headers: { 'x-csrf-token': token }, data });
    if (handle) assert.equal((await post('/api/users/login', { handle })).status(), 200);
    return { context, post };
}
try {
    const anonymous = await client();
    assert.equal((await anonymous.context.get(base + '/backups')).status(), 403);
    assert.equal((await anonymous.post(base + '/backups', {})).status(), 403);
    assert.equal((await anonymous.context.get(base + '/backups/not-a-real-id')).status(), 403);
    pass('all backup routes reject unauthenticated sessions');
    const admin = await client('default-user');
    const handle = 'dss-qa-' + Date.now();
    assert.equal((await admin.post('/api/users/create', { handle, name: 'Disposable DSS QA' })).status(), 200);
    const other = await client(handle);
    const payload = { operationId: 'security_' + Date.now(), reason: 'upload', archive: createArchive(new Map([['qa:credential', 'fake-test-value']])) };
    const savedResponse = await admin.post(base + '/backups', payload);
    assert.equal(savedResponse.status(), 200);
    const saved = await savedResponse.json();
    assert.deepEqual(await (await other.context.get(base + '/backups')).json(), []);
    assert.equal((await other.context.get(base + '/backups/' + saved.id)).status(), 404);
    const own = await (await other.post(base + '/backups', payload)).json();
    assert.notEqual(own.id, saved.id);
    assert.equal((await admin.context.get(base + '/backups/' + own.id)).status(), 404);
    pass('two logged-in accounts cannot read each other’s backup IDs or histories');
    assert.equal((await admin.context.post(base + '/backups', { data: payload })).status(), 403);
    assert.equal((await admin.context.post(base + '/backups', { headers: { 'x-csrf-token': 'invalid-token' }, data: payload })).status(), 403);
    pass('missing and incorrect CSRF tokens are rejected for logged-in users');
    const before = await (await admin.context.get(base + '/backups')).json();
    const invalid = await admin.post(base + '/backups', {});
    assert.equal(invalid.status(), 400);
    assert.equal((await invalid.json()).code, 'invalidArchive');
    const partial = await admin.post(base + '/backups', { ...payload, archive: createArchive(new Map(), { kind: 'keys', keys: [] }) });
    assert.equal(partial.status(), 400);
    const huge = await admin.post(base + '/backups', { ...payload, archive: createArchive(new Map([['large', 'x'.repeat(MAX_ARCHIVE_BYTES)]])) });
    assert.equal(huge.status(), 413);
    assert.equal((await huge.json()).code, 'archiveTooLarge');
    assert.deepEqual(await (await admin.context.get(base + '/backups')).json(), before);
    pass('invalid, partial and >32 MiB requests leave the prior history untouched');
    console.log('Completed ' + passed + ' server security checks. Disposable account: ' + handle);
} finally { await Promise.all(contexts.map(context => context.dispose())); }
