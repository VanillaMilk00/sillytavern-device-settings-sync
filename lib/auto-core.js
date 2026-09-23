import { classifyStorageEntry } from './filter.js';
import { isInternalKey } from './storage-model.js';

export const IDLE_MS = 15 * 60 * 1000;
export const RETRY_MS = [60000, 300000, 900000];
export const AUTO_PREFIX = 'sillytavern_settings_sync_auto_';

export function sortedEntries(values) {
    return [...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

export async function fingerprint(values, crypto = globalThis.crypto) {
    const data = new TextEncoder().encode(JSON.stringify(sortedEntries(values)));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function decideSync(direction, baseline, localHash, remoteHash, seeded) {
    if (localHash === remoteHash) return 'equal';
    if (!seeded) return direction === 'download' ? 'empty' : baseline ? 'upload' : 'conflict';
    if (!baseline) return 'conflict';
    const localChanged = localHash !== baseline.localHash;
    const remoteChanged = remoteHash !== baseline.remoteHash;
    if (direction === 'upload') {
        if (remoteChanged) return 'conflict';
        return localChanged ? 'upload' : 'unchanged';
    }
    if (remoteChanged && localChanged) return 'conflict';
    return remoteChanged ? 'download' : 'unchanged';
}

export function planRemote(before, state, options = {}) {
    const changes = [];
    if (options.fullStorage && state.seeded) {
        for (const [key, value] of before) {
            if (!isInternalKey(key) && !Object.hasOwn(state.entries || {}, key)) changes.push({ key, before: value, after: null });
        }
    }
    for (const [key, entry] of Object.entries(state.entries || {})) {
        if (!entry || typeof entry !== 'object') continue;
        const old = before.has(key) ? before.get(key) : null;
        const value = entry.deleted ? null : entry.value;
        if (value !== null && typeof value !== 'string') continue;
        if (!classifyStorageEntry(key, value === null ? old ?? '' : value, options).portable) continue;
        if (old !== value) changes.push({ key, before: old, after: value });
    }
    return { before: new Map(before), changes };
}

export function isTransient(error) {
    return error instanceof TypeError || [408, 429, 502, 503, 504].includes(error?.status);
}

export function requestCategory(rawUrl, method = 'GET', base = 'https://localhost/') {
    if (String(method).toUpperCase() !== 'POST') return null;
    let path;
    try { path = new URL(rawUrl, base).pathname.replace(/\/$/u, ''); } catch { return null; }
    if (path.startsWith('/api/plugins/device-settings-sync')) return null;
    if (/^\/api\/backends\/(?:chat-completions|text-completions|kobold|novelai)\/generate$/u.test(path)
        || /^\/api\/plugins\/(?:openai-responses|responses-bridge)\/generate$/u.test(path)
        || /\/(?:chat\/completions|completions|responses|messages)$/u.test(path)
        || /:(?:streamGenerateContent|generateContent)$/u.test(path)) return 'generation';
    if (/\/(?:embeddings|embed|rerank)$/u.test(path)) return 'retrieval';
    return null;
}
