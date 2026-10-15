// Disposable SillyTavern only. The target must be an address of this machine.
// Use a separate dataRoot; this suite changes localStorage and server sync data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { incrementalHash } from '../server-plugin/incremental.js';

assert.equal(process.env.DSS_QA_ALLOW_MUTATION, '1');
const host = new URL(process.env.DSS_QA_URL);
const addresses = Object.values(os.networkInterfaces()).flat().map(item => item.address);
assert.ok(addresses.includes(host.hostname) || host.hostname === 'dss-http.test');
if (host.hostname === 'dss-http.test') assert.ok(addresses.includes(process.env.DSS_QA_LOCAL_IP), 'Test DNS must point to this machine');
const dataRoot = path.resolve(process.env.DSS_QA_DATA_ROOT || '');
assert.ok(path.basename(dataRoot).startsWith('data-http-'), 'Use a dedicated HTTP test dataRoot');
await fs.access(dataRoot);
const { chromium } = await import(pathToFileURL(path.resolve(process.env.DSS_PLAYWRIGHT_MODULE)).href);
const args = host.hostname === 'dss-http.test' ? ['--host-resolver-rules=MAP dss-http.test ' + process.env.DSS_QA_LOCAL_IP] : [];
const browser = await chromium.launch({ channel: process.env.DSS_BROWSER_CHANNEL || 'msedge', headless: true, args });
const base = '/api/plugins/device-settings-sync';
const output = path.resolve(process.env.DSS_QA_OUTPUT || 'qa-artifacts/http');
await fs.mkdir(output, { recursive: true });
let count = 0;
const results = [];
const pass = label => { results.push(label); console.log('PASS ' + (++count) + ' ' + label); };
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
    await context.addInitScript(() => {
        if (['http:', 'https:'].includes(location.protocol)) localStorage.setItem('language', 'en');
    });
    const errors = [];
    const traffic = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    context.on('request', request => { if (request.url().includes(base)) traffic.push(request.method() + ' ' + new URL(request.url()).pathname); });
    const page = await context.newPage();
    async function login(target) {
        await target.goto(host.href);
        await target.evaluate(async () => {
            const { token } = await (await fetch('/csrf-token')).json();
            const result = await fetch('/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify({ handle: 'default-user' }) });
            if (!result.ok) throw new Error('QA login failed: ' + result.status);
        });
    }
    async function ready(target = page) {
        await target.goto(host.href);
        await target.waitForFunction(() => Boolean(globalThis.DeviceSettingsSync), { timeout: 60_000 });
        await target.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic || document.querySelector('dialog[open] .onboarding'), { timeout: 60_000 });
        const onboarding = target.locator('dialog[open]').filter({ has: target.locator('.onboarding') });
        if (await onboarding.count()) await onboarding.locator('.popup-button-ok').click();
        try { await target.waitForFunction(() => Boolean(DeviceSettingsSync.getDiagnostics().automatic), { timeout: 30_000 }); }
        catch (error) {
            console.log('READY DIAGNOSTICS', await target.evaluate(() => ({ diagnostics: DeviceSettingsSync.getDiagnostics(), dialogs: [...document.querySelectorAll('dialog[open]')].map(n => n.textContent), toasts: document.querySelector('#toast-container')?.textContent })), errors);
            throw error;
        }
    }
    async function api(route, body, method = 'POST') {
        return page.evaluate(async ({ route, body, method, base }) => {
            const { token } = await (await fetch('/csrf-token')).json();
            const response = await fetch(base + route, { method: body ? method : 'GET', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, ...(body ? { body: JSON.stringify(body) } : {}) });
            const data = await response.json();
            if (!response.ok) throw new Error(JSON.stringify({ status: response.status, data }));
            return data;
        }, { route, body, method, base });
    }
    async function toggle(name, enabled, accept = true) {
        const input = page.locator('#dss_auto input[data-auto="' + name + '"]');
        if (await input.isChecked() === enabled) return;
        await input.evaluate(node => node.click());
        if (enabled) await page.locator('dialog[open]').last().locator(accept ? '.popup-button-ok' : '.popup-button-cancel').click();
        await page.waitForFunction(({ name }) => !document.querySelector('#dss_auto input[data-auto="' + name + '"]').disabled, { name });
    }
    async function waitValue(key, value, timeout = 45_000) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            const state = await api('/state');
            if (state.entries?.[key]?.value === value) return state;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('Unconfirmed key ' + key + ': ' + JSON.stringify(await page.evaluate(() => DeviceSettingsSync.getDiagnostics())));
    }
    async function forward(route) {
        const url = new URL(route.request().url());
        if (host.hostname === 'dss-http.test') url.hostname = process.env.DSS_QA_LOCAL_IP;
        return route.fetch({ url: url.href });
    }

    await login(page); await ready();
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().runtime?.state === 'ready');
    const environment = await page.evaluate(() => ({ secure: isSecureContext, locks: !!navigator.locks, subtle: !!crypto.subtle, state: DeviceSettingsSync.getDiagnostics().automatic }));
    assert.equal(environment.secure, false); assert.equal(environment.locks, false); assert.equal(environment.subtle, false);
    assert.equal(environment.state.allowHttp, false); assert.equal(environment.state.upload, false); assert.equal(environment.state.download, false);
    pass('real insecure HTTP origin has no Web Locks/Web Crypto; auto mode defaults off');

    await page.evaluate(() => {
        localStorage.setItem('qa:http', '中文🙂 baseline');
        localStorage.setItem('qa:large_cache', 'a'.repeat(4 * 1024 * 1024));
    });
    await page.locator('#dss_push').evaluate(node => node.click());
    await page.locator('dialog[open] .popup-button-ok').last().click();
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().lastAction === 'upload');
    assert.equal((await api('/state')).entries['qa:http'].value, '中文🙂 baseline');
    pass('manual upload works without HTTP automatic permission');

    await page.locator('#dss_copy').evaluate(node => node.click());
    await page.waitForSelector('#dss_diagnostics_fallback textarea');
    const diagnostic = JSON.parse(await page.locator('#dss_diagnostics_fallback textarea').inputValue());
    assert.equal(diagnostic.connection.mode, 'http'); assert.ok(!JSON.stringify(diagnostic).includes('中文🙂 baseline'));
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#dss_diagnostics_fallback button').click();
    const downloadedDiagnostic = JSON.parse(await fs.readFile(await (await downloadEvent).path(), 'utf8'));
    assert.deepEqual(downloadedDiagnostic, diagnostic);
    await page.locator('dialog[open] .popup-button-ok').last().click();
    pass('HTTP clipboard fallback exposes selectable diagnostics without setting values');

    const beforeConsent = traffic.length;
    await toggle('allowHttp', true, false);
    assert.equal(traffic.length, beforeConsent);
    assert.equal((await page.evaluate(() => DeviceSettingsSync.getDiagnostics().automatic)).allowHttp, false);
    await toggle('allowHttp', true);
    const permitted = await page.evaluate(() => DeviceSettingsSync.getDiagnostics().automatic);
    assert.equal(permitted.upload, false); assert.equal(permitted.download, false);
    pass('HTTP consent can be cancelled and never enables either direction by itself');
    await toggle('upload', true);
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.status === 'autoReady');
    assert.equal((await page.evaluate(() => DeviceSettingsSync.getDiagnostics().automatic)).download, false);
    await page.evaluate(() => {
        const read = Storage.prototype.getItem;
        globalThis.qaLargeReads = 0;
        Storage.prototype.getItem = function(key) { if (key === 'qa:large_cache') qaLargeReads++; return Reflect.apply(read, this, [key]); };
        globalThis.qaRestoreReads = () => { Storage.prototype.getItem = read; };
        globalThis.qaWriteStart = performance.now();
        for (let i=0;i<1000;i++) localStorage['qa:http'] = 'latest ' + i;
        globalThis.qaWriteMs = performance.now() - qaWriteStart;
    });
    await waitValue('qa:http', 'latest 999');
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.lastConfirmedAt > 0);
    assert.equal(traffic.filter(item => item.endsWith('/incremental/commit')).length, 1);
    pass('upload-only uses worker SHA fallback and coalesces 1000 direct assignments into one commit');
    const performanceResult = await page.evaluate(() => {
        qaRestoreReads(); return { largeValueUtf16Bytes: 8 * 1024 * 1024, largeValueReadsAfterSmallEdits: qaLargeReads, thousandWritesMs: qaWriteMs };
    });
    assert.equal(performanceResult.largeValueReadsAfterSmallEdits, 0);
    performanceResult.worker = await page.evaluate(async () => {
        const { HashClient } = await import('/scripts/extensions/third-party/sillytavern-device-settings-sync/lib/hash-client.js');
        const worker = new HashClient(window); await worker.probe({ requireWorker: true });
        const before = '中'.repeat(1_000_000) + 'old'; const after = '中'.repeat(1_000_000) + 'new🙂';
        const longTasks = []; const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(row => row.duration)));
        observer.observe({ type: 'longtask' });
        const start = performance.now(); const job = worker.prepare(before, after); const dispatchMs = performance.now() - start;
        const result = await job; const elapsedMs = performance.now() - start;
        await new Promise(resolve => setTimeout(resolve, 0));
        observer.disconnect(); worker.destroy();
        return { utf8Bytes: new TextEncoder().encode(after).byteLength, dispatchMs, elapsedMs,
            deltaBytes: new TextEncoder().encode(JSON.stringify(result.delta)).byteLength, longTasksOver50Ms: longTasks };
    });
    console.log('PERFORMANCE', JSON.stringify(performanceResult));
    pass('small-key autosave does not reread an unrelated 8 MiB UTF-16 value');

    if (!process.env.DSS_QA_QUICK) {
    const activeId = await page.evaluate(() => DeviceSettingsSync.beginModelActivity());
    await page.evaluate(() => localStorage.setItem('qa:http', 'after model'));
    await new Promise(resolve => setTimeout(resolve, 31_000));
    assert.equal((await api('/state')).entries['qa:http'].value, 'latest 999');
    await page.evaluate(id => DeviceSettingsSync.endModelActivity(id), activeId);
    await waitValue('qa:http', 'after model');
    pass('an ongoing model activity blocks HTTP autosave until completion');

    await toggle('download', true);
    let releaseCommit;
    let committed = false;
    const heldResponse = new Promise(resolve => { releaseCommit = resolve; });
    await page.route('**' + base + '/incremental/commit?*', async route => {
        const response = await forward(route); committed = true;
        await heldResponse; await route.fulfill({ response });
    });
    await page.evaluate(() => localStorage.setItem('qa:http', 'in flight first'));
    const deadline = Date.now() + 45_000;
    while (!committed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(committed, true);
    await page.evaluate(() => localStorage.setItem('qa:http', 'in flight second'));
    releaseCommit();
    await waitValue('qa:http', 'in flight second', 60_000);
    await page.unroute('**' + base + '/incremental/commit?*');
    pass('both directions can be enabled; a response cannot clear a newer local edit');

    let lostOperation;
    await page.route('**' + base + '/incremental/commit?*', async route => {
        lostOperation = JSON.parse(route.request().postData()).operationId;
        await forward(route); await route.abort('failed');
    });
    await page.evaluate(() => localStorage.setItem('qa:http', 'lost receipt'));
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.status === 'autoOffline', null, { timeout: 50_000 });
    const slotBeforeRetry = await api('/incremental/auto-upload');
    await page.unroute('**' + base + '/incremental/commit?*');
    await toggle('allowHttp', false);
    const retained = await page.evaluate(async modulePath => {
        const { openAutoJournal, AutoJournal } = await import(modulePath + 'auto-journal.js');
        const journal = new AutoJournal(await openAutoJournal(indexedDB, 'default-user'));
        try { return (await journal.listBatches()).length; } finally { journal.close(); }
    }, '/scripts/extensions/third-party/sillytavern-device-settings-sync/lib/');
    assert.equal(retained, 1);
    await toggle('allowHttp', true); await toggle('upload', true);
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.status === 'autoReady' || DeviceSettingsSync.getDiagnostics().automatic.status === 'autoConfirmed');
    assert.deepEqual(await api('/incremental/auto-upload'), slotBeforeRetry);
    assert.ok(lostOperation);
    assert.equal((await api('/state')).entries['qa:http'].value, 'lost receipt');
    pass('HTTP permission revocation retains a fixed batch; reenabling recovers its receipt without another version');

    const peer = await context.newPage(); await ready(peer);
    const modulePath = '/scripts/extensions/third-party/sillytavern-device-settings-sync/lib/';
    await page.evaluate(async modulePath => {
        const { OperationCoordinator } = await import(modulePath + 'operation-coordinator.js');
        globalThis.qaClock = Date.now();
        globalThis.qaCoordinator = new OperationCoordinator(window, 'lease-fixture', { now: () => qaClock });
        globalThis.qaLock = qaCoordinator.withLock(() => new Promise(resolve => { globalThis.qaRelease = resolve; })).catch(e => e.code);
    }, modulePath);
    await page.waitForFunction(() => !!globalThis.qaRelease);
    assert.equal(await peer.evaluate(async modulePath => {
        const { OperationCoordinator } = await import(modulePath + 'operation-coordinator.js');
        globalThis.qaClock = Date.now(); globalThis.qaCoordinator = new OperationCoordinator(window, 'lease-fixture', { now: () => qaClock });
        try { await qaCoordinator.withLock(() => {}); return 'ran'; } catch (e) { return e.code; }
    }, modulePath), 'operationBusy');
    pass('two tabs use one atomic account-scoped IDB lease');
    const oldTime = await page.evaluate(() => qaClock);
    await peer.evaluate(async now => {
        globalThis.qaClock = now + 31_000;
        globalThis.qaLock = qaCoordinator.withLock(() => new Promise(resolve => { globalThis.qaRelease = resolve; })).catch(e => e.code);
    }, oldTime);
    await peer.waitForFunction(() => !!globalThis.qaRelease);
    assert.equal(await page.evaluate(async modulePath => {
        const { AutoJournal } = await import(modulePath + 'auto-journal.js');
        const journal = new AutoJournal(await qaCoordinator.database()); journal.guard = tx => qaCoordinator.assertOwned(tx);
        try { await journal.queue([{ key: 'stale', value: 'must not write' }]); return 'wrote'; } catch (e) { return e.code; }
    }, modulePath), 'autoLeaseLost');
    await page.evaluate(async () => { qaRelease(); await qaLock; });
    await peer.evaluate(async () => { qaRelease(); await qaLock; });
    pass('expired owner is fenced out of journal writes after another tab takes over');
    await peer.close();
    const uncertain = await page.evaluate(async modulePath => {
        const { OperationCoordinator } = await import(modulePath + 'operation-coordinator.js');
        let clock = Date.now();
        const first = new OperationCoordinator(window, 'activity-fixture', { now: () => clock });
        first.beginActivity('unfinished', e => { throw e; });
        await first.activities.get('unfinished').ready;
        clock += 31_000;
        const next = new OperationCoordinator(window, 'activity-fixture', { now: () => clock });
        let error;
        try { await next.withLock(() => {}); } catch (e) { error = e.code; }
        await next.resetStaleActivities();
        const recovered = await next.withLock(() => true);
        await first.destroy(); await next.destroy();
        return { error, recovered };
    }, modulePath);
    assert.deepEqual(uncertain, { error: 'autoActivityUncertain', recovered: true });
    pass('expired request activity is never guessed complete; explicit retry can recover');

    await toggle('upload', false); await toggle('download', true);
    const state = await api('/state');
    const remoteValue = 'server change ' + Date.now();
    await api('/incremental/commit', { account: 'default-user', operationId: 'http_qa_' + Date.now(), deviceId: 'http_qa_device',
        expectedRevision: state.revision, mode: 'portable', automatic: true, scope: { mode: 'portable' },
        mutations: [{ key: 'qa:http', beforeHash: incrementalHash(state.entries['qa:http'].value), afterHash: incrementalHash(remoteValue), value: remoteValue }] });
    await ready();
    await page.waitForFunction(value => localStorage.getItem('qa:http') === value, remoteValue, { timeout: 45_000 });
    assert.equal((await page.evaluate(() => DeviceSettingsSync.getDiagnostics().automatic)).upload, false);
    pass('download-only applies server changes on reopening HTTP and does not enable uploads');
    await new Promise(resolve => setTimeout(resolve, 1500));
    await page.waitForFunction(() => globalThis.DeviceSettingsSync?.getDiagnostics().automatic?.status === 'autoReady');

    await toggle('allowHttp', false);
    const off = await page.evaluate(() => DeviceSettingsSync.getDiagnostics().automatic);
    assert.equal(off.upload, false); assert.equal(off.download, false); assert.equal(off.allowHttp, false);
    const indexedDbResult = await page.evaluate(async ({ base, modulePath }) => {
        const { preflightIndexedDbTransfer, uploadIndexedDbArchive, downloadIndexedDbArchive } = await import(modulePath + 'indexeddb-transfer.js');
        await preflightIndexedDbTransfer();
        const archive = { format: 'sillytavern-indexeddb-backup', version: 1, createdAt: new Date().toISOString(), scope: { kind: 'all' },
            databases: [{ name: 'qa-http-user-db', version: 1, stores: [{ name: 'records', keyPath: null, autoIncrement: false, indexes: [],
                records: [{ key: '中文🙂', value: 'record '.repeat(180_000) }] }] }] };
        const { token } = await (await fetch('/csrf-token')).json();
        const request = async (route, options = {}) => {
            const response = await fetch(base + route, { ...options, headers: { 'content-type': 'application/json', 'x-csrf-token': token } });
            if (!response.ok) throw new Error(await response.text()); return response.json();
        };
        const backup = await uploadIndexedDbArchive(request, archive, { kind: 'backup', reason: 'upload', operationId: 'http_idb_' + Date.now(), source: { deviceId: 'http-qa' } });
        const downloaded = await downloadIndexedDbArchive(request, { metadataPath: '/indexeddb/backups/' + backup.id,
            chunkPath: index => '/indexeddb/backups/' + backup.id + '/chunks/' + index });
        return { equal: JSON.stringify(downloaded.archive) === JSON.stringify(archive), bytes: downloaded.metadata.size, chunks: downloaded.metadata.chunks };
    }, { base, modulePath });
    assert.equal(indexedDbResult.equal, true); assert.ok(indexedDbResult.chunks > 1);
    pass('manual IndexedDB backup and download verify multi-chunk bytes without Web Crypto');
    await page.route('**' + base + '/backups', route => route.fulfill({ status: 503, json: { code: 'backupBackendMissing' } }));
    await page.locator('#dss_pull').evaluate(node => node.click());
    await page.locator('dialog[open] .popup-button-ok').last().click();
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().lastErrorCode === 'backupBackendMissing');
    assert.ok(await page.locator('#dss_status').textContent());
    await page.unroute('**' + base + '/backups');
    pass('revoking HTTP permission stops both directions; backup errors remain visible on manual buttons');

    async function scopeMode(mode) {
        await page.locator('#dss_storage_mode').evaluate((node, mode) => { node.value = mode; node.dispatchEvent(new Event('change', { bubbles: true })); }, mode);
        if (mode !== 'portable') await page.locator('dialog[open] .popup-button-ok').last().click();
        await page.waitForFunction(mode => !document.querySelector('#dss_storage_mode').disabled && localStorage.getItem('sillytavern_settings_sync_auto_default-user:localstorage-mode') === mode, mode);
    }
    async function waitFullHash(key, hash) {
        const end = Date.now() + 50_000;
        while (Date.now() < end) {
            const metadata = await api('/incremental/state?mode=full');
            if (metadata.entries[key]?.hash === hash) return metadata;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('Full/selected HTTP upload was not confirmed');
    }
    await scopeMode('full');
    const longKey = 'qa:long:設定🙂'.repeat(100);
    await page.evaluate(key => {
        localStorage.setItem(key, 'full original 長鍵名');
        localStorage.setItem('', 'full empty key');
    }, longKey);
    await page.evaluate(() => DeviceSettingsSync.pushCurrentDevice());
    const fullMetadata = await api('/incremental/state?mode=full');
    assert.equal(fullMetadata.entries['qa:large_cache'].hash, incrementalHash('a'.repeat(4 * 1024 * 1024)));
    assert.equal(fullMetadata.entries[longKey].hash, incrementalHash('full original 長鍵名'));
    assert.equal(fullMetadata.entries[''].hash, incrementalHash('full empty key'));
    await toggle('allowHttp', true); await toggle('upload', true);
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.status === 'autoReady');
    await page.evaluate(key => {
        localStorage.setItem('qa:large_cache', localStorage.getItem('qa:large_cache') + 'Δ🙂');
        localStorage.setItem(key, 'full automatic 長鍵名');
    }, longKey);
    const largeHash = incrementalHash('a'.repeat(4 * 1024 * 1024) + 'Δ🙂');
    await waitFullHash('qa:large_cache', largeHash);
    await waitFullHash(longKey, incrementalHash('full automatic 長鍵名'));
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.pending === 0);
    await toggle('upload', false);
    pass('full HTTP manual and automatic sync preserve long/empty keys and a large original string');

    await page.evaluate(key => localStorage.setItem('sillytavern_settings_sync_auto_default-user:localstorage-scope', JSON.stringify({ kind: 'keys', keys: ['qa:http', key, ''] })), longKey);
    await scopeMode('selected');
    await page.evaluate(key => {
        localStorage.setItem(key, 'selected manual 長鍵名');
        localStorage.setItem('', 'selected manual empty key');
    }, longKey);
    await page.evaluate(() => DeviceSettingsSync.pushCurrentDevice());
    const selectedManual = await api('/full-state');
    assert.equal(selectedManual.entries[longKey], 'selected manual 長鍵名');
    assert.equal(selectedManual.entries[''], 'selected manual empty key');
    await toggle('upload', true);
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.status === 'autoReady');
    await page.evaluate(key => {
        localStorage.setItem('qa:http', 'only-selected');
        localStorage.setItem(key, 'selected automatic 長鍵名');
        localStorage.setItem('', 'selected automatic empty key');
    }, longKey);
    const selectedMetadata = await waitFullHash('qa:http', incrementalHash('only-selected'));
    await waitFullHash(longKey, incrementalHash('selected automatic 長鍵名'));
    await waitFullHash('', incrementalHash('selected automatic empty key'));
    assert.equal(selectedMetadata.entries['qa:large_cache'].hash, largeHash);
    await toggle('allowHttp', false);
    pass('selected HTTP manual/automatic sync includes long/empty keys and preserves unselected values');

    const receiver = await browser.newContext({ locale: 'en-US' });
    await receiver.addCookies(await context.cookies());
    await receiver.addInitScript(() => {
        if (['http:', 'https:'].includes(location.protocol)) {
            localStorage.setItem('language', 'en');
            localStorage.setItem('sillytavern_settings_sync_auto_default-user:localstorage-mode', 'full');
        }
    });
    const receiverPage = await receiver.newPage();
    await ready(receiverPage);
    await receiverPage.evaluate(() => DeviceSettingsSync.pullFromServer({ reload: false }));
    assert.equal(await receiverPage.evaluate(key => localStorage.getItem(key), longKey), 'selected automatic 長鍵名');
    assert.equal(await receiverPage.evaluate(() => localStorage.getItem('')), 'selected automatic empty key');
    assert.equal((await receiverPage.evaluate(() => DeviceSettingsSync.getDiagnostics())).lastAction, 'download');
    await receiver.close();
    pass('another browser storage context restores the original long and empty keys from the server');
    }

    await toggle('allowHttp', false);
    const restricted = await browser.newContext();
    await restricted.addCookies(await context.cookies());
    await restricted.addInitScript(() => {
        globalThis.Worker = undefined;
        if (['http:', 'https:'].includes(location.protocol)) {
            localStorage.setItem('language', 'en');
            localStorage.setItem('qa:preflight', 'unchanged');
            localStorage.setItem('sillytavern_settings_sync_auto_default-user:indexeddb-config', JSON.stringify({ enabled: true, scopeMode: 'selected' }));
            localStorage.setItem('sillytavern_settings_sync_auto_default-user:indexeddb-scope', JSON.stringify({ kind: 'databases', names: ['qa-http-user-db'] }));
        }
    });
    const restrictedTraffic = [];
    restricted.on('request', request => { if (request.url().includes(base + '/backups')) restrictedTraffic.push(request.method()); });
    const restrictedPage = await restricted.newPage(); await ready(restrictedPage);
    const preflightFailure = await restrictedPage.evaluate(async () => {
        try { await DeviceSettingsSync.pushCurrentDevice(); } catch (e) { return e.code; }
    });
    assert.equal(preflightFailure, 'autoHashUnavailable'); assert.deepEqual(restrictedTraffic, []);
    assert.equal(await restrictedPage.evaluate(() => localStorage.getItem('qa:preflight')), 'unchanged');
    pass('unsupported manual IndexedDB fails preflight before any localStorage backup or change');
    await restrictedPage.evaluate(async () => {
        localStorage.removeItem('sillytavern_settings_sync_auto_default-user:indexeddb-config');
        await DeviceSettingsSync.pushCurrentDevice();
    });
    assert.equal(restrictedTraffic.length, 1);
    await restricted.close();
    pass('manual localStorage still works when automatic mode and the hash worker are unavailable');

    async function openControls() {
        if (!await page.locator('#rm_extensions_block').isVisible()) {
            await page.locator('#extensions-settings-button .drawer-toggle').evaluate(node => node.click());
            await page.locator('#rm_extensions_block').waitFor({ state: 'visible' });
        }
        const content = page.locator('#device_settings_sync_panel .inline-drawer-content');
        if (await content.evaluate(node => getComputedStyle(node).display === 'none')) await page.locator('#device_settings_sync_panel .inline-drawer-toggle').evaluate(node => node.click());
        await page.waitForFunction(() => { const jq = globalThis.jQuery || globalThis.$; return !jq || !jq('#device_settings_sync_panel .inline-drawer-content').is(':animated'); });
        if (await page.locator('#dss_settings_menu').evaluate(node => node.hidden)) await page.locator('#dss_settings_toggle').evaluate(node => node.click());
        await page.locator('#dss_auto label').first().waitFor({ state: 'visible' });
    }
    await openControls();
    await page.locator('#dss_auto label').first().evaluate(node => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(output, 'http-desktop-layout.png'), fullPage: true });
    await page.setViewportSize({ width: 412, height: 915 });
    await openControls();
    await page.locator('#dss_auto label').first().evaluate(node => node.scrollIntoView({ block: 'start' }));
    const bounds = await page.locator('#dss_auto').boundingBox();
    assert.ok(bounds.width <= 412);
    await page.screenshot({ path: path.join(output, 'http-mobile-layout.png'), fullPage: true });
    assert.deepEqual(errors, []);
    pass('mobile viewport renders without uncaught browser errors (not a physical Android test)');
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ origin: host.origin, environment, performance: performanceResult, checks: results, errors }, null, 2));
    console.log('HTTP checks passed: ' + count);
} finally { await browser.close(); }
