const encoder = new TextEncoder();
const deltaIsWorthwhile = (delta, value) => encoder.encode(JSON.stringify(delta)).byteLength <= encoder.encode(JSON.stringify(value)).byteLength * 0.75;

function hash(value) {
    return crypto.subtle.digest('SHA-256', encoder.encode(value)).then(buffer =>
        [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
}

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

self.addEventListener('message', async event => {
    const { id, type, before, value } = event.data || {};
    try {
        if (type === 'hash') self.postMessage({ id, hash: await hash(value) });
        else if (type === 'prepare') {
            const afterHash = await hash(value);
            const delta = typeof before === 'string' && value.length > 256 * 1024 ? makeDelta(before, value) : null;
            self.postMessage({ id, afterHash, delta });
        }
    } catch (error) { self.postMessage({ id, error: String(error?.message || error) }); }
});
