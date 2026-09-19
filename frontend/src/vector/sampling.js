/** Vector-owned selection intent; source transport and map presentation are injected. */
import { validateCatalogSelection, catalogSelectionsEqual } from "../selected-area.js";
import { EMPTY_VECTOR_FILTER, vectorFilterSummary } from "./filter.js";

/** Identify calculation inputs, excluding presentation-only annotation edits.
 * @param {Object|undefined} target Layer snapshot supplied by composition.
 * @param {Object|null} filter Active analysis predicate, if any.
 * @return {string} Stable identity for detecting a changed or removed selection.
 */
const samplingTargetIdentity = (target, filter = null) => target ? JSON.stringify([target.key, target.filter,
    target.selectionIdentity ? target.selectionIdentity(filter ?? target.filter) : target.item]) : "";

/**
 * Conservatively classify the selection envelope before raster processing.
 * @param {Object} area Complete server selection with canonical bbox and counts.
 * @return {{large:boolean,nearGlobal:boolean,envelopeKm2:number}} Review policy.
 */
export function vectorSelectionReview(area) {
    const [west, south, east, north] = area.bbox;
    const envelopeKm2 = 6371.0088 ** 2 * (east - west) * Math.PI / 180 *
        (Math.sin(north * Math.PI / 180) - Math.sin(south * Math.PI / 180));
    return { envelopeKm2, large: envelopeKm2 > 5_000_000 ||
        (!(area.filter.enabled && area.filter.rules.length) && area.matched > 1),
    nearGlobal: envelopeKm2 > 100_000_000 };
}

/** Select polygon layers and invalidate areas when committed geometry or filters change. */
export class VectorSamplingController {
    /**
     * @param {Object} dependencies Views, targets, selection transport and composed callbacks.
     * @param {(target:Object|null,filter:Object|null,wasActive:boolean)=>void} [dependencies.onSourceChange] Composed response to changed committed inputs.
     * @param {(area:Object)=>void} [dependencies.releaseArea] Release obsolete uploaded inputs.
     * @param {Object|Object[]} dependencies.view One or more synchronized selection views.
     * @param {()=>Object[]} dependencies.getTargets Committed, independent layer snapshots.
     * @param {(item:Object|null,filter:Object,signal:AbortSignal,target:Object)=>Promise<Object>} dependencies.createArea Resolve one filtered area.
     * @param {(area:Object,calculate:boolean)=>void} dependencies.onActivate Present an accepted area.
     * @param {(selection:Object|undefined,area:Object)=>void} dependencies.onInvalidate Cancel work using an obsolete area.
     * @param {(key:string)=>void} dependencies.onEditFilter Open the selected layer's filter controls.
     * @param {(state:Object)=>void} [dependencies.onSelectionState] Report selection progress.
     * @param {Object} [dependencies.clock=globalThis] Existing controller clock dependency.
     */
    constructor({ view, getTargets, createArea, onActivate, onInvalidate, onEditFilter, onSelectionState = () => {}, releaseArea = () => {}, onSourceChange = () => {}, clock = globalThis }) {
        Object.assign(this, { view, getTargets, createArea, onActivate, onInvalidate, onEditFilter, clock });
        this.onSelectionState = onSelectionState;
        this.releaseArea = releaseArea;
        this.onSourceChange = onSourceChange;
        this.views = Array.isArray(view) ? view : [view];
        this.sequence = 0;
        this.state = { targets: [], key: "", phase: "idle", area: null, message: "Choose a polygon layer, then use its filtered features." };
        this.views.forEach(target => target.bind({ onLayer: key => this.choose(key), onUse: () => void this.use(),
            onConfirm: () => this.confirm(), onRemove: () => this.invalidate("Selection removed"),
            onFilter: () => this.onEditFilter(this.state.key) }));
        this.refresh();
    }
    /** Refresh committed layer snapshots and report changed calculation inputs.
     * @return {void}
     */
    refresh() {
        const targets = this.getTargets();
        const next = targets.find(target => target.key === this.state.key);
        const changed = this.sourceIdentity && this.sourceIdentity !== samplingTargetIdentity(next, this.state.selectionFilter);
        const wasActive = this.state.phase === "active";
        const previous = this.state.targets.find(target => target.key === this.state.key);
        const filter = JSON.stringify(previous?.filter) === JSON.stringify(next?.filter) ? this.state.selectionFilter : next?.filter;
        if (changed) this.invalidate("Layer or filter changed. Use these features again to update the sampling area.");
        this.state.targets = targets;
        if (!next) this.state.key = targets[0]?.key ?? "";
        this.render();
        if (changed) this.onSourceChange(next ?? null, filter, wasActive);
    }
    /** @param {string} key User-selected retained polygon layer. */
    choose(key) {
        this.invalidate("Use this layer’s filtered features as the sampling area.");
        this.state.key = key;
        this.render();
    }
    /** Read the selected analysis predicate without exposing controller state.
     * @param {string} key Retained catalog-layer identity.
     * @return {Object|null} Independent copy of the committed predicate.
     */
    selectedFilter(key) {
        return key === this.state.key && this.state.selectionFilter ? structuredClone(this.state.selectionFilter) : null;
    }
    /**
     * Select a committed predicate on one bounded lane, discarding obsolete replies.
     * @param {Object} [options={}] Explicit analysis selection options.
     * @param {Object|null} [options.filter=null] Committed analysis filter, independent of rendering.
     * @param {string} [options.key] Captured layer identity from the filter editor.
     * @param {boolean} [options.analysis=false] Defer activation to the composed primary action.
     * @return {Promise<Object|null>} Current polygon area, or null if superseded.
     * @throws {Error} If an explicit analysis selection fails.
     */
    async use({ filter = null, analysis = false, key = this.state.key } = {}) {
        const target = this.state.targets.find(value => value.key === key);
        if (!target) return null;
        this.invalidate("");
        this.state.key = key;
        const sequence = ++this.sequence;
        this.abort = new AbortController();
        const signal = this.abort.signal;
        const candidate = structuredClone(filter ?? target.filter ?? EMPTY_VECTOR_FILTER);
        this.sourceIdentity = samplingTargetIdentity(target, candidate);
        this.state.selectionFilter = candidate;
        this.state.analysis = analysis;
        this.state.phase = "reading"; this.state.message = "Reading filtered polygons…"; this.render();
        try {
            // Abort obsolete transport, then let its bounded read settle before
            // starting the next request. Release uploaded inputs from obsolete replies.
            await this.reading;
            if (sequence !== this.sequence) return null;
            const read = this.createArea(target.item, candidate, signal, target);
            this.reading = read.catch(() => {});
            const area = await read;
            if (sequence !== this.sequence) { this.releaseArea(area); return null; }
            this.state.area = area;
            this.state.review = vectorSelectionReview(area);
            if (analysis) {
                this.state.phase = "selected";
                this.render();
            } else if (this.state.review.large) {
                this.state.phase = "review";
                this.state.message = `This selects ${area.matched.toLocaleString()} of ${area.total.toLocaleString()} features. ` +
                    `Its bounding envelope is about ${Math.round(this.state.review.envelopeKm2).toLocaleString()} km². ` +
                    "Exact raster calculations may take a while. Did you mean to filter first?";
                this.render();
            } else this.activate();
            return area;
        } catch (error) {
            if (sequence !== this.sequence) return null;
            this.state.phase = "error"; this.state.message = error.message; this.render();
            if (analysis) throw error;
            return null;
        }
    }
    /** Confirm the displayed selection, with a second near-global decision. */
    confirm() {
        if (this.state.phase === "review" && this.state.review.nearGlobal) {
            this.state.phase = "confirm";
            this.state.message = "This selection spans much of the Earth. Edit filter to choose a country or smaller region. Continue with all these features only if this is intentional; processing limits still apply.";
            this.render();
        } else if (["review", "confirm"].includes(this.state.phase)) this.activate();
    }
    /** Activate a catalog selection or private polygon reference returned by composition.
     * @param {Object|null} [selection=null] Expected descriptor for a completed primary action.
     * @param {boolean} [calculate=false] Explicit intent to run configured statistics.
     * @return {void}
     */
    activate(selection = null, calculate = false) {
        if (!this.state.area) return;
        if (selection !== null && (this.state.area.polygonArea
            ? this.state.area.polygonArea.id !== selection.id
            : !catalogSelectionsEqual(this.state.area.selection, selection))) return;
        this.state.phase = "active";
        const area = this.state.area;
        this.state.message = `Sampling ${area.matched.toLocaleString()} of ${area.total.toLocaleString()} features · calculations use the exact polygon geometry.`;
        this.onActivate(area, calculate);
        this.render();
    }
    /** Cancel selection and release the previous area through its owning callback.
     * @param {string} message Visible explanation for invalidating the retained selection.
     * @return {void}
     */
    invalidate(message) {
        ++this.sequence;
        this.abort?.abort();
        const area = this.state.area;
        this.state.area = null; this.state.phase = "idle"; this.state.message = message; this.sourceIdentity = null;
        this.state.selectionFilter = null;
        if (area) { this.onInvalidate(area.selection, area); this.releaseArea(area); }
        this.render();
    }
    /** Render the applied predicate, never an uncommitted filter draft. */
    render() {
        const target = this.state.targets.find(value => value.key === this.state.key);
        const state = { ...this.state, filterSummary: vectorFilterSummary(this.state.selectionFilter ?? target?.filter ?? EMPTY_VECTOR_FILTER) };
        this.views.forEach(view => view.render(state));
        this.onSelectionState({ phase: state.phase, message: state.message, analysis: !!state.analysis });
    }
    /** Cancel native reading and invalidate the descriptor on teardown. */
    destroy() { this.invalidate(""); this.views.forEach(view => view.unbind()); }
}

/**
 * Request an immutable catalog selection using source identity and typed rules.
 * @param {Object} item Catalog item.
 * @param {Object} filter Applied filter.
 * @param {AbortSignal} signal Native read cancellation.
 * @return {Promise<Object>} Catalog descriptor and counts.
 */
export async function createVectorSamplingArea(item, filter, signal) {
    const response = await fetch("/api/vector-sampling/areas", { method: "POST", signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectionId: item.collection, itemId: item.id, filter }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.detail ?? "Could not select these features");
    validateCatalogSelection(value.selection);
    if (!Array.isArray(value.bbox) || value.bbox.length !== 4 || !value.bbox.every(Number.isFinite) ||
        !Number.isSafeInteger(value.matched) || value.matched < 1 || !Number.isSafeInteger(value.total) || value.total < value.matched)
        throw new Error("Invalid vector sampling response");
    return value;
}
