export function connectionInfo(win = window) {
    const host = String(win.location?.hostname || '').replace(/^\[|\]$/gu, '').toLowerCase();
    const ipv4 = host.split('.').map(Number);
    const privateIPv4 = /^\d+\.\d+\.\d+\.\d+$/u.test(host) && ipv4.every(n => n >= 0 && n <= 255)
        && (ipv4[0] === 10 || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) || (ipv4[0] === 192 && ipv4[1] === 168));
    const privateIP = privateIPv4 || /^f[cd][0-9a-f]{2}:/u.test(host);
    const mode = win.isSecureContext ? 'secure' : win.location?.protocol === 'http:' ? 'http' : 'unsupported';
    const capabilities = { webLocks: Boolean(win.navigator?.locks?.request), indexedDB: Boolean(win.indexedDB?.open),
        worker: Boolean(win.Worker), webCrypto: Boolean(win.crypto?.subtle), randomValues: Boolean(win.crypto?.getRandomValues),
        resourceTiming: Boolean(win.PerformanceObserver), storageObserver: Boolean(win.document?.createElement) };
    return { mode, privateIP, capabilities };
}
