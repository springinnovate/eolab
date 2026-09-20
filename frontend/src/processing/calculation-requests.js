/** Independent calculation lifecycles sharing one job observer. */
import { CalculationExecutor } from "./calculation-executor.js";

/** Own request recovery and activity without scheduling server work in the browser. */
export class CalculationRequests {
    /** Connect the existing Processing providers; executors are created on demand.
     * @param {Object} dependencies Execution providers.
     * @param {import("./api.js").ProcessingApiClient} dependencies.api Processing transport.
     * @param {import("./jobs.js").ProcessingJobs} dependencies.jobs Shared job observer.
     * @param {import("./calculation-session.js").CalculationSessionStorage} dependencies.storage Scoped tab recovery records.
     * @param {(area:Object|null)=>void} [dependencies.onActivity] Most recently active calculation area.
     * @param {()=>string} [dependencies.requestId] Idempotency key factory.
     * @param {()=>number} [dependencies.now] Monotonic clock in milliseconds.
     */
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.clients = new Map();
        this.activeAreas = new Map();
    }

    /** Create an independent executor with its own durable submission record.
     * The summary caller and up to 50 series positions can proceed independently.
     * Replacing work in one position still waits for that position's cancellation.
     * @param {string} name "summary" or "raster-series:0" through "raster-series:49".
     * @param {(snapshot:import("./calculation-executor.js").CalculationExecutionSnapshot)=>void} onChange Caller progress.
     * @return {CalculationExecutor} Executor owned by this caller.
     * @throws {TypeError} If the identity is unsupported or already registered.
     */
    createClient(name, onChange) {
        if (this.clients.has(name)) throw new TypeError("Calculation caller is already registered.");
        const storage = this.dependencies.storage.forClient(name);
        const executor = new CalculationExecutor({ ...this.dependencies, storage, onChange,
            onActivity: area => {
                if (area) this.activeAreas.set(name, area);
                else this.activeAreas.delete(name);
                this.dependencies.onActivity?.([...this.activeAreas.values()].at(-1) ?? null);
            },
        });
        this.clients.set(name, executor);
        return executor;
    }

    /** Find unfinished callers after reload without starting or cancelling their work.
     * @return {string[]} Valid saved caller identities.
     */
    savedClientNames() { return this.dependencies.storage.savedClientNames(); }

    /** Release all observers while retaining submitted jobs for reload recovery. @return {void} */
    destroy() { for (const client of this.clients.values()) client.destroy(); }
}
