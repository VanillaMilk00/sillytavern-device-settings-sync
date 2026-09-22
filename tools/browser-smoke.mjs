// Run only against a disposable SillyTavern installation: this changes its test account.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const url = new URL(process.env.DSS_QA_URL || 'http://127.0.0.1:18765');
assert.equal(process.env.DSS_QA_ALLOW_MUTATION, '1', 'Set DSS_QA_ALLOW_MUTATION=1 only for an isolated test account');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'QA must use loopback');
const { chromium } = await import(process.env.DSS_PLAYWRIGHT_MODULE
    ? pathToFileURL(path.resolve(process.env.DSS_PLAYWRIGHT_MODULE)).href : 'playwright');
const output = path.resolve(process.env.DSS_QA_OUTPUT || 'qa-artifacts');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.DSS_BROWSER_CHANNEL || 'msedge', headless: true });
const base = '/api/plugins/device-settings-sync';
let passed = 0;
function pass(label) { console.log('PASS ' + (++passed) + ' ' + label); }
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes(base)) requests.push(request.method() + ' ' + new URL(request.url()).pathname); });
    async function ready(target = page) {
        if (process.env.DSS_QA_HANDLE) {
            const request = target.context().request;
            const { token } = await (await request.get(url.origin + '/csrf-token')).json();
            assert.equal((await request.post(url.origin + '/api/users/login', {
                headers: { 'x-csrf-token': token }, data: { handle: process.env.DSS_QA_HANDLE },
            })).status(), 200);
        }
        await target.goto(url.href, { waitUntil: 'domcontentloaded' });
        await target.waitForFunction(() => Boolean(globalThis.DeviceSettingsSync), { timeout: 60000 });
        await target.evaluate(async () => {
            const { Popup } = await import('/scripts/popup.js');
            for (const popup of [...Popup.util.popups]) await popup.complete(0);
        });
    }
    await ready();
    assert.equal(requests.length, 0);
    pass('page load never contacts sync or backup APIs');
    await page.evaluate(async () => {
        localStorage.clear();
        localStorage.setItem('qa:settings', '{"theme":"dark","name":"中文😀"}');
        localStorage.setItem('qa:cache', 'x'.repeat(300000));
        localStorage.setItem('notes.history', 'y'.repeat(40000));
        localStorage.setItem('tools_debug', 'z'.repeat(10000));
        localStorage.setItem('ui.theme', 'dark');
        const { extension_settings } = await import('/scripts/extensions.js');
        extension_settings.deviceSettingsSync.backupBeforeChanges = false;
    });
    await page.locator('#dss_push').evaluate(node => node.click());
    await page.locator('dialog[open] .popup-button-cancel').last().click();
    assert.equal(requests.length, 0);
    pass('cancelled upload creates no backup');
    await page.locator('#dss_pull').evaluate(node => node.click());
    await page.locator('dialog[open] .popup-button-cancel').last().click();
    assert.equal(requests.length, 0);
    pass('cancelled download creates no backup');

    await page.route('**' + base + '/backups', route => route.request().method() === 'POST'
        ? route.fulfill({ status: 503, json: { code: 'backupBackendMissing' } }) : route.continue());
    const failed = await page.evaluate(async () => { try { await DeviceSettingsSync.pushCurrentDevice(); return false; } catch { return true; } });
    assert.equal(failed, true);
    assert.deepEqual(requests, ['POST ' + base + '/backups']);
    assert.equal(await page.evaluate(() => localStorage.getItem('sillytavern_settings_sync_device_id')), null);
    await page.unroute('**' + base + '/backups');
    pass('backup failure aborts upload before local identity or sync data changes');

    requests.length = 0;
    await page.evaluate(() => DeviceSettingsSync.pushCurrentDevice());
    assert.equal(requests[0], 'POST ' + base + '/backups');
    assert.ok(requests.includes('POST ' + base + '/merge'));
    async function api(suffix, body) {
        return page.evaluate(async ({ endpoint, body }) => {
            const { getRequestHeaders } = await import('/script.js');
            const response = await fetch(endpoint, { method: body ? 'POST' : 'GET', headers: getRequestHeaders(), ...(body ? { body: JSON.stringify(body) } : {}) });
            return { status: response.status, body: await response.json() };
        }, { endpoint: base + suffix, body });
    }
    let records = (await api('/backups')).body;
    const first = (await api('/backups/' + records[0].id)).body;
    assert.equal(first.entries.find(item => item.key === 'qa:cache').value.length, 300000);
    assert.equal(first.entries.some(item => item.key === 'sillytavern_settings_sync_device_id'), false);
    assert.equal(records.some(item => 'entries' in item || 'digest' in item), false);
    pass('real server stores full pre-sync data including values excluded from regular sync');
    const csrfStatus = await page.evaluate(async endpoint => (await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, base + '/backups');
    assert.equal(csrfStatus, 403);
    pass('real server rejects missing CSRF token');
    const retry = { operationId: 'qa_' + Date.now(), reason: 'import', archive: first };
    const one = await api('/backups', retry);
    const two = await api('/backups', retry);
    assert.equal(one.body.id, two.body.id);
    assert.equal((await api('/backups', { ...retry, reason: 'delete' })).status, 409);
    await Promise.all(Array.from({ length: 6 }, (_, i) => api('/backups', { ...retry, operationId: retry.operationId + '_' + i })));
    records = (await api('/backups')).body;
    assert.equal(records.length, 5);
    assert.equal((await api('/backups/' + one.body.id)).status, 404);
    assert.equal((await api('/backups', retry)).body.id, one.body.id);
    assert.deepEqual((await api('/backups')).body, records);
    pass('HTTP retry deduplication, conflict, concurrent creation and five-slot eviction');

    await page.route('**' + base + '/merge', route => route.fulfill({ status: 503, json: { error: 'Simulated sync failure' } }));
    assert.equal(await page.evaluate(async () => { try { await DeviceSettingsSync.pushCurrentDevice(); return false; } catch { return true; } }), true);
    const afterFailure = (await api('/backups')).body;
    assert.notEqual(afterFailure[0].id, records[0].id);
    assert.equal(afterFailure[0].reason, 'upload');
    await page.unroute('**' + base + '/merge');
    pass('a downstream sync failure retains its successfully saved rescue backup');
    let lostResponse = false;
    await page.route('**' + base + '/backups', async route => {
        if (route.request().method() === 'POST' && !lostResponse) {
            lostResponse = true;
            assert.equal((await route.fetch()).status(), 200);
            return route.abort('failed');
        }
        return route.continue();
    });
    await page.evaluate(() => DeviceSettingsSync.pushCurrentDevice());
    await page.unroute('**' + base + '/backups');
    const afterRetry = (await api('/backups')).body;
    assert.equal(afterRetry[1].id, afterFailure[0].id);
    pass('lost backup response automatically retries without allocating a second slot');

    requests.length = 0;
    await page.evaluate(() => { void DeviceSettingsSync.openManager(); });
    const manager = page.locator('.dss_manager').first();
    await manager.waitFor();
    assert.equal(requests.length, 0);
    assert.equal(await manager.getByRole('button', { name: 'Reload to apply', exact: true }).isVisible(), false);
    const dialog = page.locator('dialog[open]').last();
    assert.ok((await dialog.boundingBox()).width > 1000);
    async function settle() {
        await page.evaluate(async () => {
            globalThis.toastr?.remove();
            await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
        });
    }
    await settle();
    await page.screenshot({ path: path.join(output, 'manager-desktop.png'), fullPage: true });
    pass('manager opens without fetching backups; desktop is wide; reload is initially hidden');

    const downloadEvent = page.waitForEvent('download');
    await manager.getByRole('button', { name: 'Export all', exact: true }).click();
    const downloaded = await downloadEvent;
    const archive = JSON.parse(await fs.readFile(await downloaded.path(), 'utf8'));
    assert.equal(archive.scope.kind, 'full');
    assert.equal(archive.entries.find(item => item.key === 'qa:cache').value.length, 300000);
    assert.ok(archive.entries.some(item => item.key === 'sillytavern_settings_sync_device_id'));
    pass('full JSON download includes internal keys and large values');

    await manager.locator('input[aria-label="qa:"]').check();
    let selectedDownload = page.waitForEvent('download');
    await manager.getByRole('button', { name: 'Export selected', exact: true }).click();
    const folderFile = JSON.parse(await fs.readFile(await (await selectedDownload).path(), 'utf8'));
    assert.deepEqual(folderFile.scope, { kind: 'prefix', prefix: 'qa:' });
    assert.equal(folderFile.entries.length, 2);
    await manager.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await manager.getByRole('button', { name: 'Expand all', exact: true }).click();
    await manager.locator('input[aria-label="qa:settings"]').check();
    selectedDownload = page.waitForEvent('download');
    await manager.getByRole('button', { name: 'Export selected', exact: true }).click();
    const keyFile = JSON.parse(await fs.readFile(await (await selectedDownload).path(), 'utf8'));
    assert.deepEqual(keyFile.scope, { kind: 'keys', keys: ['qa:settings'] });
    assert.equal(keyFile.entries.length, 1);
    await manager.getByRole('button', { name: 'Clear selection', exact: true }).click();
    pass('folder and individual-key exports preserve distinct replacement scopes');

    async function importFile(value) {
        const chooser = page.waitForEvent('filechooser');
        await manager.getByRole('button', { name: 'Import file', exact: true }).click();
        await (await chooser).setFiles({ name: 'qa.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
        await page.locator('.dss_import').waitFor();
        return page.locator('.dss_import');
    }
    async function applyImport() {
        await page.locator('dialog[open]').last().locator('.popup-button-ok').click();
        await page.locator('.dss_import').waitFor({ state: 'detached' });
        await page.waitForFunction(() => !document.querySelector('.dss_manager.dss_pending'));
    }
    await importFile({ 'qa:settings': 'cancelled' });
    await page.locator('dialog[open]').last().locator('.popup-button-cancel').click();
    await page.waitForFunction(() => !document.querySelector('.dss_manager.dss_pending'));
    assert.notEqual(await page.evaluate(() => localStorage.getItem('qa:settings')), 'cancelled');
    assert.equal(requests.length, 0);
    pass('cancelled import does not write data or allocate a backup');
    const oldId = await page.evaluate(() => localStorage.getItem('sillytavern_settings_sync_device_id'));
    await importFile({ 'qa:new': '你好😀', 'ui.theme': '', sillytavern_settings_sync_device_id: 'should-not-copy' });
    await applyImport();
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('qa:new'), localStorage.getItem('ui.theme'), localStorage.getItem('sillytavern_settings_sync_device_id')]), ['你好😀', '', oldId]);
    assert.equal(requests.length, 0);
    pass('plain JSON merge, Unicode, empty strings, internal-key protection; optional backup defaults off');

    // A partial archive can replace only its original prefix, not the rest of localStorage.
    const partial = { ...archive, scope: { kind: 'prefix', prefix: 'qa:' }, entries: [{ key: 'qa:settings', value: 'replaced' }] };
    const preview = await importFile(partial);
    await preview.locator('select').first().selectOption('replace');
    assert.match(await preview.innerText(), /Delete: 2/u);
    await applyImport();
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('qa:cache'), localStorage.getItem('qa:new'), localStorage.getItem('notes.history')?.length]), [null, null, 40000]);
    pass('prefix replacement deletes only absent keys inside the file scope');

    await importFile({ 'qa:settings': 'stale-import' });
    const other = await context.newPage();
    await other.goto(url.origin + '/robots.txt');
    await other.evaluate(() => localStorage.setItem('qa:settings', 'other-tab'));
    await applyImport();
    assert.equal(await page.evaluate(() => localStorage.getItem('qa:settings')), 'other-tab');
    assert.match(await manager.locator('.dss_feedback').innerText(), /changed after this preview/u);
    await other.close();
    pass('another tab changing storage invalidates the preview without overwriting it');

    await manager.getByRole('button', { name: 'Rescan', exact: true }).click();
    await manager.getByRole('button', { name: 'Expand all', exact: true }).click();
    await manager.locator('input[aria-label="qa:settings"]').check();
    await manager.getByRole('button', { name: 'Remove selected', exact: true }).click();
    await page.locator('dialog[open]').last().locator('.popup-button-cancel').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('qa:settings')), 'other-tab');
    await manager.getByRole('checkbox', { name: 'Also back up before importing, restoring or removing local data', exact: true }).check();
    requests.length = 0;
    await manager.getByRole('button', { name: 'Remove selected', exact: true }).click();
    await page.locator('dialog[open]').last().locator('.popup-button-ok').click();
    await page.waitForFunction(() => !document.querySelector('.dss_manager.dss_pending'));
    assert.equal(await page.evaluate(() => localStorage.getItem('qa:settings')), null);
    assert.deepEqual(requests, ['POST ' + base + '/backups']);
    pass('delete cancellation is safe; optional backup precedes confirmed exact-key deletion');

    await manager.getByRole('button', { name: 'Backups', exact: true }).click();
    await manager.locator('.dss_backup_card').last().waitFor();
    assert.equal(await manager.locator('.dss_backup_card').count(), 5);
    await manager.locator('.dss_backup_card').last().getByRole('button', { name: 'Restore', exact: true }).click();
    await page.locator('.dss_import').waitFor();
    await applyImport();
    assert.equal(await page.evaluate(() => localStorage.getItem('qa:cache')?.length), 300000);
    pass('oldest slot restores successfully even when its rescue backup evicts it');
    const beforeCleanup = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
    await manager.getByRole('button', { name: 'Cleanup suggestions', exact: true }).click();
    assert.match(await manager.innerText(), /manual review required/u);
    assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort())), beforeCleanup);
    await manager.getByRole('button', { name: 'Local data', exact: true }).click();
    await manager.getByRole('searchbox').fill('qa:');
    await manager.getByRole('button', { name: 'Select visible', exact: true }).click();
    assert.equal(await manager.locator('.dss_map_box[aria-pressed="true"]').count(), 1);
    await manager.getByRole('searchbox').fill('');
    pass('cleanup never mutates; search and multi-selection are shared with the treemap');
    await page.setViewportSize({ width: 390, height: 844 });
    await settle();
    await page.screenshot({ path: path.join(output, 'manager-mobile.png'), fullPage: true });
    const treeBox = await manager.locator('.dss_tree_scroll').boundingBox();
    const mapBox = await manager.locator('.dss_map_panel').boundingBox();
    assert.ok(mapBox.y >= treeBox.y + treeBox.height - 1);
    assert.ok((await page.locator('dialog[open]').last().boundingBox()).width <= 390);
    const scroll = page.locator('dialog[open]').last().locator('.popup-content');
    assert.equal(await scroll.evaluate(node => getComputedStyle(node).overflowY), 'auto');
    await manager.locator('.dss_map_panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'manager-mobile-tree.png'), fullPage: true });
    pass('mobile stacks the tree and map within viewport');
    await page.locator('dialog[open]').last().locator('.popup-button-ok').click();

    requests.length = 0;
    await page.evaluate(() => DeviceSettingsSync.pullFromServer({ reload: false }));
    assert.deepEqual(requests, ['POST ' + base + '/backups', 'GET ' + base + '/state']);
    pass('download creates its full backup before reading and applying server state');
    await page.setViewportSize({ width: 1440, height: 1000 });
    requests.length = 0;
    await page.locator('#dss_pull').evaluate(node => node.click());
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.locator('dialog[open]').last().locator('.popup-button-ok').click();
    await navigation;
    await page.waitForFunction(() => Boolean(globalThis.DeviceSettingsSync), { timeout: 60000 });
    assert.deepEqual(requests, ['POST ' + base + '/backups', 'GET ' + base + '/state']);
    pass('confirmed UI download still automatically reloads after applying');
    assert.deepEqual(errors, []);
    await context.close();

    for (const [locale, title] of [['zh-TW', '管理 localStorage'], ['zh-CN', '管理 localStorage']]) {
        const localizedContext = await browser.newContext({ locale, viewport: { width: 1440, height: 1000 } });
        const localized = await localizedContext.newPage();
        await ready(localized);
        await localized.evaluate(() => { void DeviceSettingsSync.openManager(); });
        await localized.locator('.dss_manager h3').waitFor();
        assert.equal(await localized.locator('.dss_manager h3').textContent(), title);
        const labels = await localized.locator('.dss_manager').innerText();
        assert.equal(labels.includes('Also back up'), false);
        await localized.evaluate(async () => {
            await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
        });
        await localized.screenshot({ path: path.join(output, 'manager-' + locale + '.png'), fullPage: true });
        await localizedContext.close();
        pass(locale + ' loads translated manager in real SillyTavern');
    }
    console.log('Completed ' + passed + ' browser integration checks; screenshots: ' + output);
} finally { await browser.close(); }
