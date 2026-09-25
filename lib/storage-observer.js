// Observe localStorage through its specified cross-context storage event. The
// extension never replaces or wraps Storage.prototype methods.
export class StorageObserver {
    constructor({ window: win = window, onKey, onClear, onError } = {}) {
        this.win = win;
        this.onKey = onKey || (() => {});
        this.onClear = onClear || (() => {});
        this.onError = onError || (() => {});
        this.frame = null;
        this.readyPromise = null;
        this.readyTimer = null;
        this.listener = event => {
            if (event.key === null) this.onClear();
            else this.onKey(event.key);
        };
        this.loadListener = () => this.attach();
        this.pagehide = () => this.detach(false);
        this.pageshow = () => this.start();
    }

    start() {
        if (this.frame?.isConnected) return this.readyPromise || Promise.resolve();
        try {
            this.readyPromise = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
            const frame = this.win.document.createElement('iframe');
            frame.setAttribute('aria-hidden', 'true');
            frame.tabIndex = -1;
            frame.style.cssText = 'display:none!important;width:0;height:0;border:0';
            frame.addEventListener('load', this.loadListener, { once: true });
            this.frame = frame;
            this.win.addEventListener('pagehide', this.pagehide);
            this.win.addEventListener('pageshow', this.pageshow);
            this.readyTimer = this.win.setTimeout(() => {
                const error = new Error('Same-origin storage observer did not become ready');
                this.rejectReady?.(error);
                this.onError(error);
            }, 3000);
            // A newly created iframe already has an initial about:blank document
            // that inherits this document's origin. Keep it: navigating it to
            // an explicit about:blank after attaching can discard the listener.
            (this.win.document.body || this.win.document.documentElement).append(frame);
            if (frame.contentDocument?.readyState === 'complete') this.attach();
            return this.readyPromise;
        } catch (error) {
            this.detach();
            this.onError(error);
            return Promise.reject(error);
        }
    }

    attach() {
        try {
            const child = this.frame?.contentWindow;
            if (child && this.attachedWindow === child) return;
            // about:blank inherits its creator's Window origin, but serializing
            // its Location.origin can still return "null". Window.origin is
            // the right same-origin check for this inherited document.
            const parentOrigin = this.win.origin || this.win.location.origin;
            const childOrigin = child?.origin && child.origin !== 'null' ? child.origin : child?.location?.origin;
            if (!child || childOrigin !== parentOrigin) throw new Error('Same-origin storage observer is unavailable');
            child.addEventListener('storage', this.listener);
            this.attachedWindow = child;
            this.win.clearTimeout(this.readyTimer);
            this.readyTimer = null;
            this.resolveReady?.();
            this.resolveReady = this.rejectReady = null;
        } catch (error) {
            this.rejectReady?.(error);
            this.resolveReady = this.rejectReady = null;
            this.onError(error);
        }
    }

    detach(removeLifecycle = true) {
        this.attachedWindow?.removeEventListener('storage', this.listener);
        this.attachedWindow = null;
        if (this.readyTimer) this.win.clearTimeout(this.readyTimer);
        this.readyTimer = null;
        this.resolveReady?.();
        this.resolveReady = this.rejectReady = null;
        this.frame?.removeEventListener('load', this.loadListener);
        this.frame?.remove();
        this.frame = null;
        if (removeLifecycle) {
            this.win.removeEventListener('pagehide', this.pagehide);
            this.win.removeEventListener('pageshow', this.pageshow);
        }
    }

    destroy() { this.detach(); }
}
