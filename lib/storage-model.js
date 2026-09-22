export const ARCHIVE_FORMAT = 'sillytavern-localstorage-backup';
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder();

export class StorageError extends Error {
    constructor(code, details = {}) {
        super(code);
        this.name = 'StorageError';
        this.code = code;
        this.details = details;
    }
}

export const entryBytes = (key, value) => 2 * (key.length + value.length);
export const totalBytes = values => [...values].reduce((sum, [key, value]) => sum + entryBytes(key, value), 0);
export const isInternalKey = key => /^sillytavern_settings_sync_/iu.test(key);

export function readStorage(storage) {
    const values = new Map();
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key === null) continue;
        const value = storage.getItem(key);
        if (value !== null) values.set(key, value);
    }
    return values;
}

export function inScope(key, scope) {
    if (scope.kind === 'full') return true;
    if (scope.kind === 'prefix') return key.startsWith(scope.prefix);
    return scope.keys.includes(key);
}

export function intersectScope(a, b) {
    if (a.kind === 'full') return b;
    if (b.kind === 'full') return a;
    if (a.kind === 'keys') return { kind: 'keys', keys: a.keys.filter(key => inScope(key, b)) };
    if (b.kind === 'keys') return { kind: 'keys', keys: b.keys.filter(key => inScope(key, a)) };
    if (a.prefix.startsWith(b.prefix)) return a;
    if (b.prefix.startsWith(a.prefix)) return b;
    return { kind: 'keys', keys: [] };
}

function validateScope(scope) {
    if (!scope || typeof scope !== 'object') throw new StorageError('invalidArchive');
    if (scope.kind === 'full') return { kind: 'full' };
    if (scope.kind === 'prefix' && typeof scope.prefix === 'string' && scope.prefix.length) {
        return { kind: 'prefix', prefix: scope.prefix };
    }
    if (scope.kind === 'keys' && Array.isArray(scope.keys) && scope.keys.every(key => typeof key === 'string')) {
        return { kind: 'keys', keys: [...new Set(scope.keys)] };
    }
    throw new StorageError('invalidArchive');
}

export function createArchive(values, scope = { kind: 'full' }, source = {}) {
    source = source && typeof source === 'object' ? source : {};
    return {
        format: ARCHIVE_FORMAT,
        version: 1,
        createdAt: new Date().toISOString(),
        source: { origin: String(source.origin || ''), deviceId: String(source.deviceId || '') },
        scope: validateScope(scope),
        entries: [...values].filter(([key]) => inScope(key, scope)).map(([key, value]) => ({ key, value })),
    };
}

export function serializeArchive(archive) {
    const text = JSON.stringify(archive);
    if (encoder.encode(text).byteLength > MAX_ARCHIVE_BYTES) throw new StorageError('archiveTooLarge');
    return text;
}

export function parseArchive(text) {
    if (encoder.encode(text).byteLength > MAX_ARCHIVE_BYTES) throw new StorageError('archiveTooLarge');
    let input;
    try { input = JSON.parse(text); } catch { throw new StorageError('invalidArchive'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StorageError('invalidArchive');
    // Plain string dictionaries have no authoritative full-replacement scope.
    if (Object.values(input).every(value => typeof value === 'string')) {
        const values = new Map(Object.entries(input));
        return createArchive(values, { kind: 'keys', keys: [...values.keys()] });
    }
    if (input.format !== ARCHIVE_FORMAT || input.version !== 1 || !Array.isArray(input.entries)) {
        throw new StorageError('invalidArchive');
    }
    const scope = validateScope(input.scope);
    const values = new Map();
    for (const entry of input.entries) {
        if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string'
            || values.has(entry.key) || !inScope(entry.key, scope)) throw new StorageError('invalidArchive');
        values.set(entry.key, entry.value);
    }
    const archive = createArchive(values, scope, input.source);
    archive.createdAt = typeof input.createdAt === 'string' ? input.createdAt : '';
    return archive;
}

export function planImport(before, archive, { mode = 'merge', selectedKeys, scope = archive.scope, includeInternal = false } = {}) {
    if (!['merge', 'replace'].includes(mode)) throw new StorageError('invalidArchive');
    scope = validateScope(scope);
    const incoming = new Map(archive.entries.map(({ key, value }) => [key, value]));
    const selected = new Set(selectedKeys ?? incoming.keys());
    const allowed = key => inScope(key, scope) && inScope(key, archive.scope) && (includeInternal || !isInternalKey(key));
    const changes = [];
    for (const [key, value] of incoming) {
        if (selected.has(key) && allowed(key) && before.get(key) !== value) {
            changes.push({ key, before: before.has(key) ? before.get(key) : null, after: value });
        }
    }
    if (mode === 'replace') {
        for (const [key, value] of before) {
            // Unchecked incoming entries are protected; only genuinely absent entries can be deleted.
            if (allowed(key) && !incoming.has(key)) changes.push({ key, before: value, after: null });
        }
    }
    return { before: new Map(before), changes };
}

export function planDelete(before, keys, includeInternal = false) {
    return {
        before: new Map(before),
        changes: [...new Set(keys)].filter(key => before.has(key) && (includeInternal || !isInternalKey(key)))
            .map(key => ({ key, before: before.get(key), after: null })),
    };
}

export function assertUnchanged(storage, before) {
    const current = readStorage(storage);
    if (current.size !== before.size || [...before].some(([key, value]) => current.get(key) !== value)) {
        throw new StorageError('stalePreview');
    }
}

export function applyPlan(storage, plan) {
    assertUnchanged(storage, plan.before);
    const applied = [];
    // Release space first; keep a journal for quota failures and rollback.
    const ordered = [...plan.changes].sort((a, b) => Number(b.after === null) - Number(a.after === null));
    try {
        for (const change of ordered) {
            if (change.after === null) storage.removeItem(change.key);
            else storage.setItem(change.key, change.after);
            applied.push(change);
        }
    } catch {
        const failures = [];
        // Free newly allocated values before restoring previous values.
        for (const change of applied.filter(item => item.before === null || item.after !== null)) {
            try { storage.removeItem(change.key); } catch { failures.push(change.key); }
        }
        for (const change of [...applied].reverse()) {
            try {
                if (change.before === null) storage.removeItem(change.key);
                else storage.setItem(change.key, change.before);
            } catch { failures.push(change.key); }
        }
        throw new StorageError(failures.length ? 'rollbackFailed' : 'writeRolledBack', { failedKeys: [...new Set(failures)] });
    }
    return plan.changes.length;
}

export function buildTree(values) {
    const root = { id: 'root', type: 'folder', name: 'localStorage', prefix: '', children: [], bytes: 0, keys: [] };
    const folders = new Map([['', root]]);
    for (const [key, value] of values) {
        const boundaries = [...key.matchAll(/[:/.]/gu)].map(match => match.index + 1);
        if (!boundaries.length && key.includes('_')) boundaries.push(key.indexOf('_') + 1);
        let parent = root;
        let previous = 0;
        for (const end of boundaries) {
            const prefix = key.slice(0, end);
            let folder = folders.get(prefix);
            if (!folder) {
                folder = { id: 'folder:' + prefix, type: 'folder', name: key.slice(previous, end), prefix, children: [], bytes: 0, keys: [] };
                folders.set(prefix, folder);
                parent.children.push(folder);
            }
            parent = folder;
            previous = end;
        }
        parent.children.push({ id: 'key:' + key, type: 'file', name: key.slice(previous) || key || '(empty key)', key, bytes: entryBytes(key, value), keys: [key] });
    }
    function sum(node) {
        if (node.type === 'file') return;
        for (const child of node.children) {
            sum(child);
            node.bytes += child.bytes;
            node.keys.push(...child.keys);
        }
        node.children.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    }
    sum(root);
    return root;
}

export function cleanupAdvice(values) {
    return [...values].map(([key, value]) => {
        const caution = isInternalKey(key) || /(?:history|draft|chat|memory|snapshot|session|credential|token|secret|password|api.?key|歷史|历史|草稿|聊天|記憶|记忆|憑證|凭证|密碼|密码|令牌|金鑰|密钥)/iu.test(key);
        const candidate = !caution && /(?:快取|缓存|暫存|暂存|臨時|临时|除錯|调试|日誌|日志|(?:^|[:._/-])(?:cache|cached|temp|temporary|tmp|debug|logs?)(?:$|[:._/-]))/iu.test(key);
        return { key, bytes: entryBytes(key, value), caution, candidate };
    }).sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key))
        .filter((item, index) => index < 10 || item.candidate);
}

// Binary partitioning gives every leaf its true share of the available rectangle.
export function layoutTreemap(nodes, x = 0, y = 0, width = 100, height = 100) {
    if (!nodes.length) return [];
    if (nodes.length === 1) return [{ node: nodes[0], x, y, width, height }];
    const total = nodes.reduce((sum, node) => sum + node.bytes, 0);
    let sum = 0;
    let cut = 0;
    while (cut < nodes.length - 1 && (sum < total / 2 || cut === 0)) sum += nodes[cut++].bytes;
    const ratio = total ? sum / total : cut / nodes.length;
    if (width >= height) return [
        ...layoutTreemap(nodes.slice(0, cut), x, y, width * ratio, height),
        ...layoutTreemap(nodes.slice(cut), x + width * ratio, y, width * (1 - ratio), height),
    ];
    return [
        ...layoutTreemap(nodes.slice(0, cut), x, y, width, height * ratio),
        ...layoutTreemap(nodes.slice(cut), x, y + height * ratio, width, height * (1 - ratio)),
    ];
}
