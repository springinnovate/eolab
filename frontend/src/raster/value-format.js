/** Browser-safe display helpers for raster values and names. */

/**
 * Read the display name from a raster descriptor or catalog GeoTIFF asset.
 *
 * @param {Object} item Catalog Item or source descriptor.
 * @return {string} Descriptor label or decoded catalog filename, including its extension.
 * @throws {TypeError} If the scanner-owned Asset URL is invalid.
 */
export function getRasterDisplayName(item) {
    if (item.source) return item.label;
    const pathname = new URL(item.assets.data.href).pathname;
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
}

/**
 * Return a concise filename stem for transient map-cursor presentation.
 *
 * @param {Object} item Catalog Item or source descriptor.
 * @return {string} Decoded basename without its final extension.
 */
export function getRasterDisplayStem(item) {
    return getRasterDisplayName(item).replace(/\.[^.]+$/, "");
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
