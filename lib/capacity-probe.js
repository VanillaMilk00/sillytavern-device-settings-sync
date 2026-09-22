import { readStorage, totalBytes, StorageError } from './storage-model.js';

export const REFERENCE_CAPACITY_BYTES = 5 * 1024 * 1024;
export const MAX_PROBE_BYTES = 16 * 1024 * 1024;

// Opt-in only: temporarily grows ONE new key. Never clear storage or overwrite
// existing keys. Estimates use our UTF-16 accounting, not browser quota units.
export async function probeCapacity(storage, {
    key = 'sillytavern_settings_sync_probe_' + Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
    maxBytes = MAX_PROBE_BYTES,
    stepChars = 512,
    yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)),
} = {}) {
    const before = readStorage(storage);
    if (before.has(key)) throw new StorageError('probeCollision');
    if (!Number.isFinite(maxBytes) || maxBytes < 2 || !Number.isFinite(stepChars) || stepChars < 1) throw new StorageError('probeUnavailable');
    let ownedValue = null;
    function unchanged() {
        const current = readStorage(storage);
        if (current.has(key)) {
            if (current.get(key) !== ownedValue) throw new StorageError('stalePreview');
            current.delete(key);
        } else if (ownedValue !== null) throw new StorageError('stalePreview');
        if (current.size !== before.size || [...before].some(([k, v]) => current.get(k) !== v)) throw new StorageError('stalePreview');
    }
    function trySize(chars) {
        unchanged();
        const value = 'x'.repeat(chars);
        try {
            storage.setItem(key, value);
            ownedValue = value;
            if (storage.getItem(key) !== value) throw new StorageError('probeUnavailable');
            return true;
        } catch (error) {
            if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') return false;
            throw error;
        }
    }
    function cleanup() {
        if (ownedValue === null) return;
        const current = storage.getItem(key);
        if (current !== null && current !== ownedValue) throw new StorageError('probeCleanupFailed');
        if (current !== null) storage.removeItem(key);
        if (storage.getItem(key) !== null) throw new StorageError('probeCleanupFailed');
    }
    let result;
    let failure;
    try {
        if (!trySize(0)) throw new StorageError('probeUnavailable');
        const cap = Math.max(1, Math.floor(Math.min(maxBytes, MAX_PROBE_BYTES) / 2));
        let low = 0;
        let high = Math.min(64 * 1024, cap);
        let limited = false;
        while (trySize(high)) {
            low = high;
            if (high === cap) { limited = true; break; }
            high = Math.min(high * 2, cap);
            await yieldTask();
        }
        while (!limited && high - low > Math.max(1, stepChars)) {
            const middle = Math.floor((low + high) / 2);
            if (trySize(middle)) low = middle;
            else high = middle;
            await yieldTask();
        }
        unchanged();
        const used = totalBytes(before);
        result = {
            lowerBytes: used + 2 * (key.length + low),
            upperBytes: limited ? null : used + 2 * (key.length + high),
            limited, usedBytes: used, testedAt: new Date().toISOString(),
        };
    } catch (error) {
        failure = error;
    } finally {
        // Do not delete a same-key value changed by another actor during a yield.
        try { cleanup(); }
        catch { failure = new StorageError('probeCleanupFailed', { key }); }
    }
    if (failure) throw failure;
    return result;
}
