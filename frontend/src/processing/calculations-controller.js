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
        onActivity = () => {}, clock = globalThis, requestId = () => crypto.randomUUID(), canAutoSubmit = () => true,
        now = () => performance.now() }) {
        this.now = now;
        this.canAutoSubmit = canAutoSubmit;
        Object.assign(this, { api, jobs, storage, view, getContext, onOpen, onClose, onActivity, clock, requestId });
        this.state = { sources: [], source: null, selectedArea: null, area: null, areaChoice: "selection",
            availableAoi: null, calculations: [{ label: "Mean", expression: "mean(a)" }],
            valid: false, validation: "", plan: null, phase: "idle", message: "", active: false, checking: false, result: null, resultIntent: null, current: null, jobs: [], historyError: "" };
        this.record = storage.read();
        this.desired = null;
        this.plansToRelease = new Set();
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
            onRun: () => void this.run(),
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
            this.state.targetChunkPixels = intent.targetChunkPixels ?? null;
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
        if (!this.state.source) throw new Error("Choose a Catalog raster.");
        if (!this.state.area) throw new Error("Choose a sampling box, uploaded AOI, or Whole raster.");
        return calculationIntent(this.state);
    }

    /** Whether the calculator is the expanded foreground panel. @return {boolean} Active presentation. */
    get isActive() { return this.state.active; }

    /** Receive presentation state from composition, without importing the dock.
     * @param {boolean} active Whether this panel is active and expanded. @return {void}
     */
    setActive(active) {
        if (typeof active !== "boolean") throw new TypeError("Calculator activity must be boolean.");
        if (this.state.active === active) return;
        this.state.active = active;
        if (!active) this.invalidate();
        else this.estimate();
        this.render();
    }

    /** Invalidate unaccepted intent and cancel obsolete automatic work. @return {void} */
    invalidate() {
        const target = this.desired;
        this.desired = null;
        this.sequence += 1;
        this.clock.clearTimeout(this.debounce);
        this.discardReview();
        if (target?.plan) this.plansToRelease.add(target.plan.planId);
        if (!this.record) this.state.phase = "idle";
        if (this.record?.automatic) this.requestCancellation();
        if (this.plansToRelease.size) void this.advance();
    }

    /** Apply an editor change; debounced checks never submit a job.
     * @param {Object} change Changed fields. @return {void}
     */
    edit(change) {
        this.invalidate();
        Object.assign(this.state, change);
        if (!this.record) this.blocked = false;
        this.state.message = "";
        this.state.valid = false;
        this.state.checking = true;
        this.state.validation = "Checking formula…";
        this.validationAbort?.abort();
        const version = ++this.validationSequence;
        this.clock.clearTimeout(this.validationTimer);
        this.validationTimer = this.clock.setTimeout(() => void this.validate(version), 400);
        this.render();
    }

    /** Check formulas with the backend grammar, then estimate without submitting.
     * @param {number} version Edit version. @return {Promise<void>} Validation.
     */
    async validate(version = this.validationSequence) {
        this.validationAbort = new AbortController();
        try {
            await this.api.validateCalculation(this.state.calculations, this.validationAbort.signal);
            if (version !== this.validationSequence || this.destroyed) return;
            this.state.valid = true;
            this.state.checking = false;
            this.state.validation = "Formula is valid.";
            if (this.desired?.execute) {
                this.desired.ready = this.desired.debounced;
                void this.advance();
            } else this.estimate();
        } catch (error) {
            if (version !== this.validationSequence || this.destroyed || error.name === "AbortError") return;
            this.state.valid = false;
            this.state.checking = false;
            this.state.validation = error.message;
            this.invalidate();
            this.state.message = "Fix the formula before calculating.";
        }
        this.render();
    }

    /** Choose explicit scope; map clicks calculate only a selected map box.
     * @param {string} choice Scope. @return {void}
     */
    chooseArea(choice) {
        const area = choice === "whole" ? { kind: "wholeRaster" } : choice === "uploaded"
            ? this.state.availableAoi && { kind: "temporaryAoi", temporaryAoiId: this.state.availableAoi.id }
            : this.state.selectedArea;
        this.edit({ areaChoice: choice, area });
    }

    /** Observe AOI lifecycle without altering accepted snapshots.
     * @param {Object|null} aoi Ready reference. @return {void}
     */
    setTemporaryAoi(aoi) {
        this.state.availableAoi = aoi;
        if (this.state.area?.kind === "temporaryAoi" && this.state.area.temporaryAoiId !== aoi?.id) this.edit({ area: null });
        this.render();
    }

    /** Receive committed area context; only an explicit click intent starts work.
     * @param {Object|null} area Sampling snapshot. @return {void}
     */
    setSelection(area) {
        const next = area ? normalizeRasterSamplingArea(area) : null;
        if (identity(next) === identity(this.state.selectedArea)) return;
        this.state.selectedArea = next;
        if (this.state.areaChoice !== "selection") return;
        this.invalidate();
        this.state.area = next;
        if (!this.record) this.blocked = false;
        this.state.message = "";
        this.estimate(650);
        this.render();
    }

    /** Debounce a completed map click while this calculator is active.
     * Repeated clicks in the same box are intentional recalculations.
     * @return {void}
     */
    calculateSelection() {
        if (!this.isActive || this.state.areaChoice !== "selection" || this.state.area?.kind !== "selectedArea") return;
        this.queueCalculation(true);
    }

    /** Mark durable cancellation before recovering uncertain submissions. @return {void} */
    requestCancellation() {
        if (!this.record) return;
        this.record.cancelRequested = true;
        try { this.storage.write(this.record); }
        catch (error) { this.state.message = error.message; }
        void this.advance();
    }

    /** Retain obsolete plan identities until the server acknowledges release. @return {void} */
    discardReview() {
        const plan = this.state.plan;
        this.state.plan = null;
        if (plan) this.plansToRelease.add(plan.planId);
    }

    /** Drain unused plans on the controller's existing planning lane.
     * A failed release retains its identity for the next explicit attempt.
     * @return {Promise<void>} Completion after every queued release is acknowledged.
     */
    async releasePlans() {
        while (this.plansToRelease.size) {
            const id = this.plansToRelease.values().next().value;
            await this.api.discardPlan(id);
            this.plansToRelease.delete(id);
        }
    }

    /** Queue an automatic metadata estimate on the same lane as execution planning.
     * @param {number} delay Optional debounce in milliseconds. @return {void}
     */
    estimate(delay = 0) {
        if (!this.isActive || !this.state.valid || !this.state.source || !this.state.area ||
            this.desired || this.state.plan || this.blocked || this.destroyed) return;
        const intent = this.intent();
        if (this.record && identity(this.record.intent) === identity(intent)) return;
        const target = { intent, execute: false, ready: delay === 0, sequence: ++this.sequence };
        this.desired = target;
        if (delay) this.debounce = this.clock.setTimeout(() => {
            if (this.desired === target) { target.ready = true; void this.advance(); }
        }, delay);
        else void this.advance();
    }

    /** Queue one explicit calculation, reusing a matching automatic estimate.
     * @param {boolean} automatic Whether map sampling or an editor update requested the job.
     * @param {boolean} [debounce=automatic] Whether the caller still needs the sampling delay. @return {void}
     */
    queueCalculation(automatic, debounce = automatic) {
        if (this.destroyed || (!this.state.valid && !this.state.checking)) return;
        if (this.blocked && this.record) { this.render(); return; }
        let intent;
        try { intent = this.intent(); }
        catch (error) { this.state.message = error.message; this.render(); return; }
        // A double press must not submit the same manual intent twice.
        if (!automatic && ((this.desired?.execute && identity(this.desired.intent) === identity(intent)) ||
            (this.record && !this.record.cancelRequested && identity(this.record.intent) === identity(intent)))) return;
        this.blocked = false;
        let target = this.desired;
        if (!target || identity(target.intent) !== identity(intent)) {
            const plan = this.state.plan;
            this.state.plan = null;
            this.invalidate();
            target = { intent, plan, sequence: ++this.sequence };
            this.desired = target;
        }
        Object.assign(target, { execute: true, automatic, debounced: !debounce, ready: !debounce && this.state.valid });
        this.clock.clearTimeout(this.debounce);
        if (debounce) this.debounce = this.clock.setTimeout(() => {
            if (this.desired === target) {
                target.debounced = true;
                target.ready = this.state.valid;
                void this.advance();
            }
        }, 650);
        this.requestCancellation();
        this.state.phase = "waiting";
        this.state.message = automatic
            ? this.advanceRunning && !this.record
                ? "Waiting for the previous calculation check to finish…"
                : "Waiting for the latest sampling box…"
            : "Preparing calculation…";
        this.render();
        void this.advance();
    }

    /** Execute an already validated card batch on the durable, single-workflow lane.
     * @param {Object} intent Public snapshot. @param {boolean} automatic Whether edits requested it.
     * @return {void}
     */
    executeIntent(intent, automatic = false) {
        const snapshot = calculationIntent(intent);
        this.invalidate();
        this.validationAbort?.abort();
        this.clock.clearTimeout(this.validationTimer);
        this.validationSequence++;
        Object.assign(this.state, snapshot, { targetChunkPixels: snapshot.targetChunkPixels ?? null, valid: true, checking: false, manualRequired: false, validation: "", message: "" });
        this.queueCalculation(automatic, false);
    }

    /** Calculate the current selection, obtaining a fresh estimate when needed.
     * @return {Promise<void>} Submission progress.
     */
    async run() { this.queueCalculation(false); await this.advance(); }

    /** Cancel this calculation; a later map click is a new explicit request. @return {void} */
    stop() {
        this.invalidate();
        this.requestCancellation();
        if (!this.record) this.state.message = "Calculation cancelled.";
        this.render();
    }

    /** Close automatic work; explicit one-off jobs continue in history. @return {void} */
    close() { this.setActive(false); this.onClose(); }

    /**
     * Drain one durable workflow before admitting the newest requested area.
     * Unknown submissions retain their key; cancelling jobs retain their slot.
     * @return {Promise<void>} Current progress, never an unbounded polling loop.
     */
    async advance() {
        if (this.advanceRunning || this.destroyed || this.blocked) return;
        this.advanceRunning = true;
        try {
            if (this.plansToRelease.size) {
                this.state.phase = "releasing";
                this.state.message = "Releasing the previous calculation check…";
                this.render();
                await this.releasePlans();
                if (!this.record) { this.state.phase = "idle"; this.state.message = ""; }
            }
            if (this.record?.pending) {
                this.state.phase = "submitting";
                this.state.message = "Confirming calculation submission…";
                this.render();
                let job;
                try {
                    if (this.trace) this.trace.submissionStarted = this.now();
                    job = await this.api.submitCalculation(this.record.pending);
                    if (this.trace) this.trace.submissionFinished = this.now();
                }
                catch (error) {
                    this.trace = null; // An uncertain/retried submission has no complete stage trace.
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
                    this.state.message = this.record.cancelRequested ? "Cancelling calculation…" : "";
                    if (this.record.cancelRequested && job.status !== "cancelling") await this.jobs.action(job.jobId, "cancel");
                    return;
                }
                if (job.status === "ready" && !this.record.cancelRequested) {
                    this.state.result = job; this.state.resultIntent = this.record.intent;
                    this.state.resultTiming = this.trace ?? null;
                    this.state.message = "Calculation complete.";
                } else if (["failed", "interrupted"].includes(job.status) && !this.record.cancelRequested) {
                    this.state.message = job.error?.detail ?? "Calculation interrupted. Click Calculate to try again.";
                } else if (this.record.cancelRequested || job.status === "cancelled") {
                    this.state.message = this.desired ? "Waiting for the latest sampling box…" : "Calculation cancelled.";
                }
                this.jobs.tracked.delete(job.jobId);
                this.storage.clear(); this.record = null; this.state.current = null;
                this.trace = null;
                this.state.phase = "idle";
            }
            if (!this.desired?.ready) return;
            const target = this.desired;
            this.state.phase = target.execute ? "planning" : "estimating";
            this.state.message = "Checking calculation size…";
            this.render();
            if (target.plan && Date.parse(target.plan.expiresAt) <= Date.now()) {
                this.plansToRelease.add(target.plan.planId);
                target.plan = null;
                await this.releasePlans();
            }
            if (target !== this.desired || this.destroyed) return;
            let plan;
            // Aborting fetch cannot acknowledge native cleanup, and can lose the
            // ID of a plan already committed behind a proxy. Keep this bounded
            // request connected, then release a superseded result before reuse.
            const planningStarted = this.now();
            const planReused = !!target.plan;
            try { plan = target.plan ?? await this.api.planCalculation(target.intent); }
            catch (error) { if (target !== this.desired || error.name === "AbortError") return; throw error; }
            const planningFinished = this.now();
            if (target !== this.desired || this.destroyed) {
                this.plansToRelease.add(plan.planId);
                await this.releasePlans();
                return;
            }
            target.plan = plan;
            if (target.execute && target.automatic && !this.canAutoSubmit(plan, target.intent)) {
                this.state.plan = plan;
                this.state.manualRequired = true;
                this.desired = null;
                this.state.phase = "idle";
                this.state.message = "Large or explicit area · Calculate to update.";
                return;
            }
            if (!target.execute) {
                this.state.plan = plan;
                this.desired = null;
                this.state.phase = "idle";
                this.state.message = "Ready to calculate.";
                return;
            }
            // A click may reuse an in-flight estimate, but still waits for its debounce.
            if (!target.ready) { target.plan = plan; this.state.phase = "waiting"; return; }
            const record = { intent: target.intent, automatic: target.automatic, cancelRequested: false,
                pending: { planId: plan.planId, requestId: this.requestId() }, jobId: null };
            this.storage.write(record);
            this.record = record;
            this.trace = { planningStarted, planningFinished, planReused, serverPlan: plan.timing ?? null };
            this.desired = null;
        } catch (error) {
            this.blocked = true;
            if (this.desired?.plan) this.plansToRelease.add(this.desired.plan.planId);
            this.desired = null;
            this.state.phase = "error";
            this.state.message = `${error.message}${this.record ? " Recover / retry to confirm or cancel the same job safely." : " Click Calculate or select a new sampling box to retry."}`;
        } finally {
            if (this.destroyed) await this.releasePlans().catch(() => {});
            this.advanceRunning = false;
            this.render();
            // Newest intent waits for both old metadata and acknowledged cleanup.
            if (!this.blocked && !this.destroyed && !this.record &&
                (this.desired?.ready || this.plansToRelease.size)) {
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
        this.invalidate();
        this.state.result = job;
        this.state.resultIntent = null;
        this.state.resultTiming = null;
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
        this.state.hasWork = !!this.record || !!this.desired?.execute;
        // A replacement includes debounce/admission, but excludes a review alone,
        // stopped work, and failures awaiting an explicit recovery action.
        this.state.resultPending = !this.blocked && (!!this.desired?.execute || (!!this.record && !this.record.cancelRequested));
        this.view.render(this.state);
        const active = this.record && !this.record.cancelRequested && !this.blocked;
        this.onActivity(active ? this.record.intent.area : null);
    }

    /** Detach browser work, retaining server/recovery records. @return {void} */
    destroy() {
        this.destroyed = true;
        this.discardReview();
        if (this.desired?.plan) this.plansToRelease.add(this.desired.plan.planId);
        this.desired = null;
        this.validationAbort?.abort();
        this.clock.clearTimeout(this.debounce); this.clock.clearTimeout(this.validationTimer);
        this.unsubscribe(); this.view.unbind(); this.onActivity(null);
        if (!this.advanceRunning) void this.releasePlans().catch(() => {});
    }
}
