import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const serverPackage = JSON.parse(await fs.readFile(new URL('../server-plugin/package.json', import.meta.url), 'utf8'));

test('does not start synchronization when the extension loads', () => {
    assert.doesNotMatch(source, /setInterval\s*\(/u);
    assert.doesNotMatch(source, /Storage\.prototype\.(?:setItem|removeItem|clear)\s*=/u);
    assert.doesNotMatch(source, /eventSource\.(?:on|makeLast)\s*\(/u);
    assert.doesNotMatch(source, /(?:poll|bootstrap|touchAccountSettings)\s*\(\s*\)\s*;/u);
});

test('network synchronization is reachable only from manual actions', () => {
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
    assert.equal(manifest.version, '1.5.0');
    assert.equal(packageJson.engines.node, '>=18');
    assert.equal(serverPackage.engines.node, '>=18');
});

test('explains the Docker per-user installation cause when the server route is missing', () => {
    assert.match(source, /response\.status === 404/u);
    assert.match(source, /installed the Docker extension for yourself/u);
    assert.match(source, /auto-detect installation command/u);
});
