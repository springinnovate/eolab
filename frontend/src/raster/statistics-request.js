/** Retry temporary histogram overload; the server owns read scheduling. */
import { isRasterStatisticsCapacityError } from "./analysis-api.js";

/**
 * Send an independent histogram request, retrying only a full server queue.
 * At most five retries wait a total of 7.75 seconds. Server queue expiry,
 * invalid areas and transport failures reach the existing error/Retry UI.
 * @param {() => Promise<Object>} load Request using the supplied abort signal.
 * @param {AbortSignal} signal Statistics controller's cancellation signal.
 * @param {Object} [clock=globalThis] setTimeout/clearTimeout implementation.
 * @return {Promise<Object>} Current statistics response.
 * @throws {Error} Final request failure or cancellation reason.
 */
export async function requestRasterStatistics(load, signal, clock = globalThis) {
    for (let attempt = 0; ; attempt += 1) {
        signal.throwIfAborted();
        try {
            const result = await load();
            signal.throwIfAborted();
            return result;
        } catch (error) {
            signal.throwIfAborted();
            if (!isRasterStatisticsCapacityError(error) || attempt >= 5) throw error;
            await waitBeforeStatisticsRetry(250 * 2 ** attempt, signal, clock);
        }
    }
}

/**
 * Wait before retrying overload; cancellation clears the timer immediately.
 * @param {number} milliseconds Delay before another admission attempt.
 * @param {AbortSignal} signal Owning request's cancellation signal.
 * @param {Object} clock setTimeout/clearTimeout implementation.
 * @return {Promise<void>} Resolves after the delay.
 * @throws {Error} Cancellation reason when the request becomes obsolete.
 */
function waitBeforeStatisticsRetry(milliseconds, signal, clock) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        /** Clear the timer and reject the obsolete wait. @return {void} */
        const onAbort = () => {
            clock.clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = clock.setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, milliseconds);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
