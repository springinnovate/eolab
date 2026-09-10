/** Catalog-owned scan actions and recoverable observation of authoritative status. */

const POLL_DELAY_MS = 750;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const STATUS_TIMEOUT_MS = 10000;
const ACTIVE_STATES = new Set(["discovering", "scanning"]);
const SCAN_STATES = new Set([...ACTIVE_STATES, "not_started", "completed", "failed"]);

/**
 * Observe scan progress without owning scan execution or Catalog search.
 *
 * Transport failures retain the last snapshot and retry only status reads.
 * A generation and AbortController fence obsolete requests and timers. The
 * existing renderer and refresh callback remain application composition inputs.
 */
export class CatalogScanControls {
    /**
     * @param {Object} options Owned UI and browser capabilities.
     * @param {Document} options.documentContext Document containing scan controls.
     * @param {Window} options.windowContext Timer and page-lifecycle provider.
     * @param {typeof fetch} [options.fetchImpl=globalThis.fetch] HTTP transport.
     * @param {(status: Object) => void} options.renderStatus Render a server snapshot.
     * @param {() => Promise<void>} options.refreshCatalog Refresh the active search.
     */
    constructor({ documentContext, windowContext, fetchImpl = globalThis.fetch,
        renderStatus, refreshCatalog }) {
        this.document = documentContext;
        this.window = windowContext;
        this.fetch = fetchImpl;
        this.renderStatus = renderStatus;
        this.refreshCatalog = refreshCatalog;
        this.startButton = documentContext.querySelector("#start-scan");
        this.retryButton = documentContext.querySelector("#retry-scan-status");
        this.recovery = documentContext.querySelector("#scan-status-recovery");
        this.warning = documentContext.querySelector("#scan-status-warning");
        this.generation = 0;
        this.timer = null;
        this.deadline = null;
        this.request = null;
        this.failures = 0;
        this.refreshWhenComplete = false;
        this.refreshedId = null;
        this.completion = null;
        this.starting = false;
        this.paused = false;
        this.closed = false;
        this.retryHadFocus = false;
        this.boundStart = () => { void this.startScan(); };
        this.boundRetry = () => { void this.observe(); };
        this.boundHide = () => this.pause();
        this.boundShow = event => { if (event.persisted) void this.resume(); };
        this.startButton.addEventListener("click", this.boundStart);
        this.retryButton.addEventListener("click", this.boundRetry);
        windowContext.addEventListener("pagehide", this.boundHide);
        windowContext.addEventListener("pageshow", this.boundShow);
    }

    /**
     * Check status now, replacing any older observation and retry budget.
     * Never starts a server scan; failures are rendered rather than rejected.
     * @return {Promise<void>} Resolves after this check or its replacement.
     */
    async observe() {
        if (this.closed || this.paused || this.starting) return;
        this.cancelObservation();
        this.failures = 0;
        this.startButton.disabled = true;
        if (!this.recovery.hidden) this.warning.textContent = "Checking scan status…";
        await this.check(this.generation);
    }

    /**
     * Start a scan only for an explicit enabled-button action; 409 attaches to
     * the existing scan. An uncertain POST is never automatically resubmitted.
     * @return {Promise<void>} Resolves after initiation and the first status check.
     */
    async startScan() {
        if (this.closed || this.paused || this.starting || this.startButton.disabled) return;
        this.cancelObservation();
        const generation = this.generation;
        const request = new AbortController();
        this.request = request;
        this.starting = true;
        const timeout = this.window.setTimeout(() => request.abort(), STATUS_TIMEOUT_MS);
        this.deadline = timeout;
        this.refreshWhenComplete = true;
        this.startButton.disabled = true;
        this.startButton.textContent = "Starting scan…";
        this.retryButton.disabled = true;
        this.document.querySelector("#scan-status-disclosure").open = true;
        this.document.querySelector("#scan-errors-disclosure").open = false;
        try {
            const response = await this.fetch("/api/scans", {
                method: "POST", headers: { Accept: "application/json" }, signal: request.signal,
            });
            if (!this.isCurrent(generation)) return;
            if (!response.ok && response.status !== 409) {
                throw new Error(`Starting scan returned ${response.status}`);
            }
        } catch (error) {
            if (this.isCurrent(generation)) {
                this.showUnavailable(`Could not confirm scan startup: ${error.message}. Check status before starting another scan.`, null);
            }
            return;
        } finally {
            this.window.clearTimeout(timeout);
            if (this.deadline === timeout) this.deadline = null;
            if (this.request === request) this.request = null;
            if (generation === this.generation) this.starting = false;
        }
        if (this.isCurrent(generation)) await this.observe();
    }

    /**
     * Read and render one snapshot, scheduling recovery for this generation only.
     * @param {number} generation Current observation identity.
     * @return {Promise<void>} Resolves after handling success, failure or cancellation.
     */
    async check(generation) {
        if (!this.isCurrent(generation)) return;
        this.retryHadFocus ||= this.document.activeElement === this.retryButton;
        this.retryButton.disabled = true;
        const request = new AbortController();
        this.request = request;
        const timeout = this.window.setTimeout(() => request.abort(), STATUS_TIMEOUT_MS);
        this.deadline = timeout;
        let refreshing = false;
        try {
            const response = await this.fetch("/api/scans/current", {
                headers: { Accept: "application/json" }, signal: request.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const status = await response.json();
            this.window.clearTimeout(timeout);
            if (this.deadline === timeout) this.deadline = null;
            if (!this.isCurrent(generation)) return;
            if (!status || !SCAN_STATES.has(status.state) ||
                (status.state !== "not_started" && typeof status.id !== "string")) {
                throw new Error("Invalid scan status response");
            }
            this.renderStatus(status);
            if (ACTIVE_STATES.has(status.state)) {
                this.refreshWhenComplete = true;
                this.schedule(generation, POLL_DELAY_MS);
            } else if (status.state === "completed" && this.refreshWhenComplete && status.id !== this.refreshedId) {
                refreshing = true;
                // A manual retry during an outstanding refresh shares that refresh.
                if (this.completion?.id !== status.id) {
                    this.completion = { id: status.id, promise: Promise.resolve().then(this.refreshCatalog) };
                }
                const completion = this.completion;
                try {
                    await completion.promise;
                    this.refreshedId = status.id;
                } finally {
                    if (this.completion === completion) this.completion = null;
                }
            }
            if (!this.isCurrent(generation)) return;
            this.failures = 0;
            const retryFocused = this.retryHadFocus &&
                [this.retryButton, this.document.body].includes(this.document.activeElement);
            this.recovery.hidden = true;
            if (retryFocused) this.document.querySelector("#scan-status-summary").focus();
            this.retryHadFocus = false;
        } catch (error) {
            if (!this.isCurrent(generation)) return;
            // Even an initial unavailable snapshot may have missed a completion.
            this.refreshWhenComplete = true;
            const delay = RETRY_DELAYS_MS[this.failures++] ?? null;
            const reason = request.signal.aborted ? "request timed out" : error.message;
            const message = refreshing
                ? `Scan completed, but the Catalog could not refresh (${reason}).`
                : `Scan status unavailable (${reason}). The scan may still be running; the last received status is shown below.`;
            this.showUnavailable(message, delay);
            if (delay !== null) this.schedule(generation, delay);
        } finally {
            this.window.clearTimeout(timeout);
            if (this.deadline === timeout) this.deadline = null;
            if (this.request === request) this.request = null;
        }
    }

    /**
     * Present loss of observation separately from the last server snapshot.
     * @param {string} message Safe text describing the unavailable operation.
     * @param {number|null} delay Automatic retry delay, or null for manual retry.
     * @return {void}
     */
    showUnavailable(message, delay) {
        this.startButton.disabled = true;
        this.startButton.textContent = "Scan directories";
        this.recovery.hidden = false;
        this.retryButton.disabled = false;
        this.warning.textContent = `${message} ${delay === null
            ? "Retry the status check to reconnect."
            : `Retrying in ${delay / 1000} ${delay === 1000 ? "second" : "seconds"}.`}`;
        if (this.retryHadFocus && this.document.activeElement === this.document.body) this.retryButton.focus();
    }

    /**
     * Schedule one check after the current request has settled.
     * @param {number} generation Observation allowed to receive the result.
     * @param {number} delay Milliseconds until the next check.
     * @return {void}
     */
    schedule(generation, delay) {
        this.window.clearTimeout(this.timer);
        this.timer = this.window.setTimeout(() => {
            this.timer = null;
            void this.check(generation);
        }, delay);
    }

    /** @param {number} generation Candidate identity. @return {boolean} Whether it is live. */
    isCurrent(generation) {
        return !this.closed && !this.paused && generation === this.generation;
    }

    /** Invalidate timers and abort any obsolete HTTP request. @return {void} */
    cancelObservation() {
        ++this.generation;
        this.window.clearTimeout(this.timer);
        this.timer = null;
        this.window.clearTimeout(this.deadline);
        this.deadline = null;
        this.request?.abort();
        this.request = null;
        this.starting = false;
    }

    /** Stop network observation while the page is away, including bfcache. @return {void} */
    pause() {
        this.paused = true;
        this.cancelObservation();
    }

    /** Reconcile authoritative status when a cached page returns. @return {Promise<void>} */
    async resume() {
        this.paused = false;
        await this.observe();
    }

    /** Release this owner's requests, timers and fixed listeners. @return {void} */
    close() {
        this.closed = true;
        this.cancelObservation();
        this.startButton.removeEventListener("click", this.boundStart);
        this.retryButton.removeEventListener("click", this.boundRetry);
        this.window.removeEventListener("pagehide", this.boundHide);
        this.window.removeEventListener("pageshow", this.boundShow);
    }
}
