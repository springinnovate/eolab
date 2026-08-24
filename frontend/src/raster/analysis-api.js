/** Same-origin adapters for rendering-independent raster analysis. */

import {
    normalizeRasterSamplingArea,
    validateRasterStatisticsForSelection,
} from "./statistics.js";

const RETRYABLE_RASTER_STATISTICS_CAPACITY_MESSAGES = new Set([
    "Raster statistics capacity is busy; retry after the current bounded read finishes.",
    "Raster statistics capacity is finishing canceled work; retry shortly.",
]);

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
 * Report whether retrying a failed statistics request can change the outcome.
 *
 * Transport failures have no HTTP classification and remain retryable. Server
 * and request-throttling responses are transient, while client and conflict
 * responses are deterministic except for the service's two bounded-capacity
 * conflicts.
 *
 * @param {Error} error Statistics request failure from the analysis adapter.
 * @return {boolean} Whether the viewer should offer an explicit retry action.
 */
export function isRasterStatisticsRetryableError(error) {
    if (!(error instanceof RasterAnalysisRequestError)) {
        return true;
    }
    if (error.status === 408 || error.status === 429 || error.status >= 500) {
        return true;
    }
    return error.status === 409 &&
        RETRYABLE_RASTER_STATISTICS_CAPACITY_MESSAGES.has(error.message);
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
