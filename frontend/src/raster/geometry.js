/**
 * Canonical non-wrapping WGS 84 raster bounds.
 *
 * @typedef {Object} RasterSelectedBounds
 * @property {number} west Western longitude in degrees.
 * @property {number} south Southern latitude in degrees.
 * @property {number} east Eastern longitude in degrees.
 * @property {number} north Northern latitude in degrees.
 */

/** Default side length for the interactive raster sample window, in kilometers. */
export const DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM = 200;

/** Smallest supported raster sample-window side length, in kilometers. */
const MINIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM = 1;

/** Largest supported raster sample-window side length, in kilometers. */
const MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM = 300;

/** Guidance shown when a sample window cannot use the non-wrapping contract. */
export const RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE =
    "Move the sample window away from the pole or date line.";

/** Mean Earth radius used for spherical WGS 84 sample-window calculations. */
const WGS84_MEAN_RADIUS_KM = 6371.0088;

/** Identify a valid sample window that crosses an unsupported world boundary. */
export class RasterSampleWindowBoundaryError extends RangeError {}

/**
 * Build the stable validation error used for malformed selected bounds.
 *
 * @return {Error} User-safe selected-bounds contract error.
 */
function rasterSelectedBoundsContractError() {
    return new Error("Raster statistics returned invalid selected bounds.");
}

/**
 * Enforce the fixed user-facing sample-size contract.
 *
 * @param {number} sideLengthKm Requested square side length in kilometers.
 * @return {number} The validated side length.
 * @throws {RangeError} If the side length is nonintegral or outside 1-300 km.
 */
export function validateRasterSampleWindowSize(sideLengthKm) {
    if (
        !Number.isFinite(sideLengthKm) ||
        !Number.isInteger(sideLengthKm) ||
        sideLengthKm < MINIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM ||
        sideLengthKm > MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM
    ) {
        throw new RangeError(
            `Raster sample size must be between ` +
            `${MINIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM} and ` +
            `${MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM} kilometers.`
        );
    }
    return sideLengthKm;
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

/**
 * Return a destination reached along a spherical WGS 84 geodesic.
 *
 * @param {{longitude: number, latitude: number}} center Starting position.
 * @param {number} distanceKm Distance from the center in kilometers.
 * @param {number} bearingDegrees Clockwise bearing from north in degrees.
 * @return {{longitude: number, latitude: number}} Destination in WGS 84.
 */
function rasterSampleDestination(center, distanceKm, bearingDegrees) {
    const latitude = center.latitude * Math.PI / 180;
    const longitude = center.longitude * Math.PI / 180;
    const bearing = bearingDegrees * Math.PI / 180;
    const angularDistance = distanceKm / WGS84_MEAN_RADIUS_KM;
    const destinationLatitude = Math.asin(
        Math.sin(latitude) * Math.cos(angularDistance) +
        Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const longitudeOffset = Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
        Math.cos(angularDistance) -
            Math.sin(latitude) * Math.sin(destinationLatitude)
    );
    const unwrappedLongitude = longitude + longitudeOffset;
    const normalizedLongitude =
        ((unwrappedLongitude * 180 / Math.PI + 540) % 360) - 180;
    return {
        latitude: destinationLatitude * 180 / Math.PI,
        longitude: normalizedLongitude
    };
}

/**
 * Build an axis-aligned WGS 84 square whose ground dimensions approximate the
 * requested side length. A date-line or polar crossing is deliberately not
 * represented by the selected-bounds API contract.
 *
 * @param {{longitude: number, latitude: number}} center Window center.
 * @param {number} sideLengthKm Approximate ground side length in kilometers.
 * @return {RasterSelectedBounds} Canonical WGS 84 selected bounds.
 * @throws {RangeError} If the center or size violates the selection contract.
 * @throws {RasterSampleWindowBoundaryError} If the window crosses a pole or
 * date line.
 */
export function buildRasterSampleWindowBounds(center, sideLengthKm) {
    if (
        !Number.isFinite(center?.longitude) ||
        !Number.isFinite(center?.latitude) ||
        center.longitude < -180 || center.longitude > 180 ||
        center.latitude < -90 || center.latitude > 90
    ) {
        throw new RangeError("Raster sample center must be a WGS 84 position.");
    }
    validateRasterSampleWindowSize(sideLengthKm);

    const halfDiagonalKm = sideLengthKm / Math.sqrt(2);
    const halfDiagonalRadians = halfDiagonalKm / WGS84_MEAN_RADIUS_KM;
    if (
        Math.abs(center.latitude * Math.PI / 180) +
            halfDiagonalRadians >= Math.PI / 2
    ) {
        throw new RasterSampleWindowBoundaryError(
            RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE
        );
    }
    const corners = [315, 45, 135, 225].map((bearing) =>
        rasterSampleDestination(center, halfDiagonalKm, bearing)
    );
    const longitudes = corners.map((corner) => corner.longitude);
    const latitudes = corners.map((corner) => corner.latitude);
    if (Math.max(...longitudes) - Math.min(...longitudes) >= 180) {
        throw new RasterSampleWindowBoundaryError(
            RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE
        );
    }
    return validateRasterSelectedBounds({
        west: Math.min(...longitudes),
        south: Math.min(...latitudes),
        east: Math.max(...longitudes),
        north: Math.max(...latitudes)
    });
}
