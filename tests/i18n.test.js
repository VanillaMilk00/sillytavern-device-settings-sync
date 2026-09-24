import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
const messages = await fs.readFile(new URL('../lib/messages.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const zhCn = JSON.parse(await fs.readFile(new URL('../locales/zh-cn.json', import.meta.url), 'utf8'));
const zhTw = JSON.parse(await fs.readFile(new URL('../locales/zh-tw.json', import.meta.url), 'utf8'));

function referencedLocaleKeys() {
    const keys = new Set();
    for (const match of source.matchAll(/(?:tr|formatText)\(\s*'([^']+)'/gu)) keys.add(match[1]);
    for (const match of source.matchAll(/data-i18n="(?:\[[^\]]+\])?([^"]+)"/gu)) keys.add(match[1]);
    for (const match of messages.matchAll(/^    (\w+): '/gmu)) keys.add('dss.manager.' + match[1]);
    for (const action of ['pull', 'push']) keys.add(`dss.${action}.withIndexedDbTitle`);
    return [...keys].sort();
}

test('declares Traditional and Simplified Chinese locale files', () => {
    assert.equal(manifest.i18n['zh-tw'], 'locales/zh-tw.json');
    assert.equal(manifest.i18n['zh-cn'], 'locales/zh-cn.json');
});

test('provides every referenced translation in both Chinese locales', () => {
    const expectedKeys = referencedLocaleKeys();
    assert.deepEqual(Object.keys(zhTw).sort(), expectedKeys);
    assert.deepEqual(Object.keys(zhCn).sort(), expectedKeys);
});

test('uses English as the built-in fallback language', () => {
    assert.match(source, />Device Settings Sync</u);
    assert.match(source, />Download localStorage</u);
    assert.match(source, />Upload localStorage</u);
    assert.doesNotMatch(source, /[一-龥]/u);
});

test('translations preserve interpolation placeholders', () => {
    for (const [key, text] of Object.entries(zhTw)) {
        assert.deepEqual([...text.matchAll(/\{\w+\}/gu)].map(match => match[0]).sort(),
            [...zhCn[key].matchAll(/\{\w+\}/gu)].map(match => match[0]).sort(), key);
    }
});
