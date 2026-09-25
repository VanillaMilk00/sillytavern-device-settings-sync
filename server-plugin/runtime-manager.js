import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const PROTOCOL = 1;
const BUILD = /^[a-f0-9]{64}$/u;
const FILE = /^(?:server-plugin|lib)\/[a-z0-9-]+\.(?:js|mjs)$/u;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const resultError = code => Object.assign(new Error(code), { code });

function within(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function checkManifest(manifest) {
    const files = manifest?.files;
    if (!Array.isArray(files) || !files.length || !Number.isSafeInteger(manifest.loaderProtocol)
        || typeof manifest.version !== 'string' || !BUILD.test(manifest.build)) throw resultError('runtimeSourceInvalid');
    const seen = new Set();
    for (const file of files) {
        if (!FILE.test(file?.path) || !BUILD.test(file.sha256) || seen.has(file.path)) throw resultError('runtimeSourceInvalid');
        seen.add(file.path);
    }
    if (!seen.has('server-plugin/index.js') || !seen.has('server-plugin/worker-runner.mjs')) throw resultError('runtimeSourceInvalid');
    const descriptor = { loaderProtocol: manifest.loaderProtocol, version: manifest.version, files };
    if (sha256(JSON.stringify(descriptor)) !== manifest.build) throw resultError('runtimeSourceInvalid');
    if (manifest.loaderProtocol !== PROTOCOL) throw resultError('runtimeRestartRequired');
    return manifest;
}

class RuntimeWorker {
    constructor(directory, dataRoot) {
        this.worker = new Worker(pathToFileURL(path.join(directory, 'server-plugin/worker-runner.mjs')), {
            workerData: { dataRoot },
        });
        this.pending = new Map();
        this.nextId = 1;
        this.inFlight = 0;
        this.waiters = [];
        this.alive = true;
        this.stopping = false;
        this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
        this.worker.on('message', message => {
            if (message?.type === 'ready') {
                this.health = message.health;
                this.resolveReady();
                return;
            }
            const pending = this.pending.get(message?.id);
            if (!pending) return;
            this.pending.delete(message.id);
            pending.resolve(message);
        });
        const failed = error => {
            this.alive = false;
            this.rejectReady(error);
            for (const pending of this.pending.values()) pending.reject(error);
            this.pending.clear();
            if (!this.stopping) this.onFailure?.(error);
        };
        this.worker.once('error', failed);
        this.worker.once('exit', code => {
            if (this.alive) failed(resultError(`runtimeWorkerExited:${code}`));
        });
    }

    async dispatch(request) {
        if (!this.alive) throw resultError('runtimeWorkerUnavailable');
        const id = this.nextId++;
        const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
        try { this.worker.postMessage({ id, request }); }
        catch (error) { this.pending.delete(id); throw error; }
        return result;
    }

    async terminate() {
        this.stopping = true;
        if (this.alive) await this.worker.terminate();
    }

    async drained(timeoutMs) {
        if (this.inFlight === 0) return;
        await new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            this.waiters.push(waiter);
            const timeout = setTimeout(() => {
                this.waiters = this.waiters.filter(item => item !== waiter);
                reject(resultError('runtimeDrainTimeout'));
            }, timeoutMs);
            waiter.resolve = () => { clearTimeout(timeout); resolve(); };
        });
    }

    finish() {
        this.inFlight--;
        if (this.inFlight === 0) for (const waiter of this.waiters.splice(0)) waiter.resolve();
    }
}

export class RuntimeManager {
    constructor({ sourceRoot, dataRoot, serverRoot = process.cwd(), drainMs = 30_000 }) {
        this.sourceRoot = path.resolve(sourceRoot);
        this.dataRoot = path.resolve(dataRoot);
        this.serverRoot = path.resolve(serverRoot);
        this.cacheRoot = path.join(this.dataRoot, '.device-settings-sync-runtime');
        this.drainMs = drainMs;
        this.active = null;
        this.previousBuild = '';
        this.job = { state: 'ready', target: '', error: '' };
        this.gate = null;
        this.failedBuild = '';
    }

    async installed() {
        const manifest = JSON.parse(await fs.readFile(path.join(this.sourceRoot, 'server-plugin/runtime-manifest.json'), 'utf8'));
        return checkManifest(manifest);
    }

    async verifyFiles(directory, manifest) {
        for (const file of manifest.files) {
            const target = path.resolve(directory, file.path);
            if (!within(directory, target) || !within(directory, await fs.realpath(target))) throw resultError('runtimeSourceInvalid');
            if (sha256(await fs.readFile(target)) !== file.sha256) throw resultError('runtimeSourceInvalid');
        }
    }

    async prepare(manifest) {
        await fs.mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
        const destination = path.join(this.cacheRoot, manifest.build);
        if (await fs.stat(destination).then(() => true, () => false)) {
            await this.verifyFiles(destination, manifest);
            return destination;
        }
        const temporary = path.join(this.cacheRoot, `.stage-${randomUUID()}`);
        if (!within(this.cacheRoot, temporary)) throw resultError('runtimeSourceInvalid');
        await fs.mkdir(temporary, { mode: 0o700 });
        try {
            for (const file of manifest.files) {
                const source = path.resolve(this.sourceRoot, file.path);
                if (!within(this.sourceRoot, source) || !within(this.sourceRoot, await fs.realpath(source))) throw resultError('runtimeSourceInvalid');
                const content = await fs.readFile(source);
                if (sha256(content) !== file.sha256) throw resultError('runtimeSourceInvalid');
                const target = path.join(temporary, file.path);
                await fs.mkdir(path.dirname(target), { recursive: true });
                await fs.writeFile(target, content);
            }
            await fs.writeFile(path.join(temporary, 'package.json'), '{"type":"module"}\n');
            await fs.writeFile(path.join(temporary, 'runtime-manifest.json'), JSON.stringify(manifest));
            const modules = await fs.realpath(path.join(this.serverRoot, 'node_modules'));
            await fs.symlink(modules, path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
            await this.verifyFiles(temporary, manifest);
            try { await fs.rename(temporary, destination); }
            catch (error) {
                if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
                await this.verifyFiles(destination, manifest);
            }
            return destination;
        } finally {
            if (within(this.cacheRoot, temporary)) await fs.rm(temporary, { recursive: true, force: true });
        }
    }

    async spawn(manifest, directory) {
        const worker = new RuntimeWorker(directory, this.dataRoot);
        worker.build = manifest.build;
        worker.onFailure = () => {
            if (this.active === worker) this.job = { state: 'failed', target: worker.build, error: 'runtimeWorkerUnavailable' };
        };
        try {
            let timeout;
            await Promise.race([
                worker.ready,
                new Promise((_, reject) => { timeout = setTimeout(() => reject(resultError('runtimeStartupTimeout')), 15_000); }),
            ]).finally(() => clearTimeout(timeout));
            if (worker.health?.version !== manifest.version) throw resultError('runtimeSourceInvalid');
            return worker;
        } catch (error) {
            await worker.terminate();
            throw error;
        }
    }

    async readSaved() {
        return JSON.parse(await fs.readFile(path.join(this.cacheRoot, 'active.json'), 'utf8'));
    }

    async saveActive(build, previous) {
        const temporary = path.join(this.cacheRoot, `.active-${randomUUID()}.json`);
        try {
            await fs.writeFile(temporary, JSON.stringify({ build, previous }));
            await fs.rename(temporary, path.join(this.cacheRoot, 'active.json'));
        } finally { await fs.rm(temporary, { force: true }); }
    }

    async start() {
        let saved;
        try { saved = await this.readSaved(); } catch { saved = null; }
        try {
            const manifest = await this.installed();
            const directory = await this.prepare(manifest);
            this.active = await this.spawn(manifest, directory);
            this.previousBuild = saved?.build !== manifest.build && BUILD.test(saved?.build || '') ? saved.build : saved?.previous || '';
            await this.saveActive(manifest.build, this.previousBuild);
            await this.prune();
        } catch (error) {
            this.job = { state: error.code === 'runtimeRestartRequired' ? 'restartRequired' : 'failed', target: '', error: error.code || 'runtimeSourceInvalid' };
            if (BUILD.test(saved?.build || '')) {
                try {
                    const directory = path.join(this.cacheRoot, saved.build);
                    const manifest = checkManifest(JSON.parse(await fs.readFile(path.join(directory, 'runtime-manifest.json'), 'utf8')));
                    await this.verifyFiles(directory, manifest);
                    this.active = await this.spawn(manifest, directory);
                    this.previousBuild = saved.previous || '';
                } catch (fallbackError) { console.error('[device-settings-sync] Cached runtime unavailable', fallbackError); }
            }
            console.error('[device-settings-sync] Installed runtime unavailable', error);
        }
    }

    async status() {
        let installedBuild = '';
        let installedVersion = '';
        let sourceError = '';
        try {
            const manifest = await this.installed();
            installedBuild = manifest.build;
            installedVersion = manifest.version;
        } catch (error) { sourceError = error.code || 'runtimeSourceInvalid'; }
        return { activeBuild: this.active?.build || '', activeVersion: this.active?.health?.version || '',
            installedBuild, installedVersion, state: sourceError === 'runtimeRestartRequired' ? 'restartRequired'
                : sourceError ? 'sourceInvalid' : this.job.state,
            error: sourceError || this.job.error, targetBuild: this.job.target };
    }

    async invoke(request) {
        if (this.gate) await this.gate.promise;
        const active = this.active;
        if (!active?.alive) throw resultError('runtimeWorkerUnavailable');
        active.inFlight++;
        try { return await active.dispatch(request); }
        finally { active.finish(); }
    }

    async requestReload(expectedBuild, { retry = false } = {}) {
        const manifest = await this.installed();
        if (expectedBuild !== manifest.build) throw resultError('runtimeSourceMismatch');
        if (this.active?.build === expectedBuild && this.active.alive) return { state: 'ready' };
        if (this.job.state === 'preparing' || this.job.state === 'waiting') {
            if (this.job.target === expectedBuild) return { state: this.job.state };
            throw resultError('runtimeReloadBusy');
        }
        if (this.failedBuild === expectedBuild && !retry) return { state: 'failed' };
        this.job = { state: 'preparing', target: expectedBuild, error: '' };
        this.reloadPromise = this.switchTo(manifest).catch(error => {
            this.failedBuild = expectedBuild;
            this.job = { state: 'failed', target: expectedBuild, error: error.code || 'runtimeReloadFailed' };
            console.error('[device-settings-sync] Runtime reload failed', error);
        });
        return { state: 'preparing' };
    }

    async switchTo(manifest) {
        let candidate;
        try {
            candidate = await this.spawn(manifest, await this.prepare(manifest));
            this.job = { state: 'waiting', target: manifest.build, error: '' };
            let release;
            this.gate = { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
            const old = this.active;
            try {
                if (old) await old.drained(this.drainMs);
                await this.saveActive(manifest.build, old?.build || this.previousBuild);
                this.active = candidate;
                this.previousBuild = old?.build || this.previousBuild;
                candidate = null;
                this.failedBuild = '';
                this.job = { state: 'ready', target: manifest.build, error: '' };
            } finally {
                this.gate.release();
                this.gate = null;
            }
            try {
                if (old) await old.terminate();
                await this.prune();
            } catch (cleanupError) { console.error('[device-settings-sync] Runtime cleanup failed', cleanupError); }
        } finally { if (candidate) await candidate.terminate(); }
    }

    async prune() {
        const keep = new Set([this.active?.build, this.previousBuild]);
        for (const entry of await fs.readdir(this.cacheRoot, { withFileTypes: true })) {
            const target = path.join(this.cacheRoot, entry.name);
            if (!within(this.cacheRoot, target)) continue;
            if (entry.isDirectory() && (BUILD.test(entry.name) && !keep.has(entry.name)
                || /^\.stage-[a-f0-9-]+$/u.test(entry.name))) {
                await fs.rm(target, { recursive: true, force: true });
            }
            if (entry.isFile() && /^\.active-[a-f0-9-]+\.json$/u.test(entry.name)) {
                await fs.rm(target, { force: true });
            }
        }
    }

    async close() {
        if (this.reloadPromise) await this.reloadPromise;
        if (this.active) {
            await this.active.drained(this.drainMs).catch(() => {});
            await this.active.terminate();
        }
    }
}
