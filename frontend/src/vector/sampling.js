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
     * @param {Object} dependencies View, targets, AOI transport and composed callbacks.
     */
    constructor({ view, getTargets, createArea, removeArea, onActivate, onInvalidate, onEditFilter, clock = globalThis }) {
        Object.assign(this, { view, getTargets, createArea, removeArea, onActivate, onInvalidate, onEditFilter, clock });
        this.sequence = 0;
        this.state = { targets: [], key: "", phase: "idle", area: null, message: "Choose a polygon layer, then use its filtered features." };
        view.bind({ onLayer: key => this.choose(key), onUse: () => void this.use(),
            onConfirm: () => this.confirm(), onRemove: () => this.invalidate("Selection removed"),
            onFilter: () => this.onEditFilter(this.state.key) });
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
    /** Read a bounded snapshot; no raster jobs start until review has passed. */
    async use() {
        const target = this.state.targets.find(value => value.key === this.state.key);
        if (!target) return;
        this.invalidate("");
        const sequence = ++this.sequence;
        this.sourceIdentity = identity(target);
        this.abort = new AbortController();
        this.state.phase = "reading"; this.state.message = "Reading filtered polygons…"; this.render();
        try {
            const area = await this.createArea(target.item, target.filter ?? EMPTY_VECTOR_FILTER, this.abort.signal);
            if (sequence !== this.sequence) { void this.removeArea(area.id).catch(() => {}); return; }
            this.state.area = area;
            this.clock.clearTimeout(this.expiration);
            this.expiration = this.clock.setTimeout(() => this.invalidate("Selection expired. Use these features again to refresh it."),
                Math.max(0, Date.parse(area.expiresAt) - Date.now()));
            this.state.review = vectorSelectionReview(area);
            if (this.state.review.large) {
                this.state.phase = "review";
                this.state.message = `This selects ${area.matched.toLocaleString()} of ${area.total.toLocaleString()} features. ` +
                    `Its bounding envelope is about ${Math.round(this.state.review.envelopeKm2).toLocaleString()} km². ` +
                    "Exact raster calculations may take a while. Did you mean to filter first?";
                this.render();
            } else this.activate();
        } catch (error) {
            if (sequence !== this.sequence) return;
            this.state.phase = "error"; this.state.message = error.message; this.render();
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
    /** Activate the reviewed opaque reference, without exporting geometry to raster APIs. */
    activate() {
        this.state.phase = "active";
        const area = this.state.area;
        this.state.message = `Sampling ${area.matched.toLocaleString()} of ${area.total.toLocaleString()} features · polygon boundaries and holes respected.`;
        this.onActivate(area);
        this.render();
    }
    /** @param {string} message Visible explanation for invalidating the retained selection. */
    invalidate(message) {
        ++this.sequence;
        this.abort?.abort(); this.clock.clearTimeout(this.expiration);
        const area = this.state.area;
        this.state.area = null; this.state.phase = "idle"; this.state.message = message; this.sourceIdentity = null;
        if (area) { this.onInvalidate(area.id); void this.removeArea(area.id).catch(() => {}); }
        this.render();
    }
    /** Render the applied predicate, never an uncommitted filter draft. */
    render() {
        const target = this.state.targets.find(value => value.key === this.state.key);
        this.view.render({ ...this.state, filterSummary: vectorFilterSummary(target?.filter ?? EMPTY_VECTOR_FILTER) });
    }
    /** Cancel native extraction and release retained geometry on teardown. */
    destroy() { this.invalidate(""); this.view.unbind(); }
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
