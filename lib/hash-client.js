import { digestBytes } from './sha256.js';
const encoder = new TextEncoder();
const CHUNK_BYTES = 256 * 1024;
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SAMPLE_HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const HASH = /^[a-f0-9]{64}$/u;
const REASONS = new Set(['worker-unavailable', 'worker-load', 'worker-execution', 'worker-message', 'worker-timeout', 'worker-self-test', 'worker-protocol', 'worker-stopped']);
const PHASES = new Set(['startup', 'probe', 'hash', 'prepare', 'bytes-start', 'bytes-chunk', 'bytes-finish', 'operation', 'response']);
const deltaIsWorthwhile = (delta, value) => encoder.encode(JSON.stringify(delta)).byteLength <= encoder.encode(JSON.stringify(value)).byteLength * 0.75;

function failure(reason, details = {}) {
    return Object.assign(new Error(reason), { code: 'autoHashUnavailable', details: { reason, ...details } });
}

export function safeHashFailure(details) {
    const result = {};
    if (REASONS.has(details?.reason)) result.reason = details.reason;
    if (PHASES.has(details?.phase)) result.phase = details.phase;
    if (['module', 'classic'].includes(details?.workerType)) result.workerType = details.workerType;
    for (const key of ['timeoutMs', 'completedBytes', 'totalBytes']) {
        if (Number.isSafeInteger(details?.[key]) && details[key] >= 0) result[key] = details[key];
    }
    return result;
}

export class HashClient {
    constructor(win = window, { startupTimeoutMs = 8000, operationTimeoutMs = 60000, chunkTimeoutMs = 30000 } = {}) {
        this.win = win;
        this.worker = null;
        this.pending = new Map();
        this.sequence = 0;
        this.queue = Promise.resolve();
        this.starting = null;
        this.ready = false;
        this.destroyed = false;
        this.workerType = '';
        this.preferredType = 'module';
        this.recoveries = 0;
        this.lastFailure = null;
        this.progress = null;
        this.timeouts = { startup: startupTimeoutMs, operation: operationTimeoutMs, chunk: chunkTimeoutMs };
    }

    describe() {
        return { workerType: this.workerType || 'none', ready: this.ready, recoveries: this.recoveries,
            lastFailure: this.lastFailure ? { ...this.lastFailure } : null,
            progress: this.progress ? { ...this.progress } : null };
    }

    drop(error, worker = this.worker) {
        if (worker !== this.worker) return;
        if (error) this.lastFailure = safeHashFailure(error.details);
        this.worker = null; this.ready = false;
        this.detach?.(); this.detach = null;
        worker?.terminate();
        for (const item of this.pending.values()) item.reject(error || failure('worker-stopped'));
        this.pending.clear();
    }

    rpc(type, data = {}, { transfer = [], timeout = this.timeouts.operation } = {}) {
        if (this.destroyed) return Promise.reject(failure('worker-stopped'));
        const worker = this.worker;
        if (!worker) return Promise.reject(failure('worker-unavailable', { phase: type }));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.drop(failure('worker-timeout', {
                phase: type, workerType: this.workerType, timeoutMs: timeout,
                completedBytes: this.progress?.completedBytes || 0, totalBytes: this.progress?.totalBytes || 0,
            }), worker), timeout);
            this.pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); },
                reject: error => { clearTimeout(timer); reject(error); } });
            try { worker.postMessage({ id, type, ...data }, transfer); }
            catch { this.drop(failure('worker-message', { phase: type, workerType: this.workerType }), worker); }
        });
    }

    async spawn(type) {
        if (this.destroyed) throw failure('worker-stopped');
        let worker;
        try {
            worker = new this.win.Worker(new URL(type === 'module' ? '../workers/hash-worker.js' : '../workers/hash-worker-classic.js', import.meta.url), { type });
        } catch {
            throw failure('worker-load', { phase: 'startup', workerType: type });
        }
        this.worker = worker; this.workerType = type;
        const onMessage = event => {
            if (this.worker !== worker) return;
            const item = this.pending.get(event.data?.id);
            if (!item) return;
            this.pending.delete(event.data.id);
            if (event.data.error) {
                const reason = event.data.reason === 'worker-protocol' ? 'worker-protocol' : 'worker-execution';
                item.reject(failure(reason, { workerType: type, phase: this.ready ? 'operation' : 'startup' }));
            } else item.resolve(event.data);
        };
        const onError = event => {
            event.preventDefault?.();
            this.drop(failure(this.ready ? 'worker-execution' : 'worker-load', {
                workerType: type, phase: this.ready ? 'operation' : 'startup',
            }), worker);
        };
        const onMessageError = () => this.drop(failure('worker-message', { workerType: type, phase: 'response' }), worker);
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.addEventListener('messageerror', onMessageError);
        this.detach = () => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            worker.removeEventListener('messageerror', onMessageError);
        };
        try {
            const result = await this.rpc('probe', {}, { timeout: this.timeouts.startup });
            if (result.protocol !== 2 || result.hash !== EMPTY_HASH || result.sampleHash !== SAMPLE_HASH) {
                throw failure('worker-self-test', { workerType: type, phase: 'startup' });
            }
            if (this.destroyed) throw failure('worker-stopped');
            this.ready = true; this.preferredType = type;
        } catch (error) { this.drop(error, worker); throw error; }
    }

    async ensureWorker() {
        if (this.destroyed) throw failure('worker-stopped');
        if (typeof this.win.Worker !== 'function') {
            const error = failure('worker-unavailable', { phase: 'startup' });
            this.lastFailure = error.details;
            throw error;
        }
        if (this.worker && this.ready) return;
        if (this.starting) return this.starting;
        this.starting = (async () => {
            let error = failure('worker-unavailable', { phase: 'startup' });
            const types = this.preferredType === 'classic' ? ['classic'] : ['module', 'classic'];
            for (const type of types) {
                try { await this.spawn(type); return; }
                catch (caught) {
                    error = caught; this.lastFailure = safeHashFailure(caught.details);
                    if (this.destroyed) throw caught;
                }
            }
            throw error;
        })();
        try { return await this.starting; }
        finally { this.starting = null; }
    }

    async execute(type, data) {
        if (type !== 'bytes') {
            this.progress = null;
            const result = await this.rpc(type, data);
            if (!HASH.test(type === 'prepare' ? result.afterHash : result.hash)) {
                throw failure('worker-protocol', { phase: type, workerType: this.workerType });
            }
            return result;
        }
        const input = ArrayBuffer.isView(data.bytes) ? new Uint8Array(data.bytes.buffer, data.bytes.byteOffset, data.bytes.byteLength) : new Uint8Array(data.bytes);
        const streamId = ++this.sequence;
        const total = input.byteLength;
        this.progress = { completedBytes: 0, totalBytes: total, chunkBytes: CHUNK_BYTES };
        const started = await this.rpc('bytes-start', { streamId, total }, { timeout: this.timeouts.chunk });
        if (started.received !== 0) throw failure('worker-protocol', { phase: 'bytes-start', workerType: this.workerType });
        for (let offset = 0; offset < total; offset += CHUNK_BYTES) {
            // Keep the caller's buffer intact so a worker failure is retryable.
            const chunk = new Uint8Array(Math.min(CHUNK_BYTES, total - offset));
            chunk.set(input.subarray(offset, offset + chunk.byteLength));
            const end = offset + chunk.byteLength;
            const result = await this.rpc('bytes-chunk', { streamId, offset, bytes: chunk },
                { transfer: [chunk.buffer], timeout: this.timeouts.chunk });
            if (result.received !== end) throw failure('worker-protocol', { phase: 'bytes-chunk', workerType: this.workerType });
            this.progress.completedBytes = end;
        }
        const result = await this.rpc('bytes-finish', { streamId }, { timeout: this.timeouts.chunk });
        if (!HASH.test(result.hash)) throw failure('worker-protocol', { phase: 'bytes-finish', workerType: this.workerType });
        return result;
    }

    async native(type, data) {
        const hash = await digestBytes(type === 'bytes' ? data.bytes : encoder.encode(data.value), this.win.crypto);
        if (type !== 'prepare') return { hash };
        // Only native asynchronous hashing may run without a worker. Never run
        // the pure JavaScript HTTP hasher on the UI thread as a fallback.
        let delta = null;
        if (typeof data.before === 'string' && data.value.length > 256 * 1024) {
            let prefix = 0;
            const limit = Math.min(data.before.length, data.value.length);
            while (prefix < limit && data.before.charCodeAt(prefix) === data.value.charCodeAt(prefix)) prefix++;
            let suffix = 0;
            while (suffix < limit - prefix && data.before.charCodeAt(data.before.length - suffix - 1) === data.value.charCodeAt(data.value.length - suffix - 1)) suffix++;
            const candidate = { kind: 'splice', prefix, suffix, middle: data.value.slice(prefix, data.value.length - suffix) };
            if (deltaIsWorthwhile(candidate, data.value)) delta = candidate;
        }
        return { afterHash: hash, delta };
    }

    enqueue(work) {
        const result = this.queue.then(() => {
            if (this.destroyed) throw failure('worker-stopped');
            return work();
        });
        this.queue = result.catch(() => {});
        return result;
    }

    run(type, data) {
        return this.enqueue(async () => {
            try { await this.ensureWorker(); }
            catch (error) {
                if (!this.destroyed && this.win.crypto?.subtle) return this.native(type, data);
                throw error;
            }
            for (let attempt = 0; attempt < 2; attempt++) {
                try { return await this.execute(type, data); }
                catch (error) {
                    this.drop(error);
                    if (this.destroyed) throw error;
                    if (attempt === 1) {
                        if (this.win.crypto?.subtle) return this.native(type, data);
                        throw error;
                    }
                    this.recoveries++;
                    this.preferredType = 'classic';
                    try { await this.ensureWorker(); }
                    catch (startupError) {
                        if (this.win.crypto?.subtle) return this.native(type, data);
                        throw startupError;
                    }
                }
            }
        });
    }

    hash(value) { return this.run('hash', { value }); }
    bytes(bytes) { return this.run('bytes', { bytes }); }
    prepare(before, value) { return this.run('prepare', { before, value }); }
    probe({ requireWorker = false } = {}) {
        if (!requireWorker) return this.hash('').then(result => {
            if (result.hash !== EMPTY_HASH) throw failure('worker-self-test', { phase: 'probe' });
        });
        return this.enqueue(() => this.ensureWorker());
    }
    destroy() { this.destroyed = true; this.drop(failure('worker-stopped')); }
}
