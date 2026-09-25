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
                event.data.error ? item.reject(new Error(event.data.error)) : item.resolve(event.data);
            });
            this.worker.addEventListener('error', error => {
                for (const item of this.pending.values()) item.reject(error);
                this.pending.clear();
                this.worker?.terminate(); this.worker = null;
            });
        } catch { this.worker = null; }
    }

    async run(type, data) {
        if (!this.worker) {
            const digest = await this.win.crypto.subtle.digest('SHA-256', encoder.encode(data.value));
            const afterHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
            if (type === 'hash') return { hash: afterHash };
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
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ id, type, ...data });
        });
    }

    hash(value) { return this.run('hash', { value }); }
    prepare(before, value) { return this.run('prepare', { before, value }); }
    destroy() { this.worker?.terminate(); this.worker = null; }
}
