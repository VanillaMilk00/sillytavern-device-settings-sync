import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStorageEntry, parseAdditionalExcludes } from '../lib/filter.js';

test('keeps extension settings including legacy API configuration', () => {
    assert.equal(classifyStorageEntry('gg_api', '{"provider":"custom","key":"secret"}').portable, true);
    assert.equal(classifyStorageEntry('phone_api_config', '{}').portable, true);
    assert.equal(classifyStorageEntry('language', 'zh-TW').portable, true);
});

test('rejects caches, chat state and binary data', () => {
    assert.equal(classifyStorageEntry('yzm_memory_chat_state:chat-1', '{}').reason, 'data-or-cache');
    assert.equal(classifyStorageEntry('widget-cache:one', '{}').reason, 'data-or-cache');
    assert.equal(classifyStorageEntry('avatar', 'data:image/png;base64,abc').reason, 'binary-value');
});

test('keeps extension OAuth and login credentials when stored in localStorage', () => {
    assert.equal(classifyStorageEntry('oauth_access_token', 'abc').portable, true);
    assert.equal(classifyStorageEntry('provider_refresh_token', 'def').portable, true);
    assert.equal(classifyStorageEntry('extension_login_credentials', '{}').portable, true);
});

test('supports custom wildcard exclusions', () => {
    const options = { additionalExcludes: parseAdditionalExcludes('private:*\nfoo-*-private') };
    assert.equal(classifyStorageEntry('private:key', 'x', options).reason, 'custom-exclude');
    assert.equal(classifyStorageEntry('foo-bar-private', 'x', options).reason, 'custom-exclude');
    assert.equal(classifyStorageEntry('public:key', 'x', options).portable, true);
});

test('enforces the configured value size', () => {
    assert.equal(classifyStorageEntry('small', '1234', { maxValueBytes: 4 }).portable, true);
    assert.equal(classifyStorageEntry('large', '12345', { maxValueBytes: 4 }).reason, 'too-large');
});

test('explicit selections accept long and empty keys while portable mode retains its key restrictions', () => {
    const longKey = '設定🙂'.repeat(180);
    const options = { selectedScope: { kind: 'keys', keys: [longKey, ''] } };
    for (const key of [longKey, '']) {
        assert.equal(classifyStorageEntry(key, 'value', options).portable, true);
        assert.equal(classifyStorageEntry(key, 'value').reason, 'invalid-key');
    }
    assert.equal(classifyStorageEntry('x'.repeat(512), 'value').portable, true);
    assert.equal(classifyStorageEntry('outside', 'value', options).reason, 'not-selected');
    assert.equal(classifyStorageEntry(longKey, 'value', { selectedScope: { kind: 'prefix', prefix: '設定' } }).portable, true);
    assert.equal(classifyStorageEntry('sillytavern_settings_sync_device_id', 'private', {
        selectedScope: { kind: 'keys', keys: ['sillytavern_settings_sync_device_id'] },
    }).reason, 'sync-internal');
});
