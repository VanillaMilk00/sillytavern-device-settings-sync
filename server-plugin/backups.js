import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArchive, serializeArchive, totalBytes, StorageError, MAX_ARCHIVE_BYTES } from '../lib/storage-model.js';

const KEEP = 5;
const ID = /^[a-zA-Z0-9_-]{8,80}$/u;
const queues = new Map();

function serial(root, work) {
    const next = (queues.get(root) || Promise.resolve()).catch(() => {}).then(work);
    const tracked = next.finally(() => { if (queues.get(root) === tracked) queues.delete(root); });
    queues.set(root, tracked);
    return tracked;
}

export class BackupStore {
    constructor(root) {
        this.root = path.join(root, 'device-settings-sync-backups');
        this.indexPath = path.join(this.root, 'index.json');
    }

    async index() {
        try {
            const input = JSON.parse(await fs.readFile(this.indexPath, 'utf8'));
            const state = Array.isArray(input) ? {
                records: input,
                operations: input.map(({ id, operationId, digest }) => ({ id, operationId, digest })),
            } : input;
            if (!state || !Array.isArray(state.records) || state.records.length > KEEP
                || state.records.some(record => !record || !ID.test(record.id))
                || !Array.isArray(state.operations) || state.operations.some(operation => !operation
                    || !ID.test(operation.id) || !ID.test(operation.operationId) || !/^[a-f0-9]{64}$/u.test(operation.digest))) {
                throw new Error('Invalid backup index');
            }
            return state;
        } catch (error) {
            if (error.code === 'ENOENT') return { records: [], operations: [] };
            throw error;
        }
    }

    async atomicWrite(file, text) {
        const temporary = path.join(this.root, '.' + randomUUID() + '.tmp');
        try {
            await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, file);
            await fs.chmod(file, 0o600).catch(() => {});
        } finally {
            await fs.unlink(temporary).catch(() => {});
        }
    }

    list() {
        return serial(this.root, async () => (await this.index()).records.map(({ digest, ...metadata }) => metadata));
    }

    get(id) {
        if (!ID.test(id)) throw new StorageError('backupNotFound');
        return serial(this.root, async () => {
            if (!(await this.index()).records.some(item => item.id === id)) throw new StorageError('backupNotFound');
            const file = path.join(this.root, id + '.json');
            if ((await fs.stat(file)).size > MAX_ARCHIVE_BYTES) throw new StorageError('archiveTooLarge');
            return parseArchive(await fs.readFile(file, 'utf8'));
        });
    }

    create(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StorageError('invalidArchive');
        const { operationId, reason, archive } = input;
        if (typeof operationId !== 'string' || !ID.test(operationId)
            || !['upload', 'download', 'import', 'restore', 'delete'].includes(reason)) throw new StorageError('invalidArchive');
        const normalized = parseArchive(serializeArchive(archive));
        if (normalized.scope.kind !== 'full') throw new StorageError('invalidArchive');
        const text = serializeArchive(normalized);
        const digest = createHash('sha256').update(reason).update(text).digest('hex');
        return serial(this.root, async () => {
            const { records, operations } = await this.index();
            const existing = operations.find(item => item.operationId === operationId);
            if (existing) {
                if (existing.digest !== digest) throw new StorageError('backupConflict');
                const retained = records.find(item => item.id === existing.id);
                if (!retained) return { id: existing.id, operationId, deduplicated: true, retained: false };
                const { digest: _, ...metadata } = retained;
                return metadata;
            }
            await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
            const record = {
                id: randomUUID(), operationId, reason, digest,
                createdAt: new Date().toISOString(), source: normalized.source,
                keys: normalized.entries.length,
                bytes: totalBytes(new Map(normalized.entries.map(entry => [entry.key, entry.value]))),
                fileBytes: Buffer.byteLength(text),
            };
            const file = path.join(this.root, record.id + '.json');
            await this.atomicWrite(file, text);
            try {
                // Publish the idempotency receipt in the same atomic commit as the slots.
                // Receipts contain no storage values and survive eviction/restart so a
                // delayed retry cannot displace another device's newer rescue backup.
                await this.atomicWrite(this.indexPath, JSON.stringify({
                    records: [record, ...records].slice(0, KEEP),
                    operations: [...operations, { id: record.id, operationId, digest }],
                }));
            } catch (error) {
                await fs.unlink(file).catch(() => {});
                throw error;
            }
            // Only prune after publishing the new index, never before the new snapshot is durable.
            for (const old of records.slice(KEEP - 1)) {
                await fs.unlink(path.join(this.root, old.id + '.json')).catch(() => {});
            }
            const { digest: _, ...metadata } = record;
            return metadata;
        });
    }
}
