// Disposable-host only. Never point this at everyday account data or real model APIs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.DSS_QA_ALLOW_MUTATION, '1');
const host = new URL(process.env.DSS_QA_URL || 'http://127.0.0.1:18765');
assert.ok(['127.0.0.1', 'localhost'].includes(host.hostname));
const { chromium } = await import(pathToFileURL(path.resolve(process.env.DSS_PLAYWRIGHT_MODULE)).href);
const model = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/event-stream');
    if (req.url.includes('failed')) { res.writeHead(503); res.end('failed'); return; }
    res.writeHead(200);
    res.write('data: first\n\n');
    const timer = setTimeout(() => res.end('data: last\n\n'), 700);
    req.on('close', () => clearTimeout(timer));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const modelUrl = 'http://127.0.0.1:' + model.address().port;
const browser = await chromium.launch({ channel: process.env.DSS_BROWSER_CHANNEL || 'msedge', headless: true });
let count = 0;
const pass = name => console.log('PASS ' + (++count) + ' ' + name);
const base = '/api/plugins/device-settings-sync';
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
    await context.addInitScript(() => localStorage.setItem('language', 'en'));
    const request = context.request;
    let { token } = await (await request.get(host.origin + '/csrf-token')).json();
    if (process.env.DSS_QA_HANDLE) {
        assert.equal((await request.post(host.origin + '/api/users/login', { headers: { 'x-csrf-token': token }, data: { handle: process.env.DSS_QA_HANDLE } })).status(), 200);
        ({ token } = await (await request.get(host.origin + '/csrf-token')).json());
    }
    async function api(route, body) {
        const response = body ? await request.post(host.origin + base + route, { headers: { 'x-csrf-token': token }, data: body })
            : await request.get(host.origin + base + route);
        return { status: response.status(), body: await response.json() };
    }
    async function waitForRemoteValue(key, value) {
        const deadline = Date.now() + 20000;
        let latest;
        while (Date.now() < deadline) {
            latest = await api('/state');
            if (latest.status === 200 && latest.body.entries?.[key]?.value === value) return latest.body;
            await page.waitForTimeout(200);
        }
        throw new Error(`Server did not confirm ${key}; last value was ${JSON.stringify(latest?.body?.entries?.[key] ?? null)}`);
    }
    const page = await context.newPage();
    const errors = [];
    const traffic = [];
    const incrementalCommits = [];
    page.on('pageerror', error => errors.push(error.message));
    context.on('request', req => {
        if (req.url().includes(base)) {
            const route = req.method() + ' ' + new URL(req.url()).pathname;
            traffic.push(route);
            if (route === 'POST ' + base + '/incremental/commit') incrementalCommits.push(req.postData());
        }
    });
    async function ready(target) {
        await target.goto(host.href);
        await target.waitForFunction(() => Boolean(globalThis.DeviceSettingsSync));
        await target.waitForFunction(() => globalThis.DeviceSettingsSync.getDiagnostics().automatic || document.querySelector('dialog[open] .onboarding'));
        const onboarding = target.locator('dialog[open]').filter({ has: target.locator('.onboarding') });
        if (await onboarding.count()) await onboarding.locator('.popup-button-ok').click();
        await target.waitForFunction(() => globalThis.DeviceSettingsSync.getDiagnostics().automatic);
    }
    async function toggle(name, enabled, confirm = true) {
        const input = page.locator('#dss_auto input[data-auto="' + name + '"]');
        if (await input.isChecked() === enabled) return;
        await input.evaluate(node => node.click());
        if (enabled) await page.locator('dialog[open]').last().locator(confirm ? '.popup-button-ok' : '.popup-button-cancel').click();
        await page.waitForFunction(() => ![...document.querySelectorAll('#dss_auto input')].some(node => node.disabled));
    }
    await ready(page);
    assert.deepEqual(traffic, []);
    assert.equal(await page.locator('#dss_auto input[data-auto="upload"]').isChecked(), false);
    assert.equal(await page.locator('#dss_auto input[data-auto="download"]').isChecked(), false);
    await page.evaluate(() => localStorage.setItem('auto:theme', 'base'));
    await page.evaluate(() => DeviceSettingsSync.pushCurrentDevice());
    traffic.length = 0;
    await toggle('upload', true, false);
    assert.equal(await page.locator('#dss_auto input[data-auto="upload"]').isChecked(), false);
    assert.deepEqual(traffic, []);
    pass('both switches default off; cancelled consent never activates or contacts sync APIs');

    await toggle('upload', true);
    assert.equal(await page.locator('#dss_auto input[data-auto="download"]').isChecked(), false);
    await page.evaluate(url => {
        globalThis.qaFetch = fetch(url + '/v1/chat/completions', { method: 'POST' }).then(async response => {
            globalThis.qaHeaders = { native: response instanceof Response, url: response.url };
            globalThis.qaBody = await response.text();
        });
    }, modelUrl);
    await page.waitForFunction(() => globalThis.qaHeaders);
    assert.equal(await page.evaluate(() => globalThis.qaHeaders.native), true);
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.active > 0, null, { timeout: 10000 }).catch(async error => {
        console.error('Automatic request monitor diagnostics:', await page.evaluate(() => DeviceSettingsSync.getDiagnostics().automatic));
        throw error;
    });
    assert.equal(await page.evaluate(() => globalThis.qaBody), undefined);
    await page.evaluate(() => globalThis.qaFetch);
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.active === 0);
    assert.equal(await page.evaluate(() => globalThis.qaBody), 'data: first\n\ndata: last\n\n');
    pass('real streaming fetch stays active after headers and preserves the original Response and body');

    await page.evaluate(url => new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url + '/v1/embeddings?failed=1');
        xhr.onloadend = () => { globalThis.qaXHR = xhr.status; resolve(); };
        xhr.send();
    }), modelUrl);
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.active === 0);
    assert.equal(await page.evaluate(() => globalThis.qaXHR), 503);
    pass('failed XHR model requests finish normally without modifying status or response handling');

    await page.evaluate(() => {
        const frame = document.createElement('iframe'); frame.id = 'qa-model-frame'; frame.src = 'about:blank'; document.body.append(frame);
    });
    await page.waitForFunction(() => document.querySelector('#qa-model-frame')?.contentWindow.fetch.toString().includes('originalFetch'));
    await page.evaluate(url => {
        globalThis.qaFrameDone = document.querySelector('#qa-model-frame').contentWindow.fetch(url + '/v1/responses', { method: 'POST' }).then(response => response.text());
    }, modelUrl);
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.active > 0);
    assert.equal(await page.evaluate(() => globalThis.qaFrameDone), 'data: first\n\ndata: last\n\n');
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.active === 0);
    await page.evaluate(() => document.querySelector('#qa-model-frame').remove());
    pass('accessible same-origin iframe model requests participate in the same activity count');

    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('/script.js');
        await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
    });
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.active > 0);
    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('/script.js');
        await eventSource.emit(event_types.GENERATION_STOPPED);
        await eventSource.emit(event_types.GENERATION_ENDED);
    });
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.active === 0);
    pass('native generation cancellation and duplicate end events do not leave phantom activity');

    const autoCommitRoute = 'POST ' + base + '/incremental/commit';
    const commitsBeforeUpload = traffic.filter(value => value === autoCommitRoute).length;
    const changedAt = Date.now();
    await page.evaluate(() => localStorage.setItem('auto:theme', 'event-upload'));
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.status === 'autoConfirmed', null, { timeout: 15000 }).catch(async error => {
        console.error('Automatic save diagnostics:', await page.evaluate(() => ({ automatic: DeviceSettingsSync.getDiagnostics().automatic,
            value: localStorage.getItem('auto:theme') })));
        throw error;
    });
    const elapsed = Date.now() - changedAt;
    assert.ok(elapsed >= 1800 && elapsed < 15000, 'automatic save should follow the short coalescing window, not a 15-minute timer');
    assert.equal((await api('/state')).body.entries['auto:theme'].value, 'event-upload');
    assert.equal(traffic.filter(value => value === autoCommitRoute).length, commitsBeforeUpload + 1,
        'expected one incremental request: ' + JSON.stringify(incrementalCommits));
    assert.equal(traffic.filter(value => value === 'POST ' + base + '/backups').length, 0);
    const serverVersions = (await api('/incremental/versions?mode=portable')).body;
    assert.ok(serverVersions.length > 0 && serverVersions.length <= 5, 'server keeps at most five incremental versions');
    pass('native localStorage change is coalesced and confirmed by one incremental save without a local rescue upload');

    await page.evaluate(() => { localStorage['auto:theme-direct'] = 'property-upload'; });
    await waitForRemoteValue('auto:theme-direct', 'property-upload');
    assert.equal((await api('/state')).body.entries['auto:theme-direct'].value, 'property-upload');
    await page.evaluate(() => localStorage.removeItem('auto:theme-direct'));
    await page.waitForFunction(async () => {
        const response = await fetch('/api/plugins/device-settings-sync/state', { cache: 'no-store' });
        const state = await response.json();
        return state.entries['auto:theme-direct']?.deleted === true;
    }, null, { timeout: 20000 });
    pass('direct property assignment and removal produce exact key updates and a server tombstone');

    const other = await context.newPage(); await ready(other);
    await other.evaluate(() => { globalThis.qaActive = DeviceSettingsSync.beginModelActivity(); });
    await other.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.active > 0);
    const commitsBefore = traffic.filter(value => value === autoCommitRoute).length;
    await page.evaluate(() => localStorage.setItem('auto:theme', 'two-tabs'));
    await page.waitForTimeout(2500);
    assert.equal(traffic.filter(value => value === autoCommitRoute).length, commitsBefore, 'an active generation must hold the shared sync lock');
    await other.evaluate(() => DeviceSettingsSync.endModelActivity(globalThis.qaActive));
    await waitForRemoteValue('auto:theme', 'two-tabs');
    assert.equal((await api('/state')).body.entries['auto:theme'].value, 'two-tabs');
    assert.equal(traffic.filter(value => value === autoCommitRoute).length, commitsBefore + 1);
    await other.close();
    pass('an active generation in another tab blocks the changed-key batch, then one commit completes');

    await toggle('upload', false); await toggle('download', true);
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().automatic.status === 'autoReady');
    let state = (await api('/state')).body;
    assert.equal((await api('/commit', { deviceId: 'qa_other_device', operationId: 'qa_remote_' + Date.now(), expectedRevision: state.revision, mutations: [{ key: 'auto:theme', value: 'remote-download' }] })).status, 200);
    traffic.length = 0;
    await ready(page);
    await page.waitForFunction(() => localStorage.getItem('auto:theme') === 'remote-download');
    await page.waitForTimeout(1000); // Allow the deliberate post-apply reload to complete.
    await page.waitForLoadState('load');
    await page.waitForFunction(() => globalThis.DeviceSettingsSync?.getDiagnostics().automatic?.status === 'autoReady');
    assert.equal(traffic.filter(value => value === 'POST ' + base + '/backups').length, 1);
    assert.equal(traffic.filter(value => value === 'POST ' + base + '/commit').length, 0);
    pass('download-only entry updates local data once with a rescue backup and no upload loop');

    await page.evaluate(() => localStorage.setItem('auto:theme', 'unsent-local'));
    state = (await api('/state')).body;
    await api('/commit', { deviceId: 'qa_other_device', operationId: 'qa_conflict_' + Date.now(), expectedRevision: state.revision, mutations: [{ key: 'auto:theme', value: 'remote-conflict' }] });
    await page.reload();
    await page.getByRole('button', { name: 'Keep local and upload once', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Decide later', exact: true }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('auto:theme')), 'unsent-local');
    assert.equal((await api('/state')).body.entries['auto:theme'].value, 'remote-conflict');
    pass('two-sided entry conflict asks and deciding later preserves both sources');

    const output = path.resolve(process.env.DSS_QA_OUTPUT || 'qa-artifacts');
    await fs.mkdir(output, { recursive: true });
    await page.locator('#extensions-settings-button .drawer-toggle').click();
    await page.locator('#device_settings_sync_panel .inline-drawer-toggle').evaluate(node => node.click());
    await page.locator('#dss_settings_toggle').click();
    await page.locator('#dss_auto').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'automatic-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#dss_auto').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'automatic-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    pass('automatic controls render on desktop/mobile with no page exceptions');
    const cookies = (await context.storageState()).cookies;
    for (const [language, file] of [['zh-TW', 'zh-tw'], ['zh-CN', 'zh-cn']]) {
        const translated = JSON.parse(await fs.readFile(new URL('../locales/' + file + '.json', import.meta.url), 'utf8'));
        const localized = await browser.newContext({ locale: language, storageState: { cookies, origins: [] } });
        await localized.addInitScript(language => localStorage.setItem('language', language), language);
        const target = await localized.newPage();
        await ready(target);
        for (const [name, key] of [['upload', 'autoUpload'], ['download', 'autoDownload']]) {
            assert.equal(await target.locator('#dss_auto label').filter({ has: target.locator('[data-auto="' + name + '"]') }).textContent(), translated['dss.manager.' + key]);
        }
        assert.ok((await target.locator('#dss_auto_status').textContent()).includes(translated['dss.manager.autoOff']));
        await localized.close();
        pass(language + ' automatic controls and status use the translated catalog');
    }
    await toggle('download', false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (!(await page.locator('#device_settings_sync_panel').isVisible())) await page.locator('#extensions-settings-button .drawer-toggle').evaluate(node => node.click());
    if (!(await page.locator('#dss_settings_toggle').isVisible())) await page.locator('#device_settings_sync_panel .inline-drawer-toggle').evaluate(node => node.click());
    if (!(await page.locator('#dss_storage_mode').isVisible())) await page.locator('#dss_settings_toggle').evaluate(node => node.click());
    await page.locator('#dss_storage_mode').selectOption('full');
    await page.locator('dialog[open] .popup-button-ok').last().click();
    await page.waitForFunction(() => DeviceSettingsSync.getDiagnostics().fullStorage === true);
    await page.evaluate(() => {
        localStorage.setItem('history:full', '中'.repeat(150000));
        localStorage.setItem('cache:full', 'keep-me');
    });
    const deviceBefore = await page.evaluate(() => localStorage.getItem('sillytavern_settings_sync_device_id'));
    await page.evaluate(() => DeviceSettingsSync.pushCurrentDevice());
    let fullState = (await api('/full-state')).body;
    assert.equal(fullState.entries['history:full'].length, 150000);
    assert.equal(fullState.entries['cache:full'], 'keep-me');
    assert.equal(Object.hasOwn(fullState.entries, 'sillytavern_settings_sync_device_id'), false);
    await page.evaluate(() => {
        localStorage.setItem('history:full', 'wrong');
        localStorage.setItem('cache:absent', 'remove-me');
    });
    await page.evaluate(() => DeviceSettingsSync.pullFromServer({ reload: false }));
    assert.equal(await page.evaluate(() => localStorage.getItem('history:full').length), 150000);
    assert.equal(await page.evaluate(() => localStorage.getItem('cache:absent')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('sillytavern_settings_sync_device_id')), deviceBefore);
    pass('settings menu enables full manual sync of large/cache values with exact replacement and internal-key protection');
    console.log('Completed ' + count + ' automatic browser checks.');
} finally {
    await browser.close();
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
}
