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

/** Projection roundoff allowance, far below a displayable map distance. */
const RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE = 1e-9;

/**
 * @typedef {Object} RasterDetailPreviewViewBounds
 * @property {number} west Western WGS 84 longitude.
 * @property {number} south Southern WGS 84 latitude.
 * @property {number} east Eastern WGS 84 longitude.
 * @property {number} north Northern WGS 84 latitude.
 */

/**
 * @typedef {Object} RasterDetailPreviewOptions
 * @property {RasterDetailPreviewViewBounds|null} [viewBounds] Optional exact
 * current raster/view intersection; no source paths or read controls are
 * accepted.
 */

/**
 * Validate and normalize one detail-preview request owned by the browser.
 *
 * @param {RasterDetailPreviewOptions} options
 * Optional current map rectangle.
 * @return {{viewBounds:RasterDetailPreviewViewBounds|null}} Strict request
 * options safe to serialize without paths or numeric read controls.
 * @throws {TypeError} If fields or bounds violate the fixed request contract.
 */
function validateRasterDetailPreviewOptions(options) {
    const optionKeys = Object.keys(options ?? {});
    if (optionKeys.some((key) =>
        key !== "viewBounds"
    )) {
        throw new TypeError("Raster detail request contains unsupported fields");
    }
    const viewBounds = options?.viewBounds ?? null;
    const isCanonicalBounds = (bounds) => bounds !== null &&
        typeof bounds === "object" &&
        Object.keys(bounds).length === 4 &&
        Object.keys(bounds).every((key) =>
            ["west", "south", "east", "north"].includes(key)
        ) &&
        ["west", "south", "east", "north"].every((key) =>
            Number.isFinite(bounds[key])
        ) &&
        bounds.west >= -180 && bounds.east <= 180 &&
        bounds.south >= -90 && bounds.north <= 90 &&
        bounds.west < bounds.east && bounds.south < bounds.north;
    if (viewBounds !== null && !isCanonicalBounds(viewBounds)) {
        throw new TypeError("Raster detail view bounds are invalid");
    }
    return {
        viewBounds: viewBounds === null ? null : {
            west: viewBounds.west,
            south: viewBounds.south,
            east: viewBounds.east,
            north: viewBounds.north
        }
    };
}

/** Browser-safe conflict returned when all bounded preview readers are busy. */
const DETAIL_PREVIEW_CAPACITY_BUSY_MESSAGE =
    "Detail-only preview capacity is busy; retry after the current bounded " +
    "read finishes.";

/**
 * Identify the one transient detail-preview conflict that is safe to retry.
 *
 * Other HTTP 409 responses describe source, authorization, geometry, or work
 * contract failures and must remain actionable instead of being retried.
 *
 * @param {unknown} error Candidate request failure.
 * @return {boolean} Whether the failure is bounded-reader capacity contention.
 */
export function isRasterDetailPreviewCapacityError(error) {
    return error instanceof RenderingRequestError && error.status === 409 &&
        error.message === DETAIL_PREVIEW_CAPACITY_BUSY_MESSAGE;
}

/**
 * Validate one browser-safe detail-only preview at the network boundary.
 *
 * @param {Object} preview Parsed response document.
 * @param {RasterDetailPreviewOptions} options
 * Options sent by the current UI request.
 * @return {Object} The validated response document.
 * @throws {Error} If the response violates the fixed preview contract.
 */
export function validateRasterDetailPreview(preview, options) {
    const request = validateRasterDetailPreviewOptions(options);
    const rendering = preview?.rendering;
    const isExactDetail = rendering === "exactSourceWindow";
    const expectedDecodedSourceBytes = isExactDetail
        ? 67108864
        : 9663676416;
    const expectedSourceBlockReads = isExactDetail ? 1024 : 16129;
    const isCanonicalBounds = (bounds) =>
        Array.isArray(bounds) && bounds.length === 4 &&
        bounds.every(Number.isFinite) &&
        bounds[0] >= -180 && bounds[2] <= 180 &&
        bounds[1] >= -90 && bounds[3] <= 90 &&
        bounds[0] < bounds[2] && bounds[1] < bounds[3];
    if (
        !new Set(["sampledProxy", "exactSourceWindow"]).has(rendering) ||
        preview?.scope !== (request.viewBounds === null
            ? "rasterExtent"
            : "currentView") ||
        preview?.approximate !== true ||
        preview?.policyVersion !== "bounded-adaptive-raster-v7" ||
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
        preview?.limits?.maximumExactDetailDimension !== 512 ||
        preview?.limits?.maximumSourceBlockReads !== expectedSourceBlockReads ||
        preview?.limits?.maximumDecodedSourceBytes !==
            expectedDecodedSourceBytes ||
        preview?.limits?.maximumTransformedPositions !== 16129 ||
        preview?.limits?.maximumPointsPerCell !== 1 ||
        preview?.actual?.sampleGridWidth !== preview.imageWidth ||
        preview?.actual?.sampleGridHeight !== preview.imageHeight ||
        !Number.isSafeInteger(preview?.actual?.sourceBlockReadCount) ||
        preview.actual.sourceBlockReadCount < 0 ||
        preview.actual.sourceBlockReadCount >
            preview.limits.maximumSourceBlockReads ||
        !Number.isSafeInteger(preview?.actual?.decodedSourceBytes) ||
        preview.actual.decodedSourceBytes < 0 ||
        preview.actual.decodedSourceBytes >
            preview.limits.maximumDecodedSourceBytes ||
        !Number.isSafeInteger(preview?.actual?.pointsPerCell) ||
        preview.actual.pointsPerCell < 0
    ) {
        throw new Error("Detail-only preview response is invalid");
    }
    const sourceWindow = preview.actual.sourceWindow;
    const validSourceWindow = sourceWindow !== null &&
        typeof sourceWindow === "object" &&
        Object.keys(sourceWindow).length === 4 &&
        Number.isSafeInteger(sourceWindow.columnOffset) &&
        sourceWindow.columnOffset >= 0 &&
        Number.isSafeInteger(sourceWindow.rowOffset) &&
        sourceWindow.rowOffset >= 0 &&
        Number.isSafeInteger(sourceWindow.width) && sourceWindow.width >= 1 &&
        Number.isSafeInteger(sourceWindow.height) && sourceWindow.height >= 1;
    if (
        (rendering === "sampledProxy"
            ? Math.max(preview.imageWidth, preview.imageHeight) !==
                preview.limits.maximumProxyDimension
            : preview.imageWidth > preview.limits.maximumExactDetailDimension ||
                preview.imageHeight >
                    preview.limits.maximumExactDetailDimension) ||
        preview.actual.pointsPerCell !== (isExactDetail ? 0 : 1) ||
        (preview.actual.sourceBlockReadCount === 0) !==
            (preview.actual.decodedSourceBytes === 0) ||
        ((rendering === "sampledProxy") !== (sourceWindow == null)) ||
        (isExactDetail && (
            !validSourceWindow ||
            sourceWindow.width !== preview.imageWidth ||
            sourceWindow.height !== preview.imageHeight
        )) ||
        (request.viewBounds === null && isExactDetail)
    ) {
        throw new Error("Detail-only preview image exceeds its fixed limit");
    }
    const containsImage = (outerBounds) =>
        outerBounds[0] - RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE <=
            preview.imageBounds[0] &&
        outerBounds[1] - RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE <=
            preview.imageBounds[1] &&
        outerBounds[2] + RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE >=
            preview.imageBounds[2] &&
        outerBounds[3] + RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE >=
            preview.imageBounds[3];
    if (!containsImage(preview.rasterExtent)) {
        throw new Error("Detail-only preview placement is invalid");
    }
    if (preview.scope === "currentView") {
        const requestedBounds = [
            request.viewBounds.west,
            request.viewBounds.south,
            request.viewBounds.east,
            request.viewBounds.north
        ];
        if (!containsImage(requestedBounds)) {
            throw new Error("Detail-only preview placement is invalid");
        }
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
        (finiteValues.length > 0 && !validRange) ||
        (preview.actual.sourceBlockReadCount === 0 &&
            (finiteValues.length > 0 || range !== null))
    ) {
        throw new Error("Detail-only preview color range is invalid");
    }
    return preview;
}

/**
 * Load one explicitly selected bounded preview for an overview-limited raster.
 *
 * @param {Object} item Selected scanner-owned STAC Item.
 * @param {RasterDetailPreviewOptions} options
 * Optional current map rectangle; center sampling and 127 are server-owned.
 * @param {AbortSignal} signal Cancellation signal for stale UI intent.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Validated georeferenced detail preview.
 * @throws {Error} If the request or response violates the preview contract.
 */
export async function loadCatalogRasterDetailPreview(
    item,
    options,
    signal,
    fetchImplementation = globalThis.fetch
) {
    const request = validateRasterDetailPreviewOptions(options);
    const body = {
        collectionId: item.collection,
        itemId: item.id
    };
    if (request.viewBounds !== null) {
        body.viewBounds = request.viewBounds;
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
            body: JSON.stringify(body),
            signal
        }
    );
    if (!response.ok) {
        throw await renderingRequestError(
            response,
            "Detail-only preview request"
        );
    }
    return validateRasterDetailPreview(await response.json(), request);
}

/**
 * Load histogram statistics over one bounded sampled-raster map window.
 *
 * The server reuses the overview-safe adaptive detail reader. It uses a
 * center-point grid with exactly 127 cells on its longest edge at broad scales
 * and complete source detail when the selected window satisfies the exact
 * limits. No whole-raster or arbitrary source window is accepted here.
 *
 * @param {Object} item Selected scanner-owned STAC Item.
 * @param {AbortSignal} signal Cancellation signal for a stale selection.
 * @param {Object} selectedBounds Required canonical WGS 84 rectangle.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Validated selected-area raster statistics with
 * sampled-grid provenance.
 * @throws {Error} If bounds, backend response, or histogram data are invalid.
 */
export async function loadCatalogRasterDetailStatistics(
    item,
    signal,
    selectedBounds,
    fetchImplementation = globalThis.fetch
) {
    const validatedSelectedBounds = validateRasterSelectedBounds(
        selectedBounds
    );
    const response = await fetchImplementation.call(
        globalThis,
        "/api/rendering/detail-statistics",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                collectionId: item.collection,
                itemId: item.id,
                selectedBounds: validatedSelectedBounds
            }),
            signal
        }
    );
    if (!response.ok) {
        throw await renderingRequestError(
            response,
            "Sampled raster histogram request"
        );
    }
    return {
        ...validateRasterStatisticsForSelection(
            await response.json(),
            validatedSelectedBounds,
            null
        ),
        samplingMethod: "sampledGrid"
    };
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
