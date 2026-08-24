/** Same-origin adapter for rendering-independent raster pixel analysis. */

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
 * @return {Promise<RasterAnalysisRequestError>} Structured detail or a status
 * fallback.
 */
async function analysisRequestError(response) {
    const fallbackMessage = `Pixel sample request failed (${response.status})`;
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
 * Pixel analysis is catalog-authorized and does not depend on whether the
 * raster is displayed through WMS, adaptive detail, or no renderer at all.
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
        throw await analysisRequestError(response);
    }
    return response.json();
}
