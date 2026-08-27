/**
 * Asynchronous request lifecycle for raster statistics.
 *
 * This module owns activation, retry, cancellation, and stale-response
 * suppression for one active sampling area. Loading and presentation are
 * injected; histogram math and DOM rendering are out of scope.
 */
import { normalizeRasterSamplingArea } from "./statistics.js";
import { normalizeRasterPairedSamplingArea } from "./paired-statistics.js";

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

/** Manage one ordered-pair lifecycle and ignore every stale pair response. */
export class RasterPairedStatisticsController {
    /**
     * Create a paired statistics request lifecycle controller.
     *
     * @param {(xItem:Object,yItem:Object,area:Object,signal:AbortSignal)
     * =>Promise<Object>} loadStatistics Loads one ordered pair and scope.
     * @param {(xItem:Object,yItem:Object,area:Object,context:*)=>void} onLoading
     * Receives request start.
     * @param {(statistics:Object,xItem:Object,yItem:Object,area:Object,
     * context:*)=>void} onResult Receives current results.
     * @param {(error:Error,xItem:Object,yItem:Object,area:Object,context:*)
     * =>void} onError Receives current failures.
     */
    constructor(loadStatistics, onLoading, onResult, onError) {
        this.loadStatistics = loadStatistics;
        this.onLoading = onLoading;
        this.onResult = onResult;
        this.onError = onError;
        this.xItem = null;
        this.yItem = null;
        this.samplingArea = null;
        this.abortController = null;
        this.requestSequence = 0;
    }

    /**
     * Start a request scoped to both identities and one normalized area.
     *
     * @param {Object} xItem Catalog Item assigned to X.
     * @param {Object} yItem Catalog Item assigned to Y.
     * @param {Object} samplingArea Whole overlap or selected bounds.
     * @param {*} [context] Opaque request context returned to callbacks.
     * @return {Promise<Object|null>} Current result or null after failure/stale.
     */
    async activate(xItem, yItem, samplingArea, context = undefined) {
        const normalizedArea = normalizeRasterPairedSamplingArea(samplingArea);
        this.clear();
        this.xItem = xItem;
        this.yItem = yItem;
        this.samplingArea = normalizedArea;
        const requestSequence = ++this.requestSequence;
        const abortController = new AbortController();
        this.abortController = abortController;
        this.onLoading(xItem, yItem, normalizedArea, context);
        let statistics;
        try {
            statistics = await this.loadStatistics(
                xItem,
                yItem,
                normalizedArea,
                abortController.signal
            );
        } catch (error) {
            if (
                error.name !== "AbortError" &&
                requestSequence === this.requestSequence
            ) {
                this.onError(
                    error,
                    xItem,
                    yItem,
                    normalizedArea,
                    context
                );
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
        this.onResult(
            statistics,
            xItem,
            yItem,
            normalizedArea,
            context
        );
        return statistics;
    }

    /**
     * Repeat the current ordered pair after a recoverable failure.
     *
     * @param {*} [context] Opaque request context returned to callbacks.
     * @return {Promise<Object|null>} Retried result or null without a pair.
     */
    retry(context = undefined) {
        return this.xItem === null || this.yItem === null
            ? Promise.resolve(null)
            : this.activate(
                this.xItem,
                this.yItem,
                this.samplingArea,
                context
            );
    }

    /** Abort pending work and forget both identities and their area. @return {void} */
    clear() {
        this.requestSequence += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.xItem = null;
        this.yItem = null;
        this.samplingArea = null;
    }
}
