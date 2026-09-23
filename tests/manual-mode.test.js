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
    assert.equal(manifest.version, '1.7.0');
    assert.equal(packageJson.engines.node, '>=18');
    assert.equal(serverPackage.engines.node, '>=18');
});

test('explains the Docker per-user installation cause when the server route is missing', () => {
    assert.match(source, /response\.status === 404/u);
    assert.match(source, /installed the Docker extension for yourself/u);
    assert.match(source, /auto-detect installation command/u);
});
