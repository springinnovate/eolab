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
 * @return {string} Gradient assignments and optional exact and range overrides.
 * Each range carries lower bound, upper bound, color and opacity in display order.
 * An empty bound leaves that side open.
 * @throws {Error} If a gradient stop, override bounds, color or opacity is invalid.
 */
export function buildRasterStyleEnvironment(style) {
    validateRasterStyle(style);
    const fields = [
        `min:${style.minimum}`,
        `med:${style.midpoint}`,
        `max:${style.maximum}`,
        `cmin:${style.minimumColor.toLowerCase()}`,
        `cmed:${style.midpointColor.toLowerCase()}`,
        `cmax:${style.maximumColor.toLowerCase()}`,
        `amin:${style.minimumOpacity ?? 1}`,
        `amed:${style.midpointOpacity ?? 1}`,
        `amax:${style.maximumOpacity ?? 1}`
    ];
    if (style.valueOverride) {
        const { value, color, opacity } = style.valueOverride;
        fields.push(`vexact:${value}`, `cexact:${color.toLowerCase()}`, `aexact:${opacity}`);
    }
    if (style.rangeOverrides) {
        const ranges = style.rangeOverrides.map(({minimum, maximum, color, opacity}) =>
            [minimum, maximum, color.toLowerCase(), opacity].join(","));
        fields.push(`ranges:${ranges.join("|")}`);
    }
    return fields.join(";");
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
