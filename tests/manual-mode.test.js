import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');

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
