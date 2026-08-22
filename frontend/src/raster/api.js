/**
 * Same-origin HTTP adapter for EOLab's raster-rendering API.
 *
 * This module builds requests from Catalog Item identity, validates API
 * responses at the network boundary, and converts failures to user-safe
 * errors. It does not own raster domain calculations, UI state, or Leaflet.
 */
import { validateRasterSelectedBounds } from "./geometry.js";
import { validateRasterStatisticsForSelection } from "./statistics.js";

/**
 * Return a user-safe rendering error from FastAPI or an upstream proxy.
 *
 * @param {Response} response Failed rendering response.
 * @param {string} action User-facing description of the request.
 * @return {Promise<Error>} Structured FastAPI detail or a status fallback.
 */
async function renderingRequestError(response, action) {
    const fallbackMessage = `${action} failed (${response.status})`;
    if (!response.headers.get("content-type")?.toLowerCase().includes(
        "application/json"
    )) {
        return new Error(fallbackMessage);
    }
    try {
        const errorDocument = await response.json();
        return new Error(
            typeof errorDocument.detail === "string" &&
                errorDocument.detail.trim() !== ""
                ? errorDocument.detail
                : fallbackMessage
        );
    } catch {
        return new Error(fallbackMessage);
    }
}

/**
 * Send one selected STAC Item identity to a rendering endpoint.
 *
 * @param {string} endpoint Same-origin rendering API endpoint.
 * @param {Object} item Selected STAC Item.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Parsed JSON response document.
 * @throws {Error} If the request fails or the endpoint rejects it.
 */
async function postCatalogRasterAction(
    endpoint,
    item,
    fetchImplementation = globalThis.fetch
) {
    const response = await fetchImplementation.call(
        globalThis,
        endpoint,
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                collectionId: item.collection,
                itemId: item.id
            })
        }
    );
    if (!response.ok) {
        throw await renderingRequestError(response, "Rendering request");
    }

    return response.json();
}

/**
 * Assess and update one selected legacy raster Item.
 *
 * @param {Object} item Selected STAC Item.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Updated authoritative STAC Item.
 * @throws {Error} If assessment or catalog persistence fails.
 */
export function assessCatalogRaster(
    item,
    fetchImplementation = globalThis.fetch
) {
    return postCatalogRasterAction(
        "/api/rendering/assessments",
        item,
        fetchImplementation
    );
}

/**
 * Ask EOLab to publish the authoritative STAC Item as a WMS layer.
 *
 * @param {Object} item Selected STAC Item.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Published layer identity and bounds.
 * @throws {Error} If publication fails or the raster is not eligible.
 */
export function publishCatalogRaster(
    item,
    fetchImplementation = globalThis.fetch
) {
    return postCatalogRasterAction(
        "/api/rendering/layers",
        item,
        fetchImplementation
    );
}

/**
 * Load the bounded band-1 sample statistics for one published Catalog raster.
 *
 * @param {Object} item Selected STAC Item.
 * @param {AbortSignal} signal Cancellation signal for a stale selection.
 * @param {Object|null} [selectedBounds=null] Optional WGS 84 rectangle.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Validated fixed-bin raster statistics.
 * @throws {Error} If EOLab cannot calculate or validate the statistics.
 */
export async function loadCatalogRasterStatistics(
    item,
    signal,
    selectedBounds = null,
    fetchImplementation = globalThis.fetch
) {
    const validatedSelectedBounds = selectedBounds === null
        ? null
        : validateRasterSelectedBounds(selectedBounds);
    const requestDocument = {
        collectionId: item.collection,
        itemId: item.id
    };
    if (validatedSelectedBounds !== null) {
        requestDocument.selectedBounds = validatedSelectedBounds;
    }
    const response = await fetchImplementation.call(
        globalThis,
        "/api/rendering/statistics",
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
        throw await renderingRequestError(
            response,
            "Raster statistics request"
        );
    }
    return validateRasterStatisticsForSelection(
        await response.json(),
        validatedSelectedBounds
    );
}

/**
 * Read one band-1 pixel from the selected, published Catalog raster.
 *
 * @param {Object} item Selected STAC Item.
 * @param {{longitude: number, latitude: number}} position WGS 84 position.
 * @param {AbortSignal} signal Cancellation signal for a superseded position.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Source cell, bounds state, and value.
 * @throws {Error} If EOLab cannot sample the raster.
 */
export async function sampleCatalogRasterPixel(
    item,
    position,
    signal,
    fetchImplementation = globalThis.fetch
) {
    const response = await fetchImplementation.call(
        globalThis,
        "/api/rendering/pixels",
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
        throw await renderingRequestError(response, "Pixel sample request");
    }
    return response.json();
}
