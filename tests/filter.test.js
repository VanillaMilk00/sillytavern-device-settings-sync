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
