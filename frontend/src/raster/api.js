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
const RASTER_DETAIL_PREVIEW_POLICY_VERSION = "bounded-adaptive-raster-v7";
const RASTER_DETAIL_PREVIEW_MAXIMUM_GRID_DIMENSION = 127;
const RASTER_DETAIL_PREVIEW_MAXIMUM_EXACT_DIMENSION = 512;
const RASTER_DETAIL_PREVIEW_MAXIMUM_TRANSFORMED_POSITIONS = 127 * 127;
const RASTER_DETAIL_PREVIEW_MAXIMUM_POINTS_PER_CELL = 1;
const RASTER_DETAIL_PREVIEW_RENDERING_CONTRACTS = Object.freeze({
    sampledProxy: Object.freeze({
        maximumSourceBlockReads: 127 * 127,
        maximumDecodedSourceBytes: 9 * 1024 * 1024 * 1024,
        pointsPerCell: RASTER_DETAIL_PREVIEW_MAXIMUM_POINTS_PER_CELL,
        sourceWindowRequired: false
    }),
    exactSourceWindow: Object.freeze({
        maximumSourceBlockReads: 1_024,
        maximumDecodedSourceBytes: 64 * 1024 * 1024,
        pointsPerCell: 0,
        sourceWindowRequired: true
    })
});

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
 * Return whether a value is a positive safe integer.
 *
 * @param {unknown} value Candidate numeric field.
 * @return {boolean} Whether the value is an integer greater than zero.
 */
function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}

/**
 * Return whether a value is a nonnegative safe integer.
 *
 * @param {unknown} value Candidate work-accounting field.
 * @return {boolean} Whether the value is an integer at least zero.
 */
function isNonnegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Return whether an array is one ordered canonical WGS 84 rectangle.
 *
 * @param {unknown} bounds Candidate west, south, east, north tuple.
 * @return {boolean} Whether the tuple satisfies the map boundary contract.
 */
function isCanonicalWgs84BoundsTuple(bounds) {
    return Array.isArray(bounds) && bounds.length === 4 &&
        bounds.every(Number.isFinite) &&
        bounds[0] >= -180 && bounds[2] <= 180 &&
        bounds[1] >= -90 && bounds[3] <= 90 &&
        bounds[0] < bounds[2] && bounds[1] < bounds[3];
}

/**
 * Validate the response fields shared by every detail representation.
 *
 * @param {Object} preview Parsed response document.
 * @param {RasterDetailPreviewOptions} request Validated request options.
 * @return {Object} Fixed contract for the selected rendering representation.
 * @throws {Error} If identity, dimensions, bounds, or pixels are invalid.
 */
function requireRasterDetailPreviewEnvelope(preview, request) {
    if (preview === null || typeof preview !== "object") {
        throw new Error("Detail-only preview response is invalid");
    }
    const renderingContract =
        RASTER_DETAIL_PREVIEW_RENDERING_CONTRACTS[preview.rendering];
    if (renderingContract === undefined) {
        throw new Error("Detail-only preview response is invalid");
    }
    const expectedScope = request.viewBounds === null
        ? "rasterExtent"
        : "currentView";
    if (preview.scope !== expectedScope || preview.approximate !== true ||
        preview.policyVersion !== RASTER_DETAIL_PREVIEW_POLICY_VERSION) {
        throw new Error("Detail-only preview response is invalid");
    }
    if (typeof preview.label !== "string" || preview.label.trim() === "") {
        throw new Error("Detail-only preview response is invalid");
    }
    if (!isCanonicalWgs84BoundsTuple(preview.rasterExtent) ||
        !isCanonicalWgs84BoundsTuple(preview.imageBounds)) {
        throw new Error("Detail-only preview response is invalid");
    }
    if (!isPositiveSafeInteger(preview.imageWidth) ||
        !isPositiveSafeInteger(preview.imageHeight)) {
        throw new Error("Detail-only preview response is invalid");
    }
    if (!Array.isArray(preview.pixelValues) ||
        preview.pixelValues.length !== preview.imageWidth * preview.imageHeight ||
        preview.pixelValues.some((value) =>
            !(value === null || Number.isFinite(value)))) {
        throw new Error("Detail-only preview response is invalid");
    }
    return renderingContract;
}

/**
 * Validate the server-owned resource limits for one representation.
 *
 * @param {Object} limits Parsed response resource limits.
 * @param {Object} renderingContract Selected fixed rendering contract.
 * @return {void}
 * @throws {Error} If the server reports a different resource policy.
 */
function requireRasterDetailPreviewLimits(limits, renderingContract) {
    const expectedLimits = {
        maximumProxyDimension: RASTER_DETAIL_PREVIEW_MAXIMUM_GRID_DIMENSION,
        maximumExactDetailDimension:
            RASTER_DETAIL_PREVIEW_MAXIMUM_EXACT_DIMENSION,
        maximumSourceBlockReads:
            renderingContract.maximumSourceBlockReads,
        maximumDecodedSourceBytes:
            renderingContract.maximumDecodedSourceBytes,
        maximumTransformedPositions:
            RASTER_DETAIL_PREVIEW_MAXIMUM_TRANSFORMED_POSITIONS,
        maximumPointsPerCell:
            RASTER_DETAIL_PREVIEW_MAXIMUM_POINTS_PER_CELL
    };
    if (limits === null || typeof limits !== "object" ||
        Object.entries(expectedLimits).some(
            ([field, expected]) => limits[field] !== expected
        )) {
        throw new Error("Detail-only preview response is invalid");
    }
}

/**
 * Return whether a source-window value is a positive integral rectangle.
 *
 * @param {unknown} sourceWindow Candidate source-pixel window.
 * @return {boolean} Whether all four owned fields are valid.
 */
function isValidRasterDetailSourceWindow(sourceWindow) {
    return sourceWindow !== null && typeof sourceWindow === "object" &&
        Object.keys(sourceWindow).length === 4 &&
        isNonnegativeSafeInteger(sourceWindow.columnOffset) &&
        isNonnegativeSafeInteger(sourceWindow.rowOffset) &&
        isPositiveSafeInteger(sourceWindow.width) &&
        isPositiveSafeInteger(sourceWindow.height);
}

/**
 * Validate actual work and representation-specific image provenance.
 *
 * @param {Object} preview Validated preview envelope.
 * @param {RasterDetailPreviewOptions} request Validated request options.
 * @param {Object} renderingContract Selected fixed rendering contract.
 * @return {void}
 * @throws {Error} If actual work or source placement violates fixed limits.
 */
function requireRasterDetailPreviewWork(preview, request, renderingContract) {
    const actual = preview.actual;
    if (actual === null || typeof actual !== "object" ||
        actual.sampleGridWidth !== preview.imageWidth ||
        actual.sampleGridHeight !== preview.imageHeight) {
        throw new Error("Detail-only preview response is invalid");
    }
    if (!isNonnegativeSafeInteger(actual.sourceBlockReadCount) ||
        actual.sourceBlockReadCount >
            renderingContract.maximumSourceBlockReads ||
        !isNonnegativeSafeInteger(actual.decodedSourceBytes) ||
        actual.decodedSourceBytes >
            renderingContract.maximumDecodedSourceBytes ||
        !isNonnegativeSafeInteger(actual.pointsPerCell)) {
        throw new Error("Detail-only preview response is invalid");
    }
    const sourceWorkIsEmpty = actual.sourceBlockReadCount === 0;
    if (sourceWorkIsEmpty !== (actual.decodedSourceBytes === 0) ||
        actual.pointsPerCell !== renderingContract.pointsPerCell) {
        throw new Error("Detail-only preview image exceeds its fixed limit");
    }

    if (!renderingContract.sourceWindowRequired) {
        if (Math.max(preview.imageWidth, preview.imageHeight) !==
            RASTER_DETAIL_PREVIEW_MAXIMUM_GRID_DIMENSION ||
            actual.sourceWindow != null) {
            throw new Error("Detail-only preview image exceeds its fixed limit");
        }
        return;
    }
    if (request.viewBounds === null ||
        preview.imageWidth > RASTER_DETAIL_PREVIEW_MAXIMUM_EXACT_DIMENSION ||
        preview.imageHeight > RASTER_DETAIL_PREVIEW_MAXIMUM_EXACT_DIMENSION ||
        !isValidRasterDetailSourceWindow(actual.sourceWindow) ||
        actual.sourceWindow.width !== preview.imageWidth ||
        actual.sourceWindow.height !== preview.imageHeight) {
        throw new Error("Detail-only preview image exceeds its fixed limit");
    }
}

/**
 * Return whether outer bounds contain the preview image within roundoff.
 *
 * @param {number[]} outerBounds Candidate containing rectangle.
 * @param {number[]} imageBounds Validated preview image rectangle.
 * @return {boolean} Whether the image stays inside the outer rectangle.
 */
function rasterDetailBoundsContainImage(outerBounds, imageBounds) {
    return outerBounds[0] - RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE <=
            imageBounds[0] &&
        outerBounds[1] - RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE <=
            imageBounds[1] &&
        outerBounds[2] + RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE >=
            imageBounds[2] &&
        outerBounds[3] + RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE >=
            imageBounds[3];
}

/**
 * Validate raster-extent and current-view placement.
 *
 * @param {Object} preview Validated preview envelope.
 * @param {RasterDetailPreviewOptions} request Validated request options.
 * @return {void}
 * @throws {Error} If the image escapes its raster or requested map bounds.
 */
function requireRasterDetailPreviewPlacement(preview, request) {
    if (!rasterDetailBoundsContainImage(
        preview.rasterExtent,
        preview.imageBounds
    )) {
        throw new Error("Detail-only preview placement is invalid");
    }
    if (preview.scope !== "currentView") {
        return;
    }
    const requestedBounds = [
        request.viewBounds.west,
        request.viewBounds.south,
        request.viewBounds.east,
        request.viewBounds.north
    ];
    if (!rasterDetailBoundsContainImage(
        requestedBounds,
        preview.imageBounds
    )) {
        throw new Error("Detail-only preview placement is invalid");
    }
}

/**
 * Validate finite-value and suggested-range agreement.
 *
 * @param {Object} preview Validated preview and work document.
 * @return {void}
 * @throws {Error} If nodata, finite values, source work, and range disagree.
 */
function requireRasterDetailPreviewRange(preview) {
    const finiteValueCount = preview.pixelValues.reduce(
        (count, value) => count + (value === null ? 0 : 1),
        0
    );
    const range = preview.suggestedRange;
    const validRange = range !== null &&
        Number.isFinite(range?.minimum) &&
        Number.isFinite(range?.midpoint) &&
        Number.isFinite(range?.maximum) &&
        range.minimum < range.midpoint && range.midpoint < range.maximum;
    const rangeMatchesValues = finiteValueCount === 0
        ? range === null
        : validRange;
    const emptyWorkContainsValues =
        preview.actual.sourceBlockReadCount === 0 &&
        (finiteValueCount > 0 || range !== null);
    if (!rangeMatchesValues || emptyWorkContainsValues) {
        throw new Error("Detail-only preview color range is invalid");
    }
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
    const renderingContract = requireRasterDetailPreviewEnvelope(
        preview,
        request
    );
    requireRasterDetailPreviewLimits(preview.limits, renderingContract);
    requireRasterDetailPreviewWork(preview, request, renderingContract);
    requireRasterDetailPreviewPlacement(preview, request);
    requireRasterDetailPreviewRange(preview);
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
