import { validateRasterSelectedBounds } from "./geometry.js";


/**
 * Publish a Catalog Item for rendering.
 *
 * @callback PublishCatalogRaster
 * @param {Object} item Selected STAC Item.
 * @return {Promise<Object>} Published layer details.
 */

/**
 * Create a map layer for one published raster.
 *
 * @callback CatalogRasterLayerFactory
 * @param {Object} publishedRaster Published layer details.
 * @return {{addTo: (map: Object) => Object}} Leaflet-compatible layer.
 */

/**
 * Convert canonical bounds to Leaflet corners in one visible world copy.
 *
 * @param {Object} bounds Canonical WGS 84 selected bounds.
 * @param {number} [longitudeOffset=0] World-copy longitude offset in degrees.
 * @return {Array<Array<number>>} Southwest and northeast Leaflet corners.
 * @throws {Error} If bounds or longitudeOffset violate their contracts.
 */
export function rasterSampleBoundsToLeaflet(bounds, longitudeOffset = 0) {
    validateRasterSelectedBounds(bounds);
    if (!Number.isFinite(longitudeOffset)) {
        throw new RangeError("Raster sample longitude offset must be finite.");
    }
    return [
        [bounds.south, bounds.west + longitudeOffset],
        [bounds.north, bounds.east + longitudeOffset]
    ];
}

/**
 * Create the Leaflet WMS layer for one published Catalog raster.
 *
 * @param {Object} leaflet Leaflet namespace with a WMS tile-layer factory.
 * @param {string} wmsUrl Browser-facing GeoServer WMS endpoint.
 * @param {{bbox: number[], layerName: string}} publishedRaster Published
 * GeoServer layer identity and WGS 84 bounds.
 * @param {string} styleEnvironment Validated dynamic-style WMS environment.
 * @param {() => void} onTileError Reports the layer's first tile failure.
 * @return {Object} Leaflet-compatible WMS layer.
 */
export function createRasterWmsLayer(
    leaflet,
    wmsUrl,
    publishedRaster,
    styleEnvironment,
    onTileError
) {
    const [west, south, east, north] = publishedRaster.bbox;
    const rasterLayer = leaflet.tileLayer.wms(wmsUrl, {
        layers: publishedRaster.layerName,
        styles: "dynamic-raster",
        env: styleEnvironment,
        format: "image/png",
        transparent: true,
        version: "1.3.0",
        bounds: [
            [south, west],
            [north, east]
        ]
    });
    rasterLayer.once("tileerror", onTileError);
    return rasterLayer;
}

/**
 * Create one Leaflet rectangle for sample preview or committed selection.
 *
 * @param {Object} leaflet Leaflet namespace with a rectangle factory.
 * @param {Array<Array<number>>} bounds Visible-world Leaflet corners.
 * @param {"preview"|"selection"} layerKind Rectangle presentation kind.
 * @return {Object} Leaflet-compatible rectangle layer.
 */
export function createRasterSampleWindowLayer(leaflet, bounds, layerKind) {
    return leaflet.rectangle(bounds, layerKind === "preview"
        ? {
            color: "#f97316",
            weight: 2,
            fill: false,
            interactive: false
        }
        : {
            color: "#2563eb",
            weight: 2,
            fillColor: "#3b82f6",
            fillOpacity: 0.12,
            interactive: false
        });
}

/** Manage one WMS layer while ignoring publication results for stale selections. */
export class CatalogRasterLayerController {
    /**
     * Create a raster layer lifecycle controller.
     *
     * @param {{removeLayer: (layer: Object) => void}} leafletMap
     * Leaflet-compatible map.
     * @param {PublishCatalogRaster} publishRaster Publishes one selected Item.
     * @param {CatalogRasterLayerFactory} layerFactory Creates its map layer.
     */
    constructor(leafletMap, publishRaster, layerFactory) {
        this.leafletMap = leafletMap;
        this.publishRaster = publishRaster;
        this.layerFactory = layerFactory;
        this.activeLayer = null;
        this.requestSequence = 0;
    }

    /**
     * Publish and display one Item unless selection changed while awaiting it.
     *
     * @param {Object} item Selected STAC Item.
     * @return {Promise<Object|null>} Published layer details, or null after a
     * selection change.
     * @throws {Error} If publication or layer construction fails.
     */
    async show(item) {
        const requestSequence = ++this.requestSequence;
        const publishedRaster = await this.publishRaster(item);
        if (requestSequence !== this.requestSequence) {
            return null;
        }
        this.clear();
        this.activeLayer = this.layerFactory(publishedRaster).addTo(
            this.leafletMap
        );
        return publishedRaster;
    }

    /**
     * Invalidate pending publication and remove a displayed layer, if any.
     *
     * @return {void}
     */
    clear() {
        this.requestSequence += 1;
        if (this.activeLayer !== null) {
            this.leafletMap.removeLayer(this.activeLayer);
            this.activeLayer = null;
        }
    }
}
