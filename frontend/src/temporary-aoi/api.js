/**
 * Same-origin HTTP client and browser-response contracts for temporary AOIs.
 *
 * Uploads remain independent from Catalog scanning and raster publication. The
 * browser accepts only bounded WGS 84 GeoJSON and opaque server identifiers at
 * this network boundary before any response reaches Leaflet or UI state.
 */

const MAX_BROWSER_FEATURES = 10_000;
const MAX_BROWSER_POSITIONS = 100_000;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_DISPLAY_TEXT_LENGTH = 1_024;

/**
 * @typedef {Object} TemporaryAoiUploadProgress
 * @property {number} loadedBytes Approximate file bytes transferred.
 * @property {number} totalBytes Selected file size in bytes.
 * @property {boolean} uploadComplete Whether the request body reached the server.
 */

/**
 * @callback TemporaryAoiUploadProgressHandler
 * @param {TemporaryAoiUploadProgress} progress Current transfer progress.
 * @return {void}
 */

/**
 * Create the browser request used for observable multipart upload progress.
 *
 * @return {XMLHttpRequest} Fresh same-origin upload request.
 * @throws {Error} If the browser lacks XMLHttpRequest support.
 */
function createBrowserUploadRequest() {
    if (typeof globalThis.XMLHttpRequest !== "function") {
        throw new Error("Observable browser uploads are not supported.");
    }
    return new globalThis.XMLHttpRequest();
}

/** HTTP failure carrying the temporary-AOI response status for lifecycle UI. */
export class TemporaryAoiHttpError extends Error {
    /**
     * Create a user-safe HTTP failure.
     *
     * @param {string} message User-facing failure detail.
     * @param {number} status HTTP response status.
     */
    constructor(message, status) {
        super(message);
        this.name = "TemporaryAoiHttpError";
        this.status = status;
    }
}

/**
 * Convert one failed API response to a safe user-facing error.
 *
 * @param {Response} response Failed temporary-AOI response.
 * @param {string} action User-facing action that failed.
 * @return {Promise<Error>} Structured FastAPI detail or a status fallback.
 */
async function temporaryAoiRequestError(response, action) {
    const fallbackMessage = `${action} failed (${response.status}).`;
    if (!response.headers.get("content-type")?.toLowerCase().includes(
        "application/json"
    )) {
        return new TemporaryAoiHttpError(fallbackMessage, response.status);
    }
    try {
        const errorDocument = await response.json();
        return new TemporaryAoiHttpError(
            typeof errorDocument.detail === "string" &&
                errorDocument.detail.trim() !== ""
                ? errorDocument.detail
                : fallbackMessage,
            response.status
        );
    } catch {
        return new TemporaryAoiHttpError(fallbackMessage, response.status);
    }
}

/**
 * Convert one failed XMLHttpRequest upload to a safe user-facing error.
 *
 * @param {XMLHttpRequest} request Completed failed upload request.
 * @param {string} action User-facing action that failed.
 * @return {Error} Structured service detail or a status fallback.
 */
function temporaryAoiUploadRequestError(request, action) {
    const fallbackMessage = `${action} failed (${request.status}).`;
    const contentType = request.getResponseHeader("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
        return new TemporaryAoiHttpError(fallbackMessage, request.status);
    }
    try {
        const errorDocument = JSON.parse(request.responseText);
        return new TemporaryAoiHttpError(
            typeof errorDocument.detail === "string" &&
                errorDocument.detail.trim() !== ""
                ? errorDocument.detail
                : fallbackMessage,
            request.status
        );
    } catch {
        return new TemporaryAoiHttpError(fallbackMessage, request.status);
    }
}

/**
 * Validate an opaque identifier without assigning meaning to its contents.
 *
 * @param {unknown} value Candidate server-generated identifier.
 * @param {string} name Contract name used in validation errors.
 * @return {string} Validated opaque identifier.
 * @throws {TypeError} If the value is not a bounded non-empty string.
 */
function validateOpaqueIdentifier(value, name) {
    if (
        typeof value !== "string" ||
        value.trim() === "" ||
        value.length > MAX_IDENTIFIER_LENGTH
    ) {
        throw new TypeError(`${name} must be a bounded non-empty string.`);
    }
    return value;
}

/**
 * Validate display-only text returned by the temporary-AOI service.
 *
 * @param {unknown} value Candidate filename or dataset label.
 * @param {string} name Contract name used in validation errors.
 * @return {string} Validated display text.
 * @throws {TypeError} If the value is not a bounded non-empty string.
 */
function validateDisplayText(value, name) {
    if (
        typeof value !== "string" ||
        value.trim() === "" ||
        value.length > MAX_DISPLAY_TEXT_LENGTH
    ) {
        throw new TypeError(`${name} must be a bounded non-empty string.`);
    }
    return value;
}

/**
 * Validate one canonical WGS 84 GeoJSON position and update its count.
 *
 * @param {unknown} position Candidate GeoJSON coordinate array.
 * @param {{count: number}} counter Shared browser-position counter.
 * @return {void}
 * @throws {TypeError|RangeError} If coordinates are malformed or unbounded.
 */
function validatePosition(position, counter) {
    if (
        !Array.isArray(position) ||
        position.length < 2 ||
        position.length > 3 ||
        !position.every(Number.isFinite)
    ) {
        throw new TypeError("Temporary AOI positions must contain finite coordinates.");
    }
    const [longitude, latitude] = position;
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
        throw new RangeError("Temporary AOI coordinates must use canonical WGS 84 bounds.");
    }
    counter.count += 1;
    if (counter.count > MAX_BROWSER_POSITIONS) {
        throw new RangeError("Temporary AOI geometry is too detailed for the browser.");
    }
}

/**
 * Recursively validate coordinate nesting for one GeoJSON geometry type.
 *
 * @param {unknown} coordinates Candidate coordinate structure.
 * @param {number} nestingDepth Number of array levels above each position.
 * @param {{count: number}} counter Shared browser-position counter.
 * @return {void}
 * @throws {TypeError|RangeError} If coordinate nesting is malformed or empty.
 */
function validateCoordinates(coordinates, nestingDepth, counter) {
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
        throw new TypeError("Temporary AOI coordinate arrays must not be empty.");
    }
    if (nestingDepth === 0) {
        validatePosition(coordinates, counter);
        return;
    }
    for (const childCoordinates of coordinates) {
        validateCoordinates(childCoordinates, nestingDepth - 1, counter);
    }
}

/**
 * Validate one GeoJSON geometry accepted by the temporary-AOI overlay.
 *
 * @param {unknown} geometry Candidate GeoJSON geometry.
 * @param {{count: number}} counter Shared browser-position counter.
 * @return {void}
 * @throws {TypeError|RangeError} If the geometry violates the browser contract.
 */
function validateGeometry(geometry, counter) {
    if (geometry === null || typeof geometry !== "object" || Array.isArray(geometry)) {
        throw new TypeError("Temporary AOI features require a GeoJSON geometry.");
    }
    const nestingDepthByType = new Map([
        ["Point", 0],
        ["MultiPoint", 1],
        ["LineString", 1],
        ["MultiLineString", 2],
        ["Polygon", 2],
        ["MultiPolygon", 3],
    ]);
    if (geometry.type === "GeometryCollection") {
        if (!Array.isArray(geometry.geometries) || geometry.geometries.length === 0) {
            throw new TypeError("Temporary AOI geometry collections must not be empty.");
        }
        for (const childGeometry of geometry.geometries) {
            validateGeometry(childGeometry, counter);
        }
        return;
    }
    const nestingDepth = nestingDepthByType.get(geometry.type);
    if (nestingDepth === undefined) {
        throw new TypeError("Temporary AOI contains an unsupported geometry type.");
    }
    validateCoordinates(geometry.coordinates, nestingDepth, counter);
}

/**
 * Validate the bounded FeatureCollection returned for browser rendering.
 *
 * @param {unknown} geometry Candidate GeoJSON FeatureCollection.
 * @return {Object} Validated FeatureCollection.
 * @throws {TypeError|RangeError} If features or coordinates violate limits.
 */
export function validateTemporaryAoiGeometry(geometry) {
    if (
        geometry === null ||
        typeof geometry !== "object" ||
        Array.isArray(geometry) ||
        geometry.type !== "FeatureCollection" ||
        !Array.isArray(geometry.features)
    ) {
        throw new TypeError("Temporary AOI geometry must be a FeatureCollection.");
    }
    if (geometry.features.length === 0) {
        throw new TypeError("Temporary AOI geometry must contain a feature.");
    }
    if (geometry.features.length > MAX_BROWSER_FEATURES) {
        throw new RangeError("Temporary AOI contains too many browser features.");
    }
    const counter = { count: 0 };
    for (const feature of geometry.features) {
        if (
            feature === null ||
            typeof feature !== "object" ||
            Array.isArray(feature) ||
            feature.type !== "Feature"
        ) {
            throw new TypeError("Temporary AOI contains an invalid GeoJSON feature.");
        }
        validateGeometry(feature.geometry, counter);
    }
    return geometry;
}

/**
 * Validate canonical WGS 84 bounds returned by the temporary-AOI service.
 *
 * @param {unknown} bbox Candidate west, south, east, north bounds.
 * @return {number[]} Validated bounding box.
 * @throws {TypeError|RangeError} If bounds are malformed or noncanonical.
 */
export function validateTemporaryAoiBounds(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) {
        throw new TypeError("Temporary AOI bounds must contain four finite numbers.");
    }
    const [west, south, east, north] = bbox;
    if (
        west < -180 || east > 180 || south < -90 || north > 90 ||
        west > east || south > north
    ) {
        throw new RangeError("Temporary AOI bounds must use canonical WGS 84 ordering.");
    }
    return bbox;
}

/**
 * Validate one ready temporary-AOI response.
 *
 * @param {unknown} document Candidate ready response document.
 * @return {Object} Validated ready response.
 * @throws {TypeError|RangeError} If the response violates the API contract.
 */
function validateReadyTemporaryAoi(document) {
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
        throw new TypeError("Temporary AOI response must be an object.");
    }
    if (document.state !== "ready") {
        throw new TypeError("Temporary AOI response has an unknown state.");
    }
    validateOpaqueIdentifier(document.id, "Temporary AOI identifier");
    validateDisplayText(document.filename, "Temporary AOI filename");
    validateDisplayText(document.selectedDataset, "Temporary AOI dataset");
    validateExpiration(document.expiresAt);
    validateTemporaryAoiBounds(document.bbox);
    validateTemporaryAoiGeometry(document.geometry);
    return document;
}

/**
 * Validate an ISO expiration instant returned by the service.
 *
 * @param {unknown} value Candidate expiration text.
 * @return {string} Validated expiration text.
 * @throws {TypeError} If the value is not a parseable timestamp.
 */
function validateExpiration(value) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
        throw new TypeError("Temporary AOI expiration must be an ISO timestamp.");
    }
    return value;
}

/**
 * Validate one dataset-selection response.
 *
 * @param {unknown} document Candidate selection-required response document.
 * @return {Object} Validated selection-required response.
 * @throws {TypeError} If the response violates the API contract.
 */
function validateSelectionRequiredTemporaryAoi(document) {
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
        throw new TypeError("Temporary AOI response must be an object.");
    }
    if (document.state !== "selectionRequired") {
        throw new TypeError("Temporary AOI response has an unknown state.");
    }
    validateOpaqueIdentifier(document.id, "Temporary AOI identifier");
    validateDisplayText(document.filename, "Temporary AOI filename");
    validateExpiration(document.expiresAt);
    if (!Array.isArray(document.choices) || document.choices.length < 2) {
        throw new TypeError("Temporary AOI selection requires at least two choices.");
    }
    const choiceIdentifiers = new Set();
    for (const choice of document.choices) {
        if (choice === null || typeof choice !== "object" || Array.isArray(choice)) {
            throw new TypeError("Temporary AOI dataset choices must be objects.");
        }
        const choiceIdentifier = validateOpaqueIdentifier(
            choice.id,
            "Temporary AOI choice identifier"
        );
        validateDisplayText(choice.label, "Temporary AOI choice label");
        if (choiceIdentifiers.has(choiceIdentifier)) {
            throw new TypeError("Temporary AOI choice identifiers must be unique.");
        }
        choiceIdentifiers.add(choiceIdentifier);
    }
    return document;
}

/**
 * Validate either successful upload response state.
 *
 * @param {unknown} document Candidate upload response document.
 * @return {Object} Validated ready or selection-required response.
 * @throws {TypeError|RangeError} If the response violates the API contract.
 */
export function validateTemporaryAoiUploadResponse(document) {
    if (document?.state === "ready") {
        return validateReadyTemporaryAoi(document);
    }
    return validateSelectionRequiredTemporaryAoi(document);
}

/** Client for the bounded, same-origin temporary-AOI lifecycle API. */
export class TemporaryAoiApiClient {
    /**
     * Create a temporary-AOI API client.
     *
     * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
     * Browser fetch implementation.
     * @param {(() => XMLHttpRequest)|null} [uploadRequestFactory] Optional
     * observable upload-request factory; browsers use XMLHttpRequest by default.
     * @throws {TypeError} If the observable upload factory is not callable.
     */
    constructor(
        fetchImplementation = globalThis.fetch,
        uploadRequestFactory = (
            typeof globalThis.XMLHttpRequest === "function"
                ? createBrowserUploadRequest
                : null
        )
    ) {
        if (
            uploadRequestFactory !== null &&
            typeof uploadRequestFactory !== "function"
        ) {
            throw new TypeError("Temporary AOI upload request factory is invalid.");
        }
        this.fetchImplementation = fetchImplementation;
        this.uploadRequestFactory = uploadRequestFactory;
    }

    /**
     * Upload one GeoPackage or zipped Shapefile, optionally replacing an AOI.
     *
     * @param {File|Blob} file User-selected bounded multipart file.
     * @param {string|null} [replacementId=null] Opaque current AOI identifier.
     * @param {TemporaryAoiUploadProgressHandler} [onProgress=() => {}]
     * Receives observable file-byte transfer progress.
     * @return {Promise<Object>} Ready or selection-required upload response.
     * @throws {Error} If the request fails or the response is invalid.
     */
    async upload(file, replacementId = null, onProgress = () => {}) {
        if (!(file instanceof Blob)) {
            throw new TypeError("Temporary AOI upload requires a file.");
        }
        if (typeof onProgress !== "function") {
            throw new TypeError("Temporary AOI upload progress handler is invalid.");
        }
        const formData = new FormData();
        formData.append("file", file, file.name ?? "temporary-aoi-upload");
        if (replacementId !== null) {
            formData.append(
                "replacementId",
                validateOpaqueIdentifier(replacementId, "Replacement identifier")
            );
        }
        if (this.uploadRequestFactory !== null) {
            return this.uploadWithObservableProgress(
                file,
                formData,
                onProgress
            );
        }
        return this.uploadWithFetchFallback(file, formData, onProgress);
    }

    /**
     * Upload with XMLHttpRequest so file-byte transfer progress is observable.
     *
     * @param {File|Blob} file Selected bounded upload.
     * @param {FormData} formData Strict multipart request body.
     * @param {TemporaryAoiUploadProgressHandler} onProgress Progress receiver.
     * @return {Promise<Object>} Ready or selection-required upload response.
     * @throws {Error} If transport, HTTP, JSON, or response validation fails.
     */
    uploadWithObservableProgress(file, formData, onProgress) {
        const request = this.uploadRequestFactory();
        return new Promise((resolve, reject) => {
            request.open("POST", "/api/temporary-aois");
            request.setRequestHeader("Accept", "application/json");
            onProgress({
                loadedBytes: 0,
                totalBytes: file.size,
                uploadComplete: false,
            });
            request.upload.addEventListener("progress", (event) => {
                const transferFraction = event.lengthComputable && event.total > 0
                    ? Math.min(1, event.loaded / event.total)
                    : 0;
                onProgress({
                    loadedBytes: Math.round(file.size * transferFraction),
                    totalBytes: file.size,
                    uploadComplete: false,
                });
            });
            request.upload.addEventListener("load", () => {
                onProgress({
                    loadedBytes: file.size,
                    totalBytes: file.size,
                    uploadComplete: true,
                });
            });
            request.addEventListener("load", () => {
                if (request.status < 200 || request.status >= 300) {
                    reject(temporaryAoiUploadRequestError(
                        request,
                        "Temporary AOI upload"
                    ));
                    return;
                }
                try {
                    resolve(validateTemporaryAoiUploadResponse(
                        JSON.parse(request.responseText)
                    ));
                } catch (error) {
                    reject(error);
                }
            });
            request.addEventListener("error", () => {
                reject(new TemporaryAoiHttpError(
                    "Temporary AOI upload failed because the network request was interrupted.",
                    0
                ));
            });
            request.addEventListener("abort", () => {
                reject(new TemporaryAoiHttpError(
                    "Temporary AOI upload was canceled.",
                    0
                ));
            });
            request.send(formData);
        });
    }

    /**
     * Preserve upload support when XMLHttpRequest is unavailable.
     *
     * Fetch cannot expose request-body bytes, so this fallback reports only
     * start and server-processing boundaries while retaining response parity.
     *
     * @param {File|Blob} file Selected bounded upload.
     * @param {FormData} formData Strict multipart request body.
     * @param {TemporaryAoiUploadProgressHandler} onProgress Progress receiver.
     * @return {Promise<Object>} Ready or selection-required upload response.
     * @throws {Error} If the request fails or the response is invalid.
     */
    async uploadWithFetchFallback(file, formData, onProgress) {
        onProgress({
            loadedBytes: 0,
            totalBytes: file.size,
            uploadComplete: false,
        });
        const response = await this.fetchImplementation.call(
            globalThis,
            "/api/temporary-aois",
            {
                method: "POST",
                headers: { Accept: "application/json" },
                body: formData,
            }
        );
        onProgress({
            loadedBytes: file.size,
            totalBytes: file.size,
            uploadComplete: true,
        });
        if (!response.ok) {
            throw await temporaryAoiRequestError(response, "Temporary AOI upload");
        }
        return validateTemporaryAoiUploadResponse(await response.json());
    }

    /**
     * Select one usable dataset from a previously uploaded container.
     *
     * @param {string} temporaryAoiId Opaque pending AOI identifier.
     * @param {string} choiceId Opaque server-issued dataset choice identifier.
     * @return {Promise<Object>} Validated ready temporary AOI.
     * @throws {Error} If selection fails or the response is invalid.
     */
    async selectDataset(temporaryAoiId, choiceId) {
        const validatedAoiId = validateOpaqueIdentifier(
            temporaryAoiId,
            "Temporary AOI identifier"
        );
        const response = await this.fetchImplementation.call(
            globalThis,
            `/api/temporary-aois/${encodeURIComponent(validatedAoiId)}/selection`,
            {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    choiceId: validateOpaqueIdentifier(
                        choiceId,
                        "Temporary AOI choice identifier"
                    ),
                }),
            }
        );
        if (!response.ok) {
            throw await temporaryAoiRequestError(response, "Dataset selection");
        }
        return validateReadyTemporaryAoi(await response.json());
    }

    /**
     * Remove one ready or pending temporary AOI from server storage.
     *
     * @param {string} temporaryAoiId Opaque AOI identifier to remove.
     * @return {Promise<void>} Resolves after successful or already-expired removal.
     * @throws {Error} If the service cannot complete removal.
     */
    async remove(temporaryAoiId) {
        const validatedAoiId = validateOpaqueIdentifier(
            temporaryAoiId,
            "Temporary AOI identifier"
        );
        const response = await this.fetchImplementation.call(
            globalThis,
            `/api/temporary-aois/${encodeURIComponent(validatedAoiId)}`,
            {
                method: "DELETE",
                headers: { Accept: "application/json" },
            }
        );
        if (!response.ok && response.status !== 404 && response.status !== 410) {
            throw await temporaryAoiRequestError(response, "Temporary AOI removal");
        }
    }
}
