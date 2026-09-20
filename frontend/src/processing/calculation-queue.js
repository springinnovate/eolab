/** Give summary cards and raster series turns on one recoverable calculation executor. */
import { CalculationExecutor } from "./calculation-executor.js";
import { calculationIntent } from "./calculation-session.js";

/** Empty per-caller progress; job history is filled from the shared executor.
 * @return {Object} Idle calculation snapshot.
 */
function idleSnapshot() {
    return { isIdle: true, admission: "ready", unfinishedCalculation: null, recoverable: false,
        phase: "idle", message: "", plan: null, plannedCalculation: null, currentJob: null,
        completedJob: null, completedCalculation: null, completedTimings: null, jobs: [], historyError: "" };
}

/** Serialize the two calculation consumers without duplicating job tracking or recovery. */
export class CalculationQueue {
    /** Create the single executor shared by registered callers.
     * @param {Object} dependencies Execution providers.
     * @param {import("./api.js").ProcessingApiClient} dependencies.api Processing transport.
     * @param {import("./jobs.js").ProcessingJobs} dependencies.jobs Authoritative job observer.
     * @param {import("./calculation-session.js").CalculationSessionStorage} dependencies.storage Tab recovery record.
     * @param {(area:Object|null)=>void} [dependencies.onActivity] Working-area indicator.
     * @param {()=>string} [dependencies.requestId] Idempotency key factory.
     * @param {()=>number} [dependencies.now] Monotonic clock in milliseconds.
     */
    constructor(dependencies) {
        this.clients = new Map();
        this.waiting = [];
        this.activeClient = null;
        this.scheduled = false;
        this.executor = new CalculationExecutor({ ...dependencies, onChange: snapshot => this.receiveExecution(snapshot) });
        const unfinished = this.executor.snapshot.unfinishedCalculation;
        if (unfinished) this.activeClient = unfinished.context?.client ?? "summary";
    }

    /** Register a caller with isolated progress and completion snapshots.
     * @param {"summary"|"raster-series"} name Recovery identity.
     * @param {(snapshot:Object)=>void} onChange Receives only this caller's execution and shared history.
     * @return {CalculationQueueClient} Calculation actions for this caller.
     * @throws {TypeError} If the identity is unsupported or already registered.
     */
    createClient(name, onChange) {
        if (!["summary", "raster-series"].includes(name) || this.clients.has(name)) {
            throw new TypeError("A calculation caller must have a unique supported identity.");
        }
        const client = new CalculationQueueClient(this, name, onChange);
        if (this.activeClient === name) client.status = this.executor.snapshot;
        this.clients.set(name, client);
        return client;
    }

    /** Start recovery once, even when both consumers initialize.
     * @return {Promise<void>} Initial job observation and recovery.
     */
    start() { return this.started ??= this.executor.start(); }

    /** Queue or replace this caller's next calculation; running peers keep their turn.
     * @param {CalculationQueueClient} client Registered caller.
     * @param {Object} calculation Validated raster, area and formulas.
     * @return {void}
     * @throws {TypeError} If calculation settings violate the Processing contract.
     */
    prepare(client, calculation) {
        const intent = calculationIntent(calculation);
        if (this.activeClient === client.name) { this.executor.prepare(intent); return; }
        client.pending = intent;
        if (!this.waiting.includes(client.name)) this.waiting.push(client.name);
        client.status = { ...client.status, isIdle: false, admission: "busy", phase: "waiting",
            plan: null, plannedCalculation: null, message: "Waiting for another calculation to finish…" };
        client.onChange(client.snapshot);
        // A plan waiting for a user's decision must not monopolize execution.
        if (this.activeClient && this.executor.snapshot.isIdle && this.executor.snapshot.plan) {
            this.executor.discardPendingCalculation();
        }
        this.scheduleNextCaller();
    }

    /** Relay execution to its owner, while every caller receives current job history.
     * @param {Object} snapshot Authoritative executor snapshot.
     * @return {void}
     */
    receiveExecution(snapshot) {
        const owner = this.activeClient;
        for (const client of this.clients.values()) {
            const completion = snapshot.completedJob?.jobId !== this.completionBeforeTurn ? snapshot : client.status;
            client.status = owner === client.name ? { ...snapshot,
                completedJob: completion.completedJob, completedCalculation: completion.completedCalculation,
                completedTimings: completion.completedTimings } : {
                ...client.status, jobs: snapshot.jobs, historyError: snapshot.historyError,
            };
            client.onChange(client.snapshot);
        }
        const current = this.executor.snapshot;
        if (this.activeClient === owner && current.isIdle && !current.plan && !current.unfinishedCalculation) {
            this.activeClient = null;
            this.scheduleNextCaller();
        }
    }

    /** Admit the oldest waiting caller after completion or acknowledged cancellation.
     * Coalesce callbacks so consumers can finish recording their completed results first.
     * @return {void}
     */
    scheduleNextCaller() {
        if (this.scheduled || this.destroyed) return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            if (this.destroyed || this.activeClient || !this.executor.snapshot.isIdle) return;
            const client = this.clients.get(this.waiting.shift());
            if (!client?.pending) return;
            const intent = client.pending;
            client.pending = null;
            this.activeClient = client.name;
            this.completionBeforeTurn = this.executor.snapshot.completedJob?.jobId;
            this.executor.prepare(intent);
        });
    }

    /** Cancel only this caller's queued or active calculation.
     * @param {CalculationQueueClient} client Caller requesting cancellation.
     * @param {boolean} [submitted=true] Also cancel already-submitted work.
     * @return {void}
     */
    cancel(client, submitted = true) {
        client.pending = null;
        this.waiting = this.waiting.filter(name => name !== client.name);
        if (this.activeClient === client.name) {
            if (submitted) this.executor.stop();
            else { this.executor.discardPendingCalculation(); this.receiveExecution(this.executor.snapshot); }
        } else {
            client.status = { ...client.status, isIdle: true, admission: "ready", phase: "idle",
                plan: null, plannedCalculation: null, message: "Calculation cancelled." };
            client.onChange(client.snapshot);
        }
    }

    /** Remove a consumer; keep durable recovery when the entire page shuts down.
     * @param {CalculationQueueClient} client Consumer being destroyed.
     * @return {void}
     */
    removeClient(client) {
        this.clients.delete(client.name);
        this.waiting = this.waiting.filter(name => name !== client.name);
        if (!this.clients.size) {
            this.destroyed = true;
            this.executor.destroy();
        } else if (this.activeClient === client.name) this.executor.stop();
    }
}

/** Processing actions scoped to one consumer of the shared executor. */
export class CalculationQueueClient {
    /** Bind a caller without creating another executor or session-storage record.
     * @param {CalculationQueue} queue Shared Processing owner.
     * @param {string} name Caller identity.
     * @param {(snapshot:Object)=>void} onChange Progress recipient.
     */
    constructor(queue, name, onChange) {
        Object.assign(this, { queue, name, onChange });
        this.status = idleSnapshot();
        this.pending = null;
    }
    /** Read this caller's progress, never another caller's current result. @return {Object} Snapshot. */
    get snapshot() { return Object.freeze({ ...this.status }); }
    /** Resume the shared observer. @return {Promise<void>} Recovery progress. */
    start() { return this.queue.start(); }
    /** Prepare this caller's next calculation.
     * @param {Object} calculation Raster, area and formulas.
     * @return {void}
     * @throws {TypeError} If the calculation is invalid.
     */
    prepare(calculation) { this.queue.prepare(this, calculation); }
    /** Submit only a plan owned by this caller.
     * @param {string} planId Prepared plan ID.
     * @param {Object|null} [context=null] Caller recovery metadata.
     * @return {void}
     */
    submit(planId, context = null) {
        if (this.queue.activeClient === this.name) this.queue.executor.submit(planId, { ...context, client: this.name });
    }
    /** Cancel this caller's pending and submitted work. @return {void} */
    stop() { this.queue.cancel(this); }
    /** Discard this caller's unsubmitted work. @return {void} */
    discardPendingCalculation() { this.queue.cancel(this, false); }
    /** Retry an uncertain submission or cleanup while retaining its request key.
     * @return {Promise<void>} Retry completion, or no work when a peer owns execution.
     */
    async retry() {
        if (this.queue.activeClient === this.name || !this.queue.activeClient) await this.queue.executor.retry();
    }
    /** Act on an owned job from shared history.
     * @param {string} id Job ID. @param {"cancel"|"delete"} action Requested mutation.
     * @return {Promise<void>} Mutation and refresh.
     */
    jobAction(id, action) { return this.queue.executor.jobAction(id, action); }
    /** Stop observing this caller. @return {void} */
    destroy() { this.queue.removeClient(this); }
}
