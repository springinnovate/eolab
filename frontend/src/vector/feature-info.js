/** Bounded WMS feature-information requests for published vector layers. */

export const VECTOR_FEATURE_INFO_LIMIT = 5;
export const VECTOR_FEATURE_INFO_BUFFER_PIXELS = 8;
const MAX_WMS_VIEWPORT_EDGE = 2048;

/**
 * @typedef {Object} VectorFeatureInfoViewport
 * @property {number[]} bbox WGS 84 west, south, east, north bounds.
 * @property {number} width Browser viewport width in pixels.
 * @property {number} height Browser viewport height in pixels.
 * @property {number} x Horizontal click coordinate in viewport pixels.
 * @property {number} y Vertical click coordinate in viewport pixels.
 */

/** Browser-safe vector inspection failure. */
export class VectorFeatureInfoError extends Error {
    /** @param {string} message User-facing failure detail. */
    constructor(message) {
        super(message);
        this.name = "VectorFeatureInfoError";
    }
}

/**
 * Build a bounded GetFeatureInfo URL for one map click and vector publication.
 *
 * The request describes a neutral EPSG:4326 viewport, reducing dimensions and
 * the click coordinate together when a large display exceeds the public WMS
 * edge limit. WMS 1.1.1 keeps longitude/latitude axis order.
 *
 * @param {Object} configuration Request configuration.
 * @param {string} configuration.wmsUrl Restricted browser WMS endpoint.
 * @param {Object} configuration.publication Published vector identity.
 * @param {string[]} configuration.propertyNames Catalog-declared non-geometry
 * properties to return without materializing full feature geometry.
 * @param {VectorFeatureInfoViewport} configuration.viewport Neutral map view.
 * @return {string} Relative or absolute bounded WMS URL.
 */
export function buildVectorFeatureInfoUrl({
    wmsUrl,
    publication,
    propertyNames,
    viewport,
}) {
    if (
        !Number.isFinite(viewport?.width) ||
        !Number.isFinite(viewport?.height) ||
        viewport.width <= 0 || viewport.height <= 0 ||
        !Number.isFinite(viewport?.x) ||
        !Number.isFinite(viewport?.y) ||
        !Array.isArray(viewport?.bbox) || viewport.bbox.length !== 4 ||
        !viewport.bbox.every(Number.isFinite)
    ) {
        throw new VectorFeatureInfoError(
            "The map viewport is unavailable for feature inspection."
        );
    }
    if (
        !Array.isArray(propertyNames) ||
        !propertyNames.every((name) =>
            typeof name === "string" && name.length > 0
        )
    ) {
        throw new VectorFeatureInfoError(
            "The layer attributes are unavailable for feature inspection."
        );
    }
    const scale = Math.min(
        1,
        MAX_WMS_VIEWPORT_EDGE / viewport.width,
        MAX_WMS_VIEWPORT_EDGE / viewport.height
    );
    const width = Math.max(1, Math.round(viewport.width * scale));
    const height = Math.max(1, Math.round(viewport.height * scale));
    const i = Math.min(width - 1, Math.max(0, Math.round(viewport.x * scale)));
    const j = Math.min(height - 1, Math.max(0, Math.round(viewport.y * scale)));
    const parameters = new URLSearchParams({
        service: "WMS",
        version: "1.1.1",
        request: "GetFeatureInfo",
        layers: publication.layerName,
        query_layers: publication.layerName,
        styles: publication.styleName,
        srs: "EPSG:4326",
        bbox: viewport.bbox.join(","),
        width: String(width),
        height: String(height),
        format: "image/png",
        info_format: "application/json",
        x: String(i),
        y: String(j),
        feature_count: String(VECTOR_FEATURE_INFO_LIMIT),
        buffer: String(VECTOR_FEATURE_INFO_BUFFER_PIXELS),
    });
    if (propertyNames.length > 0) {
        parameters.set("propertyName", propertyNames.join(","));
    }
    return `${wmsUrl}${wmsUrl.includes("?") ? "&" : "?"}${parameters}`;
}

/**
 * Retrieve and validate one bounded GeoJSON FeatureCollection.
 *
 * @param {Object} configuration Request configuration accepted by the URL builder.
 * @param {AbortSignal} configuration.signal Cancellation signal.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP implementation.
 * @return {Promise<Object[]>} Valid GeoJSON Features, capped by the request limit.
 * @throws {VectorFeatureInfoError} If the public response is unavailable or invalid.
 */
export async function fetchVectorFeatureInfo(
    configuration,
    fetchImplementation = globalThis.fetch
) {
    let response;
    try {
        response = await fetchImplementation(
            buildVectorFeatureInfoUrl(configuration),
            {
                headers: { Accept: "application/json" },
                signal: configuration.signal,
            }
        );
    } catch (error) {
        if (error?.name === "AbortError") {
            throw error;
        }
        throw new VectorFeatureInfoError(
            "Feature inspection could not reach the application."
        );
    }
    if (!response.ok) {
        let detail = null;
        try {
            detail = (await response.json())?.detail ?? null;
        } catch {
            detail = null;
        }
        throw new VectorFeatureInfoError(
            typeof detail === "string" && detail.length > 0
                ? detail
                : `Feature inspection returned ${response.status}.`
        );
    }
    let document;
    try {
        document = await response.json();
    } catch {
        throw new VectorFeatureInfoError(
            "Feature inspection returned an invalid response."
        );
    }
    if (
        document?.type !== "FeatureCollection" ||
        !Array.isArray(document.features) ||
        document.features.length > VECTOR_FEATURE_INFO_LIMIT ||
        !document.features.every((feature) =>
            feature?.type === "Feature" &&
            (feature.geometry === null || typeof feature.geometry === "object") &&
            feature.properties !== null &&
            typeof feature.properties === "object" &&
            !Array.isArray(feature.properties)
        )
    ) {
        throw new VectorFeatureInfoError(
            "Feature inspection returned an invalid feature collection."
        );
    }
    return document.features;
}
