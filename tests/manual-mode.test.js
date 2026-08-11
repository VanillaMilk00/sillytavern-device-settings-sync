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

test('publishes the verified SillyTavern and Node.js compatibility floor', () => {
    assert.equal(manifest.minimum_client_version, '1.14.0');
    assert.equal(manifest.version, '1.3.0');
    assert.equal(packageJson.engines.node, '>=18');
    assert.equal(serverPackage.engines.node, '>=18');
});
