import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const serverPackage = JSON.parse(await fs.readFile(new URL('../server-plugin/package.json', import.meta.url), 'utf8'));

test('pre-change backups default on without overriding a saved choice', () => {
    const defaults = source.match(/const DEFAULT_SETTINGS = Object.freeze\(\{[^]*?\}\);/u)[0];
    const getSettings = source.slice(source.indexOf('function getSettings() {'), source.indexOf('function filterOptions() {'));
    for (const [existing, expected] of [[undefined, true], [{}, true], [{ backupBeforeChanges: true }, true], [{ backupBeforeChanges: false }, false]]) {
        const context = { extension_settings: { deviceSettingsSync: existing }, SETTINGS_KEY: 'deviceSettingsSync', OBSOLETE_SETTINGS: [], DEFAULT_MAX_VALUE_BYTES: 65536 };
        vm.runInNewContext(defaults + getSettings + '; result = getSettings().backupBeforeChanges;', context);
        assert.equal(context.result, expected);
    }
});

test('does not start synchronization when the extension loads', () => {
    assert.doesNotMatch(source, /setInterval\s*\(/u);
    assert.doesNotMatch(source, /Storage\.prototype\.(?:setItem|removeItem|clear)\s*=/u);
    assert.deepEqual([...source.matchAll(/eventSource\.on\(([^,]+)/gu)].map(match => match[1]), ['event_types.APP_READY']);
    assert.doesNotMatch(source, /(?:poll|bootstrap|touchAccountSettings)\s*\(\s*\)\s*;/u);
});

test('manual synchronization remains reachable from its explicit controls', () => {
    assert.match(source, /async function manualPull/u);
    assert.match(source, /async function manualPush/u);
    assert.match(source, /dss_pull[^]*manualPull/u);
    assert.match(source, /dss_push[^]*manualPush/u);
});

test('asks for confirmation before either manual synchronization action', () => {
    assert.match(source, /Popup\.show\.confirm/u);
    assert.match(source, /dss_pull[^]*confirmManualPull\(\)[^]*manualPull/u);
    assert.match(source, /dss_push[^]*confirmManualPush\(\)[^]*manualPush/u);
    assert.match(source, /Local changes that have not been uploaded may be lost/u);
    assert.match(source, /deleted locally will also be deleted/u);
});

test('publishes the verified SillyTavern and Node.js compatibility floor', () => {
    assert.equal(manifest.minimum_client_version, '1.14.0');
    assert.equal(manifest.version, packageJson.version);
    assert.equal(serverPackage.version, packageJson.version);
    assert.equal(packageJson.engines.node, '>=18');
    assert.equal(serverPackage.engines.node, '>=18');
});

test('explains how to install and restart the server plugin when the route is missing', () => {
    assert.match(source, /response\.status === 404/u);
    assert.match(source, /Verify the server plugin installation in the README/u);
    assert.match(source, /then restart SillyTavern/u);
});

test('button failures during confirmation and lock acquisition are reported instead of swallowed', async () => {
    const action = source.slice(source.indexOf('async function runManualButton('), source.indexOf('async function preflightManualIndexedDb('));
    for (const phase of ['confirmation', 'operation']) {
        const failure = new Error(phase);
        const errors = [];
        const context = { manualConfirming: false, operationInFlight: false,
            StorageError: Error, reportOperationError: e => errors.push(e),
            confirmManualPull: async () => { if (phase === 'confirmation') throw failure; return true; },
            manualPull: async () => { throw failure; } };
        vm.runInNewContext(action + '; result = runManualButton("pull");', context);
        await context.result;
        assert.deepEqual(errors, [failure]);
        assert.equal(context.manualConfirming, false);
    }
});

test('a repeated click cannot release another pending confirmation or begin another sync', async () => {
    const action = source.slice(source.indexOf('async function runManualButton('), source.indexOf('async function preflightManualIndexedDb('));
    let release, calls = 0;
    const confirmation = new Promise(resolve => { release = resolve; });
    const errors = [];
    const context = { manualConfirming: false, operationInFlight: false, StorageError: Error,
        reportOperationError: e => errors.push(e), confirmManualPull: () => confirmation,
        manualPull: async () => { calls++; } };
    vm.runInNewContext(action + '; first = runManualButton("pull"); second = runManualButton("pull");', context);
    await context.second;
    assert.equal(context.manualConfirming, true);
    assert.equal(errors.length, 1);
    release(true); await context.first;
    assert.equal(calls, 1);
    assert.equal(context.manualConfirming, false);
});

test('public manual sync rejects its original lock error and records it', async () => {
    const entry = source.slice(source.indexOf('async function manualPull(options'), source.indexOf('async function manualPullLocked('));
    const failure = Object.assign(new Error('lost lease'), { code: 'autoLeaseLost' });
    const errors = [];
    const context = { coordinated: async () => { throw failure; }, reportOperationError: e => errors.push(e) };
    vm.runInNewContext(entry + '; result = manualPull();', context);
    await assert.rejects(context.result, e => e === failure);
    assert.deepEqual(errors, [failure]);
});
