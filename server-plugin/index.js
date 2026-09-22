import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cookieSession from 'cookie-session';
import { csrfSync } from 'csrf-sync';
import express from 'express';

// Resolve SillyTavern from its working directory so the server plugin can be
// linked to this repository. Node resolves relative imports from a symlink's
// real path, which would otherwise point into public/scripts/extensions.
const {
    getCookieSecret,
    getCookieSessionName,
    getSessionCookieAge,
    getUserDirectories,
    requireLoginMiddleware,
    setUserDataMiddleware,
} = await import(pathToFileURL(path.resolve(process.cwd(), 'src/users.js')).href);
import { createInitialState, MAX_STATE_BYTES, mergeMutations, normalizeState, touchSettings } from './state.js';
import { BackupStore } from './backups.js';
import { StorageError } from '../lib/storage-model.js';

const FILE_NAME = 'device-settings-sync.json';
const queues = new Map();

export const info = {
    id: 'device-settings-sync',
    name: 'Cross-device settings sync',
    description: 'Stores portable browser settings per authenticated SillyTavern user.',
};

function getUserRoot(request) {
    const handle = request?.user?.profile?.handle || request?.session?.handle;
    const configuredRoot = request?.user?.directories?.root || (handle ? getUserDirectories(handle).root : '');
    if (typeof configuredRoot !== 'string' || !configuredRoot) throw new Error('Authenticated user directory is unavailable');
    const root = path.resolve(configuredRoot);
    const dataRoot = path.resolve(globalThis.DATA_ROOT);
    if (root === dataRoot || !root.startsWith(`${dataRoot}${path.sep}`)) throw new Error('Authenticated user directory is invalid');
    return root;
}

function statePath(root) {
    return path.join(root, FILE_NAME);
}

async function readState(root) {
    try {
        const text = await fs.readFile(statePath(root), 'utf8');
        if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) throw new Error('Settings sync state is too large');
        return normalizeState(JSON.parse(text));
    } catch (error) {
        if (error?.code === 'ENOENT') return createInitialState();
        throw error;
    }
}

async function writeState(root, state) {
    const target = statePath(root);
    const temporary = path.join(root, `.${FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(payload, 'utf8') > MAX_STATE_BYTES) throw new RangeError('Settings sync state is too large');
    await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => {});
}

function serialize(root, operation) {
    const previous = queues.get(root) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    queues.set(root, next);
    return next.finally(() => {
        if (queues.get(root) === next) queues.delete(root);
    });
}

function sendError(response, error) {
    if (error instanceof StorageError) {
        const status = error.code === 'backupNotFound' ? 404 : error.code === 'backupConflict' ? 409 : error.code === 'archiveTooLarge' ? 413 : 400;
        return response.status(status).json({ code: error.code });
    }
    const status = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
    if (status === 500) console.error('[device-settings-sync]', error);
    response.status(status).json({ error: status === 500 ? 'Settings sync failed' : error.message });
}

function installSillyTavernSecurity(router) {
    // Server plugins are mounted before SillyTavern's normal session and CSRF middleware.
    // Apply the same official middleware here so every state remains scoped to the
    // authenticated account and POST requests cannot be forged cross-origin.
    router.use(cookieSession({
        name: getCookieSessionName(),
        sameSite: 'lax',
        httpOnly: true,
        maxAge: getSessionCookieAge(),
        secret: getCookieSecret(globalThis.DATA_ROOT),
    }));
    router.use(setUserDataMiddleware);
    router.use(requireLoginMiddleware);

    if (!globalThis.COMMAND_LINE_ARGS?.disableCsrf) {
        const protection = csrfSync({
            getTokenFromState: request => request.session?.csrfToken,
            getTokenFromRequest: request => request.headers['x-csrf-token']?.toString(),
            storeTokenInState: (request, token) => {
                if (request.session) request.session.csrfToken = token;
            },
            size: 32,
        });
        router.use(protection.csrfSynchronisedProtection);
    }
    router.use('/backups', express.json({ limit: '32mb' }));
    router.use(express.json({ limit: '6mb' }));
}

export async function init(router) {
    installSillyTavernSecurity(router);

    router.get('/health', (_request, response) => {
        response.set('Cache-Control', 'no-store').json({ ok: true, schema: 1, version: '1.4.0', capabilities: ['backups-v1'] });
    });

    router.get('/backups', async (request, response) => {
        try {
            response.set('Cache-Control', 'no-store').json(await new BackupStore(getUserRoot(request)).list());
        } catch (error) { sendError(response, error); }
    });

    router.post('/backups', async (request, response) => {
        try {
            response.set('Cache-Control', 'no-store').json(await new BackupStore(getUserRoot(request)).create(request.body));
        } catch (error) { sendError(response, error); }
    });

    router.get('/backups/:id', async (request, response) => {
        try {
            response.set('Cache-Control', 'no-store').json(await new BackupStore(getUserRoot(request)).get(request.params.id));
        } catch (error) { sendError(response, error); }
    });

    router.get('/state', async (request, response) => {
        try {
            const state = await readState(getUserRoot(request));
            response.set('Cache-Control', 'no-store').json(state);
        } catch (error) {
            sendError(response, error);
        }
    });

    router.post('/merge', async (request, response) => {
        try {
            const root = getUserRoot(request);
            const state = await serialize(root, async () => {
                const current = await readState(root);
                const merged = mergeMutations(current, request.body);
                if (merged.revision !== current.revision) await writeState(root, merged);
                return merged;
            });
            response.set('Cache-Control', 'no-store').json(state);
        } catch (error) {
            sendError(response, error);
        }
    });

    router.post('/touch-settings', async (request, response) => {
        try {
            const root = getUserRoot(request);
            const state = await serialize(root, async () => {
                const current = await readState(root);
                const touched = touchSettings(current, request.body);
                if (touched.revision !== current.revision) await writeState(root, touched);
                return touched;
            });
            response.set('Cache-Control', 'no-store').json(state);
        } catch (error) {
            sendError(response, error);
        }
    });

    router.use((error, _request, response, next) => {
        if (error.type === 'entity.too.large') return response.status(413).json({ code: 'archiveTooLarge' });
        if (error.type === 'entity.parse.failed') return response.status(400).json({ code: 'invalidArchive' });
        return next(error);
    });
}
