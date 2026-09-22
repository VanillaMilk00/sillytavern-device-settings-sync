import { createHash } from 'node:crypto';
import { mergeMutations, normalizeState, MAX_MUTATIONS, MAX_STATE_BYTES } from './state.js';
import { StorageError, isInternalKey } from '../lib/storage-model.js';

const ID = /^[a-zA-Z0-9_-]{8,100}$/u;

export function findCommit(current, id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new StorageError('invalidCommit');
    return (current.autoCommits || []).find(item => item.operationId === id) || null;
}

// Called inside the same account queue as /merge. The state AND receipt are
// published in one atomic file replacement, so lost responses are recoverable.
export function commitMutations(current, input, now = new Date().toISOString()) {
    if (!input || typeof input.operationId !== 'string' || !ID.test(input.operationId) || !Number.isSafeInteger(input.expectedRevision)
        || input.expectedRevision < 0 || !Array.isArray(input.mutations) || input.mutations.length > 50000
        || input.mutations.some(item => !item || isInternalKey(item.key))) throw new StorageError('invalidCommit');
    const digest = createHash('sha256').update(JSON.stringify({
        deviceId: input.deviceId, expectedRevision: input.expectedRevision, mutations: input.mutations,
    })).digest('hex');
    const existing = findCommit(current, input.operationId);
    if (existing) {
        if (existing.digest !== digest) throw new StorageError('commitConflict');
        return { state: current, receipt: existing, replayed: true };
    }
    let state = normalizeState(current);
    if (state.revision !== input.expectedRevision) throw new StorageError('autoConflict');
    // Validate all chunks in memory; never expose a partially committed upload.
    for (let i = 0; i < Math.max(1, input.mutations.length); i += MAX_MUTATIONS) {
        state = mergeMutations(state, { deviceId: input.deviceId, seed: true, mutations: input.mutations.slice(i, i + MAX_MUTATIONS) }, now);
    }
    const receipt = { operationId: input.operationId, digest, revision: state.revision, createdAt: now };
    state.autoCommits = [...(state.autoCommits || []), receipt];
    if (Buffer.byteLength(JSON.stringify(state, null, 2) + '\n', 'utf8') > MAX_STATE_BYTES) throw new RangeError('Synchronized settings exceed the server limit');
    return { state, receipt, replayed: false };
}
