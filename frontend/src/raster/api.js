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
    "centerSample",
    "representativeSample",
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
    const isCanonicalBounds = (bounds) =>
        Array.isArray(bounds) && bounds.length === 4 &&
        bounds.every(Number.isFinite) &&
        bounds[0] >= -180 && bounds[2] <= 180 &&
        bounds[1] >= -90 && bounds[3] <= 90 &&
        bounds[0] < bounds[2] && bounds[1] < bounds[3];
    if (
        !RASTER_DETAIL_PREVIEW_MODES.has(requestedMode) ||
        preview?.mode !== requestedMode ||
        preview?.approximate !== true ||
        preview?.policyVersion !== "bounded-sampled-raster-v2" ||
        typeof preview?.label !== "string" || preview.label.trim() === "" ||
        !isCanonicalBounds(preview?.rasterExtent) ||
        !isCanonicalBounds(preview?.imageBounds) ||
        !Number.isSafeInteger(preview?.imageWidth) ||
        preview.imageWidth < 1 ||
        !Number.isSafeInteger(preview?.imageHeight) ||
        preview.imageHeight < 1 ||
        !Array.isArray(preview?.pixelValues) ||
        preview.pixelValues.length !== preview.imageWidth * preview.imageHeight ||
        preview.pixelValues.some((value) =>
            !(value === null || Number.isFinite(value))
        ) ||
        preview?.limits?.maximumProxyDimension !== 127 ||
        preview?.limits?.maximumSourceBlockReads !== 1024 ||
        preview?.limits?.maximumDecodedSourceBytes !== 67108864 ||
        preview?.limits?.maximumPointsPerCell !== 5 ||
        preview?.limits?.maximumPatchDimension !== 128 ||
        preview?.limits?.maximumPatchCandidates !== 9 ||
        preview?.actual?.sampleGridWidth !== preview.imageWidth ||
        preview?.actual?.sampleGridHeight !== preview.imageHeight ||
        !Number.isSafeInteger(preview?.actual?.sourceBlockReadCount) ||
        preview.actual.sourceBlockReadCount < 1 ||
        preview.actual.sourceBlockReadCount >
            preview.limits.maximumSourceBlockReads ||
        !Number.isSafeInteger(preview?.actual?.decodedSourceBytes) ||
        preview.actual.decodedSourceBytes < 1 ||
        preview.actual.decodedSourceBytes >
            preview.limits.maximumDecodedSourceBytes ||
        !Number.isSafeInteger(preview?.actual?.pointsPerCell) ||
        preview.actual.pointsPerCell < 0 ||
        !Number.isSafeInteger(preview?.actual?.candidateWindowCount) ||
        preview.actual.candidateWindowCount < 0
    ) {
        throw new Error("Detail-only preview response is invalid");
    }
    const maximumImageDimension = requestedMode === "representativePatch"
        ? preview.limits.maximumPatchDimension
        : preview.limits.maximumProxyDimension;
    if (
        preview.imageWidth > maximumImageDimension ||
        preview.imageHeight > maximumImageDimension ||
        preview.actual.pointsPerCell !== (
            requestedMode === "centerSample"
                ? 1
                : requestedMode === "representativeSample" ? 5 : 0
        ) ||
        (requestedMode === "representativePatch") !==
            (preview.actual.candidateWindowCount > 0) ||
        preview.actual.candidateWindowCount >
            preview.limits.maximumPatchCandidates
    ) {
        throw new Error("Detail-only preview image exceeds its fixed limit");
    }
    const finiteValues = preview.pixelValues.filter((value) => value !== null);
    const range = preview.suggestedRange;
    const validRange = range !== null &&
        Number.isFinite(range?.minimum) &&
        Number.isFinite(range?.midpoint) &&
        Number.isFinite(range?.maximum) &&
        range.minimum < range.midpoint && range.midpoint < range.maximum;
    if (
        (finiteValues.length === 0 && range !== null) ||
        (finiteValues.length > 0 && !validRange)
    ) {
        throw new Error("Detail-only preview color range is invalid");
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
