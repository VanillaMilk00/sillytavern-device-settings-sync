import { parentPort, workerData } from 'node:worker_threads';
import { init } from './index.js';

globalThis.DATA_ROOT = workerData.dataRoot;

const routes = [];
const router = { use() {} };
for (const method of ['get', 'post', 'put', 'delete']) {
    router[method] = (route, handler) => {
        const names = [];
        const pattern = new RegExp('^' + route.split('/').map(part => {
            if (part.startsWith(':')) {
                names.push(part.slice(1));
                return '([^/]+)';
            }
            return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        }).join('/') + '$', 'u');
        routes.push({ method: method.toUpperCase(), pattern, names, handler });
    };
}

await init(router, { security: false });

async function dispatch(request) {
    try {
        const route = routes.find(item => item.method === request.method && item.pattern.test(request.path));
        if (!route) return { status: 404, body: { code: 'notFound' } };
        const match = route.pattern.exec(request.path);
        const params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
        let status = 200;
        const headers = {};
        let completed = false;
        let body;
        const response = {
            status(value) { status = value; return this; },
            set(name, value) { headers[name] = value; return this; },
            json(value) { body = value; completed = true; return this; },
        };
        await route.handler({
            params, query: request.query, body: request.body,
            user: { profile: { handle: request.handle }, directories: { root: request.userRoot } },
            session: { handle: request.handle },
        }, response);
        return { status: completed ? status : 500, headers,
            body: completed ? body : { error: 'Settings sync failed' } };
    } catch (error) {
        console.error('[device-settings-sync] Worker request failed', error);
        return { status: 500, body: { error: 'Settings sync failed' } };
    }
}

const health = await dispatch({ method: 'GET', path: '/health', query: {}, body: {}, handle: '', userRoot: '' });
if (health.status !== 200 || health.body?.ok !== true || !Array.isArray(health.body.capabilities)) {
    throw new Error('Runtime health check failed');
}
parentPort.postMessage({ type: 'ready', health: health.body });

parentPort.on('message', async ({ id, request }) => {
    if (!Number.isSafeInteger(id) || !request) return;
    parentPort.postMessage({ id, ...await dispatch(request) });
});
