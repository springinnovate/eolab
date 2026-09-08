/** Calculation intent, inline results, and one latest-area workflow. */
import { normalizeRasterSamplingArea } from "../selected-area.js";
import { ACTIVE_JOB_STATES } from "./jobs.js";
import { ProcessingRequestError } from "./api.js";
import { calculationIntent } from "./calculation-session.js";

/** Stable comparison of public intents. @param {Object|null} value Intent. @return {string} Identity. */
function identity(value) { return JSON.stringify(value); }

/** Own calculation editing and latest-click cancellation without importing map peers. */
export class CalculationsController {
    /**
     * @param {Object} dependencies API, shared jobs, session storage, DOM view, clock,
     * public context and area/activity/presentation callbacks.
     */
    constructor({ api, jobs, storage, view, getContext, onOpen, onClose, onEditArea,
        onActivity = () => {}, clock = globalThis, requestId = () => crypto.randomUUID() }) {
        Object.assign(this, { api, jobs, storage, view, getContext, onOpen, onClose, onActivity, clock, requestId });
        this.state = { sources: [], source: null, selectedArea: null, area: null, areaChoice: "selection",
            availableAoi: null, calculations: [{ label: "Mean", expression: "mean(a)" }],
            valid: false, validation: "", plan: null, phase: "idle", message: "", followWanted: false,
            following: false, result: null, resultIntent: null, current: null, jobs: [], historyError: "" };
        this.record = storage.read();
        this.desired = null;
        this.sequence = 0;
        this.validationSequence = 0;
        this.advanceRunning = false;
        this.blocked = false;
        this.destroyed = false;
        this.unsubscribe = jobs.subscribe(() => this.receiveJobs());
        view.bind({ onOpen: () => this.open(), onClose: () => this.close(), onEditArea,
            onSource: index => this.edit({ source: this.state.sources[index] ?? null }),
            onArea: choice => this.chooseArea(choice),
            onCalculations: calculations => this.edit({ calculations }),
            onFollow: checked => {
                if (!checked && this.state.following) this.stopFollowing();
                this.state.followWanted = checked;
                this.render();
            },
            onReview: () => void this.review(), onRun: () => void this.run(),
            onRerun: () => void this.rerun(),
            onStop: () => this.stop(), onRetry: () => { this.blocked = false; void this.advance(); },
            onRefresh: () => void jobs.refresh(), onInspect: id => this.inspect(id),
            onCancel: id => void this.jobAction(id, "cancel"), onDelete: id => void this.jobAction(id, "delete"),
        });
        this.render();
    }

    /** Recover accepted work; reload always pauses automatic sampling. @return {Promise<void>} Recovery. */
    async start() {
        if (this.record) {
            const { intent, jobId } = this.record;
            this.state.source = intent.source;
            this.state.sources = [intent.source];
            this.state.area = this.state.selectedArea = intent.area;
            this.state.calculations = intent.calculations.map(row => ({ ...row }));
            if (jobId) this.jobs.tracked.add(jobId);
            try { this.storage.write(this.record); }
            catch (error) { this.state.message = error.message; this.blocked = true; this.render(); }
        }
        await this.jobs.refresh();
        await this.advance();
    }

    /** Open from a named source and explicit histogram area. @param {Object|null} source Source. @param {Object|undefined} area Area. @return {void} */
    open(source = null, area) {
        const context = this.getContext();
        this.state.sources = [...context.sources];
        const selectedSource = source ?? this.state.source ?? this.state.sources[0] ?? null;
        if (selectedSource && !this.state.sources.some(item => item.collectionId === selectedSource.collectionId && item.itemId === selectedSource.itemId)) {
            this.state.sources.unshift(selectedSource);
        }
        const selectedArea = area === undefined ? context.area : area;
        this.state.selectedArea = selectedArea ? normalizeRasterSamplingArea(selectedArea) : null;
        this.edit({ source: selectedSource, area: this.state.selectedArea, areaChoice: "selection" });
        this.view.openEditor?.();
        this.onOpen();
    }

    /** Snapshot editor intent; never fall back from no selection to whole raster. @return {Object} Frozen intent. */
    intent() {
        if (!this.state.area) throw new Error("Choose a sampling box, uploaded AOI, or Whole raster.");
        return calculationIntent(this.state);
    }

    /** Whether map selection should retain this tool's foreground presentation. @return {boolean} Follow mode. */
    get isFollowing() { return this.state.following; }

    /** Pause follow mode and invalidate unaccepted planning. @return {void} */
    stopFollowing() {
        this.state.following = false;
        this.desired = null;
        this.sequence += 1;
        this.planAbort?.abort();
        this.clock.clearTimeout(this.debounce);
        this.discardReview();
        if (!this.record) this.state.phase = "idle";
        if (this.record?.automatic) this.requestCancellation();
    }

    /** Apply an editor change; validation never submits work. @param {Object} change Changed fields. @return {void} */
    edit(change) {
        this.stopFollowing();
        Object.assign(this.state, change);
        this.state.message = "";
        this.state.phase = this.record ? this.state.phase : "idle";
        this.state.valid = false;
        this.state.validation = "Checking expressions…";
        this.validationAbort?.abort();
        const version = ++this.validationSequence;
        this.clock.clearTimeout(this.validationTimer);
        this.validationTimer = this.clock.setTimeout(() => void this.validate(version), 400);
        this.render();
    }

    /** Validate using the backend grammar only. @param {number} version Edit version. @return {Promise<void>} Validation. */
    async validate(version = this.validationSequence) {
        this.validationAbort = new AbortController();
        try {
            await this.api.validateCalculation(this.state.calculations, this.validationAbort.signal);
            if (version !== this.validationSequence || this.destroyed) return;
            this.state.valid = true;
            this.state.validation = "Expressions are valid.";
        } catch (error) {
            if (version !== this.validationSequence || this.destroyed || error.name === "AbortError") return;
            this.state.valid = false;
            this.state.validation = error.message;
        }
        this.render();
    }

    /** Choose explicit scope; follow mode is available only for map boxes. @param {string} choice Scope. @return {void} */
    chooseArea(choice) {
        const area = choice === "whole" ? { kind: "wholeRaster" } : choice === "uploaded"
            ? this.state.availableAoi && { kind: "temporaryAoi", temporaryAoiId: this.state.availableAoi.id }
            : this.state.selectedArea;
        this.edit({ areaChoice: choice, area });
    }

    /** Observe AOI lifecycle without altering accepted snapshots. @param {Object|null} aoi Ready reference. @return {void} */
    setTemporaryAoi(aoi) {
        this.state.availableAoi = aoi;
        if (this.state.area?.kind === "temporaryAoi" && this.state.area.temporaryAoiId !== aoi?.id) this.edit({ area: null });
        this.render();
    }

    /** Receive committed areas, not pointer previews. @param {Object|null} area Sampling snapshot. @return {void} */
    setSelection(area) {
        const next = area ? normalizeRasterSamplingArea(area) : null;
        if (identity(next) === identity(this.state.selectedArea)) return;
        this.state.selectedArea = next;
        if (this.state.areaChoice !== "selection") return;
        this.state.area = next;
        this.sequence += 1;
        this.planAbort?.abort();
        this.discardReview();
        if (!this.state.following) { if (!this.record) this.state.phase = "idle"; this.render(); return; }
        if (next?.kind !== "selectedArea") { this.stopFollowing(); this.render(); return; }
        this.desired = { intent: this.intent(), ready: false, automatic: true, sequence: this.sequence };
        this.requestCancellation();
        this.state.phase = "waiting";
        this.state.message = "Waiting for the latest box…";
        this.clock.clearTimeout(this.debounce);
        this.debounce = this.clock.setTimeout(() => {
            if (this.desired) this.desired.ready = true;
            void this.advance();
        }, 650);
        this.render();
    }

    /** Mark durable cancellation before recovering uncertain submissions. @return {void} */
    requestCancellation() {
        if (!this.record) return;
        this.record.cancelRequested = true;
        try { this.storage.write(this.record); }
        catch (error) { this.state.message = error.message; }
        void this.advance();
    }

    /** Discard obsolete review metadata; a disconnected release expires safely. @return {void} */
    discardReview() {
        const plan = this.state.plan;
        this.state.plan = null;
        if (plan) void this.api.discardPlan(plan.planId).catch(() => {});
    }

    /** Review one current intent without submitting a job. @return {Promise<void>} Estimate. */
    async review() {
        this.stopFollowing();
        const sequence = this.sequence;
        this.planAbort = new AbortController();
        this.state.phase = "planning";
        this.state.message = "Reading native raster metadata…";
        this.render();
        try {
            const plan = await this.api.planCalculation(this.intent(), this.planAbort.signal);
            if (sequence === this.sequence && !this.destroyed) {
                this.state.plan = plan;
                this.state.valid = true;
                this.state.message = "Review the native work below, then Run.";
            } else {
                void this.api.discardPlan(plan.planId).catch(() => {});
            }
        } catch (error) {
            if (sequence === this.sequence && error.name !== "AbortError") this.state.message = error.message;
        } finally {
            if (sequence === this.sequence) this.state.phase = "idle";
            this.render();
        }
    }

    /** Start one reviewed run and optionally arm subsequent box clicks. @return {Promise<void>} Dispatch. */
    async run() {
        if (!this.state.plan || this.destroyed) return;
        if (Date.parse(this.state.plan.expiresAt) <= Date.now()) {
            this.state.plan = null; this.state.message = "Estimate expired. Review again."; this.render(); return;
        }
        this.blocked = false;
        this.state.following = this.state.followWanted && this.state.area?.kind === "selectedArea" && this.state.areaChoice === "selection";
        this.desired = { intent: this.intent(), plan: this.state.plan, ready: true,
            automatic: this.state.following, sequence: ++this.sequence };
        this.state.plan = null;
        this.requestCancellation();
        await this.advance();
    }

    /** Recalculate unchanged, previously reviewed settings. @return {Promise<void>} Fresh plan and run. */
    async rerun() {
        if (!this.state.resultIsCurrent || this.state.hasWork) return;
        this.blocked = false;
        this.desired = { intent: this.intent(), ready: true, automatic: this.state.following, sequence: ++this.sequence };
        await this.advance();
    }

    /** Stop automatic requests and cancel this editor's active work. @return {void} */
    stop() {
        this.stopFollowing();
        this.requestCancellation();
        if (!this.record) this.state.message = "Calculation stopped.";
        this.render();
    }

    /** Closing pauses automatic work; explicit one-off jobs continue in history. @return {void} */
    close() { this.stopFollowing(); this.render(); this.onClose(); }

    /**
     * Drain one durable workflow before admitting the newest requested area.
     * Unknown submissions retain their key; cancelling jobs retain their slot.
     * @return {Promise<void>} Current progress, never an unbounded polling loop.
     */
    async advance() {
        if (this.advanceRunning || this.destroyed || this.blocked) return;
        this.advanceRunning = true;
        try {
            if (this.record?.pending) {
                this.state.phase = "submitting";
                this.state.message = "Confirming calculation submission…";
                this.render();
                let job;
                try { job = await this.api.submitCalculation(this.record.pending); }
                catch (error) {
                    if (error instanceof ProcessingRequestError && error.status >= 400 && error.status < 500 && error.status !== 408) {
                        this.storage.clear(); this.record = null;
                    }
                    throw error;
                }
                this.record.jobId = job.jobId;
                this.record.releasePlanId = this.record.pending.planId;
                this.record.pending = null;
                this.storage.write(this.record);
                this.jobs.tracked.add(job.jobId);
                this.jobs.accept(job);
            }
            if (this.record?.releasePlanId) {
                await this.api.discardPlan(this.record.releasePlanId);
                this.record.releasePlanId = null;
                this.storage.write(this.record);
            }
            if (this.record?.jobId) {
                const job = this.jobs.jobs.find(item => item.jobId === this.record.jobId);
                if (!job) { await this.jobs.refresh(); return; }
                this.state.current = job;
                if (ACTIVE_JOB_STATES.has(job.status)) {
                    this.state.phase = this.record.cancelRequested ? "cancelling" : job.status;
                    this.state.message = this.record.cancelRequested ? "Cancelling the previous calculation before starting the latest box…" : "";
                    if (this.record.cancelRequested && job.status !== "cancelling") await this.jobs.action(job.jobId, "cancel");
                    return;
                }
                if (job.status === "ready" && !this.record.cancelRequested) {
                    this.state.result = job; this.state.resultIntent = this.record.intent;
                    this.state.message = "Calculation complete.";
                } else if (["failed", "interrupted"].includes(job.status) && !this.record.cancelRequested) {
                    this.state.message = job.error?.detail ?? "Calculation interrupted. Review and run again.";
                    this.state.following = false;
                } else if (this.record.cancelRequested || job.status === "cancelled") {
                    this.state.message = this.desired ? "Waiting for the latest sampling box…" : "Calculation cancelled.";
                }
                this.jobs.tracked.delete(job.jobId);
                this.storage.clear(); this.record = null; this.state.current = null;
                this.state.phase = "idle";
            }
            if (!this.desired?.ready) return;
            const target = this.desired;
            this.state.phase = "planning";
            this.state.message = "Reading native raster metadata for the latest box…";
            this.planAbort = new AbortController();
            this.render();
            let plan;
            try { plan = target.plan ?? await this.api.planCalculation(target.intent, this.planAbort.signal); }
            catch (error) { if (target !== this.desired || error.name === "AbortError") return; throw error; }
            if (target !== this.desired || this.destroyed) {
                void this.api.discardPlan(plan.planId).catch(() => {});
                return;
            }
            const record = { intent: target.intent, automatic: target.automatic, cancelRequested: false,
                pending: { planId: plan.planId, requestId: this.requestId() }, jobId: null };
            this.storage.write(record);
            this.record = record;
            this.desired = null;
        } catch (error) {
            this.blocked = true;
            this.desired = null;
            this.state.following = false;
            this.state.phase = "error";
            this.state.message = `${error.message}${this.record ? " Recover / retry to confirm or cancel the same job safely." : " Review again to retry."}`;
        } finally {
            this.advanceRunning = false;
            this.render();
            // A newer debounced box may have arrived while an aborted plan
            // was still unwinding. Do not strand it behind that old request.
            if (!this.blocked && !this.destroyed && !this.record && this.desired?.ready) {
                queueMicrotask(() => void this.advance());
            }
        }
        if (this.record?.pending && !this.blocked) await this.advance();
        else if (this.desired?.ready && !this.blocked) await this.advance();
    }

    /** Consume shared progress without replacing current result with an older job. @return {void} */
    receiveJobs() {
        this.state.jobs = this.jobs.jobs.filter(job => job.operation === "raster.aggregate.v1");
        this.state.historyError = this.jobs.error;
        if (this.state.result) {
            this.state.result = this.jobs.jobs.find(job => job.jobId === this.state.result.jobId) ?? this.state.result;
        }
        if (this.record?.jobId) {
            this.state.current = this.jobs.jobs.find(job => job.jobId === this.record.jobId) ?? this.state.current;
            if (!this.advanceRunning) void this.advance();
        }
        this.render();
    }

    /** Inspect an immutable historical result, pausing live sampling. @param {string} id Job ID. @return {void} */
    inspect(id) {
        const job = this.jobs.jobs.find(item => item.jobId === id && item.operation === "raster.aggregate.v1");
        if (!job) return;
        this.stopFollowing();
        this.state.result = job;
        this.state.resultIntent = null;
        this.onOpen(); this.render();
    }

    /** Apply an explicit history action. @param {string} id Job ID. @param {string} action Intent. @return {Promise<void>} Action. */
    async jobAction(id, action) {
        if (id === this.record?.jobId && action === "cancel") { this.stop(); return; }
        try { await this.jobs.action(id, action); }
        catch (error) { this.state.message = error.message; this.render(); }
    }

    /** Render and publish only area-associated activity. @return {void} */
    render() {
        if (this.destroyed) return;
        let currentIntent = null;
        try { currentIntent = this.intent(); } catch { /* Incomplete editor is expected. */ }
        this.state.resultIsCurrent = !!this.state.resultIntent && identity(currentIntent) === identity(this.state.resultIntent);
        this.state.recoverable = !!this.record && this.blocked;
        this.state.hasWork = !!this.record || !!this.desired || this.state.phase === "planning";
        this.view.render(this.state);
        const active = this.record && !this.record.cancelRequested && !this.blocked;
        this.onActivity(active ? this.record.intent.area : null);
    }

    /** Detach browser work, retaining server/recovery records. @return {void} */
    destroy() {
        this.destroyed = true;
        this.planAbort?.abort(); this.validationAbort?.abort();
        this.clock.clearTimeout(this.debounce); this.clock.clearTimeout(this.validationTimer);
        this.unsubscribe(); this.view.unbind(); this.onActivity(null);
    }
}
