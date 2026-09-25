import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isInternalKey, StorageError, inScope, MAX_ARCHIVE_BYTES } from '../lib/storage-model.js';
import { isPortableStorageEntry, matchesAdditionalExclude } from '../lib/filter.js';

const DIRECTORY = 'device-settings-sync-incremental';
const VERSIONS_DIRECTORY = 'device-settings-sync-server-versions';
const MANIFEST = 'manifest.json';
const KEEP_VERSIONS = 5;
const VERSION_WINDOW_MS = 30 * 60 * 1000;
const RECEIPT_LIMIT = 500;
const CHUNK_BYTES = 256 * 1024;
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRANSFER_BYTES = MAX_ARCHIVE_BYTES + 8 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{8,100}$/u;
const encoder = new TextEncoder();
const encodedBytes = value => encoder.encode(value).byteLength;

export const incrementalHash = value => createHash('sha256').update(value, 'utf8').digest('hex');

export function incrementalDelta(before, after) {
    let prefix = 0;
    const limit = Math.min(before.length, after.length);
    while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
    let suffix = 0;
    while (suffix < limit - prefix
        && before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)) suffix++;
    const middle = after.slice(prefix, after.length - suffix);
    const delta = { kind: 'splice', prefix, suffix, middle };
    return encodedBytes(JSON.stringify(delta)) <= encodedBytes(JSON.stringify(after)) * 0.75 ? delta : null;
}

export function applyIncrementalDelta(before, delta) {
    if (!delta || delta.kind !== 'splice' || !Number.isSafeInteger(delta.prefix) || !Number.isSafeInteger(delta.suffix)
        || delta.prefix < 0 || delta.suffix < 0 || delta.prefix + delta.suffix > before.length || typeof delta.middle !== 'string') {
        throw new StorageError('incrementalInvalidDelta');
    }
    return before.slice(0, delta.prefix) + delta.middle + (delta.suffix ? before.slice(before.length - delta.suffix) : '');
}

function initialManifest() {
    return { schema: 1, revision: 0, seeded: false, updatedAt: '', settingsEpoch: 0, settingsDeviceId: '', settingsChangeId: '', entries: Object.create(null), receipts: [], autoBackupRound: null };
}

function normalizeManifest(value) {
    if (!value || value.schema !== 1 || !Number.isSafeInteger(value.revision) || !value.entries || typeof value.entries !== 'object') {
        throw new Error('Invalid incremental synchronization manifest');
    }
    return { ...initialManifest(), ...value, entries: Object.assign(Object.create(null), value.entries), receipts: Array.isArray(value.receipts) ? value.receipts : [] };
}

function validScope(scope) {
    const mode = scope?.mode;
    if (!['portable', 'selected', 'full'].includes(mode)) throw new StorageError('incrementalInvalidRequest');
    const selected = scope.selectedScope;
    if (mode === 'selected' && !(selected && ((selected.kind === 'prefix' && typeof selected.prefix === 'string' && selected.prefix.length)
        || (selected.kind === 'keys' && Array.isArray(selected.keys) && selected.keys.every(key => typeof key === 'string'))))) {
        throw new StorageError('incrementalInvalidRequest');
    }
    return { mode, selectedScope: mode === 'selected' ? selected : null,
        maxValueBytes: Math.max(1024, Math.min(256 * 1024, Number(scope.maxValueBytes) || 128 * 1024)),
        additionalExcludes: Array.isArray(scope.additionalExcludes) ? scope.additionalExcludes.slice(0, 100).map(String) : [] };
}

function allowed(key, value, scope) {
    if (isInternalKey(key) || key.length > 512 || !key) return false;
    if (scope.mode === 'full') return true;
    if (scope.mode === 'selected') return inScope(key, scope.selectedScope);
    return isPortableStorageEntry(key, value ?? '', { maxValueBytes: scope.maxValueBytes })
        && !matchesAdditionalExclude(key, scope.additionalExcludes);
}

function validateMutation(raw, current, scope) {
    if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || !raw.key || raw.key.length > 512) {
        throw new StorageError('incrementalInvalidRequest');
    }
    const key = raw.key;
    const previous = current.entries[key];
    const currentHash = previous && !previous.deleted ? previous.hash : null;
    if ((raw.beforeHash ?? null) !== currentHash) throw new StorageError('incrementalKeyConflict');
    if (raw.deleted === true) {
        if (!allowed(key, current.values.get(key) ?? '', scope)) throw new StorageError('incrementalScopeViolation');
        if (raw.afterHash !== null) throw new StorageError('incrementalInvalidRequest');
        return { key, deleted: true, hash: null };
    }
    let value;
    if (typeof raw.value === 'string') value = raw.value;
    else if (raw.delta) {
        if (!previous || previous.deleted || typeof previous.hash !== 'string') throw new StorageError('incrementalInvalidDelta');
        const oldValue = current.values.get(key);
        if (typeof oldValue !== 'string') throw new StorageError('incrementalInvalidDelta');
        value = applyIncrementalDelta(oldValue, raw.delta);
    } else throw new StorageError('incrementalInvalidRequest');
    if (!allowed(key, value, scope)) throw new StorageError('incrementalScopeViolation');
    if (raw.afterHash !== incrementalHash(value)) throw new StorageError('incrementalDigestMismatch');
    if (scope.mode !== 'full' && encoder.encode(value).byteLength > scope.maxValueBytes && scope.mode !== 'selected') {
        throw new StorageError('incrementalValueTooLarge');
    }
    return { key, value, deleted: false, hash: raw.afterHash };
}

export class IncrementalStateStore {
    constructor(root, stream = 'portable') {
        if (!['portable', 'full'].includes(stream)) throw new StorageError('incrementalInvalidRequest');
        this.root = root;
        this.stream = stream;
        this.directory = path.join(root, DIRECTORY, stream);
        this.valuesDirectory = path.join(this.directory, 'values');
        this.manifestPath = path.join(this.directory, MANIFEST);
        this.versionsDirectory = path.join(root, VERSIONS_DIRECTORY, stream);
        this.versionsIndexPath = path.join(this.versionsDirectory, 'index.json');
        this.transferDirectory = path.join(this.directory, 'transfers');
    }

    async atomicWrite(file, data) {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
        try {
            await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, file);
            await fs.chmod(file, 0o600).catch(() => {});
        } finally { await fs.unlink(temporary).catch(() => {}); }
    }

    async loadLegacy() {
        const file = path.join(this.root, this.stream === 'full' ? 'device-settings-sync-full.json' : 'device-settings-sync.json');
        try {
            const stat = await fs.stat(file);
            if (stat.size > (this.stream === 'portable' ? 5 * 1024 * 1024 : MAX_ARCHIVE_BYTES)) throw new StorageError('archiveTooLarge');
            const value = JSON.parse(await fs.readFile(file, 'utf8'));
            if (value?.schema !== 1 || !value.entries || typeof value.entries !== 'object') return initialManifest();
            const manifest = initialManifest();
            manifest.revision = Number(value.revision) || 0;
            manifest.seeded = Boolean(value.seeded);
            manifest.updatedAt = String(value.updatedAt || '');
            manifest.settingsEpoch = Number(value.settingsEpoch) || 0;
            manifest.settingsDeviceId = String(value.settingsDeviceId || '');
            manifest.settingsChangeId = String(value.settingsChangeId || '');
            manifest.receipts = (Array.isArray(value.autoCommits) ? value.autoCommits : Array.isArray(value.receipts) ? value.receipts : []).slice(-RECEIPT_LIMIT);
            for (const [key, entry] of Object.entries(value.entries)) {
                if (this.stream === 'portable' && entry?.deleted) manifest.entries[key] = { deleted: true, hash: null, revision: Number(entry.revision) || 0, updatedAt: String(entry.updatedAt || ''), deviceId: String(entry.deviceId || '') };
                else {
                    const raw = this.stream === 'full' ? entry : entry?.value;
                    if (typeof raw !== 'string') continue;
                    const hash = incrementalHash(raw);
                    await this.writeValue(hash, raw);
                    manifest.entries[key] = { deleted: false, hash, bytes: Buffer.byteLength(JSON.stringify([key, raw]), 'utf8'), revision: Number(entry?.revision) || manifest.revision,
                        updatedAt: String(entry?.updatedAt || value.updatedAt || ''), deviceId: String(entry?.deviceId || '') };
                }
            }
            await this.writeManifest(manifest);
            return manifest;
        } catch (error) { if (error.code === 'ENOENT') return initialManifest(); throw error; }
    }

    async readManifest() {
        try {
            const text = await fs.readFile(this.manifestPath, 'utf8');
            if (Buffer.byteLength(text) > MAX_ARCHIVE_BYTES) throw new StorageError('archiveTooLarge');
            return normalizeManifest(JSON.parse(text));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return this.loadLegacy();
        }
    }

    async writeValue(hash, value) {
        const file = path.join(this.valuesDirectory, hash + '.txt');
        try { await fs.access(file); }
        catch { await this.atomicWrite(file, value); }
    }

    async readValue(hash) {
        try { return await fs.readFile(path.join(this.valuesDirectory, hash + '.txt'), 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') throw new Error('Incremental value content is missing'); throw error; }
    }

    async writeManifest(manifest) {
        const text = JSON.stringify(manifest);
        if (Buffer.byteLength(text) > MAX_ARCHIVE_BYTES) throw new StorageError('archiveTooLarge');
        await this.atomicWrite(this.manifestPath, text);
    }

    async read() {
        const manifest = await this.readManifest();
        const entries = Object.create(null);
        for (const [key, item] of Object.entries(manifest.entries)) {
            entries[key] = item.deleted ? { deleted: true, revision: item.revision, updatedAt: item.updatedAt, deviceId: item.deviceId }
                : { value: await this.readValue(item.hash), deleted: false, revision: item.revision, updatedAt: item.updatedAt, deviceId: item.deviceId };
        }
        return { schema: 1, seeded: manifest.seeded, revision: manifest.revision, settingsEpoch: manifest.settingsEpoch,
            settingsDeviceId: manifest.settingsDeviceId, settingsChangeId: manifest.settingsChangeId,
            updatedAt: manifest.updatedAt, entries, autoCommits: manifest.receipts };
    }

    async writeLegacyState(state) {
        const manifest = await this.readManifest();
        const entries = Object.create(null);
        for (const [key, item] of Object.entries(state.entries || {})) {
            if (item.deleted) entries[key] = { deleted: true, hash: null, revision: item.revision, updatedAt: item.updatedAt, deviceId: item.deviceId };
            else {
                const hash = incrementalHash(item.value);
                await this.writeValue(hash, item.value);
                    entries[key] = { deleted: false, hash, bytes: Buffer.byteLength(JSON.stringify([key, item.value]), 'utf8'), revision: item.revision, updatedAt: item.updatedAt, deviceId: item.deviceId };
            }
        }
        const normalizedHashes = source => Object.entries(source).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([key, item]) => [key, item.deleted ? null : item.hash]);
        const dataChanged = JSON.stringify(normalizedHashes(manifest.entries)) !== JSON.stringify(normalizedHashes(entries));
        const manualVersion = dataChanged && manifest.revision > 0 ? await this.createVersion(manifest, {
            deviceId: 'manual', mode: this.stream, scope: { mode: this.stream },
        }, new Date(), true) : null;
        const next = { ...manifest, revision: state.revision, seeded: state.seeded, updatedAt: state.updatedAt,
            settingsEpoch: state.settingsEpoch, settingsDeviceId: state.settingsDeviceId, settingsChangeId: state.settingsChangeId,
            receipts: Array.isArray(state.autoCommits) ? state.autoCommits.slice(-RECEIPT_LIMIT) : manifest.receipts, entries,
            autoBackupRound: null };
        if (manualVersion) await this.publishServerVersion(manualVersion.record, { prune: false });
        await this.writeManifest(next);
        if (manualVersion) await this.pruneServerVersions();
        return next;
    }

    async metadata() {
        const manifest = await this.readManifest();
        return { schema: 1, revision: manifest.revision, seeded: manifest.seeded, updatedAt: manifest.updatedAt,
            entries: Object.fromEntries(Object.entries(manifest.entries).map(([key, item]) => [key, { hash: item.deleted ? null : item.hash, deleted: item.deleted === true }])) };
    }

    async snapshot() {
        const state = await this.read();
        delete state.autoCommits;
        return state;
    }

    async commit(input, { now = new Date(), automatic = true, allowAllScope = false, forceVersion = false, digestOverride = '' } = {}) {
        if (!input || !ID.test(input.operationId || '') || !ID.test(input.deviceId || '') || !Number.isSafeInteger(input.expectedRevision)
            || input.expectedRevision < 0 || (this.stream === 'portable' ? input.mode !== 'portable' : !['selected', 'full'].includes(input.mode))
            || !Array.isArray(input.mutations) || input.mutations.length > 50000) throw new StorageError('incrementalInvalidRequest');
        const scope = validScope(input.scope);
        if (!allowAllScope && scope.mode !== input.mode) throw new StorageError('incrementalScopeViolation');
        const manifest = await this.readManifest();
        const digest = digestOverride || incrementalHash(JSON.stringify({ deviceId: input.deviceId, expectedRevision: input.expectedRevision,
            scope: input.scope, mode: input.mode, mutations: input.mutations }));
        const prior = manifest.receipts.find(receipt => receipt.operationId === input.operationId);
        if (prior) {
            if (prior.digest !== digest) throw new StorageError('incrementalCommitConflict');
            return { ...prior, replayed: true };
        }
        if (manifest.revision !== input.expectedRevision) throw new StorageError('incrementalRevisionConflict');
        const mode = input.mode || scope.mode;
        const values = new Map();
        const validated = [];
        const seenKeys = new Set();
        for (const raw of input.mutations) {
            if (seenKeys.has(raw?.key)) throw new StorageError('incrementalInvalidRequest');
            seenKeys.add(raw?.key);
            const previous = manifest.entries[raw?.key];
            const current = previous && !previous.deleted ? await this.readValue(previous.hash) : undefined;
            if (typeof current === 'string') values.set(raw.key, current);
            validated.push(validateMutation(raw, { entries: manifest.entries, values }, scope));
        }
        const nextEntries = Object.assign(Object.create(null), manifest.entries);
        const revision = manifest.revision + 1;
        const timestamp = now.toISOString();
        let currentTotal = Object.values(manifest.entries).reduce((sum, item) => sum + (item.deleted ? 0 : Number(item.bytes) || 0), 0);
        for (const item of validated) {
            const old = nextEntries[item.key];
            if (old && !old.deleted) currentTotal -= Number(old.bytes) || 0;
            if (item.deleted) nextEntries[item.key] = { deleted: true, hash: null, bytes: 0, revision, updatedAt: timestamp, deviceId: input.deviceId };
            else {
                const bytes = Buffer.byteLength(JSON.stringify([item.key, item.value]), 'utf8');
                currentTotal += bytes;
                await this.writeValue(item.hash, item.value);
                nextEntries[item.key] = { deleted: false, hash: item.hash, bytes, revision, updatedAt: timestamp, deviceId: input.deviceId };
            }
        }
        const byteLimit = mode === 'full' || mode === 'selected' ? MAX_ARCHIVE_BYTES : 5 * 1024 * 1024;
        if (currentTotal > byteLimit) throw new StorageError('incrementalStateTooLarge');
        const receipt = { operationId: input.operationId, digest, revision, createdAt: timestamp };
        const backup = automatic && validated.length ? await this.prepareServerVersion(manifest, input, now)
            : forceVersion && validated.length ? await this.createVersion(manifest, input, now, true) : null;
        const next = { ...manifest, schema: 1, revision, seeded: true, updatedAt: timestamp, entries: nextEntries,
            receipts: [...manifest.receipts, receipt].slice(-RECEIPT_LIMIT),
            autoBackupRound: automatic ? backup?.round || manifest.autoBackupRound : null };
        if (backup?.publish) await this.publishServerVersion(backup.record, { prune: false });
        await this.writeManifest(next);
        if (backup?.publish) await this.pruneServerVersions();
        return { ...receipt, replayed: false };
    }

    async readVersionsIndex() {
        try {
            const data = JSON.parse(await fs.readFile(this.versionsIndexPath, 'utf8'));
            return { records: Array.isArray(data.records) ? data.records : [] };
        } catch (error) { if (error.code === 'ENOENT') return { records: [] }; throw error; }
    }

    async prepareServerVersion(manifest, input, now) {
        const previousRecord = (await this.readVersionsIndex()).records.find(item => item.operationId === input.operationId);
        if (previousRecord) return { round: { id: previousRecord.id, deviceId: input.deviceId, mode: previousRecord.mode,
            scopeSignature: JSON.stringify(input.scope || {}), startedAt: previousRecord.createdAt }, publish: false };
        const previous = manifest.autoBackupRound;
        const scopeSignature = JSON.stringify(input.scope || {});
        const sameRound = previous && previous.deviceId === input.deviceId && previous.mode === (input.mode || input.scope?.mode)
            && previous.scopeSignature === scopeSignature
            && now.getTime() - Date.parse(previous.startedAt) < VERSION_WINDOW_MS;
        if (sameRound) return { round: previous, publish: false };
        return this.createVersion(manifest, input, now, false);
    }

    async createVersion(manifest, input, now, forceNew) {
        const id = randomUUID();
        const record = { id, operationId: input.operationId || '', createdAt: now.toISOString(), source: { deviceId: input.deviceId }, mode: input.mode || input.scope?.mode || 'portable',
            revision: manifest.revision, keys: Object.values(manifest.entries).filter(item => !item.deleted).length };
        await this.atomicWrite(path.join(this.versionsDirectory, id + '.json'), JSON.stringify(manifest));
        const round = { id, deviceId: input.deviceId, mode: record.mode, scopeSignature: JSON.stringify(input.scope || {}), startedAt: record.createdAt };
        if (forceNew) return { round: null, publish: true, record };
        return { round, publish: true, record };
    }

    async commitFullSnapshot(input) {
        if (this.stream !== 'full' || !input || !ID.test(input.operationId || '') || !ID.test(input.deviceId || '')
            || !Number.isSafeInteger(input.expectedRevision) || !Array.isArray(input.entries)) throw new StorageError('invalidCommit');
        const scope = input.scope ?? { kind: 'full' };
        if (!(scope.kind === 'full' || (scope.kind === 'prefix' && typeof scope.prefix === 'string' && scope.prefix.length)
            || (scope.kind === 'keys' && Array.isArray(scope.keys) && scope.keys.every(key => typeof key === 'string')))) throw new StorageError('invalidCommit');
        const targetScope = scope.kind === 'full' ? { mode: 'full' }
            : scope.kind === 'prefix' ? { mode: 'selected', selectedScope: { kind: 'prefix', prefix: scope.prefix } }
                : { mode: 'selected', selectedScope: { kind: 'keys', keys: [...new Set(scope.keys)] } };
        const digest = incrementalHash(JSON.stringify({ deviceId: input.deviceId, expectedRevision: input.expectedRevision,
            scope, entries: input.entries }));
        const manifest = await this.readManifest();
        const previous = manifest.receipts.find(item => item.operationId === input.operationId);
        if (previous) {
            if (previous.digest !== digest) throw new StorageError('incrementalCommitConflict');
            return { ...previous, replayed: true };
        }
        if (manifest.revision !== input.expectedRevision) throw new StorageError('incrementalRevisionConflict');
        const incoming = new Map();
        for (const item of input.entries) {
            if (!item || typeof item.key !== 'string' || typeof item.value !== 'string' || isInternalKey(item.key)
                || !inScope(item.key, scope) || incoming.has(item.key)) throw new StorageError('invalidCommit');
            incoming.set(item.key, item.value);
        }
        const mutations = [];
        for (const [key, current] of Object.entries(manifest.entries)) {
            if (!inScope(key, scope) || current.deleted) continue;
            const value = await this.readValue(current.hash);
            if (!incoming.has(key)) mutations.push({ key, beforeHash: current.hash, afterHash: null, deleted: true });
            else if (incoming.get(key) !== value) mutations.push({ key, beforeHash: current.hash,
                afterHash: incrementalHash(incoming.get(key)), value: incoming.get(key) });
        }
        for (const [key, value] of incoming) if (!manifest.entries[key] || manifest.entries[key].deleted) {
            mutations.push({ key, beforeHash: null, afterHash: incrementalHash(value), value });
        }
        return this.commit({ operationId: input.operationId, deviceId: input.deviceId, expectedRevision: input.expectedRevision,
            mode: scope.kind === 'full' ? 'full' : 'selected', scope: targetScope, mutations },
        { automatic: false, forceVersion: mutations.length > 0, allowAllScope: true, digestOverride: digest });
    }

    async publishServerVersion(record, { prune = true } = {}) {
        const index = await this.readVersionsIndex();
        const records = [record, ...index.records.filter(item => item.id !== record.id)];
        await this.atomicWrite(this.versionsIndexPath, JSON.stringify({ records }));
        if (prune) await this.pruneServerVersions();
    }

    async pruneServerVersions() {
        const index = await this.readVersionsIndex();
        const keep = index.records.slice(0, KEEP_VERSIONS);
        await this.atomicWrite(this.versionsIndexPath, JSON.stringify({ records: keep }));
        for (const old of index.records.slice(KEEP_VERSIONS)) await fs.unlink(path.join(this.versionsDirectory, old.id + '.json')).catch(() => {});
    }

    async listVersions() { return (await this.readVersionsIndex()).records; }

    async getVersion(id) {
        if (!/^[0-9a-f-]{36}$/iu.test(id || '')) throw new StorageError('incrementalVersionNotFound');
        try {
            const manifest = normalizeManifest(JSON.parse(await fs.readFile(path.join(this.versionsDirectory, id + '.json'), 'utf8')));
            const entries = [];
            for (const [key, item] of Object.entries(manifest.entries)) if (!item.deleted) entries.push({ key, value: await this.readValue(item.hash) });
            const record = (await this.readVersionsIndex()).records.find(item => item.id === id);
            return { format: 'sillytavern-localstorage-backup', version: 1, createdAt: record?.createdAt || '',
                source: record?.source || { deviceId: '' }, scope: { kind: 'full' }, entries, revision: manifest.revision };
        } catch (error) { if (error.code === 'ENOENT') throw new StorageError('incrementalVersionNotFound'); throw error; }
    }

    async restoreVersion(id, expectedRevision, deviceId) {
        const current = await this.readManifest();
        if (current.revision !== expectedRevision) throw new StorageError('incrementalRevisionConflict');
        const archive = await this.getVersion(id);
        const values = Object.fromEntries(archive.entries.map(({ key, value }) => [key, value]));
        const mutations = [];
        const desired = new Map(archive.entries.map(({ key, value }) => [key, value]));
        for (const [key, item] of Object.entries(current.entries)) {
            const oldValue = item.deleted ? undefined : await this.readValue(item.hash);
            if (desired.has(key)) {
                const value = desired.get(key);
                if (value !== oldValue) mutations.push({ key, beforeHash: item.deleted ? null : item.hash, afterHash: incrementalHash(value), value });
                desired.delete(key);
            } else if (!item.deleted) mutations.push({ key, beforeHash: item.hash, afterHash: null, deleted: true });
        }
        for (const [key, value] of desired) mutations.push({ key, beforeHash: null, afterHash: incrementalHash(value), value });
        return this.commit({ operationId: 'restore_' + randomUUID().replaceAll('-', '_'), deviceId, expectedRevision,
            mode: this.stream, scope: { mode: 'full' }, mutations }, { automatic: false, allowAllScope: true, forceVersion: true });
    }

    async startTransfer(input) {
        if (!input || !ID.test(input.operationId || '') || !Number.isSafeInteger(input.expectedRevision)
            || !Number.isSafeInteger(input.chunks) || input.chunks < 1 || input.chunks > 4096
            || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_TRANSFER_BYTES) throw new StorageError('incrementalInvalidTransfer');
        if (this.stream === 'portable' ? input.mode !== 'portable' : !['selected', 'full'].includes(input.mode)) {
            throw new StorageError('incrementalInvalidTransfer');
        }
        await this.pruneExpiredTransfers();
        const id = input.operationId;
        const directory = path.join(this.transferDirectory, id);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const metadata = { ...input, updatedAt: Date.now() };
        const metaFile = path.join(directory, 'meta.json');
        try {
            const existing = JSON.parse(await fs.readFile(metaFile, 'utf8'));
            if (existing.digest !== input.digest || existing.bytes !== input.bytes || existing.chunks !== input.chunks
                || existing.expectedRevision !== input.expectedRevision || existing.mode !== input.mode || existing.account !== input.account) {
                throw new StorageError('incrementalTransferConflict');
            }
            existing.updatedAt = Date.now();
            await this.atomicWrite(metaFile, JSON.stringify(existing));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await this.atomicWrite(metaFile, JSON.stringify(metadata));
        }
        return { id, chunkBytes: CHUNK_BYTES, expiresAt: Date.now() + TRANSFER_TTL_MS };
    }

    async putTransferChunk(id, index, body) {
        if (!ID.test(id || '') || !Number.isSafeInteger(index) || typeof body?.data !== 'string') throw new StorageError('incrementalInvalidTransfer');
        const directory = path.join(this.transferDirectory, id);
        const metadata = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'));
        if (Date.now() - metadata.updatedAt > TRANSFER_TTL_MS || index < 0 || index >= metadata.chunks) throw new StorageError('incrementalTransferNotFound');
        const chunk = Buffer.from(body.data, 'base64');
        if (chunk.length > CHUNK_BYTES || (body.digest && createHash('sha256').update(chunk).digest('hex') !== body.digest)) throw new StorageError('incrementalInvalidTransfer');
        const file = path.join(directory, `${index}.chunk`);
        try {
            const previous = await fs.readFile(file);
            if (!previous.equals(chunk)) throw new StorageError('incrementalTransferConflict');
        } catch (error) { if (error.code === 'ENOENT') await this.atomicWrite(file, chunk); else throw error; }
        metadata.updatedAt = Date.now();
        await this.atomicWrite(path.join(directory, 'meta.json'), JSON.stringify(metadata));
        return { index, received: true };
    }

    async finishTransfer(id, account) {
        if (!ID.test(id || '')) throw new StorageError('incrementalTransferNotFound');
        const directory = path.join(this.transferDirectory, id);
        const metadata = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'));
        const chunks = [];
        for (let index = 0; index < metadata.chunks; index++) {
            try { chunks.push(await fs.readFile(path.join(directory, `${index}.chunk`))); }
            catch (error) { if (error.code === 'ENOENT') throw new StorageError('incrementalTransferIncomplete'); throw error; }
        }
        const payload = Buffer.concat(chunks);
        if (payload.length !== metadata.bytes || incrementalHash(payload.toString('utf8')) !== metadata.digest) throw new StorageError('incrementalDigestMismatch');
        const input = JSON.parse(payload.toString('utf8'));
        if (input.operationId !== metadata.operationId || input.expectedRevision !== metadata.expectedRevision
            || input.mode !== metadata.mode) throw new StorageError('incrementalInvalidTransfer');
        if (metadata.account !== account || input.account !== account) throw new StorageError('incrementalAccountMismatch');
        const result = await this.commit(input, { automatic: input.automatic !== false });
        await fs.rm(directory, { recursive: true, force: true });
        return result;
    }

    async pruneExpiredTransfers() {
        let children;
        try { children = await fs.readdir(this.transferDirectory, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        const cutoff = Date.now() - TRANSFER_TTL_MS;
        for (const child of children) {
            if (!child.isDirectory() || !ID.test(child.name)) continue;
            const directory = path.join(this.transferDirectory, child.name);
            try {
                const metadata = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'));
                if (!Number.isFinite(metadata.updatedAt) || metadata.updatedAt < cutoff) await fs.rm(directory, { recursive: true, force: true });
            } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) await fs.rm(directory, { recursive: true, force: true }); else throw error; }
        }
    }
}
