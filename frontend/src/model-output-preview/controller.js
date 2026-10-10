/** Own temporary run-output displays without making them catalog or analysis sources. */
import { PREVIEW_MEDIA_TYPES, readArtifactPreview } from "./api.js";
import { DEFAULT_RASTER_STYLE, buildRasterLegend } from "../raster/style.js";
import { normalizeRasterAppearanceState } from "../raster/appearance-state.js";
import { buildCategoricalRasterLegend } from "../raster/categorical-presentation.js";
import { normalizeVectorStyle, vectorStyleLegend } from "../vector/style.js";

/** Return the map identity of one run's immutable file.
 * @param {string} jobId Run identity. @param {string} artifactId File identity.
 * @return {string} Local map identity, independent of catalog keys.
 */
export function artifactLayerKey(jobId, artifactId) { return `local:artifact:${jobId}:${artifactId}`; }

/** Create an initial appearance from preview values, without claiming full-raster statistics.
 * @param {Object} data Checked display data.
 * @return {Object} Existing normalized raster or vector appearance contract.
 */
function initialAppearance(data) {
    if (data.kind === "vector") return normalizeVectorStyle({geometryKind: data.geometryKind, fillColor: data.geometryKind === "line" ? null : "#3388ff",
        fillOpacity: data.geometryKind === "line" ? null : 0.35, strokeColor: "#0066aa", strokeOpacity: 1, strokeWidth: 2, pointSize: data.geometryKind === "point" ? 8 : null,
        label: null, categorical: null, graduated: null});
    let minimum = Infinity, maximum = -Infinity;
    for (const value of data.values) if (value !== null) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
    if (!Number.isFinite(minimum)) { minimum = 0; maximum = 1; }
    if (minimum === maximum) { const pad = Math.max(Math.abs(minimum) * 1e-6, 1e-12); minimum -= pad; maximum += pad; }
    return normalizeRasterAppearanceState({kind: "raster", appearanceVersion: 1, mode: "continuous", categorical: null,
        continuous: {definition: {...DEFAULT_RASTER_STYLE, minimum, midpoint: minimum / 2 + maximum / 2, maximum},
            paletteName: "blue-yellow-red", styleWasEdited: false}});
}

/** Keep private previews, their display styles and availability tied to their originating runs. */
export class ModelOutputPreviews {
    /** Connect authorized transport and explicit map presentation callbacks.
     * @param {Object} dependencies Composition-supplied interfaces.
     * @param {Object} dependencies.api Processing status API.
     * @param {(source:Object,adapter:Object)=>void} dependencies.addLayer Attach a local display through the map owner.
     * @param {(key:string)=>void} dependencies.removeLayer Remove a displayed layer only.
     * @param {()=>void} dependencies.refreshLayers Refresh neutral layer presentations.
     * @param {(key:string,data:Object,appearance:Object)=>Object} dependencies.createLayer Create a Leaflet-compatible display.
     * @param {(jobId:string)=>void} dependencies.openRun Open the originating run's details.
     * @param {()=>void} dependencies.onChange Refresh output buttons and the private-map notice.
     * @param {Function} [dependencies.read=readArtifactPreview] Bounded preview reader.
     * @param {Object} [dependencies.clock=globalThis] Timer and wall-clock provider.
     */
    constructor({api, addLayer, removeLayer, refreshLayers, createLayer, openRun, onChange, read = readArtifactPreview, clock = globalThis}) {
        Object.assign(this, {api, addLayer, removeLayer, refreshLayers, createLayer, openRun, onChange, read, clock});
        this.layers = new Map(); this.pending = new Map(); this.messages = new Map(); this.timer = null; this.expiryTimer = null; this.destroyed = false;
    }

    /** Describe one file's display state to the Models view.
     * @param {string} jobId Run identity. @param {string} artifactId File identity.
     * @param {Object} file Validated file format and role.
     * @return {{canShow:boolean,onMap:boolean,busy:boolean,error:string}} Presentation-only status.
     */
    state(jobId, artifactId, file) {
        const key = artifactLayerKey(jobId, artifactId);
        return {canShow: PREVIEW_MEDIA_TYPES.has(file.mediaType) && file.role !== "provenance",
            onMap: this.layers.has(key), busy: this.pending.has(key), error: this.messages.get(key) ?? ""};
    }

    /** Explicitly load a file, then attach it only if its run is still available.
     * @param {Object} job Validated owning run snapshot.
     * @param {Object} file Validated manifest file.
     * @param {Object} [restore] Optional Undo style and map presentation.
     * @param {()=>boolean} [isCurrent] Whether Undo is still wanted.
     * @return {Promise<void>} Completion after attachment or visible failure.
     * @throws {Error} On failure during Undo, allowing the shared Undo action to report it.
     */
    async show(job, file, restore = null, isCurrent = () => true) {
        const key = artifactLayerKey(job.jobId, file.artifactId);
        if (this.layers.has(key) || this.pending.has(key)) return;
        const abort = new AbortController(); this.pending.set(key, abort); this.messages.delete(key); this.onChange();
        let layer;
        try {
            if (this.layers.size + this.pending.size > 8) throw new Error("Remove a result preview before adding another. Up to eight can be on the map at once.");
            if (!PREVIEW_MEDIA_TYPES.has(file.mediaType) || job.status !== "ready" || Date.parse(job.expiresAt) <= Date.now()) {
                throw new Error("This result is no longer available. Run the model again.");
            }
            const data = await this.read(job.jobId, file, abort.signal);
            if (this.destroyed || abort.signal.aborted || !isCurrent()) return;
            if (Date.parse(job.expiresAt) <= Date.now()) throw new Error("This result expired while its preview was loading.");
            const state = {key, jobId: job.jobId, runName: job.label, file, expiresAt: job.expiresAt, kind: data.kind,
                appearance: restore?.local.appearance ?? initialAppearance(data)};
            state.initial = initialAppearance(data);
            state.appearance = this.normalizeAppearance(state, state.appearance);
            layer = this.createLayer(key, data, state.appearance); state.layer = layer;
            this.layers.set(key, state);
            this.addLayer({key, label: file.label, visible: restore?.visible ?? true, opacity: restore?.opacity ?? 1}, this.adapter(state));
            this.schedule();
        } catch (error) {
            this.layers.delete(key); layer?.release();
            this.messages.set(key, error.message);
            if (restore) throw error;
        } finally { this.pending.delete(key); this.onChange(); }
    }

    /** Check copied or restored styles against this preview's supported appearance.
     * @param {Object} state Preview identity and kind.
     * @param {Object} candidate Candidate appearance contract.
     * @return {Object} Normalized compatible appearance.
     * @throws {Error} If type, symbol kind or unsupported field-based vector styling differs.
     */
    normalizeAppearance(state, candidate) {
        if (state.kind === "raster") return normalizeRasterAppearanceState(candidate);
        if (candidate.kind && candidate.kind !== "vector") throw new Error("Choose a vector style for this result.");
        const style = normalizeVectorStyle(candidate.definition ?? candidate);
        if (style.geometryKind !== state.initial.geometryKind || style.categorical || style.graduated || style.label) {
            throw new Error("Result previews support solid styles for the same geometry type.");
        }
        return style;
    }

    /** Commit an appearance and update the display and legend together.
     * @param {string} key Local preview identity. @param {Object} appearance Candidate existing style contract.
     * @return {Object} Committed normalized style.
     * @throws {Error} If the layer expired or the style is incompatible.
     */
    applyAppearance(key, appearance) {
        const state = this.layers.get(key); if (!state) throw new Error("This result is no longer on the map.");
        state.appearance = this.normalizeAppearance(state, appearance); state.layer.setAppearance(state.appearance);
        this.refreshLayers(); return state.appearance;
    }

    /** Supply the existing local-layer protocol without exposing display data to analysis.
     * @param {Object} state Private preview state owned by this component.
     * @return {Object} Map-layer adapter with style, legend and display-only lifecycle hooks.
     */
    adapter(state) {
        return {
            /** Supply the owner's state for this local layer. @return {Object} Preview state. */
            createState: () => state,
            /** Supply the owner's constructed display. @return {Object} Leaflet layer. */
            createLayer: () => state.layer,
            /** Describe this result without a catalog identity. @return {Object} Neutral layer presentation. */
            snapshot: () => ({datasetKind: state.kind, group: {id: state.jobId, label: state.runName}, legend: this.legend(state)}),
            /** Fit the map to this preview. @return {void} */
            zoom: () => state.layer.zoom(),
            /** Reopen the originating run. @return {void} */
            info: () => this.openRun(state.jobId),
            /** Copy appearance without exporting a private source. @return {Object} Existing clipboard contract. */
            exportSavedState: () => state.kind === "raster" ? state.appearance : {kind: "vector", definition: state.appearance},
            /** Check clipboard compatibility before offering Paste.
             * @param {Object} _record Neutral layer record. @param {Object} candidate Copied style.
             * @return {string|null} Explanation or null when compatible.
             */
            checkSavedStateCompatibility: (_record, candidate) => { try { this.normalizeAppearance(state, candidate); return null; } catch (error) { return error.message; } },
            /** Apply a checked clipboard style to this display.
             * @param {Object} _record Neutral layer record. @param {Object} candidate Copied style.
             * @return {Object} Committed appearance. @throws {Error} If incompatible or unavailable.
             */
            applySavedState: (_record, candidate) => this.applyAppearance(state.key, candidate),
            /** Keep identities and appearance for a fresh authorized Undo. @return {Object} No display bytes or credentials. */
            copyLayerForUndo: () => ({kind: "model-output-preview", jobId: state.jobId, artifactId: state.file.artifactId,
                appearance: structuredClone(state.appearance)}),
            /** Release display memory after its map layer is detached. @return {void} */
            removed: () => { state.layer.release(); this.layers.delete(state.key); this.schedule(); this.onChange(); },
        };
    }

    /** Project the committed appearance into the existing map legend contract.
     * @param {Object} state Preview state.
     * @return {Object} Neutral legend presentation.
     */
    legend(state) {
        if (state.kind === "vector") return vectorStyleLegend(state.appearance);
        if (state.appearance.mode === "categorical") return buildCategoricalRasterLegend(state.appearance.categorical);
        const style = state.appearance.continuous.definition; const legend = buildRasterLegend(style);
        return {kind: "gradient", ...legend, label: "Preview values", labels: [style.minimum, style.midpoint, style.maximum]};
    }

    /** Reauthorize an Undo from the server, preserving style but never reusing stale display bytes.
     * @param {Object} snapshot Shared map removal snapshot.
     * @param {()=>boolean} isCurrent Whether the Undo action is still current.
     * @return {Promise<void>} Completion after a fresh authorized preview.
     * @throws {Error} If the run or file is unavailable.
     */
    async restore(snapshot, isCurrent) {
        const job = await this.api.getJob(snapshot.local.jobId);
        const file = job.artifacts?.files.find(value => value.artifactId === snapshot.local.artifactId);
        if (!file) throw new Error("This result is no longer available. Run the model again.");
        if (isCurrent()) await this.show(job, file, snapshot, isCurrent);
    }

    /** Schedule expiry and bounded status revalidation even when Models is closed.
     * @return {void}
     */
    schedule() {
        this.clock.clearTimeout(this.timer);
        this.clock.clearTimeout(this.expiryTimer);
        if (!this.layers.size || this.destroyed) return;
        const expires = Math.min(...[...this.layers.values()].map(state => Date.parse(state.expiresAt)));
        this.timer = this.clock.setTimeout(() => void this.refreshAvailability(), 30000);
        this.expiryTimer = this.clock.setTimeout(() => { this.removeExpired(); this.schedule(); }, Math.max(0, Math.min(2147483647, expires - Date.now())));
    }

    /** Clear expired display bytes without waiting for an outstanding network read.
     * @return {void}
     */
    removeExpired() {
        for (const state of [...this.layers.values()]) {
            if (Date.parse(state.expiresAt) > Date.now()) continue;
            this.messages.set(state.key, "This result expired and its preview was removed. Run the model again.");
            this.removeLayer(state.key);
        }
    }

    /** Remove expired, deleted or inaccessible previews; failed revalidation fails closed.
     * @return {Promise<void>} Completion after one batched authoritative status request.
     */
    async refreshAvailability() {
        this.removeExpired();
        const captured = [...this.layers.values()];
        if (!captured.length) { this.schedule(); this.onChange(); return; }
        let jobs = [];
        try { ({jobs} = await this.api.readJobStatuses([...new Set(captured.map(state => state.jobId))], AbortSignal.timeout(15000))); }
        catch { /* A stale display must not survive loss of ownership or status access. */ }
        if (this.destroyed) return;
        for (const state of captured) {
            if (this.layers.get(state.key) !== state) continue;
            const job = jobs.find(value => value.jobId === state.jobId);
            const file = job?.artifacts?.files.find(value => value.artifactId === state.file.artifactId);
            if (job?.status === "ready" && Date.parse(job.expiresAt) > Date.now() && file?.sha256 === state.file.sha256) continue;
            this.messages.set(state.key, "Preview removed because the result is no longer available. Reopen the run to check it.");
            this.removeLayer(state.key);
        }
        this.schedule(); this.onChange();
    }

    /** Cancel pending reads and release every display when the application closes.
     * @return {void}
     */
    destroy() {
        this.destroyed = true; this.clock.clearTimeout(this.timer); this.clock.clearTimeout(this.expiryTimer);
        for (const abort of this.pending.values()) abort.abort();
        for (const key of this.layers.keys()) this.removeLayer(key);
    }
}
