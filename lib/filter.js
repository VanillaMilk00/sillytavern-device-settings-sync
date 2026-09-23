const encoder = new TextEncoder();

export const DEFAULT_MAX_VALUE_BYTES = 128 * 1024;

const OWN_KEYS = [
    /^sillytavern_settings_sync_/iu,
];

const DATA_AND_CACHE_KEYS = [
    /^yzm_memory_chat_state:/iu,
    /^yzm_memory_branch_snapshots:/iu,
    /^st_end_component_generation_history/iu,
    /(?:^|[:._-])(?:cache|cached|history|snapshot|snapshots|session|sessions|temp|temporary|tmp|debug|logs?|queue|drafts?)(?:$|[:._-])/iu,
];

const NON_PORTABLE_VALUE = /^(?:data:image\/|blob:)/iu;

export function parseAdditionalExcludes(text = '') {
    return String(text)
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 100);
}

function wildcardToRegExp(pattern) {
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`, 'iu');
}

export function matchesAdditionalExclude(key, patterns = []) {
    return patterns.some(pattern => wildcardToRegExp(String(pattern)).test(key));
}

export function classifyStorageEntry(key, value, options = {}) {
    const normalizedKey = String(key ?? '');
    const normalizedValue = String(value ?? '');
    const maxValueBytes = Number(options.maxValueBytes) || DEFAULT_MAX_VALUE_BYTES;
    const additionalExcludes = options.additionalExcludes ?? [];

    if (!options.fullStorage && (!normalizedKey || normalizedKey.length > 512)) {
        return { portable: false, reason: 'invalid-key' };
    }
    if (OWN_KEYS.some(pattern => pattern.test(normalizedKey))) {
        return { portable: false, reason: 'sync-internal' };
    }
    if (options.fullStorage) return { portable: true, reason: 'full-sync' };
    if (DATA_AND_CACHE_KEYS.some(pattern => pattern.test(normalizedKey))) {
        return { portable: false, reason: 'data-or-cache' };
    }
    if (matchesAdditionalExclude(normalizedKey, additionalExcludes)) {
        return { portable: false, reason: 'custom-exclude' };
    }
    if (NON_PORTABLE_VALUE.test(normalizedValue)) {
        return { portable: false, reason: 'binary-value' };
    }
    if (encoder.encode(normalizedValue).byteLength > maxValueBytes) {
        return { portable: false, reason: 'too-large' };
    }
    return { portable: true, reason: 'portable-setting' };
}

export function isPortableStorageEntry(key, value, options = {}) {
    return classifyStorageEntry(key, value, options).portable;
}
