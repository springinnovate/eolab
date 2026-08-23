/** Leaflet construction for explicitly bounded raster detail previews. */

/**
 * Convert a canonical WGS 84 array to Leaflet southwest/northeast corners.
 *
 * @param {number[]} bounds West, south, east, north bounds.
 * @return {number[][]} Leaflet latitude/longitude corner pairs.
 */
function toLeafletBounds(bounds) {
    return [
        [bounds[1], bounds[0]],
        [bounds[3], bounds[2]]
    ];
}

/**
 * Create one grouped map layer and appropriate focus for a detail preview.
 *
 * The dashed outline is the cataloged raster extent, not a valid-data
 * footprint. Point modes preserve every sampled source cell's placement; the
 * patch image is already warped by EOLab into its returned WGS 84 bounds.
 *
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} preview Validated detail preview response.
 * @return {{layer:Object,focusBounds:number[][]}} Grouped layer and fit bounds.
 */
export function createRasterDetailPreviewLayer(leaflet, preview) {
    const extentBounds = toLeafletBounds(preview.rasterExtent);
    const layers = [leaflet.rectangle(extentBounds, {
        color: "#f97316",
        weight: 2,
        dashArray: "7 5",
        fill: false,
        interactive: false,
        className: "raster-detail-extent"
    })];
    let focusBounds = extentBounds;
    if (preview.mode === "representativePatch") {
        const detailBounds = toLeafletBounds(preview.detailBounds);
        layers.push(
            leaflet.imageOverlay(preview.imageDataUrl, detailBounds, {
                opacity: 0.9,
                interactive: false,
                className: "raster-detail-patch"
            }),
            leaflet.rectangle(detailBounds, {
                color: "#0f766e",
                weight: 2,
                fill: false,
                interactive: false
            })
        );
        focusBounds = detailBounds;
    } else {
        for (const sample of preview.samples) {
            const marker = leaflet.circleMarker(
                [sample.latitude, sample.longitude],
                {
                    radius: preview.mode === "centerPixel" ? 7 : 5,
                    color: sample.value === null ? "#111827" : "#0f766e",
                    weight: 2,
                    fillColor: sample.value === null ? "#ffffff" : "#2dd4bf",
                    fillOpacity: 0.9
                }
            );
            marker.bindTooltip(
                sample.value === null
                    ? `Row ${sample.row}, column ${sample.column}: nodata`
                    : `Row ${sample.row}, column ${sample.column}: ${sample.value}`
            );
            layers.push(marker);
        }
    }
    return {
        layer: leaflet.layerGroup(layers),
        focusBounds
    };
}
