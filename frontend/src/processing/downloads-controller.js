/** Downloads owns review, immutable submissions, recovery, and job lifecycle presentation. */
import { normalizeRasterSamplingArea } from "../selected-area.js";
import { ProcessingRequestError } from "./api.js";

export const ACTIVE_JOB_STATES = new Set(["queued", "running", "cancelling"]);

/** Copy catalog identity without retaining a mutable Item. @param {Object} source Catalog source plus label. @return {Readonly<Object>} Snapshot. */
function snapshotSource(source) {
    return Object.freeze({ collectionId: source.collectionId, itemId: source.itemId, label: source.label });
}

/** Omit whole-raster areas from the download contract. @param {Object|null} area Sampling selection. @return {Readonly<Object>|null} Explicit area. */
function explicitArea(area) {
    if (area === null || area === undefined || ["wholeRaster", "wholeOverlap"].includes(area.kind)) return null;
    return normalizeRasterSamplingArea(area);
}

/** Own browser download state without importing map, histogram, or AOI implementations. */
export class DownloadsController {
    /**
     * @param {Object} dependencies Owned adapters and composition callbacks.
     * @param {Object} dependencies.api Processing API client.
     * @param {Object} dependencies.view Downloads DOM adapter.
     * @param {Object} dependencies.storage Pending-submission storage.
     * @param {Function} dependencies.getContext Returns catalog sources and the presented area.
     * @param {Function} dependencies.onOpen Opens the dock's Downloads tool.
     * @param {Function} dependencies.onClose Closes that tool.
     * @param {Function} dependencies.onEditArea Opens existing sampling controls.
     * @param {Object} [dependencies.clock=globalThis] Timer provider.
     * @param {Function} [dependencies.requestId] Generates a unique idempotency key.
     */
    constructor({ api, view, storage, getContext, onOpen, onClose, onEditArea,
        clock = globalThis, requestId = () => globalThis.crypto.randomUUID() }) {
        Object.assign(this, { api, view, storage, getContext, onOpen, clock, requestId });
        this.state = { sources: [], source: null, area: null, selectedArea: null,
            availableAoi: null, areaChoice: "selection", plan: null, jobs: [],
            busy: false, message: "", jobMessage: "", pending: storage.read(),
            submitting: false, jobActions: new Set() };
        this.planSequence = 0;
        this.planAbort = null;
        this.timer = null;
        this.refreshing = null;
        this.jobRevision = 0;
        this.destroyed = false;
        view.bind({
            onOpen: () => this.open(), onClose,
            onSource: (index) => this.selectSource(index),
            onArea: (choice) => this.selectArea(choice),
            onEditArea, onReview: () => void this.review(),
            onCreate: () => void this.submit(),
            onRetrySubmission: () => void this.submit(),
            onRefresh: () => void this.refresh(),
            onCancel: (id) => void this.jobAction(id, "cancel"),
            onDelete: (id) => void this.jobAction(id, "delete"),
        });
        this.render();
    }

    /** Start session recovery without blocking the map. @return {Promise<void>} Initial refresh. */
    async start() {
        await this.refresh();
        if (this.state.pending) await this.submit();
    }

    /**
     * Capture current intent when explicitly opening Downloads.
     * @param {Object|null} [source=null] Requested Catalog raster.
     * @param {Object|undefined} area Explicit entry-point selection; undefined uses presented selection.
     * @return {void}
     */
    open(source = null, area) {
        if (!this.state.pending && !this.state.submitting) {
            const context = this.getContext();
            this.invalidatePlan();
            this.state.sources = context.sources.map(snapshotSource);
            if (source && !this.state.sources.some(item => item.collectionId === source.collectionId && item.itemId === source.itemId)) {
                this.state.sources.unshift(snapshotSource(source));
            }
            this.state.source = source ? snapshotSource(source) : this.state.sources[0] ?? null;
            this.state.selectedArea = explicitArea(area === undefined ? context.area : area);
            this.state.area = this.state.selectedArea;
            this.state.areaChoice = "selection";
        }
        this.onOpen();
        this.render();
    }

    /** Invalidate only an unsubmitted plan. @return {void} */
    invalidatePlan() {
        this.planSequence += 1;
        this.planAbort?.abort();
        this.state.plan = null;
        this.state.busy = false;
        this.state.message = "";
    }

    /** Select one offered catalog source. @param {number} index Source option index. @return {void} */
    selectSource(index) {
        if (this.state.pending || this.state.submitting) return;
        this.invalidatePlan();
        this.state.source = this.state.sources[index] ?? null;
        this.render();
    }

    /** Select the captured box/AOI or explicitly opt into the ready upload. @param {string} choice Area option. @return {void} */
    selectArea(choice) {
        if (this.state.pending || this.state.submitting) return;
        this.invalidatePlan();
        this.state.areaChoice = choice;
        this.state.area = choice === "selection" ? this.state.selectedArea
            : choice === "uploaded" && this.state.availableAoi
                ? explicitArea({ kind: "temporaryAoi", temporaryAoiId: this.state.availableAoi.id }) : null;
        this.render();
    }

    /**
     * Receive a ready AOI lifecycle reference; accepted jobs remain unchanged.
     * @param {Readonly<Object>|null} aoi Ready public snapshot or removal/expiry.
     * @return {void}
     */
    setTemporaryAoi(aoi) {
        this.state.availableAoi = aoi;
        if (this.state.area?.kind === "temporaryAoi" && this.state.area.temporaryAoiId !== aoi?.id &&
            !this.state.pending && !this.state.submitting) {
            this.invalidatePlan();
            this.state.area = null;
            this.state.selectedArea = null;
            this.state.message = "The selected AOI is no longer available. Select a ready upload and review again.";
        }
        this.render();
    }

    /** Request a native-grid estimate for the captured intent. @return {Promise<void>} Review completion. */
    async review() {
        if (!this.state.source || !this.state.area || this.state.pending || this.state.submitting) return;
        this.invalidatePlan();
        const sequence = this.planSequence;
        this.planAbort = new AbortController();
        this.state.busy = true;
        this.render();
        try {
            const plan = await this.api.planClip(this.state.source, this.state.area, this.planAbort.signal);
            if (sequence === this.planSequence && !this.destroyed) this.state.plan = plan;
        } catch (error) {
            if (sequence === this.planSequence && !this.destroyed && error.name !== "AbortError") this.state.message = error.message;
        } finally {
            if (sequence === this.planSequence && !this.destroyed) {
                this.state.busy = false;
                this.render();
            }
        }
    }

    /** Submit once; persist and reuse the same key on uncertain responses or reload. @return {Promise<void>} Acceptance or recoverable error. */
    async submit() {
        if (this.state.submitting || this.destroyed) return;
        if (!this.state.pending) {
            if (!this.state.plan) return;
            if (Date.parse(this.state.plan.expiresAt) <= Date.now()) {
                this.invalidatePlan();
                this.state.message = "This estimate expired. Review the clip again before creating it.";
                this.render();
                return;
            }
            const pending = { planId: this.state.plan.planId, requestId: this.requestId(), label: this.state.source.label.slice(0, 512) };
            try { this.storage.write(pending); } catch (error) {
                this.state.message = `Cannot save download recovery information: ${error.message}`;
                this.render();
                return;
            }
            this.state.pending = pending;
        }
        this.state.submitting = true;
        this.state.message = "";
        this.render();
        const { planId, requestId } = this.state.pending;
        try {
            const job = await this.api.submitClip({ planId, requestId });
            this.jobRevision += 1;
            this.state.jobs = [job, ...this.state.jobs.filter(item => item.jobId !== job.jobId)];
            this.state.plan = null;
            this.storage.clear();
            this.state.pending = null;
            this.state.message = "Clip accepted. Its raster and area are fixed; you can keep exploring the map.";
        } catch (error) {
            // A definitive rejection creates no job. Server/transport failures can
            // occur after commit and must keep their original idempotency identity.
            if (error instanceof ProcessingRequestError && error.status >= 400 && error.status < 500 && error.status !== 408) {
                this.storage.clear();
                this.state.pending = null;
                this.state.plan = null;
                this.state.message = `${error.message} Review again when the problem is resolved.`;
            } else {
                this.state.message = `Submission not confirmed: ${error.message} Retry the same request to recover it safely.`;
            }
        } finally {
            this.state.submitting = false;
            this.render();
            this.scheduleRefresh();
        }
    }

    /** Refresh owned history with a single in-flight poll. @return {Promise<void>} Current listing. */
    refresh() {
        if (this.refreshing) return this.refreshing;
        const revision = this.jobRevision;
        this.refreshing = this.api.listJobs().then((jobs) => {
            if (this.destroyed || revision !== this.jobRevision) return;
            this.state.jobs = jobs;
            this.state.jobMessage = "";
        }).catch((error) => {
            if (!this.destroyed) this.state.jobMessage = `Downloads unavailable: ${error.message} Use Refresh to retry.`;
        }).finally(() => {
            this.refreshing = null;
            if (!this.destroyed) { this.render(); this.scheduleRefresh(); }
        });
        return this.refreshing;
    }

    /** Poll active work promptly and retained result expiration less often. @return {void} */
    scheduleRefresh() {
        this.clock.clearTimeout(this.timer);
        if (this.destroyed) return;
        const active = this.state.jobs.some(job => ACTIVE_JOB_STATES.has(job.status));
        this.timer = this.clock.setTimeout(() => void this.refresh(), active ? 2000 : 30000);
    }

    /** Perform one lifecycle action while preventing duplicate button dispatch. @param {string} id Job identity. @param {"cancel"|"delete"} action Intent. @return {Promise<void>} Action and refresh completion. */
    async jobAction(id, action) {
        if (this.state.jobActions.has(id)) return;
        this.state.jobActions.add(id);
        this.render();
        try {
            if (action === "cancel") await this.api.cancelJob(id);
            else await this.api.deleteJob(id);
            await this.refresh();
        } catch (error) { this.state.jobMessage = error.message; }
        finally { this.state.jobActions.delete(id); this.render(); }
    }

    /** Publish state through the owned view contract. @return {void} */
    render() { if (!this.destroyed) this.view.render(this.state); }

    /** Release browser work without cancelling accepted server jobs. @return {void} */
    destroy() {
        this.destroyed = true;
        this.planAbort?.abort();
        this.clock.clearTimeout(this.timer);
        this.view.unbind();
    }
}
