/** Color bounded numeric raster previews through the shared raster style. */

import {
    DEFAULT_RASTER_STYLE,
    getRasterStyleColor,
    getRasterStyleOpacity,
    validateRasterStyle
} from "./style.js";

/**
 * Build the normal default palette with preview-derived numeric thresholds.
 *
 * @param {Object} preview Validated bounded numeric preview.
 * @return {import("./style.js").RasterStyle} Strict shared raster style.
 * @throws {Error} If the suggested numeric thresholds are not a valid style.
 */
export function buildRasterDetailPreviewStyle(preview) {
    return validateRasterStyle({
        ...DEFAULT_RASTER_STYLE,
        ...(preview.suggestedRange ?? {})
    });
}

/**
 * Parse a validated six-digit raster color into byte channels.
 *
 * @param {string} color Validated six-digit hexadecimal color.
 * @return {number[]} Red, green, and blue bytes.
 */
function rasterColorChannels(color) {
    const encoded = Number.parseInt(color.slice(1), 16);
    return [encoded >> 16, (encoded >> 8) & 0xff, encoded & 0xff];
}

/**
 * Color one validated row-major numeric preview into transparent RGBA bytes.
 *
 * @param {Object} preview Validated bounded numeric preview.
 * @param {import("./style.js").RasterStyle} style Validated raster style.
 * @return {Uint8ClampedArray} Row-major RGBA bytes; nodata has zero alpha.
 * @throws {Error} If the shared raster style is invalid.
 */
export function buildRasterDetailPreviewRgba(preview, style) {
    validateRasterStyle(style);
    const rgba = new Uint8ClampedArray(preview.pixelValues.length * 4);
    for (const [index, value] of preview.pixelValues.entries()) {
        if (value === null) {
            continue;
        }
        const channels = rasterColorChannels(
            getRasterStyleColor(style, value)
        );
        const offset = index * 4;
        rgba[offset] = channels[0];
        rgba[offset + 1] = channels[1];
        rgba[offset + 2] = channels[2];
        rgba[offset + 3] = Math.round(getRasterStyleOpacity(style, value) * 255);
    }
    return rgba;
}

/**
 * Encode one colored numeric preview as a browser-local PNG data URL.
 *
 * @param {Object} preview Validated bounded numeric preview.
 * @param {import("./style.js").RasterStyle} style Validated raster style.
 * @param {Document} [documentContext=globalThis.document] Canvas owner.
 * @return {string} PNG data URL suitable for a Leaflet image overlay.
 * @throws {Error} If the style or two-dimensional canvas is unavailable, or
 * if the browser cannot encode the bounded image.
 */
export function encodeRasterDetailPreviewPng(
    preview,
    style,
    documentContext = globalThis.document
) {
    const canvas = documentContext.createElement("canvas");
    canvas.width = preview.imageWidth;
    canvas.height = preview.imageHeight;
    const context = canvas.getContext("2d");
    if (context === null) {
        throw new Error("Sampled raster preview canvas is unavailable");
    }
    const image = context.createImageData(
        preview.imageWidth,
        preview.imageHeight
    );
    image.data.set(buildRasterDetailPreviewRgba(preview, style));
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
}
