/** Coordinate ordinary and paired reads without increasing server capacity. */
import { isRasterStatisticsCapacityError } from "./analysis-api.js";

/** One viewer's FIFO, with obsolete work removed through controller signals. */
export class RasterStatisticsRequestQueue {
    /**
     * Create a single-flight queue with a finite capacity-retry budget.
     * @param {Object} [clock=globalThis] setTimeout/clearTimeout implementation.
     */
    constructor(clock = globalThis) {
        this.clock = clock;
        this.pending = [];
        this.active = null;
    }

    /**
     * Enqueue one read; cancellation removes waiting work immediately.
     * An active read retains its slot until its loader settles, even if the
     * loader ignores abort. Server-side cancellation may finish later still;
     * the next read handles that through the classified capacity retry path.
     * @param {() => Promise<Object>} load Read using the caller's abort signal.
     * @param {AbortSignal} signal Owning statistics controller's signal.
     * @return {Promise<Object>} Current result, or an abort/read failure.
     */
    run(load, signal) {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const job = { load, signal, resolve, reject, onAbort: null };
            /** Remove obsolete waiting work and settle its caller. */
            job.onAbort = () => {
                const index = this.pending.indexOf(job);
                if (index >= 0) this.pending.splice(index, 1);
                signal.removeEventListener("abort", job.onAbort);
                reject(signal.reason);
            };
            signal.addEventListener("abort", job.onAbort, { once: true });
            this.pending.push(job);
            void this.#drain();
        });
    }

    /** Run queued reads serially, releasing each slot after success or failure. @return {Promise<void>} */
    async #drain() {
        if (this.active !== null) return;
        while (this.pending.length > 0) {
            const job = this.pending.shift();
            this.active = job;
            try {
                job.resolve(await this.#read(job));
            } catch (error) {
                job.reject(error);
            } finally {
                job.signal.removeEventListener("abort", job.onAbort);
                this.active = null;
            }
        }
    }

    /**
     * Retry only classified capacity conflicts, at most five times (7.75s of
     * total backoff). Other errors and exhausted retries reach the normal UI.
     * @param {Object} job Queued loader and its cancellation signal.
     * @return {Promise<Object>} Statistics, or the final read/abort failure.
     */
    async #read(job) {
        for (let attempt = 0; ; attempt += 1) {
            job.signal.throwIfAborted();
            try {
                return await job.load();
            } catch (error) {
                job.signal.throwIfAborted();
                if (!isRasterStatisticsCapacityError(error) || attempt >= 5) {
                    throw error;
                }
                await this.#backoff(250 * 2 ** attempt, job.signal);
            }
        }
    }

    /**
     * Wait without blocking the UI; abort clears the retry timer immediately.
     * @param {number} milliseconds Delay before another admission attempt.
     * @param {AbortSignal} signal Owning request's cancellation signal.
     * @return {Promise<void>} Resolves after the delay, rejects on abort.
     */
    #backoff(milliseconds, signal) {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            /** Clear the timer and release the canceled wait. */
            const onAbort = () => {
                this.clock.clearTimeout(timer);
                reject(signal.reason);
            };
            const timer = this.clock.setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            }, milliseconds);
            signal.addEventListener("abort", onAbort, { once: true });
        });
    }
}
