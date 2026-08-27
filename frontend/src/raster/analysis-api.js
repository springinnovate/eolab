/** Same-origin adapters for rendering-independent raster analysis. */

import {
    normalizeRasterSamplingArea,
    validateRasterStatisticsForSelection,
} from "./statistics.js";
import {
    normalizeRasterPairedSamplingArea,
    validateRasterPairedStatisticsForSelection,
} from "./paired-statistics.js";

/**
 * Represent one browser-safe raster-analysis failure.
 *
 * @property {number} status Analysis API HTTP response status.
 */
export class RasterAnalysisRequestError extends Error {
    /**
     * Create an analysis failure.
     *
     * @param {string} message Concise user-facing failure explanation.
     * @param {number} status Analysis API HTTP response status.
     */
    constructor(message, status) {
        super(message);
        this.name = "RasterAnalysisRequestError";
        this.status = status;
    }
}

/**
 * Convert one failed analysis response into a browser-safe error.
 *
 * @param {Response} response Failed analysis response.
 * @param {string} action User-facing request description.
 * @return {Promise<RasterAnalysisRequestError>} Structured detail or a status
 * fallback.
 */
async function analysisRequestError(response, action) {
    const fallbackMessage = `${action} failed (${response.status})`;
    if (!response.headers.get("content-type")?.toLowerCase().includes(
        "application/json"
    )) {
        return new RasterAnalysisRequestError(fallbackMessage, response.status);
    }
    try {
        const errorDocument = await response.json();
        const detail = errorDocument.detail;
        return new RasterAnalysisRequestError(
            typeof detail === "string" && detail.trim() !== ""
                ? detail
                : fallbackMessage,
            response.status
        );
    } catch {
        return new RasterAnalysisRequestError(fallbackMessage, response.status);
    }
}

/**
 * Read one band-one pixel from the selected Catalog raster.
 *
 * @param {Object} item Selected STAC Item.
 * @param {{longitude: number, latitude: number}} position WGS 84 position.
 * @param {AbortSignal} signal Cancellation signal for a superseded position.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Source cell, bounds state, and value.
 * @throws {RasterAnalysisRequestError} If EOLab cannot sample the raster.
 */
export async function sampleCatalogRasterPixel(
    item,
    position,
    signal,
    fetchImplementation = globalThis.fetch
) {
    const response = await fetchImplementation.call(
        globalThis,
        "/api/raster-analysis/pixels",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                collectionId: item.collection,
                itemId: item.id,
                longitude: position.longitude,
                latitude: position.latitude
            }),
            signal
        }
    );
    if (!response.ok) {
        throw await analysisRequestError(response, "Pixel sample request");
    }
    return response.json();
}

/**
 * Load bounded band-1 statistics for one catalog raster and sampling area.
 *
 * @param {Object} item Selected scanner-owned STAC Item.
 * @param {Object} samplingArea Strict whole/bounds/AOI sampling-area union.
 * @param {AbortSignal} signal Cancellation signal for stale UI intent.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Validated fixed-bin raster statistics.
 * @throws {Error} If the area or response violates the analysis contract.
 */
export async function loadCatalogRasterStatistics(
    item,
    samplingArea,
    signal,
    fetchImplementation = globalThis.fetch
) {
    const normalizedArea = normalizeRasterSamplingArea(samplingArea);
    const requestDocument = {
        collectionId: item.collection,
        itemId: item.id
    };
    if (normalizedArea.kind === "selectedArea") {
        requestDocument.selectedBounds = normalizedArea.selectedBounds;
    } else if (normalizedArea.kind === "temporaryAoi") {
        requestDocument.temporaryAoiId = normalizedArea.temporaryAoiId;
    }
    const response = await fetchImplementation.call(
        globalThis,
        "/api/raster-analysis/statistics",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestDocument),
            signal
        }
    );
    if (!response.ok) {
        throw await analysisRequestError(
            response,
            "Raster statistics request"
        );
    }
    return validateRasterStatisticsForSelection(
        await response.json(),
        normalizedArea
    );
}

/**
 * Load bounded paired statistics for two ordered catalog rasters.
 *
 * @param {Object} xItem Catalog Item assigned to the X reference grid.
 * @param {Object} yItem Distinct Catalog Item aligned to X.
 * @param {Object} samplingArea Whole overlap or selected WGS 84 bounds.
 * @param {AbortSignal} signal Cancellation signal for stale pair intent.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Validated 2D histogram and marginals.
 * @throws {Error} If request or response violates the paired contract.
 */
export async function loadCatalogRasterPairedStatistics(
    xItem,
    yItem,
    samplingArea,
    signal,
    fetchImplementation = globalThis.fetch
) {
    const normalizedArea = normalizeRasterPairedSamplingArea(samplingArea);
    const requestDocument = {
        xRaster: {
            collectionId: xItem.collection,
            itemId: xItem.id,
        },
        yRaster: {
            collectionId: yItem.collection,
            itemId: yItem.id,
        },
    };
    if (normalizedArea.kind === "selectedArea") {
        requestDocument.selectedBounds = normalizedArea.selectedBounds;
    }
    const response = await fetchImplementation.call(
        globalThis,
        "/api/raster-analysis/paired-statistics",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify(requestDocument),
            signal,
        }
    );
    if (!response.ok) {
        throw await analysisRequestError(
            response,
            "Paired raster statistics request"
        );
    }
    return validateRasterPairedStatisticsForSelection(
        await response.json(),
        normalizedArea
    );
}

/**
 * Sample both axis rasters through the existing independent pixel contract.
 *
 * Partial failure remains axis-scoped so one usable value is still reported.
 * A shared abort remains cancellation rather than a visible dual failure.
 *
 * @param {{xItem:Object,yItem:Object}} pair Ordered Catalog Items.
 * @param {{longitude:number,latitude:number}} position WGS 84 position.
 * @param {AbortSignal} signal Cancellation signal for stale hover intent.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<{x:Object,y:Object}>} Axis-scoped pixel outcomes.
 */
export async function sampleCatalogRasterPairPixels(
    pair,
    position,
    signal,
    fetchImplementation = globalThis.fetch
) {
    const outcomes = await Promise.allSettled([
        sampleCatalogRasterPixel(
            pair.xItem,
            position,
            signal,
            fetchImplementation
        ),
        sampleCatalogRasterPixel(
            pair.yItem,
            position,
            signal,
            fetchImplementation
        ),
    ]);
    if (signal.aborted) {
        const abortError = new Error("Paired pixel sampling was canceled");
        abortError.name = "AbortError";
        throw abortError;
    }
    const axisOutcome = (outcome) => outcome.status === "fulfilled"
        ? { available: true, pixel: outcome.value, error: null }
        : {
            available: false,
            pixel: null,
            error: outcome.reason instanceof Error
                ? outcome.reason.message
                : "Pixel unavailable",
        };
    return {
        x: axisOutcome(outcomes[0]),
        y: axisOutcome(outcomes[1]),
    };
}
