import { AutoJournal, openAutoJournal } from '../lib/auto-journal.js';

function hex(buffer) { return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function digest(text) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }

async function freshHeaders(batch) {
    const response = await fetch('/csrf-token', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('CSRF token refresh HTTP ' + response.status);
    const data = await response.json();
    if (typeof data.token !== 'string' || !data.token) throw new Error('CSRF token refresh failed');
    return { ...batch.headers, 'x-csrf-token': data.token };
}

async function fetchCommit(batch, headers) {
    const json = JSON.stringify(batch.payload);
    const bytes = new TextEncoder().encode(json);
    if (bytes.byteLength <= 256 * 1024) {
        const response = await fetch(batch.url, { method: 'POST', headers, body: json,
            credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error('commit HTTP ' + response.status);
        return response.json();
    }
    const mode = encodeURIComponent(batch.payload.mode);
    const base = '/api/plugins/device-settings-sync/incremental/transfers';
    const chunkSize = 256 * 1024;
    const chunks = Math.ceil(bytes.byteLength / chunkSize);
    const start = await fetch(base + '/start', { method: 'POST', headers,
        body: JSON.stringify({ mode: batch.payload.mode, account: batch.payload.account,
            operationId: batch.payload.operationId, expectedRevision: batch.payload.expectedRevision,
            chunks, bytes: bytes.byteLength, digest: await digest(json) }), credentials: 'same-origin', cache: 'no-store' });
    if (!start.ok) throw new Error('transfer HTTP ' + start.status);
    for (let index = 0; index < chunks; index++) {
        const part = bytes.subarray(index * chunkSize, Math.min(bytes.byteLength, (index + 1) * chunkSize));
        let binary = '';
        for (let offset = 0; offset < part.length; offset += 0x8000) binary += String.fromCharCode(...part.subarray(offset, Math.min(part.length, offset + 0x8000)));
        const path = base + '/' + encodeURIComponent(batch.payload.operationId) + '/chunks/' + index + '?mode=' + mode;
        const uploaded = await fetch(path, { method: 'PUT', headers,
            body: JSON.stringify({ data: btoa(binary) }), credentials: 'same-origin', cache: 'no-store' });
        if (!uploaded.ok) throw new Error('chunk HTTP ' + uploaded.status);
    }
    const finish = await fetch(base + '/' + encodeURIComponent(batch.payload.operationId) + '/finish?mode=' + mode,
        { method: 'POST', headers, body: JSON.stringify({ account: batch.account }), credentials: 'same-origin', cache: 'no-store' });
    if (!finish.ok) throw new Error('finish HTTP ' + finish.status);
    return finish.json();
}

async function runSync(databaseName, account) {
    if (!self.navigator.locks?.request) return;
    const lock = 'dss-sync:' + account;
    await self.navigator.locks.request(lock, { ifAvailable: true }, async held => {
        if (!held) return;
        const database = await openAutoJournal(indexedDB, account);
        try {
            const reader = new AutoJournal(database);
            for (const batch of await reader.listBatches()) {
                if (batch.state === 'confirmed') continue;
                if (batch.account !== account || batch.databaseName !== databaseName) continue;
                try {
                    const scopedReader = new AutoJournal(database, batch.payload.mode);
                    if (await scopedReader.getMeta('uploadEnabled') !== true) return;
                    const headers = await freshHeaders(batch);
                    const receipt = await fetchCommit(batch, headers);
                    await scopedReader.confirmBatch(batch, receipt.revision);
                    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
                    for (const client of clients) client.postMessage({ type: 'dss-auto-confirmed', account,
                        mode: batch.payload.mode, revision: receipt.revision, confirmedAt: Date.now() });
                } catch { return; }
            }
        } finally { database.close(); }
    });
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('sync', event => {
    if (!event.tag.startsWith('dss-autosave:')) return;
    const [, encodedAccount, encodedDatabase] = event.tag.split(':');
    event.waitUntil(runSync(decodeURIComponent(encodedDatabase), decodeURIComponent(encodedAccount)));
});
