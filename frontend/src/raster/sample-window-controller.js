/**
 * Interaction controller for the map's raster sample window.
 *
 * This module owns one-shot map-position selection and selection-layer cleanup.
 * Geometry and Leaflet conversion are delegated, and selecting a window only
 * emits validated bounds to its caller.
 */
import {
    buildRasterSampleWindowBounds,
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
    isCanonicalWgs84Position,
    RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE,
    RASTER_SAMPLE_WINDOW_MAP_BOUNDS_GUIDANCE,
    RasterSampleWindowBoundaryError,
    validateRasterSampleWindowSize
} from "./geometry.js";
import { rasterSampleBoundsToLeaflet } from "./leaflet.js";

/**
 * Create a committed rectangle layer.
 *
 * @callback RasterSampleLayerFactory
 * @param {Array<Array<number>>} bounds Leaflet southwest/northeast corners.
 * @param {"selection"} kind Requested rectangle presentation.
 * @return {{addTo: (map: Object) => Object, setBounds: (bounds: Array<Array<number>>) => void}}
 * Leaflet-compatible rectangle layer.
 */

/**
 * Receive a committed raster sample window.
 *
 * @callback RasterSampleSelectionHandler
 * @param {Object} bounds Canonical WGS 84 selected bounds.
 * @return {void}
 */

/**
 * Receive user-facing sample-window guidance.
 *
 * @callback RasterSampleGuidanceHandler
 * @param {string} guidance Guidance text, or an empty string when valid.
 * @return {void}
 */

/** Own validated one-shot raster sample-window selection. */
export class RasterSampleWindowController {
    /**
     * Create a raster sample-window interaction controller.
     *
     * @param {Object} leafletMap Leaflet-compatible evented map.
     * @param {RasterSampleLayerFactory} layerFactory Creates rectangles.
     * @param {RasterSampleSelectionHandler} onSelect Receives committed bounds.
     * @param {RasterSampleGuidanceHandler} onGuidance Receives guidance text.
     */
    constructor(leafletMap, layerFactory, onSelect, onGuidance) {
        this.leafletMap = leafletMap;
        this.layerFactory = layerFactory;
        this.onSelect = onSelect;
        this.onGuidance = onGuidance;
        this.windowSizeKm = DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM;
        this.selectionLayer = null;
        this.selectionBounds = null;
    }

    /**
     * Change the ground-distance side length used by later selections.
     *
     * @param {number} sideLengthKm Integer side length from 1 through 300 km.
     * @return {void}
     * @throws {RangeError} If the side length violates the window contract.
     */
    setWindowSize(sideLengthKm) {
        this.windowSizeKm = validateRasterSampleWindowSize(sideLengthKm);
    }

    /**
     * Commit a selection at one composition-owned map position.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {Object|null} Canonical bounds, or null near a pole/date line.
     * @throws {RangeError} If the position or configured size is invalid.
     */
    selectAt(position) {
        return this.#selectAt(position);
    }

    /**
     * Remove only the committed area, retaining the hover interaction.
     *
     * @return {void}
     */
    clearSelection() {
        if (this.selectionLayer !== null) {
            this.leafletMap.removeLayer(this.selectionLayer);
            this.selectionLayer = null;
        }
        this.selectionBounds = null;
    }

    /**
     * Restore a retained selection without issuing another statistics request.
     *
     * @param {Object} bounds Canonical WGS 84 selected bounds.
     * @return {void}
     */
    restoreSelection(bounds) {
        this.clearSelection();
        this.selectionLayer = this.layerFactory(
            rasterSampleBoundsToLeaflet(bounds),
            "selection"
        ).addTo(this.leafletMap);
        this.selectionBounds = bounds;
    }

    /**
     * Remove all layers, handlers, and pointer state for the active Item.
     *
     * @return {void}
     */
    clear() {
        this.clearSelection();
        this.onGuidance("");
    }

    /** @return {Object|null} Last committed canonical WGS 84 bounds. */
    get selectedBounds() {
        return this.selectionBounds;
    }

    /**
     * Build API and single-world bounds at one Leaflet position.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {{bounds:Object,leafletBounds:Array}|null} Sampling window, or
     * null outside the map or when the window crosses a pole or date line.
     * @throws {RangeError} If the configured size is invalid.
     */
    #boundsAt(position) {
        const center = {
            longitude: position.lng,
            latitude: position.lat
        };
        if (!isCanonicalWgs84Position(center)) {
            this.onGuidance(RASTER_SAMPLE_WINDOW_MAP_BOUNDS_GUIDANCE);
            return null;
        }
        try {
            const bounds = buildRasterSampleWindowBounds(
                center,
                this.windowSizeKm
            );
            this.onGuidance("");
            return {
                bounds,
                leafletBounds: rasterSampleBoundsToLeaflet(bounds),
            };
        } catch (error) {
            if (!(error instanceof RasterSampleWindowBoundaryError)) {
                throw error;
            }
            this.onGuidance(RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE);
            return null;
        }
    }

    /**
     * Commit and report one sample window at a map position.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {Object|null} Canonical bounds, or null near a pole/date line.
     * @throws {RangeError} If the position or configured size is invalid.
     */
    #selectAt(position) {
        const sampleWindow = this.#boundsAt(position);
        if (sampleWindow === null) {
            return null;
        }
        if (this.selectionLayer === null) {
            this.selectionLayer = this.layerFactory(
                sampleWindow.leafletBounds,
                "selection"
            ).addTo(this.leafletMap);
        } else {
            this.selectionLayer.setBounds(sampleWindow.leafletBounds);
        }
        this.selectionBounds = sampleWindow.bounds;
        this.onSelect(sampleWindow.bounds);
        return sampleWindow.bounds;
    }

}
