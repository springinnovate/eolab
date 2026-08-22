/**
 * Interaction controller for the map's raster sample window.
 *
 * This module owns enablement, pointer preview, click/center selection, and
 * preview/selection layer cleanup. Geometry and Leaflet conversion are
 * delegated, and selecting a window only emits validated bounds to its caller.
 */
import {
    buildRasterSampleWindowBounds,
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
    RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE,
    RasterSampleWindowBoundaryError,
    validateRasterSampleWindowSize
} from "./geometry.js";
import { rasterSampleBoundsToLeaflet } from "./leaflet.js";

/**
 * Create a preview or committed rectangle layer.
 *
 * @callback RasterSampleLayerFactory
 * @param {Array<Array<number>>} bounds Leaflet southwest/northeast corners.
 * @param {"preview"|"selection"} kind Requested rectangle presentation.
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

/** Own the explicit hover-preview and click-to-sample map interaction. */
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
        this.enabled = false;
        this.lastPosition = null;
        this.previewLayer = null;
        this.selectionLayer = null;
        this.selectionBounds = null;
        this.onMouseMove = (event) => this.#previewAt(event.latlng);
        this.onMouseOut = () => this.#removePreview();
        this.onMouseOver = (event) => {
            const position = event.latlng ?? this.lastPosition;
            if (position !== null) {
                this.#previewAt(position);
            }
        };
        this.onClick = (event) => this.#selectAt(event.latlng);
    }

    /**
     * Start selection handlers without issuing a statistics request.
     *
     * @return {void}
     */
    enable() {
        if (this.enabled) {
            return;
        }
        this.enabled = true;
        this.leafletMap.on("mousemove", this.onMouseMove);
        this.leafletMap.on("mouseout", this.onMouseOut);
        this.leafletMap.on("mouseover", this.onMouseOver);
        this.leafletMap.on("click", this.onClick);
        this.#previewAt(this.leafletMap.getCenter());
    }

    /**
     * Stop selection handlers while retaining the committed rectangle.
     *
     * @return {void}
     */
    disable() {
        if (!this.enabled) {
            return;
        }
        this.leafletMap.off("mousemove", this.onMouseMove);
        this.leafletMap.off("mouseout", this.onMouseOut);
        this.leafletMap.off("mouseover", this.onMouseOver);
        this.leafletMap.off("click", this.onClick);
        this.enabled = false;
        this.#removePreview();
    }

    /**
     * Change the ground-distance side length used by later previews/clicks.
     *
     * @param {number} sideLengthKm Integer side length from 1 through 300 km.
     * @return {void}
     * @throws {RangeError} If the side length violates the window contract.
     */
    setWindowSize(sideLengthKm) {
        this.windowSizeKm = validateRasterSampleWindowSize(sideLengthKm);
        if (this.enabled && this.lastPosition !== null) {
            this.#previewAt(this.lastPosition);
        }
    }

    /**
     * Commit a selection at the current map center for keyboard/touch access.
     *
     * @return {Object|null} Canonical selected bounds, or null near an edge.
     */
    sampleMapCenter() {
        return this.#selectAt(this.leafletMap.getCenter());
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
     * Remove all layers, handlers, and pointer state for the active Item.
     *
     * @return {void}
     */
    clear() {
        this.disable();
        this.clearSelection();
        this.lastPosition = null;
        this.onGuidance("");
    }

    /** @return {boolean} Whether hover-and-click selection is active. */
    get isEnabled() {
        return this.enabled;
    }

    /** @return {Object|null} Last committed canonical WGS 84 bounds. */
    get selectedBounds() {
        return this.selectionBounds;
    }

    /**
     * Build API and visible-world bounds at one Leaflet position.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {{bounds:Object,leafletBounds:Array}|null} Sampling window, or
     * null when it crosses a pole or date line.
     * @throws {RangeError} If the position or configured size is invalid.
     */
    #boundsAt(position) {
        const normalizedPosition = this.#normalizePosition(position);
        try {
            const bounds = buildRasterSampleWindowBounds(
                {
                    longitude: normalizedPosition.lng,
                    latitude: normalizedPosition.lat
                },
                this.windowSizeKm
            );
            this.onGuidance("");
            return {
                bounds,
                leafletBounds: rasterSampleBoundsToLeaflet(
                    bounds,
                    position.lng - normalizedPosition.lng
                )
            };
        } catch (error) {
            if (!(error instanceof RasterSampleWindowBoundaryError)) {
                throw error;
            }
            this.#removePreview();
            this.onGuidance(RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE);
            return null;
        }
    }

    /**
     * Move or create the transient preview at one map position.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {void}
     * @throws {RangeError} If the position or configured size is invalid.
     */
    #previewAt(position) {
        this.lastPosition = position;
        const sampleWindow = this.#boundsAt(position);
        if (sampleWindow === null) {
            return;
        }
        if (this.previewLayer === null) {
            this.previewLayer = this.layerFactory(
                sampleWindow.leafletBounds,
                "preview"
            ).addTo(this.leafletMap);
        } else {
            this.previewLayer.setBounds(sampleWindow.leafletBounds);
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
        this.lastPosition = position;
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

    /**
     * Normalize a Leaflet world-copy position to canonical WGS 84 longitude.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {{lng: number, lat: number}} Canonical longitude and latitude.
     */
    #normalizePosition(position) {
        const longitude = ((position.lng + 180) % 360 + 360) % 360 - 180;
        return { lng: longitude, lat: position.lat };
    }

    /**
     * Remove the transient preview layer if present.
     *
     * @return {void}
     */
    #removePreview() {
        if (this.previewLayer !== null) {
            this.leafletMap.removeLayer(this.previewLayer);
            this.previewLayer = null;
        }
    }
}
