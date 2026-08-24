/**
 * Asynchronous request lifecycle for raster statistics.
 *
 * This module owns activation, retry, cancellation, and stale-response
 * suppression for one active sampling area. Loading and presentation are
 * injected; histogram math and DOM rendering are out of scope.
 */
import { normalizeRasterSamplingArea } from "./statistics.js";

/**
 * Load statistics for one raster scope.
 *
 * @callback LoadRasterStatistics
 * @param {Object} item Active STAC Item.
 * @param {Object} samplingArea Normalized whole/bounds/AOI area.
 * @param {AbortSignal} signal Cancellation signal for stale work.
 * @return {Promise<Object>} Validated raster statistics.
 */

/**
 * Receive the start of a statistics request.
 *
 * @callback RasterStatisticsLoadingHandler
 * @param {Object} item Active STAC Item.
 * @param {Object} samplingArea Normalized request area.
 * @param {*} context Opaque request context.
 * @return {void}
 */

/**
 * Receive a current statistics response.
 *
 * @callback RasterStatisticsResultHandler
 * @param {Object} statistics Validated response.
 * @param {Object} item Active STAC Item.
 * @param {Object} samplingArea Normalized request area.
 * @param {*} context Opaque request context.
 * @return {void}
 */

/**
 * Receive a current statistics failure.
 *
 * @callback RasterStatisticsErrorHandler
 * @param {Error} error Non-abort statistics error.
 * @param {Object} item Active STAC Item.
 * @param {Object} samplingArea Normalized request area.
 * @param {*} context Opaque request context.
 * @return {void}
 */

/** Manage one statistics lifecycle and ignore stale raster responses. */
export class RasterStatisticsController {
    /**
     * Create a statistics request lifecycle controller.
     *
     * @param {LoadRasterStatistics} loadStatistics Loads one Item and scope.
     * @param {RasterStatisticsLoadingHandler} onLoading Receives request start.
     * @param {RasterStatisticsResultHandler} onResult Receives current results.
     * @param {RasterStatisticsErrorHandler} onError Receives current failures.
     */
    constructor(loadStatistics, onLoading, onResult, onError) {
        this.loadStatistics = loadStatistics;
        this.onLoading = onLoading;
        this.onResult = onResult;
        this.onError = onError;
        this.item = null;
        this.samplingArea = null;
        this.abortController = null;
        this.requestSequence = 0;
    }

    /**
     * Start a new statistics request for the active catalog Item.
     *
     * @param {Object} item Selected STAC Item.
     * @param {Object} samplingArea Normalized whole/bounds/AOI area.
     * @param {*} [context] Opaque request context returned to callbacks.
     * @return {Promise<Object|null>} Current statistics, or null after failure
     * or invalidation.
     */
    async activate(
        item,
        samplingArea,
        context = undefined
    ) {
        const normalizedArea = normalizeRasterSamplingArea(samplingArea);
        this.clear();
        this.item = item;
        this.samplingArea = normalizedArea;
        const requestSequence = ++this.requestSequence;
        const abortController = new AbortController();
        this.abortController = abortController;
        this.onLoading(item, normalizedArea, context);
        let statistics;
        try {
            statistics = await this.loadStatistics(
                item,
                normalizedArea,
                abortController.signal
            );
        } catch (error) {
            if (
                error.name !== "AbortError" &&
                requestSequence === this.requestSequence
            ) {
                this.onError(error, item, normalizedArea, context);
            }
            return null;
        } finally {
            if (this.abortController === abortController) {
                this.abortController = null;
            }
        }
        if (requestSequence !== this.requestSequence) {
            return null;
        }
        this.onResult(statistics, item, normalizedArea, context);
        return statistics;
    }

    /**
     * Repeat the active Item's request after a recoverable failure.
     *
     * @param {*} [context] Opaque request context returned to callbacks.
     * @return {Promise<Object|null>} Retried statistics or null without an Item.
     */
    retry(context = undefined) {
        const item = this.item;
        const samplingArea = this.samplingArea;
        return item === null
            ? Promise.resolve(null)
            : this.activate(item, samplingArea, context);
    }

    /**
     * Abort and invalidate pending work and forget the active Item.
     *
     * @return {void}
     */
    clear() {
        this.requestSequence += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.item = null;
        this.samplingArea = null;
    }
}
