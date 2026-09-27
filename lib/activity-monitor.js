import { requestCategory } from './auto-core.js';

// Metadata only. Keep the original Response, body and promise rejection intact.
// Resource Timing arrives after the body transfer, unlike fetch's headers promise.
export function monitorActivity({ window: root, eventSource, eventTypes, begin, end, limitation = () => {} }) {
    let enabled = true;
    const realms = new Map();
    const generation = new Set();
    let overlappingGeneration = false;
    const cleanups = [];
    const resourceKey = raw => { const url = new URL(raw); return url.origin + url.pathname; };
    function watch(win) {
        if (!enabled || realms.has(win)) return;
        try {
            // Accessing document rejects sandboxed/cross-origin frames; accessible
            // about:blank/srcdoc frames inherit the parent's security origin.
            void win.document.documentElement;
            if (win.location.origin !== root.location.origin && !['about:blank', 'about:srcdoc'].includes(win.location.href)) { limitation(); return; }
            if (!win.PerformanceObserver) { limitation(); return; }
        } catch { limitation(); return; }
        const pending = new Set();
        const teardown = [];
        realms.set(win, teardown);
        function start(url, method) {
            if (!enabled) return null;
            const category = requestCategory(url, method, win.location.href);
            if (!category) return null;
            // SillyTavern's generation lifecycle already covers its own model
            // request through the end of streaming. Resource Timing can omit a
            // completion entry for a cancelled stream, leaving a second lock
            // held forever if we track the same request twice.
            if (win === root && category === 'generation' && generation.size && !overlappingGeneration) return null;
            const item = { id: begin(), url: resourceKey(new URL(url, win.location.href)), at: win.performance.now() };
            pending.add(item);
            return item;
        }
        function finish(item) {
            if (item && pending.delete(item)) { item.removeAbort?.(); end(item.id); }
        }
        const observer = new win.PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                // The queued resource entry itself marks completion, including
                // aborted transfers. Do not require a nonzero responseEnd as
                // an additional completion signal.
                if (entry.initiatorType !== 'fetch') continue;
                const candidates = [...pending].filter(item => item.url === resourceKey(entry.name) && item.at <= entry.startTime + 1 && item.transport === 'fetch');
                // Same-URL concurrent requests are all kept busy until each transfer
                // has a matching completion. Never use response headers as an end.
                candidates.sort((a, b) => a.at - b.at);
                if (candidates.length) finish(candidates[0]);
            }
        });
        observer.observe({ type: 'resource' });
        teardown.push(() => observer.disconnect());
        const originalFetch = win.fetch;
        const wrappedFetch = function(input, init) {
            let item;
            try {
                const request = input instanceof win.Request ? input : null;
                item = start(request ? request.url : String(input), init?.method || request?.method || 'GET');
                if (item) {
                    item.transport = 'fetch';
                    const signal = init?.signal || request?.signal;
                    const abort = () => finish(item);
                    signal?.addEventListener('abort', abort, { once: true });
                    item.removeAbort = () => signal?.removeEventListener('abort', abort);
                }
            } catch { limitation(); }
            try {
                const promise = Reflect.apply(originalFetch, this, [input, init]);
                // Attach a rejection observer, but return the original promise.
                if (item) promise.then(() => {}, () => finish(item));
                return promise;
            } catch (error) { finish(item); throw error; }
        };
        win.fetch = wrappedFetch;
        teardown.push(() => { if (win.fetch === wrappedFetch) win.fetch = originalFetch; });
        const prototype = win.XMLHttpRequest.prototype;
        const open = prototype.open;
        const send = prototype.send;
        const requests = new WeakMap();
        const wrappedOpen = function(method, url, ...args) {
            const result = Reflect.apply(open, this, [method, url, ...args]);
            requests.set(this, { method, url });
            return result;
        };
        const wrappedSend = function(...args) {
            const meta = requests.get(this);
            let item;
            try { item = meta ? start(meta.url, meta.method) : null; } catch { limitation(); }
            const done = () => finish(item);
            if (item) this.addEventListener('loadend', done, { once: true });
            try { return Reflect.apply(send, this, args); }
            catch (error) { this.removeEventListener('loadend', done); finish(item); throw error; }
        };
        prototype.open = wrappedOpen;
        prototype.send = wrappedSend;
        teardown.push(() => {
            if (prototype.open === wrappedOpen) prototype.open = open;
            if (prototype.send === wrappedSend) prototype.send = send;
            for (const item of [...pending]) finish(item);
        });
        function frames() {
            for (const frame of win.document.querySelectorAll('iframe')) {
                watch(frame.contentWindow);
                if (!frame.__dssActivityLoad) {
                    const load = () => watch(frame.contentWindow);
                    frame.addEventListener('load', load);
                    frame.__dssActivityLoad = load;
                    teardown.push(() => { frame.removeEventListener('load', load); delete frame.__dssActivityLoad; });
                }
            }
        }
        const mutations = new win.MutationObserver(frames);
        mutations.observe(win.document.documentElement, { childList: true, subtree: true });
        teardown.push(() => mutations.disconnect());
        frames();
        const unload = () => {
            for (const dispose of teardown.splice(0)) dispose();
            realms.delete(win);
        };
        win.addEventListener('pagehide', unload, { once: true });
        teardown.push(() => win.removeEventListener('pagehide', unload));
        const frame = win.frameElement;
        if (frame) {
            const detached = new root.MutationObserver(() => { if (!frame.isConnected) unload(); });
            detached.observe(root.document.documentElement, { childList: true, subtree: true });
            teardown.push(() => detached.disconnect());
        }
    }
    watch(root);
    if (eventSource && eventTypes) {
        const started = (type, options, dryRun) => {
            if (!enabled || dryRun || type === 'quiet' || options?.quiet_prompt) return;
            // The host can enter Generate() more than once while its single
            // stop button is visible. One UI session gets one native lock;
            // transport tracking stays on for overlapping model requests.
            if (generation.size) { overlappingGeneration = true; return; }
            generation.add(begin());
        };
        const stopped = () => {
            for (const id of generation) end(id);
            generation.clear();
            overlappingGeneration = false;
        };
        // GENERATION_ENDED is emitted by hideStopButton(), not once per
        // Generate() call. Releasing only one start leaves a phantom lock.
        const ended = () => stopped();
        for (const [type, callback] of [[eventTypes.GENERATION_STARTED, started], [eventTypes.GENERATION_ENDED, ended], [eventTypes.GENERATION_STOPPED, stopped]]) {
            if (!type) continue;
            eventSource.on(type, callback);
            cleanups.push(() => eventSource.removeListener(type, callback));
        }
        cleanups.push(stopped);
    }
    return () => {
        enabled = false;
        for (const teardown of realms.values()) for (const dispose of teardown.splice(0)) dispose();
        realms.clear();
        for (const dispose of cleanups) dispose();
    };
}
