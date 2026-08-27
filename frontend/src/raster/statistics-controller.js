/**
 * Asynchronous request lifecycle for raster statistics.
 *
 * This module owns activation, retry, cancellation, and stale-response
 * suppression for one active sampling area. Loading and presentation are
 * injected; histogram math and DOM rendering are out of scope.
 */
import { normalizeRasterSamplingArea } from "./statistics.js";

/**
 * Load statistics for one request target and sampling area.
 *
 * @callback LoadRasterStatistics
 * @param {Object} target Active analysis target.
 * @param {Object} samplingArea Normalized whole/bounds/AOI area.
 * @param {AbortSignal} signal Cancellation signal for stale work.
 * @return {Promise<Object>} Validated raster statistics.
 */

/**
 * Receive the start of a statistics request.
 *
 * @callback RasterStatisticsLoadingHandler
 * @param {Object} target Active analysis target.
 * @param {Object} samplingArea Normalized request area.
 * @param {*} context Opaque request context.
 * @return {void}
 */

/**
 * Receive a current statistics response.
 *
 * @callback RasterStatisticsResultHandler
 * @param {Object} statistics Validated response.
 * @param {Object} target Active analysis target.
 * @param {Object} samplingArea Normalized request area.
 * @param {*} context Opaque request context.
 * @return {void}
 */

/**
 * Receive a current statistics failure.
 *
 * @callback RasterStatisticsErrorHandler
 * @param {Error} error Non-abort statistics error.
 * @param {Object} target Active analysis target.
 * @param {Object} samplingArea Normalized request area.
 * @param {*} context Opaque request context.
 * @return {void}
 */

/** Manage one statistics lifecycle and ignore stale responses. */
export class RasterStatisticsController {
    /**
     * Create a statistics request lifecycle controller.
     *
     * @param {LoadRasterStatistics} loadStatistics Loads one target and scope.
     * @param {RasterStatisticsLoadingHandler} onLoading Receives request start.
     * @param {RasterStatisticsResultHandler} onResult Receives current results.
     * @param {RasterStatisticsErrorHandler} onError Receives current failures.
     * @param {(samplingArea:Object)=>Readonly<Object>}
     * [normalizeSamplingArea=normalizeRasterSamplingArea] Validates and
     * normalizes the sampling-area contract owned by the caller.
     */
    constructor(
        loadStatistics,
        onLoading,
        onResult,
        onError,
        normalizeSamplingArea = normalizeRasterSamplingArea
    ) {
        this.loadStatistics = loadStatistics;
        this.onLoading = onLoading;
        this.onResult = onResult;
        this.onError = onError;
        this.normalizeSamplingArea = normalizeSamplingArea;
        this.target = null;
        this.samplingArea = null;
        this.abortController = null;
        this.requestSequence = 0;
    }

    /**
     * Start a new statistics request for one analysis target.
     *
     * @param {Object} target Catalog Item or ordered Item pair.
     * @param {Object} samplingArea Normalized whole/bounds/AOI area.
     * @param {*} [context] Opaque request context returned to callbacks.
     * @return {Promise<Object|null>} Current statistics, or null after failure
     * or invalidation.
     */
    async activate(
        target,
        samplingArea,
        context = undefined
    ) {
        const normalizedArea = this.normalizeSamplingArea(samplingArea);
        this.clear();
        this.target = target;
        this.samplingArea = normalizedArea;
        const requestSequence = ++this.requestSequence;
        const abortController = new AbortController();
        this.abortController = abortController;
        this.onLoading(target, normalizedArea, context);
        let statistics;
        try {
            statistics = await this.loadStatistics(
                target,
                normalizedArea,
                abortController.signal
            );
        } catch (error) {
            if (
                error.name !== "AbortError" &&
                requestSequence === this.requestSequence
            ) {
                this.onError(error, target, normalizedArea, context);
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
        this.onResult(statistics, target, normalizedArea, context);
        return statistics;
    }

    /**
     * Repeat the active target's request after a recoverable failure.
     *
     * @param {*} [context] Opaque request context returned to callbacks.
     * @return {Promise<Object|null>} Retried result or null without a target.
     */
    retry(context = undefined) {
        const target = this.target;
        const samplingArea = this.samplingArea;
        return target === null
            ? Promise.resolve(null)
            : this.activate(target, samplingArea, context);
    }

    /**
     * Abort pending work and forget the active analysis target.
     *
     * @return {void}
     */
    clear() {
        this.requestSequence += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.target = null;
        this.samplingArea = null;
    }
}
