import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCleanup, analyzeCleanup, planCleanup, describeEntry } from '../lib/storage-analysis.js';

test('cleanup protection wins over cache/temp/log names', () => {
    for (const key of ['chat_history_cache', 'draft:tmp', 'oauth_token_cache', 'api_key_cache', 'config:cache', 'sillytavern_settings_sync_cache', '憑證快取', '历史日志']) {
        assert.equal(classifyCleanup(key).category, 'protected', key);
    }
    for (const key of ['settings', 'theme', 'language', 'extensions_settings']) assert.equal(classifyCleanup(key).category, 'protected', key);
});

test('only name-based candidates are recommended and unknown or platform keys need review', () => {
    for (const key of ['app:cache', 'reroll_cache_1', 'previous_cache', 'x/temp', 'debug.data', 'app.log', '圖片快取', '临时数据']) {
        assert.equal(classifyCleanup(key).category, 'recommended', key);
    }
    for (const key of ['tt:cache', 'tt:temp', 'arbitrary:large', 'plugin:unknown', '__proto__', '']) assert.equal(classifyCleanup(key).category, 'review', key);
});

test('analysis includes all keys, exact UTF-16 totals, reason and stable size order without modifying data', () => {
    const data = new Map([['app:cache', '😀'], ['settings', 'x'.repeat(100)], ['other', '']]);
    const before = [...data];
    const result = analyzeCleanup(data);
    assert.equal(result.length, 3);
    assert.equal(result[0].key, 'settings');
    assert.equal(result.find(item => item.key === 'app:cache').bytes, 22);
    assert.equal(result.find(item => item.key === 'app:cache').reason, 'cleanupCache');
    assert.deepEqual([...data], before);
});

test('batch cleanup filters protected keys again but permits explicitly selected unknown keys', () => {
    const data = new Map([['app:cache', 'x'], ['settings', 'keep'], ['token_cache', 'keep'], ['unknown', 'manual']]);
    const plan = planCleanup(data, [...data.keys(), 'app:cache']);
    assert.deepEqual(plan.changes.map(change => change.key), ['app:cache', 'unknown']);
    assert.deepEqual([...plan.before], [...data]);
});

test('extension hints distinguish explicit suffix, inferred JSON and ordinary dotted keys', () => {
    assert.deepEqual(describeEntry('file.JSON', '{}'), { extension: '.JSON', inferred: false, type: 'typeJson' });
    assert.deepEqual(describeEntry('ui.theme', '{"dark":true}'), { extension: '.json', inferred: true, type: 'typeJson' });
    assert.deepEqual(describeEntry('file.txt', '[1,2]'), { extension: '.txt', inferred: false, type: 'typeJson' });
    assert.deepEqual(describeEntry('empty', ''), { extension: '.txt', inferred: true, type: 'typeText' });
    assert.equal(describeEntry('object', '{invalid}').type, 'typeText');
    assert.equal(describeEntry('number', '123').type, 'typeText');
});

test('binary references and large strings are labelled without executing or deeply parsing them', () => {
    assert.equal(describeEntry('avatar', 'data:image/png;base64,abc').type, 'typeData');
    assert.equal(describeEntry('avatar', 'blob:https://example.test/id').type, 'typeBlob');
    assert.equal(describeEntry('large.json', ' '.repeat(1024 * 1024 + 1)).type, 'typeLarge');
    assert.equal(describeEntry('__proto__', '{"__proto__":{"polluted":true}}').type, 'typeJson');
    assert.equal({}.polluted, undefined);
});
