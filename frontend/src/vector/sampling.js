/** Vector-owned selection intent; AOI retention and map rendering are injected. */
import { EMPTY_VECTOR_FILTER, vectorFilterSummary } from "./filter.js";

const identity = target => target ? JSON.stringify([target.key, target.item, target.filter]) : "";

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

/** Create polygon AOIs and invalidate them when their source/filter changes. */
export class VectorSamplingController {
    /**
     * @param {Object} dependencies Views, targets, AOI transport and composed callbacks.
     * @param {Object|Object[]} dependencies.view One or more synchronized selection views.
     */
    constructor({ view, getTargets, createArea, removeArea, onActivate, onInvalidate, onEditFilter, onSelectionState = () => {}, clock = globalThis }) {
        Object.assign(this, { view, getTargets, createArea, removeArea, onActivate, onInvalidate, onEditFilter, clock });
        this.onSelectionState = onSelectionState;
        this.retired = new Set();
        this.views = Array.isArray(view) ? view : [view];
        this.sequence = 0;
        this.state = { targets: [], key: "", phase: "idle", area: null, message: "Choose a polygon layer, then use its filtered features." };
        this.views.forEach(target => target.bind({ onLayer: key => this.choose(key), onUse: () => void this.use(),
            onConfirm: () => this.confirm(), onRemove: () => this.invalidate("Selection removed"),
            onFilter: () => this.onEditFilter(this.state.key) }));
        this.refresh();
    }
    /** Refresh composition-supplied layer snapshots without interpreting renderer internals. */
    refresh() {
        const targets = this.getTargets();
        const next = targets.find(target => target.key === this.state.key);
        if (this.sourceIdentity && this.sourceIdentity !== identity(next)) {
            this.invalidate("Layer or filter changed. Use these features again to update the sampling area.");
        }
        this.state.targets = targets;
        if (!next) this.state.key = targets[0]?.key ?? "";
        this.render();
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
     * Select a committed predicate on one bounded lane, reclaiming obsolete replies.
     * @param {Object} [options={}] Explicit analysis selection options.
     * @param {Object|null} [options.filter=null] Committed analysis filter, independent of rendering.
     * @param {string} [options.key] Captured layer identity from the filter editor.
     * @param {boolean} [options.analysis=false] Defer activation to the composed primary action.
     * @return {Promise<Object|null>} Current retained area, or null if superseded.
     * @throws {Error} If an explicit analysis selection or cleanup fails.
     */
    async use({ filter = null, analysis = false, key = this.state.key } = {}) {
        const target = this.state.targets.find(value => value.key === key);
        if (!target) return null;
        this.invalidate("");
        this.state.key = key;
        const sequence = ++this.sequence;
        this.sourceIdentity = identity(target);
        const candidate = structuredClone(filter ?? target.filter ?? EMPTY_VECTOR_FILTER);
        this.state.selectionFilter = candidate;
        this.state.analysis = analysis;
        this.state.phase = "reading"; this.state.message = "Reading filtered polygons…"; this.render();
        try {
            // Keep the bounded request connected so a committed AOI identity cannot
            // be lost on abort. The next read waits for reclamation of its reply.
            await this.reading;
            await this.releaseRetired();
            if (sequence !== this.sequence) return null;
            const read = (async () => {
                const area = await this.createArea(target.item, candidate, new AbortController().signal);
                if (sequence !== this.sequence) {
                    this.retired.add(area.id);
                    await this.releaseRetired();
                    return null;
                }
                return area;
            })();
            this.reading = read.catch(() => {});
            const area = await read;
            if (!area) return null;
            if (sequence !== this.sequence) {
                this.retired.add(area.id);
                await this.releaseRetired();
                return null;
            }
            this.state.area = area;
            this.clock.clearTimeout(this.expiration);
            this.expiration = this.clock.setTimeout(() => this.invalidate("Selection expired. Use these features again to refresh it."),
                Math.max(0, Date.parse(area.expiresAt) - Date.now()));
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
    /** Release obsolete opaque references; retain failures for explicit retry.
     * @return {Promise<void>} Acknowledged lifecycle cleanup.
     * @throws {Error} If the server cannot acknowledge removal.
     */
    async releaseRetired() {
        if (this.releasing) return this.releasing;
        this.releasing = (async () => {
            for (const id of this.retired) { await this.removeArea(id); this.retired.delete(id); }
        })();
        try { await this.releasing; } finally { this.releasing = null; }
    }
    /** Confirm the displayed selection, with a second near-global decision. */
    confirm() {
        if (this.state.phase === "review" && this.state.review.nearGlobal) {
            this.state.phase = "confirm";
            this.state.message = "This selection spans much of the Earth. Edit filter to choose a country or smaller region. Continue with all these features only if this is intentional; processing limits still apply.";
            this.render();
        } else if (["review", "confirm"].includes(this.state.phase)) this.activate();
    }
    /** Activate the current opaque reference, without exporting geometry to analysis.
     * @param {string|null} [id=null] Expected identity for a completed primary action.
     * @param {boolean} [calculate=false] Explicit intent to run configured statistics.
     * @return {void}
     */
    activate(id = null, calculate = false) {
        if (!this.state.area || (id !== null && this.state.area.id !== id)) return;
        this.state.phase = "active";
        const area = this.state.area;
        this.state.message = `Sampling ${area.matched.toLocaleString()} of ${area.total.toLocaleString()} features · polygon boundaries and holes respected. Map outline simplified; calculations use exact geometry.`;
        this.onActivate(area, calculate);
        this.render();
    }
    /** @param {string} message Visible explanation for invalidating the retained selection. */
    invalidate(message) {
        ++this.sequence;
        this.clock.clearTimeout(this.expiration);
        const area = this.state.area;
        this.state.area = null; this.state.phase = "idle"; this.state.message = message; this.sourceIdentity = null;
        this.state.selectionFilter = null;
        if (area) {
            this.onInvalidate(area.id); this.retired.add(area.id);
            void this.releaseRetired().catch(error => {
                this.state.message = `Area cleanup failed: ${error.message}. Retry the selection to release it.`;
                this.render();
            });
        }
        this.render();
    }
    /** Render the applied predicate, never an uncommitted filter draft. */
    render() {
        const target = this.state.targets.find(value => value.key === this.state.key);
        const state = { ...this.state, filterSummary: vectorFilterSummary(this.state.selectionFilter ?? target?.filter ?? EMPTY_VECTOR_FILTER) };
        this.views.forEach(view => view.render(state));
        this.onSelectionState({ phase: state.phase, message: state.message, analysis: !!state.analysis });
    }
    /** Cancel native extraction and release retained geometry on teardown. */
    destroy() { this.invalidate(""); this.views.forEach(view => view.unbind()); }
}

/**
 * Request a complete polygon snapshot using Catalog identity and typed rules.
 * @param {Object} item Catalog item.
 * @param {Object} filter Applied filter.
 * @param {AbortSignal} signal Native read cancellation.
 * @return {Promise<Object>} Ready AOI and counts.
 */
export async function createVectorSamplingArea(item, filter, signal) {
    const response = await fetch("/api/vector-sampling/areas", { method: "POST", signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectionId: item.collection, itemId: item.id, filter }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.detail ?? "Could not select these features");
    if (!/^[A-Za-z0-9_-]{32}$/.test(value.id) || !Number.isFinite(Date.parse(value.expiresAt)) ||
        !Array.isArray(value.bbox) || value.bbox.length !== 4 || !value.bbox.every(Number.isFinite) ||
        !Number.isSafeInteger(value.matched) || value.matched < 1 || !Number.isSafeInteger(value.total) || value.total < value.matched ||
        value.geometry?.type !== "FeatureCollection") throw new Error("Invalid vector sampling response");
    return value;
}
