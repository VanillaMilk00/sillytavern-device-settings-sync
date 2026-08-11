import { classifyStorageEntry } from './filter.js';

export function snapshotPortableStorage(storage, options = {}) {
    const values = new Map();
    const excluded = new Map();
    for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === null) continue;
        const value = storage.getItem(key);
        if (value === null) continue;
        const classification = classifyStorageEntry(key, value, options);
        if (classification.portable) values.set(key, value);
        else excluded.set(key, classification.reason);
    }
    return { values, excluded };
}

export function diffSnapshots(previous, current) {
    const mutations = [];
    for (const [key, value] of current) {
        if (!previous.has(key) || previous.get(key) !== value) {
            mutations.push({ key, value, deleted: false });
        }
    }
    for (const key of previous.keys()) {
        if (!current.has(key)) mutations.push({ key, deleted: true });
    }
    return mutations;
}

export function serverStateToPortableValues(state, options = {}) {
    const values = new Map();
    const entries = state?.entries && typeof state.entries === 'object' ? state.entries : {};
    for (const [key, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== 'object' || entry.deleted || typeof entry.value !== 'string') continue;
        if (classifyStorageEntry(key, entry.value, options).portable) values.set(key, entry.value);
    }
    return values;
}

export function applyServerState(storage, state, options = {}) {
    let changed = 0;
    let skipped = 0;
    let failed = 0;
    const entries = state?.entries && typeof state.entries === 'object' ? state.entries : {};

    for (const [key, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== 'object') {
            skipped += 1;
            continue;
        }
        if (entry.deleted) {
            const currentValue = storage.getItem(key);
            if (currentValue !== null && classifyStorageEntry(key, currentValue, options).portable) {
                storage.removeItem(key);
                changed += 1;
            } else if (currentValue !== null) {
                skipped += 1;
            }
            continue;
        }
        const value = typeof entry.value === 'string' ? entry.value : null;
        if (value === null || !classifyStorageEntry(key, value, options).portable) {
            skipped += 1;
            continue;
        }
        if (storage.getItem(key) !== value) {
            try {
                storage.setItem(key, value);
                changed += 1;
            } catch {
                failed += 1;
            }
        }
    }
    return { changed, skipped, failed };
}
