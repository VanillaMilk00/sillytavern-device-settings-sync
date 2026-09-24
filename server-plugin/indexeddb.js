import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { INDEXEDDB_ARCHIVE_FORMAT, INDEXEDDB_CHUNK_BYTES, MAX_INDEXEDDB_ARCHIVE_BYTES, IndexedDbError, parseIndexedDbArchive, mergeArchiveObjects, selectIndexedDbArchive } from '../lib/indexeddb-model.js';
import { StorageError } from '../lib/storage-model.js';

const TRANSFERS = 'device-settings-sync-indexeddb-transfers';
const BACKUPS = 'device-settings-sync-indexeddb-backups';
const STATE = 'device-settings-sync-indexeddb.json';
const ARCHIVE_PREFIX = 'device-settings-sync-indexeddb-archive-';
const KEEP = 5;
const SESSION_TTL = 2 * 60 * 60 * 1000;
const MAX_ACTIVE_TRANSFERS = 4;
const ID = /^[a-zA-Z0-9_-]{8,100}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const EMPTY_ARCHIVE = { format: INDEXEDDB_ARCHIVE_FORMAT, version: 1, createdAt: '', scope: { kind: 'all' }, databases: [] };

function fail(code, details) { throw new StorageError(code, details); }
function hash(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function textBytes(text) { return Buffer.byteLength(text, 'utf8'); }

async function readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomicWrite(file, data) {
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, file);
        await fs.chmod(file, 0o600).catch(() => {});
    } finally { await fs.unlink(temporary).catch(() => {}); }
}

function initialState() { return { schema: 1, revision: 0, seeded: false, updatedAt: '', archive: EMPTY_ARCHIVE, receipts: [] }; }

async function readState(root) {
    const state = await readJson(path.join(root, STATE), initialState());
    if (state.schema !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.receipts)) fail('indexedDbInvalidArchive');
    let archive = state.archive;
    if (state.archiveFile) {
        if (!validArchiveFile(state.archiveFile)) fail('indexedDbInvalidArchive');
        archive = JSON.parse(await fs.readFile(path.join(root, state.archiveFile), 'utf8'));
    }
    if (!archive) archive = EMPTY_ARCHIVE;
    parseIndexedDbArchive(JSON.stringify(archive));
    return { ...state, archive };
}

function validArchiveFile(name) {
    return typeof name === 'string' && path.basename(name) === name && name.startsWith(ARCHIVE_PREFIX) && name.endsWith('.json');
}

async function readFileChunk(file, index, size) {
    const offset = index * INDEXEDDB_CHUNK_BYTES;
    const length = Math.min(INDEXEDDB_CHUNK_BYTES, size - offset);
    if (length <= 0) fail('indexedDbTransferNotFound');
    const handle = await fs.open(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) fail('indexedDbTransferNotFound');
        return buffer.toString('base64');
    } finally { await handle.close(); }
}

async function backupIndex(root) {
    const file = path.join(root, BACKUPS, 'index.json');
    const index = await readJson(file, { records: [], operations: [] });
    if (!Array.isArray(index.records) || index.records.length > KEEP || !Array.isArray(index.operations)) fail('indexedDbInvalidArchive');
    return { ...index, file };
}

async function saveBackup(root, archive, reason, operationId, source = {}) {
    if (!['upload', 'download', 'import', 'restore', 'delete'].includes(reason) || !ID.test(operationId)) fail('indexedDbInvalidArchive');
    const normalized = parseIndexedDbArchive(JSON.stringify(archive));
    const text = JSON.stringify(normalized);
    if (textBytes(text) > MAX_INDEXEDDB_ARCHIVE_BYTES) fail('indexedDbArchiveTooLarge');
    const canonical = { ...normalized, createdAt: '' };
    const digest = hash(Buffer.from(reason + JSON.stringify(canonical)));
    const directory = path.join(root, BACKUPS);
    const { records, operations, file: indexFile } = await backupIndex(root);
    const previous = operations.find(item => item.operationId === operationId);
    if (previous) {
        if (previous.digest !== digest) fail('indexedDbBackupConflict');
        return records.find(item => item.id === previous.id) || { id: previous.id, retained: false, deduplicated: true };
    }
    const record = { id: randomUUID(), operationId, reason, createdAt: new Date().toISOString(),
        source: { origin: String(source.origin || ''), deviceId: String(source.deviceId || '') },
        databases: normalized.databases.length,
        stores: normalized.databases.reduce((sum, database) => sum + database.stores.length, 0),
        records: normalized.databases.reduce((sum, database) => sum + database.stores.reduce((storeSum, store) => storeSum + store.records.length, 0), 0),
        fileBytes: textBytes(text), digest, fileDigest: hash(Buffer.from(text)) };
    const backupFile = path.join(directory, record.id + '.json');
    await atomicWrite(backupFile, text);
    try {
        await atomicWrite(indexFile, JSON.stringify({ records: [record, ...records].slice(0, KEEP),
            operations: [...operations, { id: record.id, operationId, digest }].slice(-500) }));
    } catch (error) { await fs.unlink(backupFile).catch(() => {}); throw error; }
    for (const old of records.slice(KEEP - 1)) await fs.unlink(path.join(directory, old.id + '.json')).catch(() => {});
    return record;
}

function metadata(archive, revision, updatedAt, seeded, serialized = JSON.stringify(archive)) {
    const data = Buffer.from(serialized);
    return { revision, updatedAt, seeded, format: INDEXEDDB_ARCHIVE_FORMAT,
        size: data.byteLength, digest: hash(data), chunks: Math.ceil(data.byteLength / INDEXEDDB_CHUNK_BYTES) };
}

function scopedTransferInput(scope) {
    if (scope?.kind === 'databases' && Array.isArray(scope.names) && scope.names.length > 0 && scope.names.length <= 100000
        && scope.names.every(name => typeof name === 'string' && name.length > 0)) {
        return { kind: 'databases', names: [...new Set(scope.names)] };
    }
    const validItem = item => {
        if (!item || typeof item.database !== 'string' || !item.database.length
            || (item.store !== undefined && (typeof item.store !== 'string' || !item.store.length))) return false;
        if (item.keyToken === undefined) return true;
        if (typeof item.store !== 'string' || typeof item.keyToken !== 'string') return false;
        try { JSON.parse(item.keyToken); return true; } catch { return false; }
    };
    if (scope?.kind === 'items' && Array.isArray(scope.items) && scope.items.length > 0 && scope.items.length <= 100000
        && scope.items.every(validItem)) {
        const items = [...new Map(scope.items.map(item => [JSON.stringify(item), {
            database: item.database,
            ...(item.store === undefined ? {} : { store: item.store }),
            ...(item.keyToken === undefined ? {} : { keyToken: item.keyToken }),
        }])).values()];
        return { kind: 'items', items };
    }
    fail('indexedDbInvalidTransfer');
}

export class IndexedDbTransferStore {
    constructor(root) { this.root = root; this.directory = path.join(root, TRANSFERS); }

    async cleanExpired() {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        for (const name of await fs.readdir(this.directory)) {
            const directory = path.join(this.directory, name);
            try {
                const stat = await fs.stat(path.join(directory, 'session.json'));
                if (Date.now() - stat.mtimeMs > SESSION_TTL) await fs.rm(directory, { recursive: true, force: true });
            } catch (error) { if (error.code === 'ENOENT') await fs.rm(directory, { recursive: true, force: true }); else throw error; }
        }
    }

    async start(input) {
        if (!input || !['backup', 'commit'].includes(input.kind) || !ID.test(input.operationId)
            || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_INDEXEDDB_ARCHIVE_BYTES
            || !Number.isSafeInteger(input.chunks) || input.chunks < 0 || input.chunks > Math.ceil(MAX_INDEXEDDB_ARCHIVE_BYTES / INDEXEDDB_CHUNK_BYTES)
            || !HASH.test(input.digest) || !['upload', 'download', 'import', 'restore', 'delete'].includes(input.reason)
            || (input.kind === 'commit' && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0))) fail('indexedDbInvalidTransfer');
        if (input.chunks !== Math.ceil(input.size / INDEXEDDB_CHUNK_BYTES)) fail('indexedDbInvalidTransfer');
        await this.cleanExpired();
        if ((await fs.readdir(this.directory)).length >= MAX_ACTIVE_TRANSFERS) fail('indexedDbTooManyTransfers');
        const id = randomUUID();
        const directory = path.join(this.directory, id);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const source = {
            origin: typeof input.source?.origin === 'string' ? input.source.origin.slice(0, 300) : '',
            deviceId: typeof input.source?.deviceId === 'string' ? input.source.deviceId.slice(0, 300) : '',
        };
        const session = { kind: input.kind, operationId: input.operationId, reason: input.reason, source,
            size: input.size, chunks: input.chunks, digest: input.digest, id, createdAt: Date.now(),
            ...(input.kind === 'commit' ? { expectedRevision: input.expectedRevision } : {}) };
        await atomicWrite(path.join(directory, 'session.json'), JSON.stringify(session));
        return { id, chunkBytes: INDEXEDDB_CHUNK_BYTES };
    }

    async session(id) {
        if (!ID.test(id)) fail('indexedDbTransferNotFound');
        const directory = path.join(this.directory, id);
        const session = await readJson(path.join(directory, 'session.json'), null);
        if (!session || Date.now() - session.createdAt > SESSION_TTL) fail('indexedDbTransferNotFound');
        return { directory, session };
    }

    async putChunk(id, index, input) {
        const { directory, session } = await this.session(id);
        if (!Number.isSafeInteger(index) || index < 0 || index >= session.chunks || typeof input?.chunk !== 'string') fail('indexedDbInvalidTransfer');
        let data;
        try { data = Buffer.from(input.chunk, 'base64'); } catch { fail('indexedDbInvalidTransfer'); }
        const expected = index === session.chunks - 1 ? session.size - index * INDEXEDDB_CHUNK_BYTES : INDEXEDDB_CHUNK_BYTES;
        if (data.length !== expected) fail('indexedDbInvalidTransfer');
        const file = path.join(directory, index + '.chunk');
        try {
            const existing = await fs.readFile(file);
            if (hash(existing) !== hash(data)) fail('indexedDbTransferConflict');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await atomicWrite(file, data);
        }
        return { stored: true, index };
    }

    async assemble(id) {
        const { directory, session } = await this.session(id);
        const chunks = [];
        for (let index = 0; index < session.chunks; index += 1) {
            try { chunks.push(await fs.readFile(path.join(directory, index + '.chunk'))); }
            catch (error) { if (error.code === 'ENOENT') fail('indexedDbTransferIncomplete'); throw error; }
        }
        const buffer = Buffer.concat(chunks);
        if (buffer.length !== session.size || hash(buffer) !== session.digest) fail('indexedDbTransferDigestMismatch');
        let archive;
        try { archive = parseIndexedDbArchive(buffer.toString('utf8')); }
        catch (error) { if (error instanceof IndexedDbError) fail(error.code); throw error; }
        return { directory, session, archive };
    }

    async finish(id) {
        const { directory, session, archive } = await this.assemble(id);
        if (session.kind === 'backup') {
            const record = await saveBackup(this.root, archive, session.reason, session.operationId, session.source);
            await fs.rm(directory, { recursive: true, force: true });
            return { kind: 'backup', ...record };
        }
        const current = await readState(this.root);
        const existing = current.receipts.find(item => item.operationId === session.operationId);
        const canonicalArchive = { ...archive, createdAt: '' };
        const digest = hash(Buffer.from(JSON.stringify({ expectedRevision: session.expectedRevision, archive: canonicalArchive })));
        if (existing) {
            if (existing.digest !== digest) fail('indexedDbCommitConflict');
            await fs.rm(directory, { recursive: true, force: true });
            return { kind: 'commit', revision: existing.revision, replayed: true };
        }
        if (current.revision !== session.expectedRevision) fail('indexedDbRevisionConflict');
        const combined = mergeArchiveObjects(current.archive, archive, archive.scope);
        const archiveText = JSON.stringify(combined);
        if (textBytes(archiveText) > MAX_INDEXEDDB_ARCHIVE_BYTES) fail('indexedDbArchiveTooLarge');
        const revision = current.revision + 1;
        const updatedAt = new Date().toISOString();
        const nextMeta = { schema: 1, revision, seeded: true, updatedAt, archiveFile: `${ARCHIVE_PREFIX}${revision}-${randomUUID()}.json`,
            ...metadata(combined, revision, updatedAt, true, archiveText),
            receipts: [...current.receipts, { operationId: session.operationId, digest, revision, createdAt: updatedAt }].slice(-500) };
        await atomicWrite(path.join(this.root, nextMeta.archiveFile), archiveText);
        await atomicWrite(path.join(this.root, STATE), JSON.stringify(nextMeta));
        for (const name of await fs.readdir(this.root)) {
            if (name.startsWith(ARCHIVE_PREFIX) && name !== nextMeta.archiveFile) await fs.unlink(path.join(this.root, name)).catch(() => {});
        }
        await fs.rm(directory, { recursive: true, force: true });
        return { kind: 'commit', revision, replayed: false, digest: nextMeta.digest };
    }

    async readState() { return readState(this.root); }
    async stateMetadata() {
        const state = await readJson(path.join(this.root, STATE), initialState());
        if (state.size !== undefined && state.digest && state.chunks !== undefined) return {
            revision: state.revision, updatedAt: state.updatedAt, seeded: state.seeded,
            format: INDEXEDDB_ARCHIVE_FORMAT, size: state.size, digest: state.digest, chunks: state.chunks,
        };
        return metadata(state.archive || EMPTY_ARCHIVE, state.revision, state.updatedAt, state.seeded);
    }
    async stateChunk(index) {
        const state = await readJson(path.join(this.root, STATE), initialState());
        const meta = await this.stateMetadata();
        if (!Number.isSafeInteger(index) || index < 0 || index >= meta.chunks) fail('indexedDbTransferNotFound');
        if (state.archiveFile) {
            if (!validArchiveFile(state.archiveFile)) fail('indexedDbInvalidArchive');
            return readFileChunk(path.join(this.root, state.archiveFile), index, meta.size);
        }
        const text = JSON.stringify(state.archive || EMPTY_ARCHIVE);
        const buffer = Buffer.from(text);
        return buffer.subarray(index * INDEXEDDB_CHUNK_BYTES, (index + 1) * INDEXEDDB_CHUNK_BYTES).toString('base64');
    }
    async startScopedState(scope) {
        const selectedScope = scopedTransferInput(scope);
        await this.cleanExpired();
        if ((await fs.readdir(this.directory)).length >= MAX_ACTIVE_TRANSFERS) fail('indexedDbTooManyTransfers');
        const state = await readState(this.root);
        const archive = selectIndexedDbArchive(state.archive, selectedScope);
        const text = JSON.stringify(archive);
        const data = Buffer.from(text, 'utf8');
        if (data.byteLength > MAX_INDEXEDDB_ARCHIVE_BYTES) fail('indexedDbArchiveTooLarge');
        const id = randomUUID();
        const directory = path.join(this.directory, id);
        const chunks = Math.ceil(data.byteLength / INDEXEDDB_CHUNK_BYTES);
        const digest = hash(data);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        try {
            await atomicWrite(path.join(directory, 'archive.json'), data);
            await atomicWrite(path.join(directory, 'session.json'), JSON.stringify({ kind: 'download', id,
                createdAt: Date.now(), size: data.byteLength, chunks, digest }));
        } catch (error) {
            await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
            throw error;
        }
        return { id, revision: state.revision, updatedAt: state.updatedAt, seeded: state.seeded,
            stateDigest: state.digest || metadata(state.archive, state.revision, state.updatedAt, state.seeded).digest,
            format: INDEXEDDB_ARCHIVE_FORMAT, size: data.byteLength, digest, chunks };
    }
    async scopedStateChunk(id, index) {
        const { directory, session } = await this.session(id);
        if (session.kind !== 'download' || !Number.isSafeInteger(index) || index < 0 || index >= session.chunks) fail('indexedDbTransferNotFound');
        return readFileChunk(path.join(directory, 'archive.json'), index, session.size);
    }
    async scopedTransferMetadata(id) {
        const { session } = await this.session(id);
        if (session.kind !== 'download') fail('indexedDbTransferNotFound');
        return { id: session.id, size: session.size, chunks: session.chunks, digest: session.digest };
    }
    async removeScopedState(id) {
        const { directory, session } = await this.session(id);
        if (session.kind !== 'download') fail('indexedDbTransferNotFound');
        await fs.rm(directory, { recursive: true, force: true });
        return { removed: true };
    }
    async listBackups() { return (await backupIndex(this.root)).records.map(({ digest, fileDigest, ...record }) => record); }
    async backupMetadata(id) {
        if (!ID.test(id)) fail('indexedDbBackupNotFound');
        const { records } = await backupIndex(this.root);
        const record = records.find(item => item.id === id);
        if (!record) fail('indexedDbBackupNotFound');
        return { id, size: record.fileBytes, chunks: Math.ceil(record.fileBytes / INDEXEDDB_CHUNK_BYTES), digest: record.fileDigest };
    }
    async backupChunk(id, index) {
        const metadata = await this.backupMetadata(id);
        if (!Number.isSafeInteger(index) || index < 0 || index >= metadata.chunks) fail('indexedDbBackupNotFound');
        return readFileChunk(path.join(this.root, BACKUPS, id + '.json'), index, metadata.size);
    }
}
