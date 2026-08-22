/**
 * Load statistics for one raster scope.
 *
 * @callback LoadRasterStatistics
 * @param {Object} item Active STAC Item.
 * @param {AbortSignal} signal Cancellation signal for stale work.
 * @param {Object|null} selectedBounds Optional selected-area bounds.
 * @return {Promise<Object>} Validated raster statistics.
 */

/**
 * Receive the start of a statistics request.
 *
 * @callback RasterStatisticsLoadingHandler
 * @param {Object} item Active STAC Item.
 * @param {*} context Opaque request context.
 * @return {void}
 */

/**
 * Receive a current statistics response.
 *
 * @callback RasterStatisticsResultHandler
 * @param {Object} statistics Validated response.
 * @param {Object} item Active STAC Item.
 * @param {*} context Opaque request context.
 * @return {void}
 */

/**
 * Receive a current statistics failure.
 *
 * @callback RasterStatisticsErrorHandler
 * @param {Error} error Non-abort statistics error.
 * @param {Object} item Active STAC Item.
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
        this.selectedBounds = null;
        this.abortController = null;
        this.requestSequence = 0;
    }

    /**
     * Start a new statistics request for the active rendered Item.
     *
     * @param {Object} item Selected STAC Item.
     * @param {*} [context] Opaque request context returned to callbacks.
     * @param {Object|null} [selectedBounds=null] Optional WGS 84 selection.
     * @return {Promise<Object|null>} Current statistics, or null after failure
     * or invalidation.
     */
    async activate(item, context = undefined, selectedBounds = null) {
        this.clear();
        this.item = item;
        this.selectedBounds = selectedBounds;
        const requestSequence = ++this.requestSequence;
        const abortController = new AbortController();
        this.abortController = abortController;
        this.onLoading(item, context);
        let statistics;
        try {
            statistics = await this.loadStatistics(
                item,
                abortController.signal,
                selectedBounds
            );
        } catch (error) {
            if (
                error.name !== "AbortError" &&
                requestSequence === this.requestSequence
            ) {
                this.onError(error, item, context);
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
        this.onResult(statistics, item, context);
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
        const selectedBounds = this.selectedBounds;
        return item === null
            ? Promise.resolve(null)
            : this.activate(item, context, selectedBounds);
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
        this.selectedBounds = null;
    }
}
