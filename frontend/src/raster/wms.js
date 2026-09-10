/**
 * WMS protocol adapter for dynamic raster styling.
 *
 * This module serializes a validated raster style into GeoServer's ENV
 * parameter. It does not publish Catalog rasters, manage Leaflet layers, or
 * own style-editing state.
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
