import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RuntimeManager } from '../server-plugin/runtime-manager.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const runner = `import { parentPort } from 'node:worker_threads';
import { marker } from '../lib/helper.js';
parentPort.postMessage({ type: 'ready', health: { ok: true, schema: 1, version: '1.11.0', capabilities: ['backups-v1'] } });
parentPort.on('message', async ({ id, request }) => {
    if (request.path === '/delay') await new Promise(resolve => setTimeout(resolve, 150));
    parentPort.postMessage({ id, status: 200, headers: { 'Cache-Control': 'no-store' },
        body: { marker, handle: request.handle, root: request.userRoot } });
});
`;

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-runtime-'));
    const sourceRoot = path.join(root, 'extension');
    const dataRoot = path.join(root, 'data');
    const serverRoot = path.join(root, 'server');
    await fs.mkdir(path.join(sourceRoot, 'server-plugin'), { recursive: true });
    await fs.mkdir(path.join(sourceRoot, 'lib'));
    await fs.mkdir(path.join(serverRoot, 'node_modules'), { recursive: true });
    await fs.mkdir(dataRoot);
    const publish = async (marker, { broken = false } = {}) => {
        const content = broken ? `throw new Error('broken candidate');\n` : `export const marker = ${JSON.stringify(marker)};\n`;
        const contents = [
            ['server-plugin/index.js', 'export const info = {};\n'],
            ['server-plugin/worker-runner.mjs', runner],
            ['lib/helper.js', content],
        ];
        for (const [file, value] of contents) await fs.writeFile(path.join(sourceRoot, file), value);
        const descriptor = { loaderProtocol: 1, version: '1.11.0',
            files: contents.map(([file, value]) => ({ path: file, sha256: hash(value) })) };
        const manifest = { ...descriptor, build: hash(JSON.stringify(descriptor)) };
        await fs.writeFile(path.join(sourceRoot, 'server-plugin/runtime-manifest.json'), JSON.stringify(manifest));
        return manifest;
    };
    const first = await publish('old');
    const manager = new RuntimeManager({ sourceRoot, dataRoot, serverRoot, drainMs: 500 });
    await manager.start();
    assert.equal(manager.active?.build, first.build);
    const request = (route = '/value') => ({ method: 'GET', path: route, query: {}, body: {}, handle: 'alice', userRoot: path.join(dataRoot, 'alice') });
    const close = async () => {
        await manager.close();
        await fs.rm(root, { recursive: true, force: true });
    };
    return { root, sourceRoot, dataRoot, serverRoot, publish, manager, request, close };
}

test('reloading a dependency switches the entire worker without changing the server process', async () => {
    const qa = await fixture();
    try {
        const firstThread = qa.manager.active.worker.threadId;
        assert.equal((await qa.manager.invoke(qa.request())).body.marker, 'old');
        const next = await qa.publish('new');
        assert.deepEqual(await qa.manager.requestReload(next.build), { state: 'preparing' });
        await qa.manager.reloadPromise;
        const result = await qa.manager.invoke(qa.request());
        assert.deepEqual(result.body, { marker: 'new', handle: 'alice', root: path.join(qa.dataRoot, 'alice') });
        assert.notEqual(qa.manager.active.worker.threadId, firstThread);
        assert.equal((await qa.manager.status()).activeBuild, next.build);
        assert.equal(qa.manager.previousBuild.length, 64);
    } finally { await qa.close(); }
});

test('incomplete, modified and broken candidates keep the previous worker active', async () => {
    const qa = await fixture();
    try {
        const altered = await qa.publish('tampered');
        await fs.writeFile(path.join(qa.sourceRoot, 'lib/helper.js'), 'export const marker = "changed after manifest";\n');
        await qa.manager.requestReload(altered.build);
        await qa.manager.reloadPromise;
        assert.equal((await qa.manager.invoke(qa.request())).body.marker, 'old');
        assert.equal((await qa.manager.status()).state, 'failed');

        const broken = await qa.publish('unused', { broken: true });
        await qa.manager.requestReload(broken.build);
        await qa.manager.reloadPromise;
        assert.equal((await qa.manager.invoke(qa.request())).body.marker, 'old');
    } finally { await qa.close(); }
});

test('duplicate reload requests share one update and stale build IDs never run', async () => {
    const qa = await fixture();
    try {
        const next = await qa.publish('new');
        const results = await Promise.all([qa.manager.requestReload(next.build), qa.manager.requestReload(next.build)]);
        assert.ok(results.every(result => ['preparing', 'waiting'].includes(result.state)));
        await qa.manager.reloadPromise;
        await assert.rejects(qa.manager.requestReload('a'.repeat(64)), error => error.code === 'runtimeSourceMismatch');
        assert.equal((await qa.manager.invoke(qa.request())).body.marker, 'new');
    } finally { await qa.close(); }
});

test('the handoff waits for accepted requests and sends held requests to the new worker', async () => {
    const qa = await fixture();
    try {
        const running = qa.manager.invoke(qa.request('/delay'));
        const next = await qa.publish('new');
        await qa.manager.requestReload(next.build);
        while (qa.manager.job.state === 'preparing') await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(qa.manager.job.state, 'waiting');
        const held = qa.manager.invoke(qa.request());
        let completed = false;
        held.then(() => { completed = true; });
        await new Promise(resolve => setTimeout(resolve, 15));
        assert.equal(completed, false);
        assert.equal((await running).body.marker, 'old');
        await qa.manager.reloadPromise;
        assert.equal((await held).body.marker, 'new');
    } finally { await qa.close(); }
});

test('a draining timeout releases held requests back to the healthy old worker', async () => {
    const qa = await fixture();
    try {
        qa.manager.drainMs = 10;
        const running = qa.manager.invoke(qa.request('/delay'));
        const next = await qa.publish('new');
        await qa.manager.requestReload(next.build);
        while (qa.manager.job.state === 'preparing') await new Promise(resolve => setTimeout(resolve, 5));
        const held = qa.manager.invoke(qa.request());
        await qa.manager.reloadPromise;
        assert.equal((await held).body.marker, 'old');
        assert.equal((await running).body.marker, 'old');
        assert.equal((await qa.manager.status()).state, 'failed');
    } finally { await qa.close(); }
});

test('repeated compatible updates retain at most current and previous snapshots', async () => {
    const qa = await fixture();
    try {
        const oldWorkers = [];
        const memoryBefore = process.memoryUsage().rss;
        for (let index = 0; index < 6; index++) {
            oldWorkers.push(qa.manager.active.worker);
            const next = await qa.publish(`version-${index}`);
            await qa.manager.requestReload(next.build);
            await qa.manager.reloadPromise;
            assert.equal((await qa.manager.invoke(qa.request())).body.marker, `version-${index}`);
            assert.ok(oldWorkers.every(worker => worker.threadId === -1), 'replaced Workers must terminate');
        }
        const directory = path.join(qa.dataRoot, '.device-settings-sync-runtime');
        const names = (await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}$/u.test(name));
        assert.equal(names.length, 2);
        assert.equal(qa.manager.active.alive, true);
        assert.ok(process.memoryUsage().rss - memoryBefore < 128 * 1024 * 1024, 'repeated tiny updates must not leak unbounded memory');
    } finally { await qa.close(); }
});
