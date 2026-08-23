/**
 * Same-origin HTTP adapter for EOLab's raster-rendering API.
 *
 * This module builds requests from Catalog Item identity, validates API
 * responses at the network boundary, and converts failures to user-safe
 * errors. It does not own raster domain calculations, UI state, or Leaflet.
 */
import { validateRasterSelectedBounds } from "./geometry.js";
import { validateRasterStatisticsForSelection } from "./statistics.js";

/** Stable publication categories exposed by the rendering API. */
const RASTER_PUBLICATION_FAILURE_CATEGORIES = new Set([
    "reader_rejection",
    "connectivity",
    "authentication",
    "timeout",
    "configuration",
    "upstream_failure"
]);

/**
 * Represent one browser-safe rendering API failure.
 *
 * @property {string|null} category Stable publication category, when supplied.
 * @property {number} status Rendering API HTTP response status.
 */
export class RenderingRequestError extends Error {
    /**
     * Create a rendering failure with optional stable publication metadata.
     *
     * @param {string} message Concise user-facing failure explanation.
     * @param {string|null} category Stable publication category, when supplied.
     * @param {number} status Rendering API HTTP response status.
     */
    constructor(message, category, status) {
        super(message);
        this.name = "RenderingRequestError";
        this.category = category;
        this.status = status;
    }
}

/**
 * Return a user-safe rendering error from FastAPI or an upstream proxy.
 *
 * @param {Response} response Failed rendering response.
 * @param {string} action User-facing description of the request.
 * @return {Promise<RenderingRequestError>} Structured FastAPI detail or a
 * status fallback.
 */
async function renderingRequestError(response, action) {
    const fallbackMessage = `${action} failed (${response.status})`;
    if (!response.headers.get("content-type")?.toLowerCase().includes(
        "application/json"
    )) {
        return new RenderingRequestError(
            fallbackMessage,
            null,
            response.status
        );
    }
    try {
        const errorDocument = await response.json();
        const detail = errorDocument.detail;
        if (
            typeof detail === "object" &&
            detail !== null &&
            RASTER_PUBLICATION_FAILURE_CATEGORIES.has(detail.category) &&
            typeof detail.message === "string" &&
            detail.message.trim() !== ""
        ) {
            return new RenderingRequestError(
                detail.message,
                detail.category,
                response.status
            );
        }
        return new RenderingRequestError(
            typeof detail === "string" && detail.trim() !== ""
                ? detail
                : fallbackMessage,
            null,
            response.status
        );
    } catch {
        return new RenderingRequestError(
            fallbackMessage,
            null,
            response.status
        );
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
 * @param {string|null} [temporaryAoiId=null] Optional opaque ready AOI.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Validated fixed-bin raster statistics.
 * @throws {Error} If EOLab cannot calculate or validate the statistics.
 */
export async function loadCatalogRasterStatistics(
    item,
    signal,
    selectedBounds = null,
    temporaryAoiId = null,
    fetchImplementation = globalThis.fetch
) {
    if (typeof temporaryAoiId === "function") {
        fetchImplementation = temporaryAoiId;
        temporaryAoiId = null;
    }
    if (selectedBounds !== null && temporaryAoiId !== null) {
        throw new Error(
            "Raster statistics bounds and temporary AOI are mutually exclusive."
        );
    }
    const validatedSelectedBounds = selectedBounds === null
        ? null
        : validateRasterSelectedBounds(selectedBounds);
    if (
        temporaryAoiId !== null &&
        (
            typeof temporaryAoiId !== "string" ||
            !/^[A-Za-z0-9_-]{32}$/.test(temporaryAoiId)
        )
    ) {
        throw new Error("Temporary AOI identity is invalid.");
    }
    const requestDocument = {
        collectionId: item.collection,
        itemId: item.id
    };
    if (validatedSelectedBounds !== null) {
        requestDocument.selectedBounds = validatedSelectedBounds;
    } else if (temporaryAoiId !== null) {
        requestDocument.temporaryAoiId = temporaryAoiId;
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
        validatedSelectedBounds,
        temporaryAoiId
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
