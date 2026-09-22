import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createArchive, serializeArchive, parseArchive, readStorage, totalBytes, buildTree,
    planImport, planDelete, applyPlan, cleanupAdvice, layoutTreemap, MAX_ARCHIVE_BYTES, intersectScope,
} from '../lib/storage-model.js';

class MemoryStorage {
    constructor(entries = []) { this.values = new Map(entries); this.fail = () => false; }
    get length() { return this.values.size; }
    key(index) { return [...this.values.keys()][index] ?? null; }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { if (this.fail(key, value)) throw new Error('quota'); this.values.set(key, value); }
    removeItem(key) { this.values.delete(key); }
}

test('full archives preserve all strings, special keys, credentials and large excluded values', () => {
    const values = new Map([
        ['', ''], ['__proto__', 'literal'], ['constructor', 'value'], ['中文:😀', '\u0000\ud800'],
        ['cache:huge', 'x'.repeat(300 * 1024)], ['api_key', 'secret'], ['sillytavern_settings_sync_device_id', 'device_12345678'],
    ]);
    const archive = parseArchive(serializeArchive(createArchive(values)));
    assert.deepEqual(new Map(archive.entries.map(entry => [entry.key, entry.value])), values);
    assert.equal(totalBytes(new Map([['中', '😀']])), 6);
});

test('flat JSON dictionaries are exact-key archives, never full replacement authority', () => {
    const archive = parseArchive('{"__proto__":"text","a":"new"}');
    assert.equal(archive.scope.kind, 'keys');
    const storage = new MemoryStorage([['b', 'keep']]);
    applyPlan(storage, planImport(readStorage(storage), archive, { mode: 'replace' }));
    assert.equal(storage.getItem('b'), 'keep');
    assert.equal(storage.getItem('__proto__'), 'text');
});

test('invalid versions, duplicates, non-string values and out-of-scope entries are rejected', () => {
    const archive = createArchive(new Map([['x:a', 'a']]), { kind: 'prefix', prefix: 'x:' });
    for (const input of [
        null, [], { a: 7 }, { ...archive, version: 7 },
        { ...archive, entries: [...archive.entries, ...archive.entries] },
        { ...archive, entries: [{ key: 'outside', value: 'x' }] },
    ]) assert.throws(() => parseArchive(JSON.stringify(input)), { code: 'invalidArchive' });
    assert.throws(() => parseArchive('{'), { code: 'invalidArchive' });
    assert.throws(() => parseArchive(' '.repeat(MAX_ARCHIVE_BYTES + 1)), { code: 'archiveTooLarge' });
});

test('merge keeps other keys and protects internal keys unless explicitly included', () => {
    const storage = new MemoryStorage([['a', 'old'], ['other', 'keep'], ['sillytavern_settings_sync_device_id', 'this-device']]);
    const archive = createArchive(new Map([['a', 'new'], ['b', ''], ['sillytavern_settings_sync_device_id', 'other-device']]));
    applyPlan(storage, planImport(readStorage(storage), archive));
    assert.equal(storage.getItem('other'), 'keep');
    assert.equal(storage.getItem('b'), '');
    assert.equal(storage.getItem('sillytavern_settings_sync_device_id'), 'this-device');
    applyPlan(storage, planImport(readStorage(storage), archive, { includeInternal: true }));
    assert.equal(storage.getItem('sillytavern_settings_sync_device_id'), 'other-device');
});

test('prefix replacement is bounded and leaves unchecked incoming keys unchanged', () => {
    const storage = new MemoryStorage([['a:x', 'old'], ['a:y', 'old'], ['a:gone', 'remove'], ['a.other', 'keep'], ['ab:z', 'keep']]);
    const archive = createArchive(new Map([['a:x', 'new'], ['a:y', 'new']]), { kind: 'prefix', prefix: 'a:' });
    applyPlan(storage, planImport(readStorage(storage), archive, { mode: 'replace', selectedKeys: ['a:x'], scope: { kind: 'full' } }));
    assert.deepEqual([...storage.values], [['a:x', 'new'], ['a:y', 'old'], ['a.other', 'keep'], ['ab:z', 'keep']]);
});

test('selection cannot widen an existing folder import scope', () => {
    assert.deepEqual(intersectScope({ kind: 'prefix', prefix: 'a:b:' }, { kind: 'prefix', prefix: 'a:' }), { kind: 'prefix', prefix: 'a:b:' });
    assert.deepEqual(intersectScope({ kind: 'prefix', prefix: 'a:' }, { kind: 'prefix', prefix: 'ab:' }), { kind: 'keys', keys: [] });
    assert.deepEqual(intersectScope({ kind: 'prefix', prefix: 'a:' }, { kind: 'keys', keys: ['a:x', 'ab:x'] }), { kind: 'keys', keys: ['a:x'] });
});

test('full empty archives can clear the chosen scope but keep protected internal keys', () => {
    const storage = new MemoryStorage([['a', 'remove'], ['sillytavern_settings_sync_device_id', 'keep']]);
    applyPlan(storage, planImport(readStorage(storage), createArchive(new Map()), { mode: 'replace' }));
    assert.equal(storage.length, 1);
});

test('stale previews catch overwritten values and newly inserted keys before any mutation', () => {
    for (const change of [s => s.setItem('a', 'changed'), s => s.setItem('extra', 'added')]) {
        const storage = new MemoryStorage([['a', 'old']]);
        const plan = planDelete(readStorage(storage), ['a']);
        change(storage);
        const expected = readStorage(storage);
        assert.throws(() => applyPlan(storage, plan), { code: 'stalePreview' });
        assert.deepEqual(readStorage(storage), expected);
    }
});

test('quota failure rolls back deletions, overwrites and added keys', () => {
    const storage = new MemoryStorage([['a', 'old'], ['gone', 'old']]);
    const before = readStorage(storage);
    const archive = createArchive(new Map([['a', 'new'], ['b', 'new'], ['fail', 'new']]));
    const plan = planImport(before, archive, { mode: 'replace' });
    storage.fail = key => key === 'fail';
    assert.throws(() => applyPlan(storage, plan), { code: 'writeRolledBack' });
    assert.deepEqual([...readStorage(storage)].sort(), [...before].sort());
});

test('rollback failures are reported explicitly', () => {
    const storage = new MemoryStorage([['a', 'old']]);
    storage.fail = (key, value) => key === 'fail' || value === 'old';
    const plan = planImport(readStorage(storage), createArchive(new Map([['a', 'new'], ['fail', 'new']])));
    assert.throws(() => applyPlan(storage, plan), error => error.code === 'rollbackFailed' && error.details.failedKeys.includes('a'));
});

test('deletion is exact-key, deduplicated and protects internal data by default', () => {
    const before = new Map([['a', 'x'], ['ab', 'y'], ['sillytavern_settings_sync_id', 'z']]);
    assert.deepEqual(planDelete(before, ['a', 'a', 'sillytavern_settings_sync_id']).changes.map(item => item.key), ['a']);
    assert.equal(planDelete(before, [...before.keys()], true).changes.length, 3);
});

test('tree preserves separator distinctions, prefixes and every full key exactly once', () => {
    const values = new Map(['a:b', 'a.b', 'a/b', 'a:b:c', 'a:b:', 'a__c', 'stand-alone', ''].map(key => [key, '😀']));
    const root = buildTree(values);
    assert.equal(root.bytes, totalBytes(values));
    const leaves = [];
    const folders = [];
    const walk = node => {
        if (node.type === 'file') leaves.push(node.key);
        else { folders.push(node.prefix); node.children.forEach(walk); }
    };
    walk(root);
    assert.deepEqual(leaves.sort(), [...values.keys()].sort());
    assert(folders.includes('a:'));
    assert(folders.includes('a.'));
    assert(folders.includes('a/'));
    assert(folders.includes('a_'));
    assert(!folders.includes('stand-'));
});

test('treemap rectangle areas sum correctly and stay proportional', () => {
    const nodes = [30, 20, 10, 5, 1].map((size, index) => ({ id: index, bytes: size }));
    const boxes = layoutTreemap(nodes);
    const total = nodes.reduce((sum, node) => sum + node.bytes, 0);
    assert(Math.abs(boxes.reduce((sum, box) => sum + box.width * box.height, 0) - 10000) < 1e-6);
    for (const box of boxes) {
        assert(Math.abs(box.width * box.height / 10000 - box.node.bytes / total) < 1e-6);
        assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= 100.00001 && box.y + box.height <= 100.00001);
    }
    assert.equal(layoutTreemap([{ bytes: 0 }, { bytes: 0 }]).length, 2);
});

test('cleanup suggestions never call sensitive or history data a cache-removal candidate', () => {
    const advice = cleanupAdvice(new Map([
        ['app:cache', 'large'], ['app:logs', 'log'], ['chat-cache', 'data'],
        ['history:cache', 'data'], ['draft:tmp', 'data'], ['oauth_token', 'data'],
    ]));
    assert(advice.find(item => item.key === 'app:cache').candidate);
    for (const key of ['chat-cache', 'history:cache', 'draft:tmp', 'oauth_token']) {
        const item = advice.find(entry => entry.key === key);
        assert.equal(item.candidate, false);
        assert.equal(item.caution, true);
    }
});

test('cleanup recognizes Chinese cache names without recommending deletion of credentials or drafts', () => {
    const advice = cleanupAdvice(new Map(['圖片快取', '图片缓存', '除錯日誌', '草稿暫存', '憑證快取', '历史日志'].map(key => [key, 'x'])));
    for (const key of ['圖片快取', '图片缓存', '除錯日誌']) assert.equal(advice.find(item => item.key === key).candidate, true);
    for (const key of ['草稿暫存', '憑證快取', '历史日志']) assert.equal(advice.find(item => item.key === key).caution, true);
});
