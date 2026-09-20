/** Calculate the same area statistics for each raster selected in Raster series. */
import { calculationIntent } from "./calculation-session.js";
import { normalizeCalculationArea } from "./calculation-area.js";
import { AUTOMATIC_CALCULATION_LIMITS, canAutomaticallyCalculate } from "./calculation-policy.js";
import { performanceDescription } from "./calculation-performance.js";
import { describeJobProgress } from "./presentation.js";

/**
 * Calculate up to five formulas over one shared area for each selected raster.
 * Requests run one raster at a time through the shared Processing queue. This
 * controller keeps per-raster results, pauses for confirmation or recovery, and
 * cancels obsolete work when the inputs change or area statistics is hidden.
 */
export class RasterSeriesCalculations {
    /** Register Raster series with Processing and initialize an empty calculation list.
     * Creating the controller does not validate formulas or submit calculations.
     * Composition supplies the area; the Raster series controller supplies selected
     * rasters, formulas and visibility before work can begin.
     * @param {Object} options Providers.
     * @param {import("./api.js").ProcessingApiClient} options.api Formula validator.
     * @param {import("./calculation-queue.js").CalculationQueue} options.queue Queue shared with summary cards.
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
        this.client = queue.createClient("raster-series", state => this.handleCalculationProgress(state));
    }

    /** Replace the callback that refreshes the plot when calculation state changes.
     * The callback reads this controller's results, progress and confirmation state.
     * Register it when connecting Raster series to this calculation controller.
     * @param {()=>void} onChange Plot refresh callback; no initial notification is sent.
     * @return {void}
     */
    setProgressListener(onChange) { this.onChange = onChange; }

    /** Recover a series calculation saved before reload and request its cancellation.
     * Call once during browser startup. The remaining raster list is not saved, so
     * that old series must not resume automatically. If its submission response was
     * lost, the executor recovers the job with the original request key before cancelling.
     * Also starts shared job observation when there is no saved series calculation.
     * @return {Promise<void>} Initial recovery attempt; cancellation may finish later
     * through the shared job observer.
     */
    async recoverAndCancelPreviousCalculation() {
        if (this.client.snapshot.unfinishedCalculation) this.client.stop();
        await this.client.start();
    }

    /** Replace the selected rasters, area and formulas after a user edit.
     * Changed calculation inputs cancel old work and clear current results; new
     * calculations are scheduled only while area statistics is visible. Changes to
     * names, raster order or the area label refresh the display without recalculating.
     * @param {{key:string,label:string,item:{collection:string,id:string}}[]} sources Selected catalog rasters.
     * @param {Object|null} area Map box, filtered catalog selection, uploaded polygon reference,
     * whole-raster descriptor, or null when no area has been chosen.
     * @param {string} label Area description displayed beside the plot.
     * @param {{id:number,label:string,expression:string}[]} formulas Selected formulas and display names.
     * @return {void}
     * @throws {TypeError|Error} If the area is not a supported Processing descriptor.
     */
    updateCalculationInputs(sources, area, label, formulas) {
        const normalized = area ? normalizeCalculationArea(area) : null;
        const key = JSON.stringify([sources.map(source => [source.key, source.item.collection, source.item.id]).sort(),
            normalized, formulas.map(({id,expression}) => [id,expression.trim()])]);
        this.formulas = formulas.map(formula => ({ ...formula }));
        this.sources = sources.map(source => ({ ...source }));
        this.area = normalized;
        this.areaLabel = label;
        if (this.inputKey !== key) { this.inputKey = key; this.resetResultsForChangedInputs(); }
        else this.onChange();
    }

    /** Schedule missing results when area statistics becomes visible; cancel unfinished work when hidden.
     * Call when the Raster series panel opens/closes or switches pixel/area mode.
     * Completed results remain available when the user returns to this mode.
     * @param {boolean} visible True only when both the panel and its area-statistics mode are active.
     * @return {void}
     */
    updateCalculationForPanelVisibility(visible) {
        if (this.active === visible) return;
        this.active = visible;
        if (!visible && (this.busy || this.current)) this.cancelRemainingRasters();
        else if (visible && !this.complete) this.scheduleRemainingCalculations();
    }

    /** Clear results after a calculation input changes and schedule replacements when visible.
     * Keep completed values separately for the faded previous plot. Cancel pending
     * work, clear formula validation and confirmation, and reset the stack's automatic
     * work budget so the new inputs are checked before submission.
     * @return {void}
     */
    resetResultsForChangedInputs() {
        if (this.results.size) this.previousResults = new Map(this.results);
        this.cancelRemainingRasters();
        this.results = new Map();
        this.complete = false;
        this.confirmation = false;
        this.validated = false;
        this.authorized = false;
        this.budget = { nativeBlocks: 0, decodedBytes: 0, geometryCells: 0 };
        if (this.active) this.scheduleRemainingCalculations();
        else this.onChange();
    }

    /** Stop the unfinished series after cancellation, input replacement or hiding the plot.
     * Cancel the debounce timer and formula check, ignore late responses, and ask
     * Processing to cancel this series' submitted job. Completed results remain
     * available; the executor retains any job that still needs cancellation recovery.
     * @return {void} Cancellation is requested here and acknowledged asynchronously.
     */
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

    /** Schedule remaining calculations after 700 ms without another edit.
     * Used after input changes or reopening an unfinished area plot. Replace the
     * previous timer and show checking feedback; the delayed request validates the
     * formulas and applies confirmation rules before submitting any raster work.
     * @return {void}
     */
    scheduleRemainingCalculations() {
        this.clock.clearTimeout(this.timer);
        this.message = "Checking formulas…";
        this.busy = true;
        this.timer = this.clock.setTimeout(() => void this.calculateRemainingRasters(false), 700);
        this.onChange();
    }

    /** Begin or continue the unfinished raster series using the current area and formulas.
     * Called by Calculate or the debounce timer. Check the inputs and validate the
     * formulas once, then queue the next raster. Completion callbacks advance the
     * rest of the series; validation errors are shown in the plot without submission.
     * @param {boolean} [authorize=true] True for an explicit Calculate click approving
     * the remaining stack; false for automatic work that may need confirmation.
     * @return {Promise<void>} Completion of input checking and the first queue request,
     * not completion of the raster calculations.
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
            const first = calculationIntent({ source: this.getRasterReference(this.sources[0]), area, calculations: formulas });
            if (!this.validated) await this.api.validateCalculation(first.calculations, validation.signal);
            if (version !== this.version || !this.active) return;
            this.validated = true;
            this.queueNextRasterCalculation();
        } catch (error) {
            if (version !== this.version || error.name === "AbortError") return;
            this.message = error.message; this.busy = false; this.onChange();
        }
    }

    /** Read the catalog IDs and display name used to request one raster calculation.
     * Called while building formula-validation and calculation requests.
     * @param {{label:string,item:{collection:string,id:string}}} source Selected catalog raster.
     * @return {{collectionId:string,itemId:string,label:string}} Raster reference accepted by Processing.
     */
    getRasterReference(source) {
        return { collectionId: source.item.collection, itemId: source.item.id, label: source.label };
    }

    /** Ask Processing to prepare the next raster that has no recorded result or error.
     * Called after formula validation or the preceding raster finishes. Include all
     * selected formulas in one request so they share its reads and polygon mask.
     * Mark the series complete when every source has an outcome. Do nothing while
     * paused, hidden, unvalidated or already waiting for a raster.
     * @return {void}
     */
    queueNextRasterCalculation() {
        if (!this.active || !this.busy || !this.validated || this.current) return;
        const source = this.sources.find(item => !this.results.has(item.key));
        if (!source) {
            this.complete = true; this.busy = false; this.message = "Raster series complete."; this.onChange(); return;
        }
        const intent = calculationIntent({ source: this.getRasterReference(source),
            area: this.area,
            calculations: this.formulas.map(formula => ({ label: "stat-" + formula.id, expression: formula.expression.trim() })) });
        this.current = { key: source.key, intent, startedAt: this.now(), submitted: false };
        this.message = "Preparing " + source.label;
        this.client.prepare(intent);
        this.onChange();
    }

    /** Check whether the current raster plan can be submitted without another Calculate click.
     * An earlier explicit Calculate click approves the remaining stack. Cached results
     * also need no confirmation. Otherwise, require a small rectangular selection and
     * check this plan plus work already submitted against the automatic stack budget.
     * This check does not charge the budget; submission does.
     * @param {Object} plan Current raster's server plan with cache status and grid estimates.
     * @return {boolean} True if no additional user confirmation is needed.
     */
    canSubmitWithoutConfirmation(plan) {
        if (this.authorized || plan.cacheHit) return true;
        if (!canAutomaticallyCalculate(plan, this.current.intent)) return false;
        const estimates = { nativeBlocks: plan.grid.nativeBlocks, decodedBytes: plan.grid.decodedBytes,
            geometryCells: plan.grid.groundArea?.estimatedGeometryCells ?? 0 };
        return Object.entries(estimates).every(([key, value]) => (this.budget?.[key] ?? 0) + value <= AUTOMATIC_CALCULATION_LIMITS[key]);
    }

    /** Respond to Processing updates for the current raster and advance the series.
     * The queue calls this when planning, submission or job status changes. Submit
     * matching plans when approved, or pause for confirmation. Record completed values
     * or job failures and queue the next raster. API failures pause the series; offer
     * recovery when a saved submission remains unresolved. Ignore obsolete results.
     * The queue/executor continues to own cancellation and saved submission recovery.
     * @param {import("./calculation-executor.js").CalculationExecutionSnapshot} state This series' execution progress.
     * @return {void}
     */
    handleCalculationProgress(state) {
        const current = this.current;
        if (!current) { this.onChange(); return; }
        /** Check whether a plan or result belongs to the raster request being tracked.
         * @param {Readonly<Object>|null} value Calculation settings from Processing.
         * @return {boolean} True when source, area, formulas and execution settings match.
         */
        const matchesCurrentCalculation = value => JSON.stringify(value) === JSON.stringify(current.intent);
        if (state.completedJob && matchesCurrentCalculation(state.completedCalculation) && current.submitted &&
            state.completedJob.jobId !== current.previousJobId && !state.unfinishedCalculation && state.isIdle) {
            this.results.set(current.key, { job: state.completedJob, intent: current.intent,
                elapsedSeconds: (this.now() - current.startedAt) / 1000,
                performanceLines: performanceDescription(state.completedJob) });
            this.current = null;
            this.onChange();
            queueMicrotask(() => this.queueNextRasterCalculation());
            return;
        }
        if (state.recoverable || state.admission === "retry") {
            this.message = state.message;
            this.busy = false;
            if (!state.recoverable) this.current = null;
            this.onChange(); return;
        }
        if (state.plan && state.isIdle && matchesCurrentCalculation(state.plannedCalculation)) {
            if (!this.canSubmitWithoutConfirmation(state.plan)) {
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
            this.current = null; this.onChange(); queueMicrotask(() => this.queueNextRasterCalculation()); return;
        }
        this.message = state.currentJob ? describeJobProgress(state.currentJob) : state.message;
        this.onChange();
    }

    /** Tell the plot whether to offer recovery for a saved submission after a failure.
     * @return {boolean} True when an API/storage error left a submitted job unresolved.
     */
    get needsRecovery() { return this.client.snapshot.recoverable; }

    /** Retry the failed Processing step when the user clicks Recover.
     * Reuse the original request key for an uncertain submission. If this controller
     * still tracks that raster, its progress callbacks can continue the series.
     * Otherwise, report recovery and wait for Calculate to start the remaining work.
     * @return {Promise<void>} Completion of the retry attempt; a recovered job may
     * still be running or cancelling afterward.
     */
    async retryInterruptedCalculation() {
        this.busy = !!this.current;
        await this.client.retry();
        if (!this.current && !this.complete && !this.needsRecovery) {
            this.busy = false;
            this.message = "Previous calculation recovered. Calculate to continue.";
        }
        this.onChange();
    }

    /** Detach the series controller when the page is torn down.
     * Clear its timer and formula-validation request, then release its queue client.
     * The queue owns cancellation and preserves unfinished submission records for
     * recovery when the entire page closes. Use cancelRemainingRasters to stop work
     * while keeping this controller available.
     * @return {void}
     */
    destroy() {
        this.clock.clearTimeout(this.timer);
        this.validation?.abort();
        this.client.destroy();
    }
}
