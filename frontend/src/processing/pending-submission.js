/** Reload recovery for one uncertain submission. No cookies, geometry, or result files are stored. */
const KEY = "eolab.processing.pending.v1";

/** Own the minimal per-tab idempotency record. */
export class PendingSubmissionStorage {
    /** @param {Storage|null} storage Browser session storage; null disables submission recovery. */
    constructor(storage) { this.storage = storage; }

    /** Read a bounded validated record after reload. @return {Object|null} Submission identity and display label. */
    read() {
        try {
            const text = this.storage?.getItem(KEY);
            if (!text || text.length > 2048) return null;
            const value = JSON.parse(text);
            if (!/^[A-Za-z0-9_-]{32}$/.test(value.planId) ||
                !/^[A-Za-z0-9_-]{16,80}$/.test(value.requestId) ||
                typeof value.label !== "string" || value.label.length > 512) return null;
            return { planId: value.planId, requestId: value.requestId, label: value.label };
        } catch { return null; }
    }

    /** Persist before dispatch so a lost response can be retried safely. @param {Object} value Stable submission record. @return {void} */
    write(value) {
        if (!this.storage) throw new Error("Browser session storage is unavailable. Enable it to create recoverable downloads.");
        this.storage.setItem(KEY, JSON.stringify(value));
    }

    /** Clear a confirmed submission. @return {void} */
    clear() { this.storage?.removeItem(KEY); }
}
