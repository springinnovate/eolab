/** Browser-safe display helpers for scanner-owned raster values and names. */

/**
 * Read the display basename from a scanner-owned GeoTIFF Asset URL.
 *
 * @param {Object} item Selected mounted GeoTIFF STAC Item.
 * @return {string} Decoded raster filename, including its extension.
 * @throws {TypeError} If the scanner-owned Asset URL is invalid.
 */
export function getCatalogRasterBasename(item) {
    const pathname = new URL(item.assets.data.href).pathname;
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
}

/**
 * Format one finite raster value in scientific notation.
 *
 * @param {number} value Sampled raster value.
 * @return {string} Value with four significant digits, or zero.
 * @throws {TypeError} If value is not finite.
 */
export function formatRasterPixelValue(value) {
    if (!Number.isFinite(value)) {
        throw new TypeError("Raster point value must be finite");
    }
    return value === 0 ? "0" : value.toExponential(3);
}
