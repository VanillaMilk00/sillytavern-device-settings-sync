import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StorageError, isInternalKey, MAX_ARCHIVE_BYTES } from '../lib/storage-model.js';

const FILE = 'device-settings-sync-full.json';
const ID = /^[a-zA-Z0-9_-]{8,100}$/u;
const encoder = new TextEncoder();

export function initialFullState() {
    return { schema: 1, revision: 0, seeded: false, updatedAt: '', entries: {}, receipts: [] };
}

export function fullReceipt(state, id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new StorageError('invalidCommit');
    return state.receipts.find(item => item.operationId === id) || null;
}

export function commitFullState(current, input, now = new Date().toISOString()) {
    if (!input || !ID.test(input.operationId) || !ID.test(input.deviceId)
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
        || !Array.isArray(input.entries)) throw new StorageError('invalidCommit');
    const entries = Object.create(null);
    for (const item of input.entries) {
        if (!item || typeof item.key !== 'string' || typeof item.value !== 'string'
            || isInternalKey(item.key) || Object.hasOwn(entries, item.key)) throw new StorageError('invalidCommit');
        entries[item.key] = item.value;
    }
    const digest = createHash('sha256').update(JSON.stringify({
        deviceId: input.deviceId, expectedRevision: input.expectedRevision, entries: input.entries,
    })).digest('hex');
    const previous = fullReceipt(current, input.operationId);
    if (previous) {
        if (previous.digest !== digest) throw new StorageError('commitConflict');
        return { state: current, receipt: previous, replayed: true };
    }
    if (current.revision !== input.expectedRevision) throw new StorageError('autoConflict');
    const receipt = { operationId: input.operationId, digest, revision: current.revision + 1, createdAt: now };
    const state = {
        schema: 1, revision: receipt.revision, seeded: true, updatedAt: now, entries,
        receipts: [...current.receipts, receipt],
    };
    if (encoder.encode(JSON.stringify(state)).byteLength > MAX_ARCHIVE_BYTES) throw new StorageError('archiveTooLarge');
    return { state, receipt, replayed: false };
}

export class FullStateStore {
    constructor(root) { this.file = path.join(root, FILE); }
    async read() {
        try {
            if ((await fs.stat(this.file)).size > MAX_ARCHIVE_BYTES) throw new StorageError('archiveTooLarge');
            const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
            if (state?.schema !== 1 || !Number.isSafeInteger(state.revision) || !state.entries
                || Array.isArray(state.entries) || !Array.isArray(state.receipts)
                || Object.entries(state.entries).some(([key, value]) => isInternalKey(key) || typeof value !== 'string')) {
                throw new Error('Invalid full sync state');
            }
            return state;
        } catch (error) { if (error.code === 'ENOENT') return initialFullState(); throw error; }
    }
    async commit(input) {
        const result = commitFullState(await this.read(), input);
        if (result.replayed) return { ...result.receipt, replayed: true };
        const temporary = path.join(path.dirname(this.file), '.' + FILE + '.' + randomUUID() + '.tmp');
        try {
            await fs.writeFile(temporary, JSON.stringify(result.state), { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, this.file);
            await fs.chmod(this.file, 0o600).catch(() => {});
        } finally { await fs.unlink(temporary).catch(() => {}); }
        return { ...result.receipt, replayed: false };
    }
}
