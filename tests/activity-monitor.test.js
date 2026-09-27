import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorActivity } from '../lib/activity-monitor.js';

function fixture({ withFrame = false } = {}) {
    const active = new Set();
    const listeners = new Map();
    const observers = [];
    let nextId = 0;
    class PerformanceObserver {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe() {}
        disconnect() {}
        report(entries) { this.callback({ getEntries: () => entries }); }
    }
    class MutationObserver { observe() {} disconnect() {} }
    class XMLHttpRequest {
        open() {}
        send() {}
    }
    const win = {
        location: { origin: 'https://tavern.test', href: 'https://tavern.test/' },
        document: { documentElement: {}, querySelectorAll: () => [] },
        performance: { now: () => 100 },
        PerformanceObserver, MutationObserver, XMLHttpRequest,
        Request: class Request {},
        fetch: async () => ({ ok: true }),
        addEventListener() {}, removeEventListener() {},
    };
    const frame = withFrame ? { isConnected: true, addEventListener() {}, removeEventListener() {} } : null;
    const child = frame ? {
        ...win, document: { documentElement: {}, querySelectorAll: () => [] },
        frameElement: frame, fetch: async () => ({ ok: true }),
    } : null;
    if (frame) {
        frame.contentWindow = child;
        win.document.querySelectorAll = () => [frame];
    }
    const eventSource = {
        on(type, callback) { listeners.set(type, callback); },
        removeListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
        emit(type, ...args) { listeners.get(type)?.(...args); },
    };
    const eventTypes = { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop' };
    const stop = monitorActivity({ window: win, eventSource, eventTypes,
        begin: () => { const id = ++nextId; active.add(id); return id; }, end: id => active.delete(id) });
    return { win, child, active, observers, eventSource, stop };
}

test('native generation lifecycle is the only lock for its own fetch, even without Resource Timing', async () => {
    const f = fixture();
    f.eventSource.emit('start');
    assert.equal(f.active.size, 1);
    await f.win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
    assert.equal(f.active.size, 1, 'the fetch must not leave a second lock after the generation ends');
    f.eventSource.emit('end');
    assert.equal(f.active.size, 0);
    f.stop();
});

test('overlapping start events need only one host end event and keep the second transport tracked', async () => {
    const f = fixture();
    f.eventSource.emit('start', 'normal', {}, false);
    await f.win.fetch('/v1/responses', { method: 'POST' });
    assert.equal(f.active.size, 1);
    f.eventSource.emit('start', 'normal', {}, false);
    await f.win.fetch('/v1/responses', { method: 'POST' });
    assert.equal(f.active.size, 2, 'the overlapping transport remains protected independently');
    f.eventSource.emit('end');
    assert.equal(f.active.size, 1, 'the host has only one end event for its visible generation session');
    f.observers[0].report([{ initiatorType: 'fetch', name: 'https://tavern.test/v1/responses', startTime: 101, responseEnd: 200 }]);
    assert.equal(f.active.size, 0);
    f.stop();
});

test('quiet generations do not create an unmatched native lock but still track their model transport', async () => {
    const f = fixture();
    f.eventSource.emit('start', 'quiet', {}, false);
    assert.equal(f.active.size, 0);
    await f.win.fetch('/v1/responses', { method: 'POST' });
    assert.equal(f.active.size, 1);
    f.observers[0].report([{ initiatorType: 'fetch', name: 'https://tavern.test/v1/responses', startTime: 101, responseEnd: 200 }]);
    assert.equal(f.active.size, 0);
    f.stop();
});

test('model requests outside a native generation still wait for transfer completion', async () => {
    const f = fixture();
    await f.win.fetch('/v1/responses', { method: 'POST' });
    assert.equal(f.active.size, 1, 'fetch resolving headers does not end the request');
    f.observers[0].report([{ initiatorType: 'fetch', name: 'https://tavern.test/v1/responses', startTime: 101, responseEnd: 200 }]);
    assert.equal(f.active.size, 0);
    f.stop();
});

test('a failed transfer with a zero responseEnd resource entry releases its request lock', async () => {
    const f = fixture();
    await f.win.fetch('/v1/responses', { method: 'POST' });
    assert.equal(f.active.size, 1);
    f.observers[0].report([{ initiatorType: 'fetch', name: 'https://tavern.test/v1/responses', startTime: 101, responseEnd: 0 }]);
    assert.equal(f.active.size, 0);
    f.stop();
});

test('retrieval requests remain independently tracked during a native generation', async () => {
    const f = fixture();
    f.eventSource.emit('start');
    await f.win.fetch('/v1/embeddings', { method: 'POST' });
    assert.equal(f.active.size, 2);
    f.eventSource.emit('end');
    assert.equal(f.active.size, 1);
    f.observers[0].report([{ initiatorType: 'fetch', name: 'https://tavern.test/v1/embeddings', startTime: 101, responseEnd: 200 }]);
    assert.equal(f.active.size, 0);
    f.stop();
});

test('an independent same-origin iframe model request is not hidden by the main generation event', async () => {
    const f = fixture({ withFrame: true });
    f.eventSource.emit('start');
    await f.child.fetch('/v1/responses', { method: 'POST' });
    assert.equal(f.active.size, 2);
    f.eventSource.emit('end');
    assert.equal(f.active.size, 1);
    f.observers[1].report([{ initiatorType: 'fetch', name: 'https://tavern.test/v1/responses', startTime: 101, responseEnd: 200 }]);
    assert.equal(f.active.size, 0);
    f.stop();
});
