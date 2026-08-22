/**
 * Leaflet adapter for raster layers, bounds, and layer lifecycle.
 *
 * This module converts raster domain bounds to Leaflet coordinates, creates
 * WMS and sample-window layers, and manages keyed raster attachment, opacity,
 * and drawing order. It does not fetch publication or statistics data.
 */
import { validateRasterSelectedBounds } from "./geometry.js";

/**
 * Convert canonical bounds to Leaflet corners in the single visible world.
 *
 * @param {Object} bounds Canonical WGS 84 selected bounds.
 * @return {Array<Array<number>>} Southwest and northeast Leaflet corners.
 * @throws {Error} If bounds violate the selected-bounds contract.
 */
export function rasterSampleBoundsToLeaflet(bounds) {
    validateRasterSelectedBounds(bounds);
    return [
        [bounds.south, bounds.west],
        [bounds.north, bounds.east]
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
        noWrap: true,
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

/** Manage independent keyed Leaflet raster layers without publication logic. */
export class RasterLeafletLayerSet {
    /**
     * Create an empty keyed layer set.
     *
     * @param {{removeLayer: (layer: Object) => void}} leafletMap
     * Leaflet-compatible map.
     */
    constructor(leafletMap) {
        this.leafletMap = leafletMap;
        this.layers = new Map();
    }

    /**
     * Retain one newly created layer and optionally attach it to the map.
     *
     * @param {string} key Stable raster layer key.
     * @param {Object} layer Leaflet-compatible layer.
     * @param {{visible:boolean,opacity:number}} presentation Initial local
     * presentation.
     * @return {Object} Retained Leaflet layer.
     * @throws {Error} If key is already retained.
     */
    add(key, layer, { visible, opacity }) {
        if (this.layers.has(key)) {
            throw new Error(`Raster Leaflet layer already exists: ${key}`);
        }
        layer.setOpacity(opacity);
        const record = { layer, attached: false };
        this.layers.set(key, record);
        if (visible) {
            layer.addTo(this.leafletMap);
            record.attached = true;
        }
        return layer;
    }

    /**
     * Attach or detach one retained layer without recreating it.
     *
     * @param {string} key Stable raster layer key.
     * @param {boolean} visible Requested map visibility.
     * @return {void}
     */
    setVisible(key, visible) {
        const record = this.#require(key);
        if (record.attached === visible) {
            return;
        }
        if (visible) {
            record.layer.addTo(this.leafletMap);
        } else {
            this.leafletMap.removeLayer(record.layer);
        }
        record.attached = visible;
    }

    /**
     * Apply ordinary-overlay opacity locally.
     *
     * @param {string} key Stable raster layer key.
     * @param {number} opacity Opacity from zero through one.
     * @return {void}
     */
    setOpacity(key, opacity) {
        this.#require(key).layer.setOpacity(opacity);
    }

    /**
     * Apply deterministic top-first drawing order to every retained layer.
     *
     * @param {string[]} orderedKeys Stable keys from topmost to bottommost.
     * @return {void}
     * @throws {Error} If orderedKeys do not identify the complete layer set.
     */
    setOrder(orderedKeys) {
        if (
            orderedKeys.length !== this.layers.size ||
            orderedKeys.some((key) => !this.layers.has(key))
        ) {
            throw new Error(
                "Raster Leaflet order must contain every retained layer once."
            );
        }
        const uniqueKeys = new Set(orderedKeys);
        if (uniqueKeys.size !== orderedKeys.length) {
            throw new Error("Raster Leaflet order cannot contain duplicate keys.");
        }
        const baseZIndex = 200;
        orderedKeys.forEach((key, index) => {
            this.#require(key).layer.setZIndex(
                baseZIndex + orderedKeys.length - index
            );
        });
    }

    /**
     * Return one retained Leaflet layer.
     *
     * @param {string} key Stable raster layer key.
     * @return {Object|null} Matching layer or null.
     */
    get(key) {
        return this.layers.get(key)?.layer ?? null;
    }

    /**
     * Return whether one retained layer is attached to the map.
     *
     * @param {string} key Stable raster layer key.
     * @return {boolean} Whether the layer currently generates map tiles.
     */
    isAttached(key) {
        return this.layers.get(key)?.attached ?? false;
    }

    /**
     * Remove one retained layer from the map and keyed set.
     *
     * @param {string} key Stable raster layer key.
     * @return {Object|null} Removed Leaflet layer or null when unknown.
     */
    remove(key) {
        const record = this.layers.get(key);
        if (record === undefined) {
            return null;
        }
        if (record.attached) {
            this.leafletMap.removeLayer(record.layer);
        }
        this.layers.delete(key);
        return record.layer;
    }

    /** Remove every retained layer, preserving no map attachments. */
    clear() {
        for (const key of [...this.layers.keys()]) {
            this.remove(key);
        }
    }

    /**
     * Require one retained record.
     *
     * @param {string} key Stable raster layer key.
     * @return {{layer:Object,attached:boolean}} Retained record.
     * @throws {RangeError} If key is unknown.
     */
    #require(key) {
        const record = this.layers.get(key);
        if (record === undefined) {
            throw new RangeError(`Unknown Raster Leaflet layer: ${key}`);
        }
        return record;
    }
}
