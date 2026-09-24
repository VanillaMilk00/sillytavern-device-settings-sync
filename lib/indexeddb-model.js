export const INDEXEDDB_ARCHIVE_FORMAT = 'sillytavern-indexeddb-backup';
export const MAX_INDEXEDDB_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const INDEXEDDB_CHUNK_BYTES = 1024 * 1024;

export class IndexedDbError extends Error {
    constructor(code, details = {}) { super(code); this.name = 'IndexedDbError'; this.code = code; this.details = details; }
}

const utf8 = new TextEncoder();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const asBytes = buffer => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
};
const fromBytes = text => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
};

async function encodeValue(value, context = { seen: new Map(), next: 1 }, path = '$') {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : { $type: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
    if (typeof value === 'undefined') return { $type: 'undefined' };
    if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) };
    if (typeof value === 'function' || typeof value === 'symbol') throw new IndexedDbError('indexedDbUnsupportedValue', { path });
    if (context.seen.has(value)) return { $ref: context.seen.get(value) };
    const id = context.next++;
    context.seen.set(value, id);
    if (Array.isArray(value)) {
        const items = [];
        for (let index = 0; index < value.length; index += 1) items.push(await encodeValue(value[index], context, `${path}[${index}]`));
        return { $type: 'array', $id: id, value: items };
    }
    if (value instanceof Date) return { $type: 'date', $id: id, value: Number.isNaN(value.getTime()) ? null : value.toISOString() };
    if (value instanceof RegExp) return { $type: 'regexp', $id: id, source: value.source, flags: value.flags, lastIndex: value.lastIndex };
    if (value instanceof Map) {
        const entries = [];
        let index = 0;
        for (const [key, item] of value) entries.push([
            await encodeValue(key, context, `${path}.<map-key:${index}>`),
            await encodeValue(item, context, `${path}.<map-value:${index++}>`),
        ]);
        return { $type: 'map', $id: id, value: entries };
    }
    if (value instanceof Set) {
        const items = [];
        let index = 0;
        for (const item of value) items.push(await encodeValue(item, context, `${path}.<set:${index++}>`));
        return { $type: 'set', $id: id, value: items };
    }
    if (value instanceof ArrayBuffer) return { $type: 'array-buffer', $id: id, value: asBytes(value) };
    if (ArrayBuffer.isView(value)) {
        if (value instanceof DataView) return { $type: 'data-view', $id: id, value: asBytes(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) };
        return { $type: 'typed-array', $id: id, name: value.constructor.name, value: asBytes(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)), length: value.length };
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        const result = { $type: 'blob', $id: id, value: asBytes(await value.arrayBuffer()), mime: value.type };
        if (typeof File !== 'undefined' && value instanceof File) Object.assign(result, { file: true, name: value.name, lastModified: value.lastModified });
        return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
        const entries = [];
        for (const key of Object.keys(value)) entries.push([key, await encodeValue(value[key], context, `${path}.${key}`)]);
        return { $type: 'object', $id: id, nullPrototype: prototype === null, value: entries };
    }
    throw new IndexedDbError('indexedDbUnsupportedValue', { path, type: value.constructor?.name || 'unknown' });
}

function decodeValue(input, refs = new Map()) {
    if (input === null || typeof input !== 'object') return input;
    if (own(input, '$ref')) {
        if (!Number.isSafeInteger(input.$ref) || !refs.has(input.$ref)) throw new IndexedDbError('indexedDbInvalidArchive');
        return refs.get(input.$ref);
    }
    const register = value => {
        if (!Number.isSafeInteger(input.$id) || input.$id < 1 || refs.has(input.$id)) throw new IndexedDbError('indexedDbInvalidArchive');
        refs.set(input.$id, value);
        return value;
    };
    switch (input.$type) {
        case 'undefined': return undefined;
        case 'bigint':
            if (typeof input.value !== 'string' || !/^-?\d+$/u.test(input.value)) throw new IndexedDbError('indexedDbInvalidArchive');
            return BigInt(input.value);
        case 'number':
            if (input.value === 'NaN') return NaN;
            if (input.value === 'Infinity') return Infinity;
            if (input.value === '-Infinity') return -Infinity;
            if (input.value === '-0') return -0;
            throw new IndexedDbError('indexedDbInvalidArchive');
        case 'array': {
            if (!Array.isArray(input.value)) throw new IndexedDbError('indexedDbInvalidArchive');
            const value = register([]);
            for (const item of input.value) value.push(decodeValue(item, refs));
            return value;
        }
        case 'object': {
            if (!Array.isArray(input.value) || typeof input.nullPrototype !== 'boolean') throw new IndexedDbError('indexedDbInvalidArchive');
            const value = register(input.nullPrototype ? Object.create(null) : {});
            const keys = new Set();
            for (const entry of input.value) {
                if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || keys.has(entry[0])) throw new IndexedDbError('indexedDbInvalidArchive');
                keys.add(entry[0]);
                Object.defineProperty(value, entry[0], { value: decodeValue(entry[1], refs), writable: true, enumerable: true, configurable: true });
            }
            return value;
        }
        case 'map': {
            if (!Array.isArray(input.value)) throw new IndexedDbError('indexedDbInvalidArchive');
            const value = register(new Map());
            for (const entry of input.value) {
                if (!Array.isArray(entry) || entry.length !== 2) throw new IndexedDbError('indexedDbInvalidArchive');
                value.set(decodeValue(entry[0], refs), decodeValue(entry[1], refs));
            }
            return value;
        }
        case 'set': {
            if (!Array.isArray(input.value)) throw new IndexedDbError('indexedDbInvalidArchive');
            const value = register(new Set());
            for (const item of input.value) value.add(decodeValue(item, refs));
            return value;
        }
        case 'date': {
            if (input.value !== null && typeof input.value !== 'string') throw new IndexedDbError('indexedDbInvalidArchive');
            const value = input.value === null ? new Date(NaN) : new Date(input.value);
            return register(value);
        }
        case 'regexp': {
            if (typeof input.source !== 'string' || typeof input.flags !== 'string') throw new IndexedDbError('indexedDbInvalidArchive');
            const value = new RegExp(input.source, input.flags); value.lastIndex = input.lastIndex || 0; return register(value);
        }
        case 'array-buffer': { return register(fromBytes(input.value)); }
        case 'data-view': { return register(new DataView(fromBytes(input.value))); }
        case 'typed-array': {
            const constructors = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, ...(typeof BigInt64Array === 'undefined' ? {} : { BigInt64Array, BigUint64Array }) };
            const Constructor = constructors[input.name];
            if (!Constructor) throw new IndexedDbError('indexedDbInvalidArchive');
            return register(new Constructor(fromBytes(input.value)));
        }
        case 'blob': {
            if (typeof input.value !== 'string' || (input.mime !== undefined && typeof input.mime !== 'string')
                || (input.file && (typeof File === 'undefined' || typeof input.name !== 'string'))) throw new IndexedDbError('indexedDbInvalidArchive');
            const bytes = new Uint8Array(fromBytes(input.value));
            const blob = new Blob([bytes], { type: input.mime || '' });
            const value = input.file ? new File([blob], input.name, { type: input.mime || '', lastModified: input.lastModified || 0 }) : blob;
            return register(value);
        }
        default: throw new IndexedDbError('indexedDbInvalidArchive');
    }
}

export function encodeIndexedDbKey(value) {
    let next = 1;
    const encodeKey = key => {
        if (typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key))) return key;
        if (key instanceof Date) return { $type: 'date', $id: next++, value: Number.isNaN(key.getTime()) ? null : key.toISOString() };
        if (key instanceof ArrayBuffer) return { $type: 'array-buffer', $id: next++, value: asBytes(key) };
        if (Array.isArray(key)) return { $type: 'array', $id: next++, value: key.map(encodeKey) };
        throw new IndexedDbError('indexedDbInvalidKey');
    };
    return JSON.stringify(encodeKey(value));
}
export function decodeIndexedDbKey(encoded) { return decodeValue(JSON.parse(encoded)); }

export async function listIndexedDatabases(factory = globalThis.indexedDB) {
    if (!factory?.databases) throw new IndexedDbError('indexedDbEnumerationUnsupported');
    const rows = await factory.databases();
    return rows.filter(row => typeof row.name === 'string').map(row => ({ name: row.name, version: row.version || 1 })).sort((a, b) => a.name.localeCompare(b.name));
}

function openExisting(name, factory) {
    return new Promise(async (resolve, reject) => {
        let known;
        try { known = await listIndexedDatabases(factory); } catch (error) { reject(error); return; }
        const row = known.find(item => item.name === name);
        if (!row) { reject(new IndexedDbError('indexedDbDatabaseMissing', { name })); return; }
        const request = factory.open(name);
        let blocked = false;
        request.onblocked = () => { blocked = true; reject(new IndexedDbError('indexedDbBlocked', { name })); };
        request.onerror = () => reject(new IndexedDbError('indexedDbOpenFailed', { name }));
        request.onsuccess = () => {
            if (blocked) { request.result.close(); return; }
            request.result.onversionchange = () => request.result.close(); resolve(request.result);
        };
    });
}

function readStore(database, storeName) {
    return new Promise((resolve, reject) => {
        let transaction;
        try { transaction = database.transaction(storeName, 'readonly'); }
        catch (error) { reject(error); return; }
        const store = transaction.objectStore(storeName);
        let keys, values;
        const keyRequest = store.getAllKeys();
        const valueRequest = store.getAll();
        keyRequest.onsuccess = () => { keys = keyRequest.result; };
        valueRequest.onsuccess = () => { values = valueRequest.result; };
        transaction.oncomplete = () => resolve({ keys: keys || [], values: values || [] });
        transaction.onerror = () => reject(transaction.error || new IndexedDbError('indexedDbReadFailed'));
        transaction.onabort = () => reject(transaction.error || new IndexedDbError('indexedDbReadFailed'));
    });
}

function selectionAllows(scope, database, store, keyToken) {
    if (!scope || scope.kind === 'all') return true;
    if (scope.kind === 'databases') return scope.names.includes(database);
    return scope.kind === 'items' && scope.items.some(item => item.database === database
        && (item.store === undefined || item.store === store) && (item.keyToken === undefined || item.keyToken === keyToken));
}

function scopeAllowsDatabase(scope, database) {
    if (!scope || scope.kind === 'all') return true;
    if (scope.kind === 'databases') return scope.names.includes(database);
    return scope.kind === 'items' && scope.items.some(item => item.database === database);
}

function scopeAllowsStore(scope, database, store) {
    if (!scope || scope.kind === 'all' || scope.kind === 'databases') return scopeAllowsDatabase(scope, database);
    return scope.kind === 'items' && scope.items.some(item => item.database === database
        && (item.store === undefined || item.store === store));
}

function scopeSelectsStoreSchema(scope, database, store) {
    if (!scope || scope.kind === 'all' || scope.kind === 'databases') return scopeAllowsStore(scope, database, store);
    return scope.kind === 'items' && scope.items.some(item => item.database === database
        && (item.store === undefined || item.store === store) && item.keyToken === undefined);
}

function quotedJsonStringBytes(value) {
    let size = 2;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
            size += 2;
        } else if (code < 0x20) {
            size += 6;
        } else if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                size += 4;
                index += 1;
            } else {
                size += 6;
            }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            size += 6;
        } else if (code <= 0x7f) {
            size += 1;
        } else if (code <= 0x7ff) {
            size += 2;
        } else {
            size += 3;
        }
    }
    return size;
}

// Estimate JSON's UTF-8 size without first allocating one enormous string.
// This lets the manager display large databases and lets archive serialization
// reject oversized transfers before hitting the engine's maximum string length.
export function estimateJsonBytes(value) {
    let size = 0;
    const active = new WeakSet();
    const stack = [{ value }];
    while (stack.length) {
        const task = stack.pop();
        if (task.exit) {
            active.delete(task.value);
            continue;
        }

        const current = task.value;
        if (current === null) { size += 4; continue; }
        if (typeof current === 'string') { size += quotedJsonStringBytes(current); continue; }
        if (typeof current === 'boolean') { size += current ? 4 : 5; continue; }
        if (typeof current === 'number') {
            size += Number.isFinite(current) ? String(current).length : 4;
            continue;
        }
        if (typeof current === 'undefined' || typeof current === 'function' || typeof current === 'symbol') {
            size += 4;
            continue;
        }
        if (typeof current === 'bigint') throw new TypeError('BigInt cannot be serialized as JSON');
        if (typeof current !== 'object') throw new TypeError('Unsupported JSON value');
        if (active.has(current)) throw new TypeError('Circular structure cannot be serialized as JSON');
        active.add(current);
        stack.push({ value: current, exit: true });

        if (Array.isArray(current)) {
            size += 2 + Math.max(0, current.length - 1);
            for (let index = 0; index < current.length; index += 1) stack.push({ value: current[index] });
            continue;
        }

        const keys = Object.keys(current).filter(key => {
            const item = current[key];
            return item !== undefined && typeof item !== 'function' && typeof item !== 'symbol';
        });
        size += 2 + Math.max(0, keys.length - 1) + keys.length;
        for (const key of keys) {
            size += quotedJsonStringBytes(key);
            stack.push({ value: current[key] });
        }
    }
    return size;
}

export async function snapshotIndexedDB({ factory = globalThis.indexedDB, scope = { kind: 'all' }, onProgress = () => {}, allowOversize = false, tolerateUnsupported = false } = {}) {
    const databases = await listIndexedDatabases(factory);
    const selectedNames = scope?.kind === 'databases' ? new Set(scope.names) : scope?.kind === 'items'
        ? new Set(scope.items.map(item => item.database)) : null;
    const result = { format: INDEXEDDB_ARCHIVE_FORMAT, version: 1, createdAt: new Date().toISOString(), scope, databases: [] };
    for (const row of databases) {
        if (selectedNames && !selectedNames.has(row.name)) continue;
        const database = await openExisting(row.name, factory);
        try {
            const stores = [];
            for (const storeName of Array.from(database.objectStoreNames)) {
                const rows = await readStore(database, storeName);
                const transaction = database.transaction(storeName, 'readonly');
                const objectStore = transaction.objectStore(storeName);
                const indexes = Array.from(objectStore.indexNames, name => {
                    const index = objectStore.index(name);
                    return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
                });
                const selection = scope?.kind === 'items' ? scope.items.filter(item => item.database === row.name && (item.store === undefined || item.store === storeName)) : null;
                const records = [];
                for (let index = 0; index < rows.keys.length; index += 1) {
                    const key = await encodeValue(rows.keys[index]);
                    const keyToken = JSON.stringify(key);
                    if (selection && !selection.some(item => item.keyToken === undefined || item.keyToken === keyToken)) continue;
                    let value;
                    try { value = await encodeValue(rows.values[index]); }
                    catch (error) {
                        if (!tolerateUnsupported || error.code !== 'indexedDbUnsupportedValue') throw error;
                        value = { $type: 'unsupported-display', description: error.details?.type || error.details?.path || 'unsupported value' };
                    }
                    records.push({ key, value });
                }
                stores.push({ name: storeName, keyPath: objectStore.keyPath, autoIncrement: objectStore.autoIncrement, indexes, records });
                onProgress({ database: row.name, store: storeName, records: records.length });
            }
            result.databases.push({ name: database.name, version: database.version, stores });
        } finally { database.close(); }
    }
    if (!allowOversize) serializeIndexedDbArchive(result);
    return result;
}

export function serializeIndexedDbArchive(archive) {
    if (estimateJsonBytes(archive) > MAX_INDEXEDDB_ARCHIVE_BYTES) throw new IndexedDbError('indexedDbArchiveTooLarge');
    let text;
    try { text = JSON.stringify(archive); }
    catch (error) {
        if (error instanceof RangeError) throw new IndexedDbError('indexedDbArchiveTooLarge');
        throw error;
    }
    if (utf8.encode(text).byteLength > MAX_INDEXEDDB_ARCHIVE_BYTES) throw new IndexedDbError('indexedDbArchiveTooLarge');
    return text;
}

export function parseIndexedDbArchive(text) {
    if (typeof text !== 'string' || text.length > MAX_INDEXEDDB_ARCHIVE_BYTES || utf8.encode(text).byteLength > MAX_INDEXEDDB_ARCHIVE_BYTES) {
        throw new IndexedDbError('indexedDbArchiveTooLarge');
    }
    let archive;
    try { archive = JSON.parse(text); } catch { throw new IndexedDbError('indexedDbInvalidArchive'); }
    const validScope = archive?.scope?.kind === 'all'
        || (archive?.scope?.kind === 'databases' && Array.isArray(archive.scope.names) && archive.scope.names.every(name => typeof name === 'string'))
        || (archive?.scope?.kind === 'items' && Array.isArray(archive.scope.items) && archive.scope.items.every(item => item
            && typeof item.database === 'string' && (item.store === undefined || typeof item.store === 'string')
            && (item.keyToken === undefined || typeof item.keyToken === 'string')));
    if (archive?.format !== INDEXEDDB_ARCHIVE_FORMAT || archive.version !== 1 || !Array.isArray(archive.databases) || !validScope
        || typeof archive.createdAt !== 'string') throw new IndexedDbError('indexedDbInvalidArchive');
    const databaseNames = new Set();
    for (const database of archive.databases) {
        if (!database || typeof database.name !== 'string' || !Number.isSafeInteger(database.version) || database.version < 1 || !Array.isArray(database.stores)
            || databaseNames.has(database.name)) throw new IndexedDbError('indexedDbInvalidArchive');
        databaseNames.add(database.name);
        const storeNames = new Set();
        for (const store of database.stores) {
            const validKeyPath = keyPath => keyPath === null || typeof keyPath === 'string'
                || (Array.isArray(keyPath) && keyPath.every(part => typeof part === 'string'));
            if (!store || typeof store.name !== 'string' || !Array.isArray(store.records) || !Array.isArray(store.indexes)
                || storeNames.has(store.name) || !validKeyPath(store.keyPath) || typeof store.autoIncrement !== 'boolean') throw new IndexedDbError('indexedDbInvalidArchive');
            storeNames.add(store.name);
            const indexNames = new Set();
            for (const index of store.indexes) {
                if (!index || typeof index.name !== 'string' || indexNames.has(index.name)
                    || !(typeof index.keyPath === 'string' || (Array.isArray(index.keyPath) && index.keyPath.every(part => typeof part === 'string')))
                    || typeof index.unique !== 'boolean' || typeof index.multiEntry !== 'boolean'
                    || (index.multiEntry && Array.isArray(index.keyPath))) throw new IndexedDbError('indexedDbInvalidArchive');
                indexNames.add(index.name);
            }
            const recordKeys = new Set();
            for (const record of store.records) {
                if (!record || !own(record, 'key') || !own(record, 'value')) throw new IndexedDbError('indexedDbInvalidArchive');
                const token = JSON.stringify(record.key);
                if (recordKeys.has(token)) throw new IndexedDbError('indexedDbInvalidArchive');
                recordKeys.add(token);
                let key;
                try { key = decodeValue(record.key); } catch { throw new IndexedDbError('indexedDbInvalidArchive'); }
                if (!validIndexedDbKey(key) || encodeIndexedDbKey(key) !== token) throw new IndexedDbError('indexedDbInvalidArchive');
            }
        }
    }
    return archive;
}

function sameKeyPath(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function openForMerge(definition, factory = globalThis.indexedDB) {
    return new Promise(async (resolve, reject) => {
        let existing = null;
        let schemaChanged = false;
        try {
            const databases = await listIndexedDatabases(factory);
            existing = databases.find(row => row.name === definition.name) || null;
        } catch (error) { reject(error); return; }
        let version = existing ? existing.version : Math.max(1, definition.version);
        if (existing) {
            const current = await openExisting(definition.name, factory).catch(reject);
            if (!current) return;
            let upgradeNeeded = false;
            for (const store of definition.stores) {
                if (!current.objectStoreNames.contains(store.name)) { upgradeNeeded = true; continue; }
                const transaction = current.transaction(store.name, 'readonly');
                const actual = transaction.objectStore(store.name);
                if (!sameKeyPath(actual.keyPath, store.keyPath) || actual.autoIncrement !== store.autoIncrement) {
                    current.close(); reject(new IndexedDbError('indexedDbSchemaConflict', { database: definition.name, store: store.name })); return;
                }
                for (const index of store.indexes) {
                    if (!actual.indexNames.contains(index.name)) { upgradeNeeded = true; continue; }
                    const currentIndex = actual.index(index.name);
                    if (!sameKeyPath(currentIndex.keyPath, index.keyPath) || currentIndex.unique !== index.unique || currentIndex.multiEntry !== index.multiEntry) {
                        current.close(); reject(new IndexedDbError('indexedDbSchemaConflict', { database: definition.name, store: store.name })); return;
                    }
                }
            }
            current.close();
            // A database's version is global to every consumer. Do not bump it
            // merely because another device recorded a higher version number;
            // only a selected schema addition requires a local upgrade.
            if (upgradeNeeded) {
                version = Math.max(version + 1, definition.version);
                schemaChanged = true;
            }
        }
        if (!existing) schemaChanged = true;
        const request = existing ? factory.open(definition.name, version) : factory.open(definition.name, version);
        let blocked = false;
        request.onblocked = () => {
            blocked = true;
            try { request.transaction?.abort(); } catch { /* The pending upgrade may already have been cancelled. */ }
            reject(new IndexedDbError('indexedDbBlocked', { name: definition.name }));
        };
        request.onerror = () => reject(request.error || new IndexedDbError('indexedDbOpenFailed', { name: definition.name }));
        request.onupgradeneeded = () => {
            const database = request.result;
            for (const store of definition.stores) {
                let objectStore;
                if (database.objectStoreNames.contains(store.name)) objectStore = request.transaction.objectStore(store.name);
                else objectStore = database.createObjectStore(store.name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement });
                for (const index of store.indexes) {
                    if (!objectStore.indexNames.contains(index.name)) objectStore.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
                }
            }
        };
        request.onsuccess = () => {
            if (blocked) { request.result.close(); return; }
            request.result.onversionchange = () => request.result.close(); resolve({ database: request.result, schemaChanged });
        };
    });
}

export async function mergeIndexedDbArchive(archive, { factory = globalThis.indexedDB, scope, onProgress = () => {} } = {}) {
    archive = typeof archive === 'string' ? parseIndexedDbArchive(archive) : parseIndexedDbArchive(JSON.stringify(archive));
    if (scope === undefined) scope = archive.scope;
    archive = selectIndexedDbArchive(archive, scope);
    // Decode and validate every record before opening/upgrading any destination database.
    // A malformed later row must not leave earlier rows committed as a partial import.
    const prepared = [];
    for (const database of archive.databases) {
        const stores = [];
        for (const store of database.stores) {
            if (!scopeAllowsStore(scope, database.name, store.name)) continue;
            const records = [];
            for (const record of store.records) {
                const key = decodeValue(record.key);
                const value = decodeValue(record.value);
                if (!validIndexedDbKey(key)) throw new IndexedDbError('indexedDbInvalidKey');
                if (store.keyPath !== null) {
                    const keyPaths = Array.isArray(store.keyPath) ? store.keyPath : [store.keyPath];
                    const extracted = keyPaths.map(keyPath => readKeyPath(value, keyPath));
                    const expectedKey = Array.isArray(store.keyPath) ? extracted : extracted[0];
                    if (!validIndexedDbKey(expectedKey) || encodeIndexedDbKey(expectedKey) !== JSON.stringify(record.key)) {
                        throw new IndexedDbError('indexedDbInvalidArchive');
                    }
                }
                records.push({ key, value, token: JSON.stringify(record.key) });
            }
            // A key-only selection is a record merge, not a schema request.
            // Avoid creating empty databases/stores when the selected key is
            // absent remotely. Store/database selections still carry schema.
            if (records.length || scopeSelectsStoreSchema(scope, database.name, store.name)) stores.push({ definition: store, records });
        }
        if (stores.length) prepared.push({ definition: database, stores });
    }
    const changed = [];
    for (const { definition: databaseDefinition, stores: preparedStores } of prepared) {
        if (!scopeAllowsDatabase(scope, databaseDefinition.name)) continue;
        const opened = await openForMerge({ ...databaseDefinition, stores: preparedStores.map(store => store.definition) }, factory);
        const database = opened.database;
        try {
            if (opened.schemaChanged) {
                const change = { database: databaseDefinition.name, store: '', count: 0, schema: true };
                changed.push(change);
                onProgress(change);
            }
            for (const { definition: storeDefinition, records: preparedRecords } of preparedStores) {
                if (!database.objectStoreNames.contains(storeDefinition.name)) continue;
                const rows = preparedRecords.filter(record => selectionAllows(scope, databaseDefinition.name, storeDefinition.name, record.token));
                if (!rows.length) continue;
                await new Promise((resolve, reject) => {
                    let transaction;
                    try { transaction = database.transaction(storeDefinition.name, 'readwrite'); }
                    catch (error) { reject(error); return; }
                    const store = transaction.objectStore(storeDefinition.name);
                    try {
                        for (const record of rows) {
                            if (store.keyPath === null) store.put(record.value, record.key);
                            else store.put(record.value);
                        }
                    } catch (error) {
                        try { transaction.abort(); } catch { /* A completed transaction is already safe. */ }
                        reject(error);
                        return;
                    }
                    transaction.oncomplete = resolve;
                    transaction.onerror = () => reject(transaction.error || new IndexedDbError('indexedDbWriteFailed'));
                    transaction.onabort = () => reject(transaction.error || new IndexedDbError('indexedDbWriteFailed'));
                });
                changed.push({ database: databaseDefinition.name, store: storeDefinition.name, count: rows.length });
                onProgress(changed.at(-1));
            }
        } finally { database.close(); }
    }
    return { changed };
}

function validIndexedDbKey(key, seen = new Set()) {
    if (typeof key === 'string') return true;
    if (typeof key === 'number') return Number.isFinite(key);
    if (key instanceof Date) return Number.isFinite(key.getTime());
    if (key instanceof ArrayBuffer) return true;
    if (Array.isArray(key)) {
        if (seen.has(key)) return false;
        seen.add(key);
        const valid = key.every(item => validIndexedDbKey(item, seen));
        seen.delete(key);
        return valid;
    }
    return false;
}

function readKeyPath(value, path) {
    if (path === '') return value;
    let current = value;
    for (const part of path.split('.')) {
        if (current === null || (typeof current !== 'object' && typeof current !== 'function') || !(part in current)) return undefined;
        current = current[part];
    }
    return current;
}

export async function deleteIndexedDbItems(items, { factory = globalThis.indexedDB } = {}) {
    const grouped = new Map();
    for (const item of items) {
        const id = `${item.database}\u0000${item.store}`;
        if (!grouped.has(id)) grouped.set(id, []);
        grouped.get(id).push(item);
    }
    for (const group of grouped.values()) {
        const database = await openExisting(group[0].database, factory);
        try {
            await new Promise((resolve, reject) => {
                const transaction = database.transaction(group[0].store, 'readwrite');
                const store = transaction.objectStore(group[0].store);
                for (const item of group) store.delete(decodeValue(JSON.parse(item.keyToken)));
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error || new IndexedDbError('indexedDbWriteFailed'));
                transaction.onabort = () => reject(transaction.error || new IndexedDbError('indexedDbWriteFailed'));
            });
        } finally { database.close(); }
    }
    return items.length;
}

export function mergeArchiveObjects(current, incoming, scope = incoming.scope) {
    const result = structuredClone(current);
    const byName = new Map(result.databases.map(database => [database.name, database]));
    for (const sourceDb of incoming.databases) {
        if (!scopeAllowsDatabase(scope, sourceDb.name)) continue;
        const sourceStores = sourceDb.stores.filter(store => scopeAllowsStore(scope, sourceDb.name, store.name)
            && (scopeSelectsStoreSchema(scope, sourceDb.name, store.name)
                || store.records.some(record => selectionAllows(scope, sourceDb.name, store.name, JSON.stringify(record.key)))));
        if (!sourceStores.length && !(scope?.kind === 'all' || scope?.kind === 'databases')) continue;
        let targetDb = byName.get(sourceDb.name);
        if (!targetDb) { targetDb = { ...sourceDb, stores: [] }; result.databases.push(targetDb); byName.set(sourceDb.name, targetDb); }
        const isNewDatabase = targetDb.stores.length === 0 && !current.databases.some(database => database.name === sourceDb.name);
        targetDb.version = Math.max(targetDb.version || 1, sourceDb.version || 1);
        const stores = new Map(targetDb.stores.map(store => [store.name, store]));
        let schemaChanged = false;
        for (const sourceStore of sourceStores) {
            let targetStore = stores.get(sourceStore.name);
            if (!targetStore) {
                targetStore = { ...sourceStore, records: [] };
                targetDb.stores.push(targetStore);
                stores.set(sourceStore.name, targetStore);
                schemaChanged = true;
            }
            if (!sameKeyPath(targetStore.keyPath, sourceStore.keyPath) || targetStore.autoIncrement !== sourceStore.autoIncrement) {
                throw new IndexedDbError('indexedDbSchemaConflict', { database: sourceDb.name, store: sourceStore.name });
            }
            const mergedIndexes = new Map(targetStore.indexes.map(index => [index.name, index]));
            for (const index of sourceStore.indexes) {
                const existingIndex = mergedIndexes.get(index.name);
                if (existingIndex && (!sameKeyPath(existingIndex.keyPath, index.keyPath) || existingIndex.unique !== index.unique || existingIndex.multiEntry !== index.multiEntry)) {
                    throw new IndexedDbError('indexedDbSchemaConflict', { database: sourceDb.name, store: sourceStore.name });
                }
                if (!existingIndex) { mergedIndexes.set(index.name, index); schemaChanged = true; }
            }
            targetStore.indexes = [...mergedIndexes.values()];
            const records = new Map(targetStore.records.map(record => [JSON.stringify(record.key), record]));
            for (const record of sourceStore.records) {
                if (selectionAllows(scope, sourceDb.name, sourceStore.name, JSON.stringify(record.key))) records.set(JSON.stringify(record.key), record);
            }
            targetStore.records = [...records.values()];
        }
        if (!isNewDatabase && schemaChanged) targetDb.version = Math.max((targetDb.version || 1) + 1, sourceDb.version || 1);
    }
    result.createdAt = new Date().toISOString();
    return result;
}

export function selectIndexedDbArchive(archive, scope) {
    const result = { format: INDEXEDDB_ARCHIVE_FORMAT, version: 1, createdAt: archive.createdAt, scope, databases: [] };
    for (const database of archive.databases) {
        if (scope?.kind === 'databases' && !scope.names.includes(database.name)) continue;
        const stores = [];
        for (const store of database.stores) {
            if (scope?.kind === 'items' && !scope.items.some(item => item.database === database.name && (item.store === undefined || item.store === store.name))) continue;
            const records = store.records.filter(record => selectionAllows(scope, database.name, store.name, JSON.stringify(record.key)));
            stores.push({ ...store, records });
        }
        if (stores.length) result.databases.push({ ...database, stores });
    }
    return result;
}
