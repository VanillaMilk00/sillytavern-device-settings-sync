// Fault-injection checks on a disposable local HTTP SillyTavern only.
// This is not a physical Safari/iOS test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

assert.equal(process.env.DSS_QA_ALLOW_MUTATION, '1');
const host = new URL(process.env.DSS_QA_URL);
assert.equal(host.protocol, 'http:');
assert.ok(Object.values(os.networkInterfaces()).flat().some(item => item.address === host.hostname));
assert.match(path.basename(process.env.DSS_QA_DATA_ROOT || ''), /^data-(?:http|hash)-/u);
await fs.access(process.env.DSS_QA_DATA_ROOT);
const { chromium } = await import(pathToFileURL(path.resolve(process.env.DSS_PLAYWRIGHT_MODULE)).href);
const browser = await chromium.launch({ channel: process.env.DSS_BROWSER_CHANNEL || 'msedge', headless: true });
const base = '/api/plugins/device-settings-sync';
const modules = '/scripts/extensions/third-party/sillytavern-device-settings-sync/';
const results = [];
const pass = label => { results.push(label); console.log('PASS ' + results.length + ' ' + label); };
const dbName = 'qa-hash-browser-' + Date.now();
const expectedValue = '中文🙂' + 'v'.repeat(1_200_000);
try {
    const context = await browser.newContext({ locale: 'en-US' });
    const errors = [];
    context.on('page', target => target.on('pageerror', error => errors.push(error.message)));
    const { token } = await (await context.request.get(host.origin + '/csrf-token')).json();
    assert.equal((await context.request.post(host.origin + '/api/users/login', { headers: { 'x-csrf-token': token }, data: { handle: 'default-user' } })).status(), 200);
    const normal = await context.newPage(); await ready(normal);
    const normalHash = await normal.evaluate(async modules => {
        const { HashClient } = await import(modules + 'lib/hash-client.js');
        const client = new HashClient(window); await client.probe({ requireWorker: true });
        const digest = await client.hash('normal module 中文🙂'); const state = client.describe(); client.destroy();
        return { hash: digest.hash, state };
    }, modules);
    assert.equal(normalHash.hash, createHash('sha256').update('normal module 中文🙂').digest('hex'));
    assert.equal(normalHash.state.workerType, 'module'); await normal.close();
    pass('normal module worker path remains available and byte-compatible without fault injection');
    async function configure(ctx, selectedDb = '') {
        await ctx.route('**/workers/hash-worker.js', route => route.abort());
        await ctx.addInitScript(({ selectedDb }) => {
            if (!['http:', 'https:'].includes(location.protocol)) return;
            localStorage.setItem('language', 'en');
            if (selectedDb) {
                localStorage.setItem('sillytavern_settings_sync_auto_default-user:indexeddb-config', JSON.stringify({ enabled: true, scopeMode: 'selected' }));
                localStorage.setItem('sillytavern_settings_sync_auto_default-user:indexeddb-scope', JSON.stringify({ kind: 'databases', names: [selectedDb] }));
            }
            const NativeWorker = window.Worker;
            globalThis.qaHashStats = { active: 0, created: 0, maxChunk: 0, chunks: 0 };
            globalThis.qaHashFault = '';
            globalThis.qaHashFaultUsed = false;
            window.Worker = class extends NativeWorker {
                constructor(...args) { super(...args); qaHashStats.active++; qaHashStats.created++; }
                postMessage(data, transfer) {
                    if (data.type === 'bytes-chunk') {
                        qaHashStats.maxChunk = Math.max(qaHashStats.maxChunk, data.bytes.byteLength); qaHashStats.chunks++;
                        if (qaHashFault === 'error' || (qaHashFault === 'once' && !qaHashFaultUsed)) {
                            qaHashFaultUsed = true;
                            this.dispatchEvent(new ErrorEvent('error', { message: 'Injected worker failure; no source data' }));
                            return;
                        }
                        if (qaHashFault === 'hang') return;
                    }
                    return super.postMessage(data, transfer);
                }
                terminate() { if (!this.qaTerminated) { this.qaTerminated = true; qaHashStats.active--; } return super.terminate(); }
            };
        }, { selectedDb });
    }
    await configure(context);
    const page = await context.newPage();
    async function ready(target) {
        await target.goto(host.href);
        await target.waitForFunction(() => !!globalThis.DeviceSettingsSync?.getDiagnostics().automatic, { timeout: 60_000 });
        const onboarding = target.locator('dialog[open]').filter({ has: target.locator('.onboarding') });
        if (await onboarding.count()) await onboarding.locator('.popup-button-ok').click();
        await target.waitForFunction(() => DeviceSettingsSync.getDiagnostics().runtime?.state === 'ready', { timeout: 30_000 });
    }
    async function api(route) {
        const response = await context.request.get(host.origin + base + route);
        assert.equal(response.status(), 200); return response.json();
    }
    await ready(page);
    assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, subtle: !!crypto.subtle })), { secure: false, subtle: false });
    pass('actual insecure HTTP has no native digest; module-worker loading is deliberately blocked');
    const result = await page.evaluate(async modules => {
        const { HashClient } = await import(modules + 'lib/hash-client.js');
        globalThis.qaHashClient = new HashClient(window);
        await qaHashClient.probe({ requireWorker: true });
        const input = Uint8Array.from({ length: 3 * 1024 * 1024 + 17 }, (_, i) => i % 251);
        const started = performance.now(); const digest = await qaHashClient.bytes(input);
        const state = qaHashClient.describe();
        return { hash: digest.hash, length: input.byteLength, first: input[0], last: input.at(-1), state,
            elapsedMs: performance.now() - started, stats: { ...qaHashStats } };
    }, modules);
    const binary = Uint8Array.from({ length: 3 * 1024 * 1024 + 17 }, (_, i) => i % 251);
    assert.equal(result.hash, createHash('sha256').update(binary).digest('hex'));
    assert.equal(result.length, binary.length); assert.equal(result.last, binary.at(-1));
    assert.equal(result.state.workerType, 'classic'); assert.equal(result.stats.maxChunk, 256 * 1024);
    pass('real classic worker verifies a multi-megabyte source in transferable chunks without detaching it');
    const recovered = await page.evaluate(async () => {
        qaHashFault = 'once'; qaHashFaultUsed = false;
        const input = new TextEncoder().encode('recover🙂');
        const digest = await qaHashClient.bytes(input);
        return { hash: digest.hash, state: qaHashClient.describe(), text: new TextDecoder().decode(input), active: qaHashStats.active };
    });
    assert.equal(recovered.hash, createHash('sha256').update('recover🙂').digest('hex'));
    assert.equal(recovered.text, 'recover🙂'); assert.equal(recovered.state.recoveries, 1); assert.equal(recovered.active, 1);
    pass('a real worker lost mid-job is replaced once and the original bytes are reverified');
    const timeout = await page.evaluate(async modules => {
        qaHashClient.destroy(); qaHashFault = 'hang';
        const { HashClient } = await import(modules + 'lib/hash-client.js');
        const client = new HashClient(window, { chunkTimeoutMs: 150 });
        let failure;
        try { await client.bytes(new Uint8Array([1, 2, 3])); } catch (error) { failure = { code: error.code, details: error.details }; }
        qaHashFault = '';
        const retried = await client.bytes(new Uint8Array([1, 2, 3]));
        const state = client.describe(); client.destroy();
        return { failure, hash: retried.hash, state, active: qaHashStats.active };
    }, modules);
    assert.equal(timeout.failure.code, 'autoHashUnavailable'); assert.equal(timeout.failure.details.reason, 'worker-timeout');
    assert.equal(timeout.hash, createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex')); assert.equal(timeout.active, 0);
    pass('chunk timeout fails after bounded retry; a later explicit retry creates a healthy worker');

    await page.evaluate(async ({ dbName, expectedValue }) => {
        const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open(dbName, 1); open.onupgradeneeded = () => open.result.createObjectStore('records');
            open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(expectedValue, '原始🙂'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        }); db.close();
        localStorage.setItem('qa:hash-browser', 'localStorage confirmed before IDB failure');
        localStorage.setItem('sillytavern_settings_sync_auto_default-user:indexeddb-config', JSON.stringify({ enabled: true, scopeMode: 'selected' }));
        localStorage.setItem('sillytavern_settings_sync_auto_default-user:indexeddb-scope', JSON.stringify({ kind: 'databases', names: [dbName] }));
        const original = window.fetch;
        globalThis.qaAfterCommitFault = true;
        window.fetch = async function(...args) {
            const response = await Reflect.apply(original, this, args);
            const path = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname;
            if (qaAfterCommitFault && response.ok && path.endsWith('/device-settings-sync/commit')) qaHashFault = 'error';
            return response;
        };
    }, { dbName, expectedValue });
    const idbBefore = await api('/indexeddb/state');
    const partial = await page.evaluate(async () => {
        try { await DeviceSettingsSync.pushCurrentDevice(); } catch { return DeviceSettingsSync.getDiagnostics(); }
    });
    assert.equal(partial.lastErrorCode, 'autoHashUnavailable'); assert.equal(partial.stage, 'indexeddb-verify-download');
    assert.equal(partial.lastErrorDetails.reason, 'worker-execution'); assert.match(partial.lastError, /localStorage was uploaded/u);
    assert.equal((await api('/state')).entries['qa:hash-browser'].value, 'localStorage confirmed before IDB failure');
    const idbAfter = await api('/indexeddb/state'); assert.equal(idbAfter.revision, idbBefore.revision);
    pass('late IndexedDB hash failure leaves its server revision untouched and reports partial localStorage success with the true stage');
    await page.evaluate(async () => { qaAfterCommitFault = false; qaHashFault = ''; await DeviceSettingsSync.pushCurrentDevice(); });
    assert.equal((await api('/indexeddb/state')).revision, idbBefore.revision + 1);
    assert.equal(await page.evaluate(() => DeviceSettingsSync.getDiagnostics().lastError), '');
    pass('manual retry rebuilds the failed IndexedDB worker and completes a multi-chunk backup/upload');

    const receiver = await browser.newContext({ locale: 'en-US' });
    await receiver.addCookies(await context.cookies()); await configure(receiver, dbName);
    const target = await receiver.newPage(); await ready(target);
    await target.evaluate(async dbName => {
        const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open(dbName, 1); open.onupgradeneeded = () => open.result.createObjectStore('records');
            open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put('retain', 'local-extra'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        }); db.close();
        await DeviceSettingsSync.pullFromServer({ reload: false });
    }, dbName);
    const restored = await target.evaluate(async dbName => {
        const db = await new Promise(resolve => { const open = indexedDB.open(dbName); open.onsuccess = () => resolve(open.result); });
        const rows = await Promise.all(['原始🙂', 'local-extra'].map(key => new Promise((resolve, reject) => {
            const get = db.transaction('records').objectStore('records').get(key); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
        }))); db.close(); return rows;
    }, dbName);
    assert.equal(restored[0], expectedValue); assert.equal(restored[1], 'retain');
    await receiver.close();
    pass('independent HTTP storage context restores IndexedDB through classic hashing and preserves local-only records');
    assert.deepEqual(errors, []);
    const output = path.resolve(process.env.DSS_QA_OUTPUT || 'qa-artifacts/hash'); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'hash-results.json'), JSON.stringify({ checks: results, performance: result, partial,
        physicalSafariTested: false, errors }, null, 2));
    console.log('Hash recovery browser checks passed: ' + results.length);
} finally { await browser.close(); }
