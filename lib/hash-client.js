import { digestBytes } from './sha256.js';
const encoder = new TextEncoder();
const deltaIsWorthwhile = (delta, value) => encoder.encode(JSON.stringify(delta)).byteLength <= encoder.encode(JSON.stringify(value)).byteLength * 0.75;

export class HashClient {
    constructor(win = window) {
        this.win = win;
        this.worker = null;
        this.pending = new Map();
        this.sequence = 0;
        try {
            this.worker = new win.Worker(new URL('../workers/hash-worker.js', import.meta.url), { type: 'module' });
            this.worker.addEventListener('message', event => {
                const item = this.pending.get(event.data?.id);
                if (!item) return;
                this.pending.delete(event.data.id);
                event.data.error ? item.reject(Object.assign(new Error(event.data.error), { code: 'autoHashUnavailable' })) : item.resolve(event.data);
            });
            this.worker.addEventListener('error', error => {
                const failure = Object.assign(new Error(error.message || 'Hash worker failed'), { code: 'autoHashUnavailable' });
                for (const item of this.pending.values()) item.reject(failure);
                this.pending.clear();
                this.worker?.terminate(); this.worker = null;
            });
        } catch { this.worker = null; }
    }

    async run(type, data) {
        if (!this.worker) {
            if (!this.win.crypto?.subtle) throw Object.assign(new Error('Hash worker is unavailable'), { code: 'autoHashUnavailable' });
            const afterHash = await digestBytes(type === 'bytes' ? data.bytes : encoder.encode(data.value), this.win.crypto);
            if (type === 'hash' || type === 'bytes') return { hash: afterHash };
            let delta = null;
            if (typeof data.before === 'string' && data.value.length > 256 * 1024) {
                let prefix = 0;
                const limit = Math.min(data.before.length, data.value.length);
                while (prefix < limit && data.before.charCodeAt(prefix) === data.value.charCodeAt(prefix)) prefix++;
                let suffix = 0;
                while (suffix < limit - prefix && data.before.charCodeAt(data.before.length - suffix - 1)
                    === data.value.charCodeAt(data.value.length - suffix - 1)) suffix++;
                const candidate = { kind: 'splice', prefix, suffix, middle: data.value.slice(prefix, data.value.length - suffix) };
                if (deltaIsWorthwhile(candidate, data.value)) delta = candidate;
            }
            return { afterHash, delta };
        }
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const failure = Object.assign(new Error('Hash worker timed out'), { code: 'autoHashUnavailable' });
                for (const item of this.pending.values()) item.reject(failure);
                this.pending.clear(); this.worker?.terminate(); this.worker = null;
            }, 60_000);
            this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
            try { this.worker.postMessage({ id, type, ...data }); }
            catch (error) {
                this.pending.get(id)?.reject(Object.assign(new Error(error.message), { code: 'autoHashUnavailable' }));
                this.pending.delete(id);
            }
        });
    }

    hash(value) { return this.run('hash', { value }); }
    bytes(bytes) { return this.run('bytes', { bytes }); }
    async probe({ requireWorker = false } = {}) {
        if (requireWorker && !this.worker) throw Object.assign(new Error('Hash worker is unavailable'), { code: 'autoHashUnavailable' });
        const result = await this.hash('');
        if (result.hash !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') throw new Error('Hash self-test failed');
    }
    prepare(before, value) { return this.run('prepare', { before, value }); }
    destroy() {
        for (const item of this.pending.values()) item.reject(Object.assign(new Error('Hash worker stopped'), { code: 'autoHashUnavailable' }));
        this.pending.clear(); this.worker?.terminate(); this.worker = null;
    }
}
