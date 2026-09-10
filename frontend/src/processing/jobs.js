/** Shared owned-job polling for clip and calculation presentations. */
export const ACTIVE_JOB_STATES = new Set(["queued", "running", "cancelling"]);

/** Own one session listing, mutations, and poll clock independently of editors. */
export class ProcessingJobs {
    /** @param {Object} api Processing transport. @param {Object} [clock=globalThis] Timer provider. */
    constructor(api, clock = globalThis) {
        Object.assign(this, { api, clock });
        this.jobs = [];
        this.error = "";
        this.listeners = new Set();
        this.tracked = new Set();
        this.revision = 0;
        this.refreshing = null;
        this.timer = null;
        this.destroyed = false;
        this.stopEvents = null;
        this.eventRevision = 0;
    }
    /** Observe shared history. @param {Function} listener Receives store. @return {Function} Unsubscribe. */
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    /** Notify editors without changing their intent. @return {void} */
    notify() { if (!this.destroyed) for (const listener of this.listeners) listener(this); }
    /** Protect new/mutated jobs from older list responses. @param {Object} job Accepted snapshot. @return {void} */
    accept(job) {
        this.revision += 1;
        this.jobs = [job, ...this.jobs.filter(item => item.jobId !== job.jobId)];
        this.notify();
        this.schedule();
    }
    /** Share one in-flight poll including tracked jobs beyond recent history. @return {Promise<void>} Refresh. */
    refresh() {
        if (this.refreshing) return this.refreshing;
        const revision = this.revision;
        const eventRevision = this.eventRevision;
        this.refreshing = (async () => {
            try {
                const jobs = await this.api.listJobs();
                for (const id of this.tracked) {
                    if (!jobs.some(job => job.jobId === id)) jobs.push(await this.api.getJob(id));
                }
                if (!this.destroyed && revision === this.revision) { this.jobs = jobs; this.error = ""; }
            } catch (error) { this.error = `Processing history unavailable: ${error.message}`; }
        })().finally(() => {
            this.refreshing = null; this.notify(); this.schedule();
            // An event arriving during a read may describe a newer commit than
            // that read saw. Coalesce the burst into exactly one subsequent read.
            if (!this.destroyed && eventRevision !== this.eventRevision) void this.refresh();
        });
        return this.refreshing;
    }
    /** Schedule progress/expiry updates. @return {void} */
    schedule() {
        this.clock.clearTimeout(this.timer);
        const active = this.jobs.some(job => ACTIVE_JOB_STATES.has(job.status)) || this.tracked.size;
        if (!this.destroyed && active && !this.stopEvents) this.stopEvents = this.api.watchJobs?.(() => {
            if (this.destroyed) return;
            this.eventRevision += 1;
            void this.refresh();
        }) ?? null;
        if ((!active || this.destroyed) && this.stopEvents) { this.stopEvents(); this.stopEvents = null; }
        if (!this.destroyed) this.timer = this.clock.setTimeout(() => void this.refresh(),
            active ? 2000 : 30000);
    }
    /** Mutate one owned job and refresh. @param {string} id Job ID. @param {string} action Cancel or delete. @return {Promise<Object|undefined>} Updated job. */
    async action(id, action) {
        const job = action === "cancel" ? await this.api.cancelJob(id) : await this.api.deleteJob(id);
        if (job?.jobId) this.accept(job);
        await this.refresh();
        return job;
    }
    /** Stop the shared poller. @return {void} */
    destroy() {
        this.destroyed = true; this.clock.clearTimeout(this.timer); this.listeners.clear();
        this.stopEvents?.(); this.stopEvents = null;
    }
}
