/**
 * Describe a pointer and map bounds in the same projection for WMS picking.
 * Convert world pixels directly to CRS coordinates so a zoomed-out viewport
 * extending beyond the projection's latitude limits is not clamped.
 * @param {Object} map Leaflet map.
 * @param {{x:number,y:number}} containerPoint Pointer position in map pixels.
 * @return {import("./feature-info.js").VectorFeatureInfoViewport} Projected bounds and pointer.
 */
export function getFeatureInfoViewport(map, containerPoint) {
    const size = map.getSize();
    const pixelBounds = map.getPixelBounds();
    const crs = map.options.crs;
    const scale = crs.scale(map.getZoom());
    const northwest = crs.transformation.untransform(pixelBounds.min, scale);
    const southeast = crs.transformation.untransform(pixelBounds.max, scale);
    return {
        crs: crs.code,
        bbox: [northwest.x, southeast.y, southeast.x, northwest.y],
        width: size.x,
        height: size.y,
        x: containerPoint.x,
        y: containerPoint.y,
    };
}
