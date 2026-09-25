// Disposable SillyTavern only: changes a copied extension to simulate an update.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createArchive } from '../lib/storage-model.js';

assert.equal(process.env.DSS_QA_ALLOW_MUTATION, '1');
const host = new URL(process.env.DSS_QA_URL || 'http://127.0.0.1:18765');
assert.ok(['127.0.0.1', 'localhost'].includes(host.hostname));
const qa = path.resolve(process.env.DSS_QA_EXTENSION || '');
assert.ok(qa && qa.includes('dss-qa-') && qa !== path.resolve('.'), 'DSS_QA_EXTENSION must be a disposable extension copy');
const { chromium, request } = await import(pathToFileURL(path.resolve(process.env.DSS_PLAYWRIGHT_MODULE)).href);
const base = host.origin + '/api/plugins/device-settings-sync';
const contexts = [];
const client = async handle => {
    const context = await request.newContext({ baseURL: host.origin });
    contexts.push(context);
    const { token } = await (await context.get('/csrf-token')).json();
    if (handle) assert.equal((await context.post('/api/users/login', { headers: { 'x-csrf-token': token }, data: { handle } })).status(), 200);
    const current = (await (await context.get('/csrf-token')).json()).token;
    return { context, post: (route, data) => context.post(base + route, { headers: { 'x-csrf-token': current }, data }) };
};
const runManifest = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(qa, 'tools/runtime-manifest.mjs')], { cwd: qa, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`manifest exit ${code}`)));
});
const helperPath = path.join(qa, 'lib/storage-model.js');
const runnerPath = path.join(qa, 'server-plugin/worker-runner.mjs');
const originalHelper = await fs.readFile(helperPath, 'utf8');
const originalRunner = await fs.readFile(runnerPath, 'utf8');
let browser;
try {
    await fs.copyFile(new URL('./runtime-manifest.mjs', import.meta.url), path.join(qa, 'tools/runtime-manifest.mjs'));
    const anonymous = await client();
    assert.equal((await anonymous.context.get(base + '/health')).status(), 403);
    assert.equal((await anonymous.post('/runtime/reload', {})).status(), 403);
    const admin = await client('default-user');
    const user = 'dss-runtime-qa-' + Date.now();
    const adminToken = (await (await admin.context.get('/csrf-token')).json()).token;
    assert.equal((await admin.context.post('/api/users/create', {
        headers: { 'x-csrf-token': adminToken }, data: { handle: user, name: 'Runtime QA user' },
    })).status(), 200);
    const ordinary = await client(user);
    const initial = await (await admin.context.get(base + '/health')).json();
    assert.equal(initial.runtime.state, 'ready');
    assert.equal(initial.runtime.canReload, true);
    assert.equal((await ordinary.context.get(base + '/health')).status(), 200);
    assert.equal((await ordinary.post('/runtime/reload', { expectedBuild: initial.runtime.activeBuild })).status(), 403);
    assert.equal((await admin.context.post(base + '/runtime/reload', { data: { expectedBuild: initial.runtime.activeBuild } })).status(), 403);
    assert.equal((await admin.post('/runtime/reload', { expectedBuild: '0'.repeat(64) })).status(), 409);
    console.log('PASS 1 login, admin, CSRF and expected-build checks');

    const operationId = 'runtime_replay_' + Date.now();
    const payload = { operationId, reason: 'upload', archive: createArchive(new Map([['runtime:qa', 'before switch']])) };
    const beforeBackup = await (await ordinary.post('/backups', payload)).json();
    assert.ok(beforeBackup.id);

    await fs.writeFile(helperPath, originalHelper + '\nexport const QA_RUNTIME_DEPENDENCY = "updated-dependency";\n');
    await fs.writeFile(runnerPath, originalRunner.replace(
        "import { init } from './index.js';",
        "import { init } from './index.js';\nimport { QA_RUNTIME_DEPENDENCY } from '../lib/storage-model.js';",
    ).replace(
        "parentPort.postMessage({ type: 'ready', health: health.body });",
        "parentPort.postMessage({ type: 'ready', health: { ...health.body, qaDependencyMarker: QA_RUNTIME_DEPENDENCY } });",
    ));
    await runManifest();
    const installed = await (await admin.context.get(base + '/health')).json();
    assert.notEqual(installed.runtime.installedBuild, initial.runtime.activeBuild);
    assert.equal(installed.runtime.activeBuild, initial.runtime.activeBuild);
    browser = await chromium.launch({ channel: process.env.DSS_BROWSER_CHANNEL || 'msedge', headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const { token } = await (await context.request.get(host.origin + '/csrf-token')).json();
    assert.equal((await context.request.post(host.origin + '/api/users/login', {
        headers: { 'x-csrf-token': token }, data: { handle: 'default-user' },
    })).status(), 200);
    await page.goto(host.origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(build => globalThis.DeviceSettingsSync?.getDiagnostics().runtime?.activeBuild === build,
        installed.runtime.installedBuild, { timeout: 60000 });
    const after = await (await admin.context.get(base + '/health')).json();
    assert.equal(after.runtime.activeBuild, installed.runtime.installedBuild);
    assert.equal(after.qaDependencyMarker, 'updated-dependency');
    assert.equal(after.runtime.state, 'ready');
    assert.equal((await (await ordinary.post('/backups', payload)).json()).id, beforeBackup.id);
    console.log('PASS 2 refresh auto-applies updated backend dependency; accepted backup receipt replays');
    await context.close();
} finally {
    if (browser) await browser.close();
    await fs.writeFile(helperPath, originalHelper);
    await fs.writeFile(runnerPath, originalRunner);
    await runManifest();
    await Promise.all(contexts.map(context => context.dispose()));
}
