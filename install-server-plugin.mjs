import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(extensionRoot, 'server-plugin');
const sillyTavernRoot = path.resolve(process.argv[2] || process.cwd());
const pluginsRoot = path.join(sillyTavernRoot, 'plugins');
const target = path.join(pluginsRoot, 'device-settings-sync');

async function requirePath(candidate, message) {
    try {
        await fs.access(candidate);
    } catch {
        throw new Error(message);
    }
}

await requirePath(path.join(sillyTavernRoot, 'src', 'users.js'), `Not a SillyTavern root: ${sillyTavernRoot}`);
await requirePath(path.join(source, 'index.js'), `Server plugin is missing: ${source}`);
await fs.mkdir(pluginsRoot, { recursive: true });

try {
    const existing = await fs.lstat(target);
    if (!existing.isSymbolicLink()) {
        throw new Error(`Refusing to replace the existing directory: ${target}`);
    }
    const current = await fs.realpath(target);
    const expected = await fs.realpath(source);
    if (current !== expected) throw new Error(`The existing link points elsewhere: ${target}`);
    console.log(`Server plugin link is already correct: ${target}`);
} catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    console.log(`Linked server plugin: ${target} -> ${source}`);
}

console.log('Set enableServerPlugins: true in config.yaml, then restart SillyTavern.');
console.log('After restart, the API is mounted at /api/plugins/device-settings-sync.');
