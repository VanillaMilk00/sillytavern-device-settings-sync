import { INDEXEDDB_CHUNK_BYTES, MAX_INDEXEDDB_ARCHIVE_BYTES, parseIndexedDbArchive, serializeIndexedDbArchive, IndexedDbError } from './indexeddb-model.js';
import { HashClient } from './hash-client.js';

const encoder = new TextEncoder();
const asBase64 = bytes => {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
};
const fromBase64 = value => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
};

let hashClient;
function transferHasher() { return hashClient ||= new HashClient(globalThis); }
export function indexedDbHashDiagnostics() { return hashClient?.describe() || null; }

export async function preflightIndexedDbTransfer() {
    if (!globalThis.indexedDB?.open) throw new IndexedDbError('indexedDbEnumerationUnsupported');
    if (globalThis.indexedDB.databases) await globalThis.indexedDB.databases();
    await transferHasher().probe({ requireWorker: !globalThis.crypto?.subtle });
}

export async function digestHex(bytes, crypto = globalThis.crypto) {
    if (crypto?.subtle && bytes.byteLength <= 256 * 1024) {
        try {
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest), item => item.toString(16).padStart(2, '0')).join('');
        } catch { /* A real worker remains available if native digest is blocked. */ }
    }
    return (await transferHasher().bytes(bytes)).hash;
}

export async function uploadIndexedDbArchive(request, archive, { kind, reason, operationId, expectedRevision, source, onProgress = () => {}, beforeFinish = async () => {} }) {
    const text = serializeIndexedDbArchive(archive);
    const data = encoder.encode(text);
    if (data.byteLength > MAX_INDEXEDDB_ARCHIVE_BYTES) throw new IndexedDbError('indexedDbArchiveTooLarge');
    const chunks = Math.ceil(data.byteLength / INDEXEDDB_CHUNK_BYTES);
    const digest = await digestHex(data);
    const session = await request('/indexeddb/transfers/start', {
        method: 'POST', body: JSON.stringify({ kind, operationId, reason, expectedRevision, source,
            size: data.byteLength, chunks, digest }),
    });
    for (let index = 0; index < chunks; index += 1) {
        const chunk = data.subarray(index * INDEXEDDB_CHUNK_BYTES, Math.min(data.byteLength, (index + 1) * INDEXEDDB_CHUNK_BYTES));
        await request(`/indexeddb/transfers/${encodeURIComponent(session.id)}/chunks/${index}`, {
            method: 'PUT', body: JSON.stringify({ chunk: asBase64(chunk) }),
        });
        onProgress({ index: index + 1, chunks });
    }
    if (kind === 'commit') await beforeFinish();
    return request(`/indexeddb/transfers/${encodeURIComponent(session.id)}/finish`, { method: 'POST', body: '{}' });
}

export async function downloadIndexedDbArchive(request, { metadataPath, metadata: suppliedMetadata, chunkPath }) {
    const metadata = suppliedMetadata || await request(metadataPath);
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_INDEXEDDB_ARCHIVE_BYTES
        || !Number.isSafeInteger(metadata.chunks) || metadata.chunks !== Math.ceil(metadata.size / INDEXEDDB_CHUNK_BYTES)) {
        throw new IndexedDbError('indexedDbInvalidArchive');
    }
    // Allocate only the destination buffer; do not retain a second full list of
    // decoded chunks while hashing on memory-constrained mobile browsers.
    const data = new Uint8Array(metadata.size);
    let total = 0;
    for (let index = 0; index < metadata.chunks; index += 1) {
        const response = await request(chunkPath(index));
        if (response.index !== index || response.chunks !== metadata.chunks || response.digest !== metadata.digest) throw new IndexedDbError('indexedDbTransferDigestMismatch');
        const chunk = fromBase64(response.chunk);
        if (chunk.byteLength !== Math.min(INDEXEDDB_CHUNK_BYTES, metadata.size - total)) throw new IndexedDbError('indexedDbTransferDigestMismatch');
        data.set(chunk, total);
        total += chunk.byteLength;
    }
    if (total !== metadata.size) throw new IndexedDbError('indexedDbTransferDigestMismatch');
    try {
        if (await digestHex(data) !== metadata.digest) throw new IndexedDbError('indexedDbTransferDigestMismatch');
    } catch (error) { error.operationStage = 'indexeddb-verify-download'; throw error; }
    return { metadata, archive: parseIndexedDbArchive(new TextDecoder().decode(data)) };
}
