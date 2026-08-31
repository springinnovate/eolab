/** Bounded WMS feature-information requests for published vector layers. */

export const VECTOR_FEATURE_INFO_LIMIT = 5;
export const VECTOR_FEATURE_INFO_BUFFER_PIXELS = 8;
const MAX_WMS_VIEWPORT_EDGE = 2048;

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
 * The request describes the current EPSG:4326 viewport, reducing dimensions
 * and the click coordinate together when a large display exceeds the public
 * WMS edge limit. WMS 1.1.1 keeps longitude/latitude axis order and causes
 * GeoServer's default feature-info reprojection to return Leaflet-ready GeoJSON.
 *
 * @param {Object} configuration Request configuration.
 * @param {string} configuration.wmsUrl Restricted browser WMS endpoint.
 * @param {Object} configuration.leafletMap Initialized Leaflet map.
 * @param {Object} configuration.publication Published vector identity.
 * @param {{x:number,y:number}} configuration.containerPoint Click position.
 * @return {string} Relative or absolute bounded WMS URL.
 */
export function buildVectorFeatureInfoUrl({
    wmsUrl,
    leafletMap,
    publication,
    containerPoint,
}) {
    const size = leafletMap.getSize();
    if (
        !Number.isFinite(size?.x) || !Number.isFinite(size?.y) ||
        size.x <= 0 || size.y <= 0 ||
        !Number.isFinite(containerPoint?.x) ||
        !Number.isFinite(containerPoint?.y)
    ) {
        throw new VectorFeatureInfoError(
            "The map viewport is unavailable for feature inspection."
        );
    }
    const scale = Math.min(
        1,
        MAX_WMS_VIEWPORT_EDGE / size.x,
        MAX_WMS_VIEWPORT_EDGE / size.y
    );
    const width = Math.max(1, Math.round(size.x * scale));
    const height = Math.max(1, Math.round(size.y * scale));
    const i = Math.min(width - 1, Math.max(0, Math.round(containerPoint.x * scale)));
    const j = Math.min(height - 1, Math.max(0, Math.round(containerPoint.y * scale)));
    const bounds = leafletMap.getBounds();
    const southwest = bounds.getSouthWest();
    const northeast = bounds.getNorthEast();
    const bbox = [southwest.lng, southwest.lat, northeast.lng, northeast.lat];
    if (!bbox.every(Number.isFinite)) {
        throw new VectorFeatureInfoError(
            "The map bounds are unavailable for feature inspection."
        );
    }
    const parameters = new URLSearchParams({
        service: "WMS",
        version: "1.1.1",
        request: "GetFeatureInfo",
        layers: publication.layerName,
        query_layers: publication.layerName,
        styles: publication.styleName,
        srs: "EPSG:4326",
        bbox: bbox.join(","),
        width: String(width),
        height: String(height),
        format: "image/png",
        info_format: "application/json",
        x: String(i),
        y: String(j),
        feature_count: String(VECTOR_FEATURE_INFO_LIMIT),
        buffer: String(VECTOR_FEATURE_INFO_BUFFER_PIXELS),
    });
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
