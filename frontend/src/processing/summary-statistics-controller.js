/** Editable fixed-raster cards and composed multi-raster queries over Processing. */
import { rasterSourceKey } from "../raster-source.js";
import { calculationIntent, calculationPixelPoint } from "./calculation-session.js";
import { normalizeCalculationArea } from "./calculation-area.js";
import { catalogSelectionsEqual } from "../selected-area.js";
import { RasterSeriesCalculations } from "./raster-series-calculations.js";

/** Execution status received from CalculationExecutor's onChange callback.
 * The JSDoc import refers to the field definitions in calculation-executor.js
 * for documentation and editor type checking; it does not load code at runtime.
 * @typedef {import("./calculation-executor.js").CalculationExecutionSnapshot} CalculationExecutionSnapshot
 */

export const STATISTIC_PRESETS = Object.freeze({
    pixel: { label: "Pixel value", expression: "pixelValue(a)" },
    mean: { label: "Mean", expression: "mean(a)" }, sum: { label: "Sum", expression: "sum(a)" },
    stdev: { label: "Standard deviation", expression: "stdev(a)" },
    count: { label: "Count above 10", expression: "count(a > 10)" },
    "area-threshold": { label: "Area above 10", expression: "areaha(a > 10)" },
    "area-class": { label: "Area in class 4", expression: "areaha(a == 4)" },
    percent: { label: "Percent above 10", expression: "100 * count(a > 10) / count(a)" },
    range: { label: "Range", expression: "max(a) - min(a)" }, custom: { label: "", expression: "" },
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Compare original sources independently of labels or renderer state.
 * @param {Object|null} source Original raster reference. @return {string} Stable identity or empty for no selection.
 */
const sourceKey = source => source ? rasterSourceKey(source) : "";

/** Own statistic templates, validation and fixed or composed-query execution intent. */
export class SummaryStatisticsController {
    /** Wire statistic cards to the existing Processing executor and composed actions.
     * @param {Object} dependencies Processing providers and composed UI actions.
     * @param {import("./api.js").ProcessingApiClient} dependencies.api Formula validation.
     * @param {import("./jobs.js").ProcessingJobs} dependencies.jobs Shared owned-job observer.
     * @param {import("./summary-statistics-view.js").SummaryStatisticsView} dependencies.view Statistic controls.
     * @param {()=>Object} dependencies.getContext Available rasters and selected area.
     * @param {"single"|"query"} [dependencies.sourceMode="single"] Initial fixed-card or composed map-query policy.
     * @param {(area:Object|null)=>Object[]} [dependencies.getQuerySources] Composed catalog candidates; never an analysis authorization gate.
     * @param {()=>void} dependencies.onOpen Show this panel.
     * @param {()=>void} dependencies.onClose Close this panel.
     * @param {()=>void} dependencies.onEditArea Show sampling controls.
     * @param {(area:Object|null,label:string)=>void} [dependencies.onAreaChange] Publish the committed calculation area.
     * @param {Object} [dependencies.clock=globalThis] Debounce timers.
     * @param {import("./calculation-requests.js").CalculationRequests} dependencies.calculationRequests Independent recoverable calculation requests.
     * @param {Function} [dependencies.onCancelSelection] Cancel an in-progress area selection.
     * @throws {TypeError} If the initial source policy is unsupported.
     */
    constructor(dependencies) {
        const { api, jobs, view, getContext, getQuerySources = () => [], sourceMode = "single", onOpen, onClose, onEditArea, onCancelSelection = () => {}, onAreaChange = () => {}, clock = globalThis } = dependencies;
        if (!["single", "query"].includes(sourceMode)) throw new TypeError("Unknown statistics source policy.");
        Object.assign(this, { api, jobs, view, getContext, getQuerySources, onOpen, onClose, onCancelSelection, onAreaChange, clock });
        this.serial = 0;
        this.state = { sources: [], statistics: [], area: null, selectedArea: null, pixelPoint: null, areaChoice: "selection",
            active: false, automatic: true, currentWork: null, undo: false, sourceMode, querySources: [] };
        this.state.statistics.push(this.makeStatistic(STATISTIC_PRESETS.mean));
        this.executor = dependencies.calculationRequests.createClient("summary", snapshot => this.receive(snapshot));
        this.queryCalculations = new RasterSeriesCalculations({ requests: dependencies.calculationRequests, clock, clientName: "summary-query" });
        this.queryCalculations.setProgressListener(() => this.render());
        view.bind({ onOpen: () => this.open(), onClose: () => this.close(), onEditArea,
            onSourceMode: mode => this.chooseSourceMode(mode),
            onArea: choice => this.chooseArea(choice), onAutomatic: value => this.setAutomatic(value),
            onEdit: (id, change) => this.editStatistic(id, change), onAdd: preset => this.addStatistic(preset),
            onRemove: id => this.removeStatistic(id), onUndo: () => this.undoRemove(),
            onRun: id => this.request(id, "manual"), onStop: id => this.stopStatistic(id),
            onRetry: () => void this.retry(), onCancelWork: () => this.stopCurrentCalculation(),
        });
        this.render();
    }

    makeStatistic(value, source = null) {
        return { id: ++this.serial, label: value.label, expression: value.expression, source,
            version: 0, valid: false, checking: false, requested: null, pending: false,
            message: "Choose a raster", result: null, error: false };
    }
    label(card) { return card.label.trim() || `Summary statistic ${card.id}`; }
    /** Identify calculation inputs, including the click only when this formula uses it.
     * @param {Object} card Statistic card. @return {string} Stable input identity.
     */
    key(card) { return JSON.stringify([sourceKey(card.source), card.expression.trim(), this.state.area,
        calculationPixelPoint([card], this.state.pixelPoint)]); }
    /** Whether committed vector changes may automatically update the visible summary.
     * @return {boolean} True when the vector summary is active and automatic updates are enabled.
     */
    get followsVectorChanges() { return this.isActive && this.state.automatic && this.state.areaChoice === "vector"; }
    get isActive() { return this.state.active && !this.destroyed; }

    /** Restore cards for a submission saved before reload, then resume tracking that job.
     * Restored cards remain pending so progress and Cancel are accessible immediately.
     * Automatic jobs are cancelled on reload; this does not start a new calculation.
     * @return {Promise<void>} Recovery progress.
     */
    async start() {
        const unfinished = this.executor.snapshot.unfinishedCalculation;
        if (unfinished) {
            this.state.sourceMode = "single";
            this.state.pixelPoint = unfinished.calculation.pixelPoint ?? null;
            this.state.area = this.state.selectedArea = unfinished.calculation.area;
            this.state.areaChoice = unfinished.calculation.area.kind === "wholeRaster" ? "whole" : ["catalogSelection", "polygonArea"].includes(unfinished.calculation.area.kind) ? "vector" : "selection";
            this.state.sources = [unfinished.calculation.source];
            this.state.statistics = unfinished.calculation.calculations.map(value => {
                const card = this.makeStatistic(value, unfinished.calculation.source); card.valid = true; card.pending = true; return card;
            });
            this.batch = { automatic: unfinished.context?.automatic ?? false, obsolete: unfinished.cancelRequested || !!unfinished.context?.automatic,
                intent: unfinished.calculation, cards: this.state.statistics.map(card => ({ id: card.id, key: this.key(card) })) };
        }
        if (unfinished?.context?.automatic) this.executor.stop();
        await this.executor.start();
        await this.queryCalculations.recoverAndCancelPreviousSeriesCalculations();
        this.receive(this.executor.snapshot);
    }

    /** Opening/reopening is presentation, never an automatic calculation trigger.
     * @param {Object|null} [source=null] Optional catalog raster to bind to the first card.
     * @param {Object|undefined} [area] Explicit area, otherwise use current context.
     * @return {void}
     */
    open(source = null, area) {
        if (source) this.chooseSourceMode("single");
        const context = this.getContext();
        if (!this.state.pixelPoint && context.pixelPoint) this.setPixelPoint(context.pixelPoint, false);
        const sources = [...(context.sources ?? [])];
        for (const item of [source, ...this.state.statistics.map(card => card.source)]) {
            if (item && !sources.some(other => sourceKey(other) === sourceKey(item))) sources.push(item);
        }
        this.state.sources = sources;
        const selected = area === undefined ? context.area : area;
        if (area !== undefined || (!this.state.area && this.state.areaChoice === "selection")) {
            this.state.areaChoice = this.state.vectorArea && catalogSelectionsEqual(selected?.catalogSelection, this.state.vectorArea.selection) ? "vector" : "selection";
            this.setSelection(selected, false);
            this.changeArea(this.state.selectedArea, false);
        }
        for (const card of this.state.statistics) {
            if (this.state.sourceMode === "query") {
                if (!card.valid && !card.checking) this.validateLater(card, false);
                continue;
            }
            const next = (source && card === this.state.statistics[0]) ? source : card.source ?? sources[0] ?? null;
            if (sourceKey(next) !== sourceKey(card.source)) this.editStatistic(card.id, { source: next }, false);
            else if (!card.valid && !card.checking) this.validateLater(card, false);
        }
        this.onOpen();
        this.refreshQuerySources();
        this.render();
    }

    /**
     * Refresh composed names and query candidates. Name-only edits preserve calculations;
     * changed query candidates supersede the old query through its execution provider.
     * Submitted job metadata keeps the name recorded when the job was created.
     * @return {void}
     */
    refreshSourceNames() {
        const names = new Map((this.getContext().sources ?? []).map(source => [sourceKey(source), source.label]));
        let changed = false;
        const rename = source => {
            const label = names.get(sourceKey(source));
            if (label === undefined || label === source?.label) return source;
            changed = true;
            return { ...source, label };
        };
        this.state.sources = this.state.sources.map(rename);
        for (const card of this.state.statistics) card.source = rename(card.source);
        this.refreshQuerySources();
        if (changed) this.render();
    }

    /** Apply panel visibility, cancelling transient queries and automatic fixed work.
     * Explicit fixed-raster work retains its independent lifecycle when hidden.
     * @param {boolean} active Whether composition presents Statistics.
     * @return {void}
     */
    setActive(active) {
        if (this.state.active === active) return;
        this.state.active = active;
        if (!active) {
            for (const card of this.state.statistics) if (card.requested === "automatic") card.requested = null;
            if (this.batch?.automatic) this.invalidateBatch();
            this.queryRequested = this.queryManual = false;
        }
        this.refreshQuerySources();
        this.render();
    }
    close() { this.setActive(false); this.onClose(); }
    /** Apply the user's update policy; enabling waits for a new edit or query.
     * @param {boolean} value Whether future input changes calculate automatically.
     * @return {void}
     */
    setAutomatic(value) {
        this.state.automatic = !!value;
        if (!value) {
            for (const card of this.state.statistics) if (card.requested === "automatic") card.requested = null;
            if (this.batch?.automatic) this.invalidateBatch();
            this.queryRequested = this.queryManual = false;
        }
        this.refreshQuerySources();
        // Enabling affects the next edit/click, not every existing card immediately.
        this.render();
    }

    /** Select a catalog descriptor or owned polygon upload and optionally calculate.
     * Optional outline generation remains independent.
     * @param {Object} info Catalog selection or polygonArea reference, plus a presentation label.
     * @param {boolean} [calculate=false] User explicitly requested filter and calculation.
     * @return {void}
     */
    setVectorSamplingArea(info, calculate = false) {
        this.state.vectorSelecting = false;
        this.state.vectorCalculation = calculate;
        this.state.selectionMessage = "";
        this.state.vectorArea = info;
        this.state.areaChoice = "vector";
        this.state.selectedArea = normalizeCalculationArea(info.polygonArea ? { kind: "polygonArea", polygonArea: info.polygonArea }
            : { kind: "catalogSelection", catalogSelection: info.selection });
        this.changeArea(this.state.selectedArea, false);
        if (calculate) {
            this.open();
            this.calculateSelection(true);
        }
        this.render();
    }
    /** Receive selection lifecycle through composition, without accessing vector state.
     * @param {{phase:string,message:string,analysis:boolean}} selection Public progress snapshot.
     * @return {void}
     */
    setVectorSelectionState(selection) {
        if (!selection.analysis) return;
        const selecting = ["reading", "selected"].includes(selection.phase);
        if (selecting && !this.state.vectorSelecting) {
            this.invalidateBatch();
            this.executor.discardPendingCalculation();
            this.state.areaChoice = "vector";
            this.changeArea(null, false);
        }
        this.state.vectorSelecting = selecting;
        this.state.selectionMessage = selection.phase === "active" ? "" : selection.message;
        this.render();
    }
    /** Cancel work for a removed or changed polygon upload, including hidden cards.
     * @param {string} id Private Processing input identity to invalidate.
     * @return {void}
     */
    invalidatePolygonArea(id) {
        if (this.batch?.intent.area?.polygonArea?.id === id) this.invalidateBatch();
        if (this.state.area?.polygonArea?.id === id) { this.invalidateBatch(); this.changeArea(null, false); }
        if (this.state.selectedArea?.polygonArea?.id === id) this.state.selectedArea = null;
        if (this.state.vectorArea?.polygonArea?.id === id) this.state.vectorArea = null;
        this.render();
    }

    /** Cancel obsolete catalog-selection work even when its panel is no longer active.
     * @param {Object} id Catalog selection to invalidate. @return {void}
     */
    invalidateSamplingArea(id) {
        if (catalogSelectionsEqual(this.batch?.intent.area?.catalogSelection, id)) this.invalidateBatch();
        if (catalogSelectionsEqual(this.state.area?.catalogSelection, id)) { this.invalidateBatch(); this.changeArea(null, false); }
        if (catalogSelectionsEqual(this.state.selectedArea?.catalogSelection, id)) this.state.selectedArea = null;
        if (catalogSelectionsEqual(this.state.vectorArea?.selection, id)) this.state.vectorArea = null;
        this.render();
    }
    /** Receive the current map selection and supersede an active vector area when it changes.
     * @param {Object|null} area Current box, AOI, catalog selection or polygon reference.
     * @param {boolean} [automatic=true] Whether the normal automatic-calculation policy applies.
     * @return {void}
     */
    setSelection(area, automatic = true) {
        const next = area ? normalizeCalculationArea(area) : null;
        if (same(next, this.state.selectedArea)) return;
        this.state.selectedArea = next;
        const vectorArea = this.state.vectorArea;
        const currentUsesVector = this.state.area?.kind === "polygonArea"
            ? this.state.area.polygonArea.id === vectorArea?.polygonArea?.id
            : catalogSelectionsEqual(this.state.area?.catalogSelection, vectorArea?.selection);
        const nextUsesVector = next?.kind === "polygonArea"
            ? next.polygonArea.id === vectorArea?.polygonArea?.id
            : catalogSelectionsEqual(next?.catalogSelection, vectorArea?.selection);
        if (next && this.state.areaChoice === "vector" && currentUsesVector && !nextUsesVector) {
            this.state.areaChoice = "selection";
        }
        if (this.state.areaChoice === "selection") this.changeArea(next, automatic);
    }
    /** Refresh formulas that depend on the exact map click, even when the area stays fixed.
     * Unchanged area-only cards keep their results and validation feedback.
     * @param {{longitude:number,latitude:number}|null} point Canonical WGS84 click from composition.
     * @param {boolean} [automatic=true] Whether the automatic-update policy applies.
     * @return {void}
     */
    setPixelPoint(point, automatic = true) {
        if (same(point, this.state.pixelPoint)) return;
        const keys = this.state.statistics.map(card => this.key(card));
        this.state.pixelPoint = point ? { ...point } : null;
        for (const [index, card] of this.state.statistics.entries()) {
            if (keys[index] === this.key(card)) continue;
            if (this.batch?.automatic || this.isActive) this.invalidateBatch(card.id);
            this.executor.discardPendingCalculation();
            card.error = false;
            card.requested = automatic && this.isActive && this.state.automatic && this.state.area ? "automatic" : null;
            this.validateLater(card, false);
        }
        this.render();
    }
    chooseArea(choice) {
        this.state.areaChoice = choice;
        const area = choice === "vector" ? null : choice === "whole" ? { kind: "wholeRaster" } : this.state.selectedArea;
        this.changeArea(area, true);
        this.render();
    }
    /** Replace the current scope and release obsolete reviews before further admission.
     * @param {Object|null} area Neutral sampling area.
     * @param {boolean} automatic Whether normal automatic-update policy applies.
     * @return {void}
     */
    changeArea(area, automatic) {
        if (same(area, this.state.area)) return;
        if (this.batch?.automatic || this.isActive) this.invalidateBatch();
        this.executor.discardPendingCalculation();
        this.state.area = area;
        this.onAreaChange(area, ["catalogSelection", "polygonArea"].includes(area?.kind)
            ? this.state.vectorArea?.label ?? "Selected polygons"
            : area?.kind === "wholeRaster" ? "Whole raster" : area ? "Sampling area" : "");
        for (const card of this.state.statistics) {
            card.error = false;
            card.requested = automatic && this.isActive && this.state.automatic && area ? "automatic" : null;
            this.validateLater(card, false);
        }
        this.render();
    }
    /** Queue the configured cards for the current area through the existing executor.
     * Map clicks follow automatic-update policy. Explicit histogram or accepted vector
     * actions authorize manual submission, cancel superseded work, and show live cards.
     * Formula validation and server planning apply to both paths; absent areas wait.
     * @param {boolean} [explicit=false] Whether the user explicitly requested calculation.
     * @return {void}
     */
    calculateSelection(explicit = false) {
        if (!this.isActive) return;
        if (!explicit && (!this.state.automatic || this.state.areaChoice !== "selection" || this.state.area?.kind !== "selectedArea")) return;
        if (this.state.sourceMode === "query") {
            this.queryRequested = true;
            if (explicit) { this.queryManual = true; this.manualInputKey = this.queryKey(); }
            this.refreshQuerySources(explicit);
            return;
        }
        if (explicit) {
            if (this.batch?.cards.some(entry => {
                const card = this.state.statistics.find(item => item.id === entry.id);
                return !card || entry.key !== this.key(card);
            })) this.invalidateBatch();
            if (!this.state.statistics.length) this.view.focusAddStatistic?.();
        }
        for (const card of this.state.statistics) this.request(card.id, explicit ? "manual" : "automatic", !explicit);
        this.render();
    }

    /** Edit a template; a deliberate raster binding selects fixed-raster mode.
     * Names do not change immutable calculation identity or submitted exports.
     * @param {number} id Statistic identity.
     * @param {{label?:string,expression?:string,source?:Object|null}} change Edited fields.
     * @param {boolean} [automatic=true] Whether normal automatic-update policy applies.
     * @return {void}
     */
    editStatistic(id, change, automatic = true) {
        if (Object.hasOwn(change, "source")) this.chooseSourceMode("single");
        const card = this.state.statistics.find(item => item.id === id);
        if (!card) return;
        const oldKey = this.key(card);
        Object.assign(card, change);
        if (oldKey !== this.key(card)) {
            this.invalidateBatch(id);
            card.error = false;
            card.requested = automatic && this.isActive && this.state.automatic ? "automatic" : null;
            this.validateLater(card, false);
        }
        // Names are presentation only; the immutable original export keeps its run label.
        this.render();
        this.refreshQuerySources();
    }
    addStatistic(preset) {
        if (this.state.statistics.length >= 5 || !STATISTIC_PRESETS[preset]) return;
        const card = this.makeStatistic(STATISTIC_PRESETS[preset], this.state.statistics.at(-1)?.source ?? this.state.sources[0] ?? null);
        this.state.statistics.push(card);
        this.validateLater(card, this.isActive && this.state.automatic);
        this.render();
        this.view.focusStatistic?.(card.id);
    }
    removeStatistic(id) {
        const index = this.state.statistics.findIndex(card => card.id === id);
        if (index < 0) return;
        const [card] = this.state.statistics.splice(index, 1);
        this.clock.clearTimeout(card.timer); card.abort?.abort(); card.version++;
        this.removed = { card, index }; this.state.undo = true;
        this.invalidateBatch(id);
        this.render();
        this.view.focusUndo?.();
        this.refreshQuerySources();
    }
    undoRemove() {
        if (!this.removed || this.state.statistics.length >= 5) return;
        const { card, index } = this.removed;
        card.pending = false; card.requested = null;
        this.state.statistics.splice(index, 0, card);
        this.removed = null; this.state.undo = false;
        this.validateLater(card, this.isActive && this.state.automatic && card.result?.key !== this.key(card));
        this.render(); this.view.focusStatistic?.(card.id);
    }

    /** Schedule editor feedback, reusing successful feedback for an unchanged formula.
     * Source and area changes do not change the fixed alias or formula grammar.
     * Submission always validates the complete inputs again on the server.
     * @param {Object} card Owned statistic card.
     * @param {boolean} requestAutomatic Whether a complete edit requests an automatic update.
     * @return {void}
     */
    validateLater(card, requestAutomatic) {
        this.clock.clearTimeout(card.timer); card.abort?.abort();
        const version = ++card.version;
        card.valid = false; card.checking = true; card.error = false;
        card.cancelled = false;
        if (requestAutomatic) card.requested = "automatic";
        if (card.validatedExpression === card.expression.trim()) {
            card.valid = true; card.checking = false;
            if (card.result?.key === this.key(card)) card.requested = null;
            this.scheduleNextBatch();
            return;
        }
        card.message = "Checking formula…";
        card.timer = this.clock.setTimeout(() => void this.validate(card, version), 700);
    }
    /** Check a paused editor value without overriding a newer edit or explicit submission.
     * @param {Object} card Owned statistic card.
     * @param {number} version Editor revision captured when the check was scheduled.
     * @return {Promise<void>} Feedback update; transport and formula errors are displayed.
     */
    async validate(card, version) {
        card.abort = new AbortController();
        try {
            if (!card.expression.trim()) throw new Error("Enter a formula");
            await this.api.validateCalculation([{ label: this.label(card), expression: card.expression }], card.abort.signal);
            if (this.destroyed || version !== card.version || !this.state.statistics.includes(card)) return;
            card.valid = true; card.checking = false; card.message = "Ready to calculate";
            card.validatedExpression = card.expression.trim();
            if (card.result?.key === this.key(card)) card.requested = null;
        } catch (error) {
            if (this.destroyed || version !== card.version || error.name === "AbortError" || !this.state.statistics.includes(card)) return;
            card.valid = false; card.checking = false; card.error = !!card.expression.trim();
            card.message = error.message; card.requested = null;
        }
        this.render(); this.scheduleNextBatch();
    }
    /** Queue fixed work immediately or a query when its templates pass editor validation.
     * Automatic typing still waits for debounced feedback. A manual submission
     * supersedes any pending feedback so a late response cannot change its state.
     * @param {number} id Stable card identity.
     * @param {string} kind Manual or automatic execution intent.
     * @param {boolean} [debounce=false] Whether formula validation must wait for editing.
     * @return {void}
     */
    request(id, kind, debounce = false) {
        if (this.state.sourceMode === "query") {
            const card = this.state.statistics.find(item => item.id === id);
            if (!card?.expression.trim() || !this.state.area) return;
            this.queryRequested = true;
            this.queryManual = kind === "manual";
            if (this.queryManual) this.manualInputKey = this.queryKey();
            if (!card.valid) this.validateLater(card, false);
            this.refreshQuerySources(kind === "manual");
            return;
        }
        const card = this.state.statistics.find(item => item.id === id);
        if (!card || !card.source || !this.state.area) return;
        if (this.batch && !this.batch.obsolete && this.batch.cards.some(entry => entry.id === id && entry.key === this.key(card))) return;
        card.requested = kind; card.error = false; card.cancelled = false;
        if (kind === "manual") {
            this.clock.clearTimeout(card.timer); card.abort?.abort(); card.version++;
            card.checking = false;
        } else if (debounce) this.validateLater(card, false);
        else if (!card.valid && !card.checking) this.validateLater(card, false);
        this.render(); this.scheduleNextBatch();
    }
    /** Cancel queued calculation or composed selection work without discarding old values.
     * @param {number} id Stable card identity.
     * @return {void}
     */
    stopStatistic(id) {
        if (this.state.sourceMode === "query") {
            this.queryRequested = this.queryManual = false;
            for (const card of this.state.statistics) card.requested = null;
            this.queryCalculations.updateCalculationForPanelVisibility(false);
            this.render();
            return;
        }
        if (this.state.vectorSelecting) this.onCancelSelection();
        const card = this.state.statistics.find(item => item.id === id);
        if (card) { card.requested = null; card.cancelled = true; card.message = "Calculation cancelled"; }
        this.invalidateBatch(id);
        this.render();
    }

    /** Cancel the unfinished scan when recovery or changed inputs need a separate control.
     * Record cancellation through the existing executor even before acceptance is confirmed.
     * Retain prior values and do not requeue other cards from the cancelled scan.
     * @return {void}
     */
    stopCurrentCalculation() {
        if (this.batch) {
            this.batch.obsolete = true;
            for (const entry of this.batch.cards) {
                const card = this.state.statistics.find(item => item.id === entry.id);
                if (card) { card.requested = null; card.cancelled = true; }
            }
        }
        this.executor.stop();
        this.render();
    }

    /** Cancel a superseded batch, retaining unchanged sibling requests for the next shared scan. */
    invalidateBatch(id) {
        const batch = this.batch;
        if (!batch || (id !== undefined && !batch.cards.some(card => card.id === id))) return;
        if (!batch.obsolete) {
            batch.obsolete = true;
            for (const entry of batch.cards) {
                const card = this.state.statistics.find(item => item.id === entry.id);
                if (card && card.id !== id && id !== undefined && this.key(card) === entry.key &&
                    (!batch.automatic || (this.isActive && this.state.automatic))) card.requested = batch.automatic ? "automatic" : "manual";
            }
            this.executor.stop();
        }
    }
    /** Schedule a check for the next statistic batch after current callbacks finish.
     * Coalesce repeated requests into one microtask; the batch check waits if busy.
     * @return {void}
     */
    scheduleNextBatch() {
        if (this.batchStartScheduled || this.destroyed) return;
        this.batchStartScheduled = true;
        queueMicrotask(() => { this.batchStartScheduled = false; this.startNextBatch(); });
    }
    /** Submit compatible statistics, isolating manually requested unchecked formulas.
     * Previously checked formulas may share a scan. An unchecked manual formula
     * is submitted alone so its server rejection cannot block valid peers.
     * Query mode passes validated templates to the independent multi-raster provider.
     * @return {void}
     */
    startNextBatch() {
        if (this.state.sourceMode === "query") {
            if (this.state.statistics.some(card => card.requested === "automatic") && this.isActive && this.state.automatic) this.queryRequested = true;
            for (const card of this.state.statistics) card.requested = null;
            this.refreshQuerySources();
            return;
        }
        const execution = this.executor.snapshot;
        if (this.destroyed || this.batch || !execution.isIdle) return;
        const eligible = this.state.statistics.filter(card => card.requested && (card.valid || (card.requested === "manual" && card.expression.trim())) && !card.checking && card.source && this.state.area &&
            (["manual", "review"].includes(card.requested) || (this.isActive && this.state.automatic)));
        const first = eligible[0];
        if (!first) return;
        if (execution.admission === "retry" && first.requested === "automatic") {
            for (const card of eligible) { card.requested = null; card.error = true; card.message = "Calculation paused after an error · Calculate to retry"; }
            this.render(); return;
        }
        // Combine distinct labels on one raster into a single native scan. Other rasters wait.
        const labels = new Set();
        const group = eligible.filter(card => {
            const label = this.label(card);
            if (card !== first && (!first.valid || !card.valid)) return false;
            if (card.requested !== first.requested || sourceKey(card.source) !== sourceKey(first.source) || labels.has(label)) return false;
            labels.add(label); return true;
        });
        let intent;
        try {
            intent = calculationIntent({ source: first.source, area: this.state.area,
                pixelPoint: this.state.pixelPoint,
                calculations: group.map(card => ({ label: this.label(card), expression: card.expression })) });
        } catch (error) {
            for (const card of group) { card.requested = null; card.error = true; card.message = error.message; }
            this.render(); this.scheduleNextBatch(); return;
        }
        this.batch = { intent, previousJobId: execution.completedJob?.jobId, automatic: first.requested !== "manual", obsolete: false,
            cards: group.map(card => ({ id: card.id, key: this.key(card) })) };
        for (const card of group) { card.requested = null; card.pending = true; card.error = false; card.message = "Preparing calculation…"; }
        this.executor.submit(intent, Object.freeze({automatic: this.batch.automatic}));
        this.render();
    }

    /** Apply the queued job’s preparation, calculation progress and results to its cards.
     * A continuing manual scan retains its completed value with submitted inputs even
     * when the hidden panel's map context changed. It remains a previous result.
     * @param {CalculationExecutionSnapshot} execution Progress, remaining work and last completed job from one executor update.
     * @return {void}
     */
    receive(execution) {
        if (!this.executor || this.destroyed) return;
        this.state.recoverable = execution.recoverable;
        for (const card of this.state.statistics) {
            if (card.result) {
                const job = execution.jobs.find(item => item.jobId === card.result.job.jobId);
                if (job?.status === "deleted") card.result = null;
            }
        }
        const batch = this.batch;
        if (batch) {
            const isIdle = execution.isIdle;
            const job = execution.completedJob; // Numeric rows are inside job.result, not the job metadata.
            const matching = !batch.obsolete && same(execution.completedCalculation, batch.intent) && job?.status === "ready" && job.jobId !== batch.previousJobId;
            batch.cards.forEach((entry, index) => {
                const card = this.state.statistics.find(item => item.id === entry.id);
                if (!card) return;
                if (isIdle && matching && job.result?.rows[index]) {
                    card.result = { key: entry.key, row: job.result.rows[index], job, source: batch.intent.source, area: batch.intent.area };
                }
                if (!batch.obsolete && this.key(card) === entry.key) {
                    if (execution.currentJob || matching) {
                        card.valid = true; card.validatedExpression = card.expression.trim();
                    }
                    card.message = execution.message || (execution.currentJob?.status === "running" ? "Calculating…" : "Waiting to calculate…");
                    card.progress = execution.currentJob?.progress ?? null;
                    card.error = execution.phase === "error";
                    if (isIdle && matching && job.result?.rows[index]) {
                        card.message = "Up to date";
                    } else if (isIdle && !matching) {
                        card.error = execution.phase === "error" || !batch.obsolete;
                    }
                }
                if (isIdle) { card.pending = false; card.progress = null; }
            });
            if (isIdle) { this.batch = null; this.scheduleNextBatch(); }
        }
        this.render();
    }
    /** Schedule feedback for the chosen area workflow, preserving card-level failures.
     * Idle vector snapshots do not replace map-click guidance. Formula and source
     * feedback remain local to each card while selection controls show their lifecycle.
     * Query rows project immutable per-raster results; late obsolete work cannot be current.
     * @return {void}
     */
    render() {
        if (this.destroyed) return;
        const execution = this.executor.snapshot;
        const unfinished = execution.unfinishedCalculation;
        const inputsChanged = !this.batch || this.batch.cards.some(entry => {
            const card = this.state.statistics.find(item => item.id === entry.id);
            return !card || this.key(card) !== entry.key;
        });
        this.state.currentWork = unfinished && (execution.recoverable || inputsChanged) ? {
            calculation: unfinished.calculation, message: execution.message,
            cancelling: unfinished.cancelRequested || execution.currentJob?.status === "cancelling",
        } : null;
        const vectorWorkflow = this.state.areaChoice === "vector" || ["catalogSelection", "polygonArea"].includes(this.state.area?.kind);
        for (const card of this.state.statistics) {
            card.current = !!card.result && card.result.key === this.key(card) && !card.pending && !card.requested && !card.checking && !card.error && !card.cancelled;
            card.awaitingMap = !this.state.area && this.state.areaChoice === "selection" && !!card.source && card.valid &&
                !card.pending && !card.checking && !card.error && !card.cancelled;
            if (!card.pending && !card.checking && !card.error) {
                card.message = !card.source ? "Choose a raster" : card.awaitingMap ? (this.state.automatic
                    ? "Click the map to calculate. Statistics use the sampling box around your click."
                    : "Click the map to select an area, then choose Calculate.")
                    : !card.valid ? "Enter a formula" : !this.state.area ? "Choose an area"
                    : card.requested ? "Ready to calculate · queued" : card.current ? "Up to date"
                    : "Ready to calculate";
            }
        }
        for (const card of this.state.statistics) {
            if (card.cancelled) card.message = card.pending ? "Cancelling calculation…" : "Calculation cancelled";
            if (!vectorWorkflow || !card.source || !card.valid || card.pending || card.checking || card.error) continue;
            if (this.state.vectorSelecting) card.message = "Calculating · selecting filtered features…";
            else if (!this.state.area && this.state.selectionMessage) card.message = this.state.selectionMessage;
        }
        if (this.state.sourceMode === "query") {
            const work = this.queryCalculations;
            this.state.recoverable = work.needsRecovery || execution.recoverable;
            this.state.queryMessage = work.message;
            const statistics = this.state.statistics.map(card => {
                const index = work.formulas.findIndex(formula => formula.id === card.id);
                const queryResults = this.state.querySources.map(source => {
                    const key = sourceKey(source);
                    const current = work.results.get(key);
                    const saved = current?.job ? current : work.previousResults?.get(key);
                    const progress = work.progress.get(key);
                    const job = this.jobs.jobs.find(job => job.jobId === saved?.job?.jobId) ?? saved?.job;
                    const row = job?.status === "deleted" ? null : job?.result?.rows.find(result => result.label.endsWith(` [${card.id}]`));
                    const result = row ? { key, row, job, source: saved.calculationInputs.source, area: saved.calculationInputs.area } : null;
                    return { key, source, result, current: !!current && !!result && !progress && index >= 0 && !card.checking && !card.error && !card.cancelled,
                        pending: !!progress, error: current?.error ?? "", message: progress?.message ?? current?.error ?? (result ? "" : "Ready to calculate") };
                });
                return { ...card, queryResults, source: null, result: null, current: work.complete && index >= 0 && !work.hasErrors,
                    pending: work.busy, requested: null, progress: null, awaitingMap: !this.state.area,
                    message: card.error ? card.message : card.checking ? "Checking formula…" : !this.state.area ? "Click the map to select an area."
                        : !this.state.querySources.length ? "No enabled rasters intersect this area."
                        : index < 0 ? "Enter a valid formula" : work.message === "Raster series complete." ? "Up to date" : work.message || "Ready to calculate" };
            });
            this.view.render({ ...this.state, statistics });
        } else this.view.render(this.state);
    }
    /** Switch between a composed all-raster query and deliberately fixed card bindings.
     * Switching policy cancels query jobs, without authorizing or hiding Catalog sources.
     * Fixed choices refresh from current composition, retaining deliberately bound sources.
     * @param {"single"|"query"} mode Requested source policy.
     * @return {void}
     * @throws {TypeError} If the source policy is unknown.
     */
    chooseSourceMode(mode) {
        if (!["single", "query"].includes(mode)) throw new TypeError("Unknown statistics source policy.");
        if (this.state.sourceMode === mode) return;
        if (this.batch?.automatic) this.invalidateBatch();
        this.queryRequested = this.queryManual = false;
        this.state.sourceMode = mode;
        if (mode === "single") {
            this.state.sources = [...(this.getContext().sources ?? [])];
            for (const card of this.state.statistics) {
                if (card.source && !this.state.sources.some(source => sourceKey(source) === sourceKey(card.source))) this.state.sources.push(card.source);
            }
        }
        for (const card of this.state.statistics) {
            card.requested = null;
            if (mode === "single" && !card.source) card.source = this.state.sources[0] ?? null;
        }
        this.refreshQuerySources();
        this.render();
    }
    /** Refresh candidate identities and formulas through composition, retaining per-raster execution isolation.
     * Opening alone does not submit. Automatic queries supersede old inputs; explicitly
     * requested query work stops on navigation/input changes, like a raster-stack query.
     * Fixed manual calculations retain their existing independent lifecycle.
     * @param {boolean} [explicit=false] Run/retry the current validated query now.
     * @return {void}
     */
    refreshQuerySources(explicit = false) {
        const work = this.queryCalculations;
        if (this.state.sourceMode !== "query") { work.updateCalculationForPanelVisibility(false); return; }
        this.state.querySources = this.getQuerySources(this.state.area).map(source => ({ ...source }));
        const formulas = this.state.statistics.filter(card => card.valid && !card.checking).map(card => ({
            id: card.id, label: card.label, expression: card.expression,
            calculationLabel: this.label(card).slice(0, 65) + ` [${card.id}]`,
        }));
        if (this.queryManual && this.manualInputKey !== this.queryKey()) this.queryManual = false;
        work.updateCalculationInputs(this.state.querySources.map(source => ({ key: sourceKey(source), label: source.label,
            source })),
        this.state.area, "Current statistics area", formulas, this.state.pixelPoint);
        const active = this.isActive && !!this.state.area && !!formulas.length && !!this.state.querySources.length
            && ((this.state.automatic && this.queryRequested) || this.queryManual || explicit);
        work.updateCalculationForPanelVisibility(active);
        if (explicit && active) work.calculateRemainingRasters();
        this.render();
    }
    /** Recover each owning execution namespace with its original submission keys.
     * @return {Promise<void>} Recovery attempts; server jobs may still be running.
     */
    async retry() { await Promise.all([this.executor.snapshot.recoverable ? this.executor.retry() : Promise.resolve(), this.queryCalculations.retryInterruptedCalculations()]); }
    /** Identify manual query inputs independently of asynchronous formula feedback.
     * Presentation names and validation completion do not supersede a user request.
     * @return {string} Source, area, formula and applicable pixel identity.
     */
    queryKey() {
        return JSON.stringify([this.getQuerySources(this.state.area).map(sourceKey).sort(), this.state.area,
            this.state.statistics.map(card => [card.id, card.expression.trim()]),
            calculationPixelPoint(this.state.statistics, this.state.pixelPoint)]);
    }
    /** Release validation, execution observers and retained presentation state.
     * Unfinished requests keep their owned recovery records for the next startup.
     * @return {void}
     */
    destroy() {
        this.destroyed = true;
        for (const card of this.state.statistics) { this.clock.clearTimeout(card.timer); card.abort?.abort(); }
        this.executor.destroy(); this.view.unbind();
        this.queryCalculations.destroy();
    }
}
