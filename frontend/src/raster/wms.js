/**
 * WMS protocol adapter for dynamic raster styling.
 *
 * This module serializes continuous styles into GeoServer's ENV parameter and
 * categorical styles into the application WMS raster_style parameter. It does
 * not publish Catalog rasters, manage Leaflet layers, or own style-editing state.
 */
import { validateRasterStyle } from "./style.js";
import { normalizeCategoricalRasterStyle } from "./categorical-style.js";

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
 * Build the application WMS raster_style parameter for categorical appearance.
 *
 * The caller passes this JSON as one query-parameter value; URL encoding belongs
 * to the request transport. The existing continuous ENV parameter is separate.
 *
 * @param {unknown} style Candidate categorical style.
 * @return {string} Bounded canonical JSON preserving category table order.
 * @throws {Error} If the candidate violates the categorical style contract.
 */
export function buildCategoricalRasterStyleParameter(style) {
    return JSON.stringify(normalizeCategoricalRasterStyle(style));
}
