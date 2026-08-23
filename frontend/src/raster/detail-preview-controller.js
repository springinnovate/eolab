/** Lifecycle coordinator for one transient, bounded raster detail preview. */

import { loadCatalogRasterDetailPreview } from "./api.js";
import { createRasterDetailPreviewLayer } from "./detail-preview-leaflet.js";
import { getCatalogRasterLayerKey } from "./layer-stack.js";

/**
 * @typedef {Object} RasterDetailPreviewController
 * @property {(item:Object, mode:string) => Promise<Object|null>} show Load and
 * display one current preview, returning null when cancellation loses a race.
 * @property {(item:Object) => boolean} contains Whether the Item owns the map
 * preview.
 * @property {(item?:Object) => void} remove Remove the matching/current preview.
 * @property {() => void} invalidate Abort pending work without removing display.
 * @property {() => void} clear Abort work and remove the current display.
 * @property {() => void} destroy Permanently clear the controller.
 */

/**
 * Initialize one detail-only preview boundary against the shared map.
 *
 * @param {{leafletMap:Object,leaflet:Object,onChange?:Function}} configuration
 * Leaflet collaborators and optional state-change callback.
 * @param {{loadPreview?:Function,createPreviewLayer?:Function}} dependencies
 * Injectable network and Leaflet boundaries.
 * @return {RasterDetailPreviewController} Detail preview lifecycle API.
 */
export function initializeRasterDetailPreview(
    { leafletMap, leaflet, onChange = () => {} },
    {
        loadPreview = loadCatalogRasterDetailPreview,
        createPreviewLayer = createRasterDetailPreviewLayer,
    } = {}
) {
    let generation = 0;
    let pendingAbortController = null;
    let current = null;
    let destroyed = false;

    /**
     * Abort pending work and invalidate it even if cancellation loses.
     *
     * @return {void}
     */
    function invalidate() {
        generation += 1;
        pendingAbortController?.abort();
        pendingAbortController = null;
    }

    /**
     * Return whether one Item owns the displayed preview.
     *
     * @param {Object} item Catalog Item.
     * @return {boolean} Whether its composite identity is displayed.
     */
    function contains(item) {
        return current?.key === getCatalogRasterLayerKey(item);
    }

    /**
     * Remove the current preview, optionally only for one matching Item.
     *
     * @param {Object} [item] Optional Item that must own the preview.
     * @return {void}
     */
    function remove(item) {
        if (item !== undefined && !contains(item)) {
            return;
        }
        invalidate();
        if (current !== null) {
            leafletMap.removeLayer(current.layer);
            current = null;
            onChange();
        }
    }

    /**
     * Abort work and remove the current detail-only preview.
     *
     * @return {void}
     */
    function clear() {
        remove();
    }

    /**
     * Load and display one explicitly selected detail preview.
     *
     * @param {Object} item Selected Catalog raster.
     * @param {string} mode Fixed detail preview mode.
     * @return {Promise<Object|null>} Current response or null when stale.
     * @throws {Error} If the request is observably aborted, or the current
     * request or Leaflet construction otherwise fails.
     */
    async function show(item, mode) {
        invalidate();
        const requestGeneration = generation;
        const abortController = new AbortController();
        pendingAbortController = abortController;
        let preview;
        try {
            preview = await loadPreview(
                item,
                mode,
                abortController.signal
            );
        } finally {
            if (pendingAbortController === abortController) {
                pendingAbortController = null;
            }
        }
        if (
            destroyed ||
            requestGeneration !== generation ||
            abortController.signal.aborted
        ) {
            return null;
        }
        const presentation = createPreviewLayer(leaflet, preview);
        const previous = current;
        try {
            presentation.layer.addTo(leafletMap);
        } catch (layerError) {
            leafletMap.removeLayer(presentation.layer);
            throw layerError;
        }
        if (previous !== null) {
            leafletMap.removeLayer(previous.layer);
        }
        current = {
            key: getCatalogRasterLayerKey(item),
            item,
            mode,
            layer: presentation.layer,
            preview,
            style: presentation.style,
        };
        const changedFocusScope = previous === null ||
            previous.key !== current.key ||
            (previous.mode === "representativePatch") !==
                (mode === "representativePatch");
        if (changedFocusScope) {
            leafletMap.fitBounds(presentation.focusBounds, {
                maxZoom: mode === "representativePatch" ? 16 : 8
            });
        }
        onChange();
        return preview;
    }

    /**
     * Permanently clear preview state.
     *
     * @return {void}
     */
    function destroy() {
        destroyed = true;
        clear();
    }

    return { show, contains, remove, invalidate, clear, destroy };
}
