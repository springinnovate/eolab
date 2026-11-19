/** Submit raster clips, recover pending requests and present download progress. */
import { labeledRasterSource, rasterSourceKey } from "../raster-source.js";
import { normalizeRasterSamplingArea, WHOLE_RASTER_SAMPLING_AREA } from "../selected-area.js";
import { ProcessingRequestError } from "./api.js";

import { ProcessingJobs } from "./jobs.js";
export { ACTIVE_JOB_STATES } from "./jobs.js";

/** Copy original raster identity and its label. @param {Object} source Labeled raster source. @return {Readonly<Object>} Snapshot. @throws {TypeError} If identity or label is invalid. */
function copyClipRasterSource(source) {
    return labeledRasterSource(source, source.label);
}

/** Validate a clip's rectangle, sampling box or original vector selection.
 * @param {Object|null|undefined} area Sampling selection.
 * @return {Readonly<Object>|null} Validated area, or null when no clipping area is selected.
 * @throws {TypeError|Error} If a selected rectangle or polygon reference is invalid.
 */
function normalizeClipArea(area) {
    if (area === null || area === undefined || ["wholeRaster", "wholeOverlap"].includes(area.kind)) return null;
    const selection = normalizeRasterSamplingArea(area);
    if (selection.kind === "polygonArea") {
        throw new TypeError("Choose a sampling box, Catalog layer or uploaded polygon layer to clip a raster.");
    }
    return selection;
}

/** Offer only map selections the clip service can read alongside the captured viewport and full raster.
 * @param {Object|null} viewport Visible geographic area at the time the sheet opened.
 * @param {Object|null} selection Current sampling box or original vector selection.
 * @return {{viewport:Object|null,whole:Object,box:Object|null,polygons:Object|null}} File area choices for a single map item.
 */
function layerDownloadAreas(viewport, selection) {
    return {viewport, whole: WHOLE_RASTER_SAMPLING_AREA,
        box: ["selectedArea", "samplingBox"].includes(selection?.kind) ? selection : null,
        polygons: selection?.kind === "catalogSelection" ? selection : null};
}

/** Retain clip state and show it only while the raster clip tool is active. */
export class RasterClipsController {
    /** Connect clip controls to the Processing API, job history and map area callbacks.
     * @param {Object} dependencies API clients, view, request storage and map callbacks.
     * @param {import("./api.js").ProcessingApiClient} dependencies.api Processing API client.
     * @param {ProcessingJobs} [dependencies.jobs] Shared session polling/history.
     * @param {import("./raster-clips-view.js").RasterClipsView} dependencies.view Raster clip DOM adapter.
     * @param {import("./raster-download-sheet.js").RasterDownloadSheet|null} [dependencies.layerView=null] Optional map-item presentation of the same clip workflow.
     * @param {import("./pending-submission.js").PendingSubmissionStorage} dependencies.storage Pending-submission storage.
     * @param {()=>{sources:Object[],area:Object|null}} dependencies.getContext Catalog sources and the presented area.
     * @param {((area:Object|null)=>Object[])|null} [dependencies.getQuerySources=null] Composed default candidates; explicit raster choices remain available.
     * @param {()=>void} dependencies.onOpen Opens the dock's raster clip tool.
     * @param {()=>void} dependencies.onClose Closes that tool.
     * @param {()=>void} dependencies.onEditArea Opens existing sampling controls.
     * @param {Object} [dependencies.clock=globalThis] Timer provider.
     * @param {()=>string} [dependencies.requestId] Generates a unique idempotency key.
     */
    constructor({ api, jobs, view, layerView = null, storage, getContext, getQuerySources = null, onOpen, onClose, onEditArea,
        clock = globalThis, requestId = () => globalThis.crypto.randomUUID() }) {
        Object.assign(this, { api, view, layerView, storage, getContext, getQuerySources, onOpen, onEditArea, clock, requestId });
        this.layerDrafts = new Map();
        this.layerKey = null;
        this.pendingDraft = null;
        this.state = { sources: [], source: null, area: null, jobs: [], currentJobId: null, review: false,
            message: "", jobMessage: "", pending: storage.read(),
            submitting: false, jobActions: new Set() };
        this.destroyed = false;
        this.active = false;
        this.ownsJobs = !jobs;
        this.jobs = jobs ?? new ProcessingJobs(api, clock);
        this.unsubscribe = this.jobs.subscribe(store => {
            this.state.jobs = store.jobs.filter(job => job.operation === "raster.clip.v1");
            if (!this.state.jobs.some(job => job.jobId === this.state.currentJobId && job.status !== "deleted")) {
                this.state.currentJobId = this.state.jobs.find(job => job.status !== "deleted")?.jobId ?? null;
            }
            this.state.jobMessage = store.error;
            this.render();
        });
        view.bind({
            onOpen: () => this.open(), onClose,
            onSource: (index) => this.selectSource(index),
            onEditArea: () => this.editArea(),
            onNew: () => this.open(null, this.getContext().area ?? null),
            onShowJob: id => this.showJob(id),
            onCreate: () => void this.submit(),
            onRetrySubmission: () => void this.submit(),
            onCancel: (id) => void this.jobAction(id, "cancel"),
            onDelete: (id) => void this.jobAction(id, "delete"),
        });
        layerView?.bind({
            onClose: focus => this.closeLayer(focus),
            onChoice: choice => {
                const draft = this.layerDrafts.get(this.layerKey);
                if (draft?.areas[choice] && !this.state.pending) {
                    draft.choice = choice;
                    draft.message = "";
                    this.render();
                }
            },
            onPrepare: () => this.submit(this.layerDrafts.get(this.layerKey)),
            onCancel: () => this.jobAction(this.layerDrafts.get(this.layerKey).jobId, "cancel"),
            onNew: () => {
                const draft = this.layerDrafts.get(this.layerKey);
                draft.jobId = null;
                draft.message = "";
                this.render();
            },
        });
        this.render();
    }

    /** Start session recovery without blocking the map. @return {Promise<void>} Initial refresh. */
    async start() {
        await this.refresh();
        if (this.state.pending) await this.submit();
    }

    /**
     * Review explicit entry-point inputs, or resume the current owned download.
     * Returning from area controls updates only unsubmitted intent. A pending
     * submission always retains its original inputs and request key.
     * @param {Object|null} [source=null] Original raster reference with the name of the chosen map view.
     * @param {Object|null|undefined} [area] Explicit entry-point selection; undefined uses presented selection.
     * @return {void}
     * @throws {TypeError} If an explicit sampling descriptor violates the neutral area contract.
     */
    open(source = null, area) {
        this.closeLayer(false);
        if (!this.state.pending && !this.state.submitting) {
            const context = this.getContext();
            this.state.message = "";
            this.state.sources = context.sources.map(copyClipRasterSource);
            this.state.review = source !== null || area !== undefined || !!this.editingArea || !this.state.currentJobId;
            if (this.state.review) {
                this.state.area = normalizeClipArea(area === undefined ? context.area : area);
                const fixed = source ?? (this.editingArea && this.sourceWasChosen ? this.state.source : null);
                const chosen = fixed ?? (this.getQuerySources ? this.getQuerySources(this.state.area)[0] : this.state.sources[0]) ?? null;
                this.sourceWasChosen = !!fixed;
                if (chosen && !this.state.sources.some(item => item.label === chosen.label && rasterSourceKey(item) === rasterSourceKey(chosen))) {
                    this.state.sources.unshift(copyClipRasterSource(chosen));
                }
                this.state.source = chosen ? copyClipRasterSource(chosen) : null;
            }
        }
        this.editingArea = false;
        this.active = true;
        this.onOpen();
        this.render();
    }

    /** Toggle the file sheet for a specific map view, including a renamed copy of the same source.
     * @param {string} key Map view identity.
     * @param {Object} source Labeled original raster or exact temporal observation.
     * @param {{viewport:Object|null,selection:Object|null,viewportError?:string}} context Snapshot of the visible map and available sampling selection.
     * @return {void}
     */
    toggleLayer(key, source, {viewport, selection, viewportError = ""}) {
        if (this.layerKey === key) { this.closeLayer(true); return; }
        let draft = this.layerDrafts.get(key);
        if (!draft || rasterSourceKey(draft.source) !== rasterSourceKey(source)) {
            draft = {choice: viewport ? "viewport" : "whole", jobId: null, message: ""};
            this.layerDrafts.set(key, draft);
        }
        draft.source = copyClipRasterSource(source);
        draft.viewportError = viewportError;
        draft.areas = layerDownloadAreas(viewport, selection);
        const pending = this.state.pending;
        if (pending && !this.pendingDraft && pending.label === source.label && rasterSourceKey(pending.source) === rasterSourceKey(source)) {
            this.pendingDraft = draft;
        }
        this.layerKey = key;
        this.layerView.open(key);
        this.render();
    }

    /** Dismiss the active layer sheet while retaining its draft, captured submission and owned job.
     * @param {boolean} returnFocus Whether to focus its current map button.
     * @return {void}
     */
    closeLayer(returnFocus) {
        if (this.layerKey === null) return;
        this.layerKey = null;
        this.layerView.close(returnFocus);
    }

    /** Drop draft state for map views that have been removed or changed their original raster.
     * @param {{key:string,source:Object,label:string}[]} layers Eligible map views with their original source identities and current display names.
     * @return {void}
     */
    syncLayerDownloads(layers) {
        if (!this.layerDrafts.size) return;
        const byKey = new Map(layers.map(layer => [layer.key, layer]));
        for (const [key, draft] of this.layerDrafts) {
            const layer = byKey.get(key);
            if (!layer || rasterSourceKey(layer.source) !== rasterSourceKey(draft.source)) {
                if (this.layerKey === key) this.closeLayer(false);
                this.layerDrafts.delete(key);
            } else if (layer.label !== draft.source.label) {
                draft.source = copyClipRasterSource({...draft.source, label: layer.label});
                if (this.layerKey === key) this.render();
            }
        }
    }

    /** Select one offered catalog source. @param {number} index Source option index. @return {void} */
    selectSource(index) {
        if (this.state.pending || this.state.submitting) return;
        this.state.message = "";
        this.state.source = this.state.sources[index] ?? null;
        this.sourceWasChosen = this.state.source !== null;
        this.render();
    }

    /** Open composed sampling controls for unsubmitted intent only. @return {void} */
    editArea() {
        if (this.state.pending || this.state.submitting) return;
        this.editingArea = true;
        this.onEditArea();
    }

    /** Update the open map choices and Tools form after a shared sampling-area edit.
     * Submitted jobs and uncertain submissions retain their original inputs.
     * @param {Readonly<Object>|null} area Validated, immutable map box or polygon selection; null clears it.
     * @return {void}
     */
    setSelection(area) {
        if (this.state.pending || this.state.submitting) return;
        const draft = this.layerDrafts.get(this.layerKey);
        if (draft && !draft.jobId) {
            draft.areas = layerDownloadAreas(draft.areas.viewport, area);
        }
        if (this.active && this.state.review) this.state.area = area;
        if (draft || this.active && this.state.review) this.render();
    }

    /** Inspect one owned download without changing submitted inputs or dispatching work.
     * @param {string} id Owned clip job selected from the current listing.
     * @return {void}
     */
    showJob(id) {
        if (this.state.pending || this.state.submitting || !this.state.jobs.some(job => job.jobId === id && job.status !== "deleted")) return;
        this.state.currentJobId = id;
        this.state.review = false;
        this.state.message = "";
        this.render();
        this.view.focusCurrent?.();
    }

    /** Prepare one GeoTIFF, retaining the captured inputs and retry key across dismissal or reload.
     * @param {Object|null} [layerDraft=null] The originating map item's draft, or null for the Tools form and session recovery.
     * @return {Promise<void>} Acceptance or recoverable error.
     */
    async submit(layerDraft = null) {
        if (this.state.submitting || this.destroyed) return;
        if (layerDraft && this.state.pending && layerDraft !== this.pendingDraft) return;
        const owner = this.pendingDraft ?? layerDraft;
        if (!this.state.pending) {
            const source = layerDraft ? layerDraft.source : this.state.source;
            const area = layerDraft ? layerDraft.areas[layerDraft.choice] : this.state.area;
            if (!source || !area) return;
            const pending = {source, area, requestId: this.requestId(), label: source.label.slice(0, 512)};
            try { this.storage.write(pending); } catch (error) {
                this.state.message = `Cannot save download recovery information: ${error.message}`;
                if (owner) owner.message = this.state.message;
                this.render();
                return;
            }
            this.state.pending = pending;
            this.pendingDraft = owner;
        }
        this.state.submitting = true;
        if (owner) owner.message = "";
        this.state.message = "";
        this.render();
        try {
            const job = await this.api.submitClip(this.state.pending);
            if (this.pendingDraft) this.pendingDraft.jobId = job.jobId;
            this.state.currentJobId = job.jobId;
            this.state.review = false;
            this.jobs.accept(job);
            this.storage.clear();
            this.state.pending = null;
            this.pendingDraft = null;
            this.state.message = "";
        } catch (error) {
            // A definitive rejection creates no job. Server/transport failures can
            // occur after commit and must keep their original idempotency identity.
            if (error instanceof ProcessingRequestError && error.status >= 400 && error.status < 500 && error.status !== 408 && !error.isCapacityRejection) {
                this.storage.clear();
                this.state.pending = null;
                this.pendingDraft = null;
                this.state.message = `${error.message} Prepare the download again when the problem is resolved.`;
            } else {
                this.state.message = error.message;
            }
        } finally {
            if (owner) owner.message = this.state.message;
            this.state.submitting = false;
            this.render();
            this.scheduleRefresh();
        }
    }

    /** Refresh owned history with a single in-flight poll. @return {Promise<void>} Current listing. */
    refresh() {
        return this.jobs.refresh();
    }

    /** Poll active work promptly and retained result expiration less often. @return {void} */
    scheduleRefresh() {
        this.jobs.schedule();
    }

    /** Perform one lifecycle action while preventing duplicate button dispatch. @param {string} id Job identity. @param {"cancel"|"delete"} action Intent. @return {Promise<void>} Action and refresh completion. */
    async jobAction(id, action) {
        if (this.state.jobActions.has(id)) return;
        this.state.jobActions.add(id);
        this.render();
        try {
            await this.jobs.action(id, action);
        } catch (error) { this.state.jobMessage = error.message; }
        finally { this.state.jobActions.delete(id); this.render(); }
    }

    /**
     * Show the latest retained clip state when the dock activates this tool.
     * Closing it leaves accepted jobs and uncertain-submission recovery intact.
     * @param {boolean} active Whether the raster clip tool is visible.
     * @return {void}
     */
    setActive(active) {
        if (this.active === active) return;
        this.active = active;
        this.render();
    }

    /** Refresh the visible download presentations from the same session jobs and submission state. @return {void} */
    render() {
        if (this.destroyed) return;
        if (this.active) this.view.render(this.state);
        const draft = this.layerDrafts.get(this.layerKey);
        if (draft) this.layerView.render(draft, this.state.jobs.find(job => job.jobId === draft.jobId) ?? null, {
            pending: this.pendingDraft === draft ? this.state.pending : null,
            blocked: !!this.state.pending && this.pendingDraft !== draft, submitting: this.state.submitting,
            cancelling: this.state.jobActions.has(draft.jobId),
            error: draft.message || this.state.jobMessage,
        });
    }

    /** Release browser work without cancelling accepted server jobs. @return {void} */
    destroy() {
        this.destroyed = true;
        this.state.message = "";
        this.unsubscribe();
        if (this.ownsJobs) this.jobs.destroy();
        this.view.unbind();
        this.layerView?.destroy();
    }
}
