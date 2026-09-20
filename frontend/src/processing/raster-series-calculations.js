/** Group area formulas per raster and retain a separate result for each source. */
import { calculationIntent } from "./calculation-session.js";
import { normalizeCalculationArea } from "./calculation-area.js";
import { AUTOMATIC_CALCULATION_LIMITS, canAutomaticallyCalculate } from "./calculation-policy.js";
import { performanceDescription } from "./calculation-performance.js";
import { describeJobProgress } from "./presentation.js";

/** Run a raster stack through Processing, with at most one pending request and five formulas. */
export class RasterSeriesCalculations {
    /** Connect formula validation and the shared Processing queue.
     * @param {Object} options Providers.
     * @param {import("./api.js").ProcessingApiClient} options.api Formula validator.
     * @param {import("./calculation-queue.js").CalculationQueue} options.queue Shared executor.
     * @param {Object} [options.clock=globalThis] Debounce timer provider.
     * @param {()=>number} [options.now] Monotonic browser clock in milliseconds.
     */
    constructor({ api, queue, clock = globalThis, now = () => performance.now() }) {
        Object.assign(this, { api, clock, now });
        this.onChange = () => {};
        this.formulas = [];
        this.sources = [];
        this.area = null;
        this.areaLabel = "";
        this.active = false;
        this.version = 0;
        this.results = new Map();
        this.previousResults = null;
        this.current = null;
        this.message = "";
        this.busy = false;
        this.confirmation = false;
        this.validated = false;
        this.client = queue.createClient("raster-series", state => this.receiveCalculationProgress(state));
    }

    /** Connect presentation without exposing the executor to the view.
     * @param {()=>void} onChange Refresh the owning series view. @return {void}
     */
    bind(onChange) { this.onChange = onChange; }

    /** Cancel a recovered stack job: the unsaved remainder must never restart on reload.
     * The executor still recovers an uncertain submission's original request key before cancellation.
     * @return {Promise<void>} Shared observer startup and cancellation recovery.
     */
    async start() {
        if (this.client.snapshot.unfinishedCalculation) this.client.stop();
        await this.client.start();
    }

    /** Set selected sources and the exact committed area supplied by composition.
     * Presentation-only ordering, names and area labels do not restart work.
     * @param {Object[]} sources Selected catalog rasters.
     * @param {Object|null} area Processing sampling-area descriptor.
     * @param {string} label Human-readable selection description.
     * @param {{id:number,label:string,expression:string}[]} formulas Caller-owned formula snapshots.
     * @return {void}
     * @throws {TypeError} If the area violates the Processing input contract.
     */
    setInputs(sources, area, label, formulas) {
        const normalized = area ? normalizeCalculationArea(area) : null;
        const key = JSON.stringify([sources.map(source => [source.key, source.item.collection, source.item.id]).sort(),
            normalized, formulas.map(({id,expression}) => [id,expression.trim()])]);
        this.formulas = formulas.map(formula => ({ ...formula }));
        this.sources = sources.map(source => ({ ...source }));
        this.area = normalized;
        this.areaLabel = label;
        if (this.inputKey !== key) { this.inputKey = key; this.invalidateResults(); }
        else this.onChange();
    }

    /** Start missing results only while area statistics is the visible series mode.
     * Leaving the mode cancels remaining and in-flight calculations.
     * @param {boolean} active Whether to calculate on input changes. @return {void}
     */
    setActive(active) {
        if (this.active === active) return;
        this.active = active;
        if (!active && (this.busy || this.current)) this.cancelRemainingRasters();
        else if (active && !this.complete) this.scheduleCalculation();
    }

    /** Mark all existing values as previous before replacing the area or formulas. @return {void} */
    invalidateResults() {
        if (this.results.size) this.previousResults = new Map(this.results);
        this.cancelRemainingRasters();
        this.results = new Map();
        this.complete = false;
        this.confirmation = false;
        this.validated = false;
        this.authorized = false;
        this.budget = { nativeBlocks: 0, decodedBytes: 0, geometryCells: 0 };
        if (this.active) this.scheduleCalculation();
        else this.onChange();
    }

    /** Cancel obsolete input, retaining only completed values for optional display. @return {void} */
    cancelRemainingRasters() {
        this.version++;
        this.clock.clearTimeout(this.timer);
        this.validation?.abort();
        this.current = null;
        this.busy = false;
        this.client.stop();
        this.message = "Calculation stopped. Calculate to continue.";
        this.onChange();
    }

    /** Debounce formula edits and area replacements before validation and planning. @return {void} */
    scheduleCalculation() {
        this.clock.clearTimeout(this.timer);
        this.message = "Checking formulas…";
        this.busy = true;
        this.timer = this.clock.setTimeout(() => void this.calculateRemainingRasters(false), 700);
        this.onChange();
    }

    /** Validate the formulas once, then calculate each selected source in sequence.
     * An explicit button authorizes the remaining stack, including large areas.
     * @param {boolean} [authorize=true] Whether the user explicitly requested this stack.
     * @return {Promise<void>} Formula validation and first queued calculation.
     */
    async calculateRemainingRasters(authorize = true) {
        this.clock.clearTimeout(this.timer);
        if (!this.active || this.current) return;
        const area = this.area;
        if (!this.sources.length || this.sources.length > 50 || !area) {
            this.busy = false; this.message = !area ? "Choose an area or click the map to calculate." : "Select between 1 and 50 rasters.";
            this.onChange(); return;
        }
        if (this.client.snapshot.recoverable) {
            this.message = "Recover the previous calculation before starting another.";
            this.busy = false; this.onChange(); return;
        }
        const version = this.version;
        this.authorized ||= authorize;
        this.confirmation = false;
        this.busy = true;
        this.validation?.abort();
        const validation = this.validation = new AbortController();
        try {
            const formulas = this.formulas.map(formula => ({ label: "stat-" + formula.id, expression: formula.expression.trim() }));
            const first = calculationIntent({ source: this.calculationSource(this.sources[0]), area, calculations: formulas });
            if (!this.validated) await this.api.validateCalculation(first.calculations, validation.signal);
            if (version !== this.version || !this.active) return;
            this.validated = true;
            this.queueNextRaster();
        } catch (error) {
            if (version !== this.version || error.name === "AbortError") return;
            this.message = error.message; this.busy = false; this.onChange();
        }
    }

    /** Translate a catalog snapshot into the path-free Processing identity.
     * @param {Object} source Catalog raster. @return {Object} Calculation source.
     */
    calculationSource(source) {
        return { collectionId: source.item.collection, itemId: source.item.id, label: source.label };
    }

    /** Queue the next unfinished source; all formulas share its one raster pass. @return {void} */
    queueNextRaster() {
        if (!this.active || !this.busy || !this.validated || this.current) return;
        const source = this.sources.find(item => !this.results.has(item.key));
        if (!source) {
            this.complete = true; this.busy = false; this.message = "Raster series complete."; this.onChange(); return;
        }
        const intent = calculationIntent({ source: this.calculationSource(source),
            area: this.area,
            calculations: this.formulas.map(formula => ({ label: "stat-" + formula.id, expression: formula.expression.trim() })) });
        this.current = { key: source.key, intent, startedAt: this.now(), submitted: false };
        this.message = "Preparing " + source.label;
        this.client.prepare(intent);
        this.onChange();
    }

    /** Decide whether the remaining automatic stack stays within the shared small-box budget.
     * Cached plans consume no raster-work budget.
     * @param {Object} plan Server plan. @return {boolean} Safe to submit without confirmation.
     */
    canCalculatePlanAutomatically(plan) {
        if (this.authorized || plan.cacheHit) return true;
        if (!canAutomaticallyCalculate(plan, this.current.intent)) return false;
        const estimates = { nativeBlocks: plan.grid.nativeBlocks, decodedBytes: plan.grid.decodedBytes,
            geometryCells: plan.grid.groundArea?.estimatedGeometryCells ?? 0 };
        return Object.entries(estimates).every(([key, value]) => (this.budget?.[key] ?? 0) + value <= AUTOMATIC_CALCULATION_LIMITS[key]);
    }

    /** Record only the current area's result and advance after acknowledged completion.
     * Lifecycle retries, cancellation and durable recovery remain in Processing.
     * @param {Object} state This caller's execution snapshot. @return {void}
     */
    receiveCalculationProgress(state) {
        const current = this.current;
        if (!current) { this.onChange(); return; }
        /** Compare executor settings with the one current per-raster request.
         * @param {Object|null} value Executor calculation.
         * @return {boolean} True for this exact source, area and grouped formulas.
         */
        const matches = value => JSON.stringify(value) === JSON.stringify(current.intent);
        if (state.completedJob && matches(state.completedCalculation) && current.submitted &&
            state.completedJob.jobId !== current.previousJobId && !state.unfinishedCalculation && state.isIdle) {
            this.results.set(current.key, { job: state.completedJob, intent: current.intent,
                elapsedSeconds: (this.now() - current.startedAt) / 1000,
                performanceLines: performanceDescription(state.completedJob) });
            this.current = null;
            this.onChange();
            queueMicrotask(() => this.queueNextRaster());
            return;
        }
        if (state.recoverable || state.admission === "retry") {
            this.message = state.message;
            this.busy = false;
            if (!state.recoverable) this.current = null;
            this.onChange(); return;
        }
        if (state.plan && state.isIdle && matches(state.plannedCalculation)) {
            if (!this.canCalculatePlanAutomatically(state.plan)) {
                this.confirmation = true; this.busy = false; this.current = null;
                this.message = "This area or stack needs a larger calculation. Calculate the remaining rasters, or choose a smaller area.";
                this.client.discardPendingCalculation(); this.onChange(); return;
            }
            current.previousJobId = state.completedJob?.jobId;
            current.submitted = true;
            if (!state.plan.cacheHit) {
                this.budget ??= { nativeBlocks: 0, decodedBytes: 0, geometryCells: 0 };
                this.budget.nativeBlocks += state.plan.grid.nativeBlocks;
                this.budget.decodedBytes += state.plan.grid.decodedBytes;
                this.budget.geometryCells += state.plan.grid.groundArea?.estimatedGeometryCells ?? 0;
            }
            this.client.submit(state.plan.planId, { automatic: !this.authorized });
            return;
        }
        if (current.submitted && state.isIdle && !state.plan && !state.unfinishedCalculation) {
            this.results.set(current.key, { intent: current.intent, error: state.message || "No result returned." });
            this.current = null; this.onChange(); queueMicrotask(() => this.queueNextRaster()); return;
        }
        this.message = state.currentJob ? describeJobProgress(state.currentJob) : state.message;
        this.onChange();
    }

    /** Read whether the previous submission needs explicit recovery.
     * @return {boolean} True while its result or cancellation remains uncertain.
     */
    get needsRecovery() { return this.client.snapshot.recoverable; }

    /** Retry uncertain submission/cleanup without creating a new request key.
     * @return {Promise<void>} Recovery step; the user can then continue the remaining stack.
     */
    async recover() {
        this.busy = !!this.current;
        await this.client.retry();
        if (!this.current && !this.complete && !this.needsRecovery) {
            this.busy = false;
            this.message = "Previous calculation recovered. Calculate to continue.";
        }
        this.onChange();
    }

    /** Release timers and observation; submitted recovery remains owned by Processing. @return {void} */
    destroy() {
        this.clock.clearTimeout(this.timer);
        this.validation?.abort();
        this.client.destroy();
    }
}
