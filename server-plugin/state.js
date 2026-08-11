export const STATE_SCHEMA = 1;
export const MAX_VALUE_BYTES = 256 * 1024;
export const MAX_STATE_BYTES = 5 * 1024 * 1024;
export const MAX_MUTATIONS = 1000;

const encoder = new TextEncoder();

export function createInitialState() {
    return {
        schema: STATE_SCHEMA,
        seeded: false,
        revision: 0,
        settingsEpoch: 0,
        settingsDeviceId: '',
        settingsChangeId: '',
        updatedAt: '',
        entries: {},
    };
}

export function normalizeState(value) {
    const initial = createInitialState();
    if (!value || typeof value !== 'object' || value.schema !== STATE_SCHEMA) return initial;
    return {
        ...initial,
        ...value,
        revision: Math.max(0, Number(value.revision) || 0),
        settingsEpoch: Math.max(0, Number(value.settingsEpoch) || 0),
        entries: value.entries && typeof value.entries === 'object' ? value.entries : {},
    };
}

function validDeviceId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/u.test(value);
}

function normalizeMutation(mutation) {
    if (!mutation || typeof mutation !== 'object') throw new TypeError('Invalid mutation');
    const key = String(mutation.key ?? '');
    if (!key || key.length > 512) throw new TypeError('Invalid storage key');
    if (mutation.deleted) return { key, deleted: true };
    if (typeof mutation.value !== 'string') throw new TypeError('Mutation value must be a string');
    if (encoder.encode(mutation.value).byteLength > MAX_VALUE_BYTES) throw new RangeError('Mutation value is too large');
    return { key, value: mutation.value, deleted: false };
}

export function mergeMutations(current, request, now = new Date().toISOString()) {
    const state = normalizeState(structuredClone(current));
    const deviceId = request?.deviceId;
    if (!validDeviceId(deviceId)) throw new TypeError('Invalid device ID');
    const mutations = Array.isArray(request?.mutations) ? request.mutations : [];
    if (mutations.length > MAX_MUTATIONS) throw new RangeError('Too many mutations');

    if (request?.seed === true && !state.seeded) {
        state.seeded = true;
        state.revision += 1;
        state.updatedAt = now;
    }

    for (const rawMutation of mutations) {
        const mutation = normalizeMutation(rawMutation);
        state.revision += 1;
        state.entries[mutation.key] = {
            ...(mutation.deleted ? { deleted: true } : { value: mutation.value, deleted: false }),
            revision: state.revision,
            updatedAt: now,
            deviceId,
        };
    }
    if (mutations.length) state.updatedAt = now;
    if (encoder.encode(JSON.stringify(state)).byteLength > MAX_STATE_BYTES) {
        throw new RangeError('Synchronized settings exceed the server limit');
    }
    return state;
}

export function touchSettings(current, request, now = new Date().toISOString()) {
    const state = normalizeState(structuredClone(current));
    const deviceId = request?.deviceId;
    const changeId = request?.changeId;
    if (!validDeviceId(deviceId)) throw new TypeError('Invalid device ID');
    if (typeof changeId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/u.test(changeId)) {
        throw new TypeError('Invalid change ID');
    }
    if (state.settingsDeviceId === deviceId && state.settingsChangeId === changeId) return state;
    state.revision += 1;
    state.settingsEpoch = state.revision;
    state.settingsDeviceId = deviceId;
    state.settingsChangeId = changeId;
    state.updatedAt = now;
    return state;
}
