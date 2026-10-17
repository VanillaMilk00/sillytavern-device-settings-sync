import { digestBytes, Sha256 } from '../lib/sha256.js';
const encoder = new TextEncoder();
const deltaIsWorthwhile = (delta, value) => encoder.encode(JSON.stringify(delta)).byteLength <= encoder.encode(JSON.stringify(value)).byteLength * 0.75;

function hash(value) { return digestBytes(encoder.encode(value)); }

function makeDelta(before, after) {
    let prefix = 0;
    const limit = Math.min(before.length, after.length);
    while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
    let suffix = 0;
    while (suffix < limit - prefix
        && before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)) suffix++;
    const delta = { kind: 'splice', prefix, suffix, middle: after.slice(prefix, after.length - suffix) };
    return deltaIsWorthwhile(delta, after) ? delta : null;
}

let stream = null;
self.addEventListener('message', async event => {
    const { id, type, before, value, bytes, streamId, total, offset } = event.data || {};
    try {
        if (type === 'probe') self.postMessage({ id, protocol: 2, hash: await hash(''), sampleHash: await hash('abc') });
        else if (type === 'bytes-start') {
            if (stream || !Number.isSafeInteger(streamId) || !Number.isSafeInteger(total) || total < 0) throw new Error('protocol');
            stream = { id: streamId, total, received: 0, hasher: new Sha256() };
            self.postMessage({ id, received: 0 });
        } else if (type === 'bytes-chunk') {
            if (!stream || stream.id !== streamId || offset !== stream.received || !(bytes instanceof Uint8Array)
                || bytes.byteLength > 256 * 1024 || stream.received + bytes.byteLength > stream.total) throw new Error('protocol');
            stream.hasher.update(bytes);
            stream.received += bytes.byteLength;
            self.postMessage({ id, received: stream.received });
        } else if (type === 'bytes-finish') {
            if (!stream || stream.id !== streamId || stream.received !== stream.total) throw new Error('protocol');
            const result = stream.hasher.digestHex();
            stream = null;
            self.postMessage({ id, hash: result });
        } else if (type === 'bytes') self.postMessage({ id, hash: await digestBytes(bytes) });
        else if (type === 'hash') self.postMessage({ id, hash: await hash(value) });
        else if (type === 'prepare') {
            const afterHash = await hash(value);
            const delta = typeof before === 'string' && value.length > 256 * 1024 ? makeDelta(before, value) : null;
            self.postMessage({ id, afterHash, delta });
        } else throw new Error('protocol');
    } catch (error) {
        stream = null;
        // Never expose source values, keys, URLs or exception messages.
        self.postMessage({ id, error: true, reason: error?.message === 'protocol' ? 'worker-protocol' : 'worker-execution' });
    }
});
