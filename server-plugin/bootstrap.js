import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cookieSession from 'cookie-session';
import { csrfSync } from 'csrf-sync';
import express from 'express';
import { RuntimeManager } from './runtime-manager.js';

const {
    getCookieSecret,
    getCookieSessionName,
    getSessionCookieAge,
    getUserDirectories,
    requireAdminMiddleware,
    requireLoginMiddleware,
    setUserDataMiddleware,
} = await import(pathToFileURL(path.resolve(process.cwd(), 'src/users.js')).href);

const extensionName = 'sillytavern-device-settings-sync';
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let manager;

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

function installSecurity(router) {
    router.use(cookieSession({
        name: getCookieSessionName(), sameSite: 'lax', httpOnly: true,
        maxAge: getSessionCookieAge(), secret: getCookieSecret(globalThis.DATA_ROOT),
    }));
    router.use(setUserDataMiddleware);
    router.use(requireLoginMiddleware);
    if (!globalThis.COMMAND_LINE_ARGS?.disableCsrf) {
        const protection = csrfSync({
            getTokenFromState: request => request.session?.csrfToken,
            getTokenFromRequest: request => request.headers['x-csrf-token']?.toString(),
            storeTokenInState: (request, token) => { if (request.session) request.session.csrfToken = token; },
            size: 32,
        });
        router.use(protection.csrfSynchronisedProtection);
    }
}

async function canReload(request) {
    if (request.user?.profile?.admin !== true) return false;
    const linked = await fs.realpath(extensionRoot);
    const global = path.resolve(process.cwd(), 'public/scripts/extensions/third-party', extensionName);
    if (await fs.realpath(global).catch(() => '') === linked) return true;
    const personal = path.join(request.user.directories.extensions, extensionName);
    return await fs.realpath(personal).catch(() => '') === linked;
}

function errorResponse(response, error) {
    const status = error.code === 'runtimeSourceMismatch' || error.code === 'runtimeReloadBusy'
        || error.code === 'runtimeRestartRequired' ? 409
        : error.code === 'runtimeWorkerUnavailable' ? 503 : 500;
    if (status === 500) console.error('[device-settings-sync] Runtime request failed', error);
    return response.status(status).json({ code: status === 500 ? 'runtimeReloadFailed' : error.code });
}

export async function init(router) {
    installSecurity(router);
    manager = new RuntimeManager({
        sourceRoot: await fs.realpath(extensionRoot), dataRoot: globalThis.DATA_ROOT, serverRoot: process.cwd(),
    });
    await manager.start();

    router.get('/health', async (request, response) => {
        const state = await manager.status();
        const active = manager.active?.health;
        response.set('Cache-Control', 'no-store').json({
            ...(active || { ok: false, schema: 1, version: state.activeVersion, capabilities: [] }),
            capabilities: [...new Set([...(active?.capabilities || []), 'runtime-reload-v1'])],
            runtime: { ...state, canReload: await canReload(request) },
        });
    });

    router.post('/runtime/reload', express.json({ limit: '16kb' }), requireAdminMiddleware, async (request, response) => {
        try {
            if (!await canReload(request)) return response.status(403).json({ code: 'runtimeSourceMismatch' });
            const result = await manager.requestReload(request.body?.expectedBuild, { retry: request.body?.retry === true });
            response.set('Cache-Control', 'no-store').status(result.state === 'preparing' || result.state === 'waiting' ? 202 : 200).json(result);
        } catch (error) { errorResponse(response, error); }
    });

    router.use('/backups', express.json({ limit: '32mb' }));
    router.use('/full-commit', express.json({ limit: '32mb' }));
    router.use('/incremental/commit', express.json({ limit: '32mb' }));
    router.use('/incremental/transfers', express.json({ limit: '512kb' }));
    router.use('/indexeddb/transfers', express.json({ limit: '2mb' }));
    router.use(express.json({ limit: '6mb' }));
    router.use(async (request, response) => {
        try {
            const result = await manager.invoke({
                method: request.method, path: request.path, query: request.query, body: request.body,
                handle: request.user.profile.handle, userRoot: getUserRoot(request),
            });
            for (const [name, value] of Object.entries(result.headers || {})) response.set(name, value);
            response.set('Cache-Control', 'no-store').status(result.status).json(result.body);
        } catch (error) { errorResponse(response, error); }
    });
    router.use((error, _request, response, next) => {
        if (error.type === 'entity.too.large') return response.status(413).json({ code: 'archiveTooLarge' });
        if (error.type === 'entity.parse.failed') return response.status(400).json({ code: 'invalidArchive' });
        return next(error);
    });
}

export async function exit() {
    if (manager) await manager.close();
}
