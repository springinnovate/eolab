/** Browser-safe display helpers for raster values and names. */

/**
 * Read a supplied raster label, curated dataset title, or original filename.
 *
 * @param {Object} item Catalog Item or source descriptor.
 * @return {string} Descriptor label, curated dataset title, or decoded original filename.
 * @throws {TypeError} If the scanner-owned Asset URL is invalid.
 */
export function getRasterDisplayName(item) {
    if (item.source) return item.label;
    if (item.properties?.["eolab:metadata"]) {
        return item.properties["eolab:metadata"].title;
    }
    const pathname = new URL(item.assets.data.href).pathname;
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
}

/**
 * Return a curated title or concise filename stem for map-cursor presentation.
 *
 * @param {Object} item Catalog Item or source descriptor.
 * @return {string} Curated title, or decoded basename without its final extension.
 */
export function getRasterDisplayStem(item) {
    const name = getRasterDisplayName(item);
    return item.properties?.["eolab:metadata"] ? name : name.replace(/\.[^.]+$/, "");
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
