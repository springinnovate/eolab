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

/** Fixed user-selectable bounded preview modes. */
const RASTER_DETAIL_PREVIEW_MODES = new Set([
    "centerPixel",
    "samplingGrid",
    "representativePatch"
]);

/**
 * Validate one browser-safe detail-only preview at the network boundary.
 *
 * @param {Object} preview Parsed response document.
 * @param {string} requestedMode Mode sent by the current UI request.
 * @return {Object} The validated response document.
 * @throws {Error} If the response violates the fixed preview contract.
 */
export function validateRasterDetailPreview(preview, requestedMode) {
    const isFiniteBounds = (bounds) =>
        Array.isArray(bounds) && bounds.length === 4 &&
        bounds.every(Number.isFinite) &&
        bounds[0] < bounds[2] && bounds[1] < bounds[3];
    if (
        !RASTER_DETAIL_PREVIEW_MODES.has(requestedMode) ||
        preview?.mode !== requestedMode ||
        preview?.approximate !== true ||
        typeof preview?.policyVersion !== "string" ||
        typeof preview?.label !== "string" ||
        !isFiniteBounds(preview?.rasterExtent) ||
        !Array.isArray(preview?.samples) ||
        preview?.limits?.maximumGridSamples !== 25 ||
        preview?.limits?.maximumPatchDimension !== 128 ||
        preview?.limits?.maximumPatchCandidates !== 9
    ) {
        throw new Error("Detail-only preview response is invalid");
    }
    if (requestedMode === "representativePatch") {
        if (
            preview.samples.length !== 0 ||
            !isFiniteBounds(preview.detailBounds) ||
            typeof preview.imageDataUrl !== "string" ||
            !preview.imageDataUrl.startsWith("data:image/png;base64,")
        ) {
            throw new Error("Representative detail patch response is invalid");
        }
        return preview;
    }
    if (
        preview.detailBounds !== null ||
        preview.imageDataUrl !== null ||
        preview.samples.length < 1 ||
        preview.samples.length > preview.limits.maximumGridSamples ||
        preview.samples.some((sample) =>
            !Number.isSafeInteger(sample?.row) ||
            !Number.isSafeInteger(sample?.column) ||
            !Number.isFinite(sample?.longitude) ||
            !Number.isFinite(sample?.latitude) ||
            !(sample?.value === null || Number.isFinite(sample?.value))
        )
    ) {
        throw new Error("Detail sample preview response is invalid");
    }
    if (requestedMode === "centerPixel" && preview.samples.length !== 1) {
        throw new Error("Center-pixel preview must contain one sample");
    }
    return preview;
}

/**
 * Load one explicitly selected bounded preview for an overview-limited raster.
 *
 * @param {Object} item Selected scanner-owned STAC Item.
 * @param {string} mode One fixed detail preview mode.
 * @param {AbortSignal} signal Cancellation signal for stale UI intent.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Validated georeferenced detail preview.
 * @throws {Error} If the request or response violates the preview contract.
 */
export async function loadCatalogRasterDetailPreview(
    item,
    mode,
    signal,
    fetchImplementation = globalThis.fetch
) {
    if (!RASTER_DETAIL_PREVIEW_MODES.has(mode)) {
        throw new TypeError(`Unsupported raster detail preview mode: ${mode}`);
    }
    const response = await fetchImplementation.call(
        globalThis,
        "/api/rendering/detail-previews",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                collectionId: item.collection,
                itemId: item.id,
                mode
            }),
            signal
        }
    );
    if (!response.ok) {
        throw await renderingRequestError(
            response,
            "Detail-only preview request"
        );
    }
    return validateRasterDetailPreview(await response.json(), mode);
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
