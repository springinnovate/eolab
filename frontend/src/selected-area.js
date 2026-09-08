/** Immutable geographic selection values shared by sampling and downloads. No I/O. */
/**
 * Build the stable validation error used for malformed selected bounds.
 *
 * @return {Error} User-safe selected-bounds contract error.
 */
function rasterSelectedBoundsContractError() {
    return new Error("Raster statistics returned invalid selected bounds.");
}

/**
 * Validate one server-compatible WGS 84 statistics rectangle.
 *
 * @param {RasterSelectedBounds} bounds Candidate coordinate rectangle.
 * @return {RasterSelectedBounds} The validated non-wrapping WGS 84 bounds.
 * @throws {Error} If fields, ranges, or coordinate ordering are invalid.
 */
export function validateRasterSelectedBounds(bounds) {
    if (bounds === null || typeof bounds !== "object") {
        throw rasterSelectedBoundsContractError();
    }
    const fieldNames = ["west", "south", "east", "north"];
    if (
        Object.keys(bounds).length !== fieldNames.length ||
        !fieldNames.every((fieldName) => Object.hasOwn(bounds, fieldName))
    ) {
        throw rasterSelectedBoundsContractError();
    }
    const { west, south, east, north } = bounds;
    if (
        ![west, south, east, north].every(Number.isFinite) ||
        west < -180 || east > 180 || south < -90 || north > 90 ||
        !(west < east && south < north)
    ) {
        throw rasterSelectedBoundsContractError();
    }
    return bounds;
}

/** Immutable whole-raster member of the frontend sampling-area union. */
export const WHOLE_RASTER_SAMPLING_AREA = Object.freeze({
    kind: "wholeRaster"
});

/**
 * Normalize one strict raster-statistics sampling-area union.
 *
 * @param {Object} [samplingArea=WHOLE_RASTER_SAMPLING_AREA] Candidate whole,
 * selected-bounds, or temporary-AOI area.
 * @return {Readonly<Object>} Validated immutable sampling area.
 * @throws {TypeError} If the discriminator, owned field, or object shape is
 * invalid.
 */
export function normalizeRasterSamplingArea(
    samplingArea = WHOLE_RASTER_SAMPLING_AREA
) {
    if (samplingArea === null || typeof samplingArea !== "object") {
        throw new TypeError("Raster statistics sampling area is invalid.");
    }
    const keys = Object.keys(samplingArea).sort();
    if (
        samplingArea.kind === "wholeRaster" &&
        keys.length === 1 && keys[0] === "kind"
    ) {
        return WHOLE_RASTER_SAMPLING_AREA;
    }
    if (
        samplingArea.kind === "selectedArea" &&
        keys.length === 2 &&
        keys[0] === "kind" &&
        keys[1] === "selectedBounds"
    ) {
        return Object.freeze({
            kind: "selectedArea",
            selectedBounds: Object.freeze({
                ...validateRasterSelectedBounds(samplingArea.selectedBounds)
            })
        });
    }
    if (
        samplingArea.kind === "temporaryAoi" &&
        keys.length === 2 &&
        keys[0] === "kind" &&
        keys[1] === "temporaryAoiId" &&
        typeof samplingArea.temporaryAoiId === "string" &&
        /^[A-Za-z0-9_-]{32}$/.test(samplingArea.temporaryAoiId)
    ) {
        return Object.freeze({
            kind: "temporaryAoi",
            temporaryAoiId: samplingArea.temporaryAoiId
        });
    }
    throw new TypeError("Raster statistics sampling area is invalid.");
}
