/**
 * WMS protocol adapter for dynamic raster styling and service readiness.
 *
 * This module serializes a validated raster style into GeoServer's ENV
 * parameter and validates GetCapabilities responses. It does not publish
 * Catalog rasters, manage Leaflet layers, or own style-editing state.
 */
import { validateRasterStyle } from "./style.js";

/**
 * Build GeoServer's dynamic-SLD environment from a valid raster style.
 *
 * @param {import("./style.js").RasterStyle} style Numeric thresholds and
 * six-digit hex colors.
 * @return {string} Canonical nine-assignment WMS environment value.
 * @throws {Error} If thresholds or colors violate the style contract.
 */
export function buildRasterStyleEnvironment(style) {
    validateRasterStyle(style);
    return [
        `min:${style.minimum}`,
        `med:${style.midpoint}`,
        `max:${style.maximum}`,
        `cmin:${style.minimumColor.toLowerCase()}`,
        `cmed:${style.midpointColor.toLowerCase()}`,
        `cmax:${style.maximumColor.toLowerCase()}`,
        `amin:${style.minimumOpacity ?? 1}`,
        `amed:${style.midpointOpacity ?? 1}`,
        `amax:${style.maximumOpacity ?? 1}`
    ].join(";");
}

/**
 * Request and validate the public WMS capabilities document.
 *
 * @param {string} wmsUrl Browser-facing WMS endpoint.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Fetch implementation used by the browser.
 * @return {Promise<string>} URL of the validated capabilities document.
 * @throws {Error} If WMS is unavailable or returns a different document.
 */
export async function loadWmsCapabilities(
    wmsUrl,
    fetchImplementation = globalThis.fetch
) {
    const query = new URLSearchParams({
        service: "WMS",
        version: "1.3.0",
        request: "GetCapabilities"
    });
    const capabilitiesUrl = `${wmsUrl}${wmsUrl.includes("?") ? "&" : "?"}${query}`;
    const response = await fetchImplementation.call(globalThis, capabilitiesUrl, {
        headers: { Accept: "application/xml" }
    });
    if (!response.ok) {
        throw new Error(`WMS GetCapabilities returned ${response.status}`);
    }

    const capabilitiesDocument = await response.text();
    if (
        !capabilitiesDocument.includes("<WMS_Capabilities") &&
        !capabilitiesDocument.includes("<WMT_MS_Capabilities")
    ) {
        throw new Error("WMS GetCapabilities returned an unexpected document");
    }
    return capabilitiesUrl;
}
