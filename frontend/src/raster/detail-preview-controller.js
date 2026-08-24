/** Lifecycle coordinator for zoom-adaptive, bounded raster detail previews. */

import {
    isRasterDetailPreviewCapacityError,
    loadCatalogRasterDetailPreview
} from "./api.js";
import {
    createRasterDetailPreviewLayer,
    ensureRasterDetailPreviewPanes
} from "./detail-preview-leaflet.js";
import {
    intersectRasterViewport,
    isRasterDetailZoom,
    rasterViewportKey
} from "./detail-preview-viewport.js";
import { getCatalogRasterLayerKey } from "./layer-stack.js";

const DETAIL_REFINEMENT_DEBOUNCE_MILLISECONDS = 200;
const DETAIL_CAPACITY_RETRY_MILLISECONDS = 1_000;

/**
 * Return whether two controller-owned Leaflet bounds have identical corners.
 *
 * @param {number[][]} left First southwest/northeast latitude-longitude pair.
 * @param {number[][]} right Second southwest/northeast pair.
 * @return {boolean} Whether both focus rectangles are spatially identical.
 */
function rasterDetailFocusBoundsMatch(left, right) {
    return left[0][0] === right[0][0] && left[0][1] === right[0][1] &&
        left[1][0] === right[1][0] && left[1][1] === right[1][1];
}

/**
 * @typedef {Object} RasterDetailPreviewController
 * @property {(item:Object)=>Promise<Object|null>}
 * show Load and display one base preview, returning null when stale.
 * @property {(item:Object) => boolean} contains Whether the Item owns preview.
 * @property {(item:Object,style:Object) => void} setStyle Recolor current base
 * and detail images with the shared raster style.
 * @property {(item?:Object) => void} remove Remove matching/current layers.
 * @property {() => void} invalidate Abort pending work without removing display.
 * @property {(item?:Object) => Object|null} getState Return current UI state.
 * @property {() => void} clear Abort work and remove all current layers.
 * @property {() => void} destroy Permanently clear and unbind the controller.
 */

/**
 * Initialize one sampled-raster session against the shared Leaflet map.
 *
 * The controller owns one coarse/base layer and at most one finer current-view
 * layer. Every completed replacement is added before its predecessor is
 * removed. Move requests are debounced, abortable, and guarded by both session
 * and viewport identities so stale responses cannot replace current state.
 *
 * @param {{leafletMap:Object,leaflet:Object,onChange?:Function}} configuration
 * Leaflet collaborators and optional state-change callback.
 * @param {{loadPreview?:Function,createPreviewLayer?:Function,setTimer?:Function,
 * clearTimer?:Function,detailDebounceMilliseconds?:number,
 * detailCapacityRetryMilliseconds?:number}} dependencies
 * Injectable network, presentation, and timer boundaries.
 * @return {RasterDetailPreviewController} Detail preview lifecycle API.
 * @throws {TypeError} If the map does not expose required event methods.
 * @throws {Error} If Leaflet cannot create the ordered preview panes.
 */
export function initializeRasterDetailPreview(
    { leafletMap, leaflet, onChange = () => {} },
    {
        loadPreview = loadCatalogRasterDetailPreview,
        createPreviewLayer = createRasterDetailPreviewLayer,
        setTimer = globalThis.setTimeout.bind(globalThis),
        clearTimer = globalThis.clearTimeout.bind(globalThis),
        detailDebounceMilliseconds = DETAIL_REFINEMENT_DEBOUNCE_MILLISECONDS,
        detailCapacityRetryMilliseconds = DETAIL_CAPACITY_RETRY_MILLISECONDS
    } = {}
) {
    if (typeof leafletMap.on !== "function" ||
        typeof leafletMap.off !== "function") {
        throw new TypeError("Sampled raster preview requires Leaflet map events");
    }
    ensureRasterDetailPreviewPanes(leafletMap);
    let generation = 0;
    let detailGeneration = 0;
    let pendingBaseAbortController = null;
    let pendingDetail = null;
    let detailTimer = null;
    let current = null;
    let replacingBase = false;
    let destroyed = false;

    /**
     * Remove one presentation and release any resources it owns.
     *
     * @param {{layer:Object,dispose?:Function}|null} presentation Presentation.
     * @return {void}
     */
    function disposePresentation(presentation) {
        if (presentation === null) {
            return;
        }
        try {
            leafletMap.removeLayer(presentation.layer);
        } finally {
            presentation.dispose?.();
        }
    }

    /** Cancel scheduled/in-flight current-view work. @return {void} */
    function cancelDetailWork() {
        detailGeneration += 1;
        if (detailTimer !== null) {
            clearTimer(detailTimer);
            detailTimer = null;
        }
        pendingDetail?.abortController.abort();
        pendingDetail = null;
    }

    /** Abort every pending request and invalidate late completions. @return {void} */
    function invalidate() {
        generation += 1;
        pendingBaseAbortController?.abort();
        pendingBaseAbortController = null;
        cancelDetailWork();
        if (current !== null) {
            current.detailStatus = current.detail === null ? "none" : "ready";
            current.detailError = null;
        }
    }

    /**
     * Return whether one Item owns the displayed sampled raster.
     *
     * @param {Object} item Catalog Item.
     * @return {boolean} Whether its composite identity is displayed.
     */
    function contains(item) {
        return current?.key === getCatalogRasterLayerKey(item);
    }

    /**
     * Return browser-safe state for the matching/current sampled raster.
     *
     * @param {Object} [item] Optional Item that must own the state.
     * @return {Object|null} Base/detail metrics and refinement status.
     */
    function getState(item) {
        if (current === null || (item !== undefined && !contains(item))) {
            return null;
        }
        return {
            basePreview: current.base.preview,
            detailPreview: current.detail?.preview ?? null,
            detailStatus: current.detailStatus,
            detailError: current.detailError,
            style: { ...current.base.style }
        };
    }

    /**
     * Recolor the displayed numeric images without new source reads.
     *
     * Replacement layers are both constructed and attached before the prior
     * layers are removed, so a style edit cannot leave a partially updated
     * sampled raster on the map.
     *
     * @param {Object} item Catalog Item that must own the current preview.
     * @param {Object} style Valid shared raster thresholds and color stops.
     * @return {void}
     * @throws {Error} If the Item is not current or recoloring/attachment
     * violates the preview presentation contract.
     */
    function setStyle(item, style) {
        if (!contains(item)) {
            throw new Error("Sampled raster style target is not current");
        }
        const nextBasePresentation = createPreviewLayer(
            leaflet,
            current.base.preview,
            { style }
        );
        let nextDetailPresentation = null;
        try {
            nextDetailPresentation = current.detail === null
                ? null
                : createPreviewLayer(
                    leaflet,
                    current.detail.preview,
                    { style }
                );
            nextBasePresentation.layer.addTo(leafletMap);
            nextDetailPresentation?.layer.addTo(leafletMap);
        } catch (error) {
            disposePresentation(nextDetailPresentation);
            disposePresentation(nextBasePresentation);
            throw error;
        }
        const previousBasePresentation = current.base.presentation;
        const previousDetailPresentation =
            current.detail?.presentation ?? null;
        current.base.presentation = nextBasePresentation;
        current.base.style = Object.freeze({ ...nextBasePresentation.style });
        current.base.styleEstablished = true;
        if (current.detail !== null) {
            current.detail.presentation = nextDetailPresentation;
        }
        disposePresentation(previousDetailPresentation);
        disposePresentation(previousBasePresentation);
        onChange();
    }

    /** Clear only the current-view overlay. @return {void} */
    function clearDetailLayer() {
        cancelDetailWork();
        if (current === null) {
            return;
        }
        const changed = current.detail !== null ||
            current.detailStatus !== "none" || current.detailError !== null;
        disposePresentation(current.detail?.presentation ?? null);
        current.detail = null;
        current.detailStatus = "none";
        current.detailError = null;
        if (changed) {
            onChange();
        }
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
            disposePresentation(current.detail?.presentation ?? null);
            disposePresentation(current.base.presentation);
            current = null;
            onChange();
        }
    }

    /** Abort work and remove the current preview. @return {void} */
    function clear() {
        remove();
    }

    /**
     * Return whether an asynchronous detail intent is still current.
     *
     * @param {number} sessionGeneration Explicit base-session identity.
     * @param {number} requestDetailGeneration Viewport intent identity.
     * @param {string} intentKey Item and bounds identity.
     * @return {boolean} Whether a completion may update the map.
     */
    function isCurrentDetailIntent(
        sessionGeneration,
        requestDetailGeneration,
        intentKey
    ) {
        return !destroyed && current !== null &&
            sessionGeneration === generation &&
            requestDetailGeneration === detailGeneration &&
            current.requestedDetailKey === intentKey;
    }

    /**
     * Load and atomically attach one finer proxy over the current map view.
     *
     * @param {number} sessionGeneration Base-session identity.
     * @param {number} requestDetailGeneration Viewport intent identity.
     * @param {string} intentKey Item and bounds identity.
     * @param {Object} viewBounds Canonical raster/view intersection.
     * @return {Promise<void>} Completion after success, stale ignore, or an
     * honestly reported non-destructive refinement failure.
     */
    async function loadCurrentViewDetail(
        sessionGeneration,
        requestDetailGeneration,
        intentKey,
        viewBounds
    ) {
        detailTimer = null;
        if (!isCurrentDetailIntent(
            sessionGeneration,
            requestDetailGeneration,
            intentKey
        )) {
            return;
        }
        const abortController = new AbortController();
        pendingDetail = { abortController, intentKey };
        try {
            const preview = await loadPreview(
                current.item,
                {
                    viewBounds
                },
                abortController.signal
            );
            if (abortController.signal.aborted || !isCurrentDetailIntent(
                sessionGeneration,
                requestDetailGeneration,
                intentKey
            )) {
                return;
            }
            const presentation = createPreviewLayer(
                leaflet,
                preview,
                current.base.styleEstablished
                    ? { style: current.base.style }
                    : {}
            );
            try {
                presentation.layer.addTo(leafletMap);
            } catch (layerError) {
                disposePresentation(presentation);
                throw layerError;
            }
            if (!isCurrentDetailIntent(
                sessionGeneration,
                requestDetailGeneration,
                intentKey
            )) {
                disposePresentation(presentation);
                return;
            }
            const previousDetail = current.detail;
            if (!current.base.styleEstablished &&
                preview.suggestedRange !== null) {
                current.base.style = Object.freeze(presentation.style);
                current.base.styleEstablished = true;
            }
            current.detail = { intentKey, presentation, preview };
            current.detailStatus = "ready";
            current.detailError = null;
            disposePresentation(previousDetail?.presentation ?? null);
            onChange();
        } catch (error) {
            if (isRasterDetailPreviewCapacityError(error) &&
                isCurrentDetailIntent(
                    sessionGeneration,
                    requestDetailGeneration,
                    intentKey
                )) {
                current.detailStatus = "loading";
                current.detailError = null;
                detailTimer = setTimer(() => {
                    void loadCurrentViewDetail(
                        sessionGeneration,
                        requestDetailGeneration,
                        intentKey,
                        viewBounds
                    );
                }, detailCapacityRetryMilliseconds);
                onChange();
            } else if (error.name !== "AbortError" && isCurrentDetailIntent(
                sessionGeneration,
                requestDetailGeneration,
                intentKey
            )) {
                current.detailStatus = "error";
                current.detailError = error.message;
                onChange();
            }
        } finally {
            if (pendingDetail?.abortController === abortController) {
                pendingDetail = null;
            }
        }
    }

    /** Derive and debounce the latest viewport refinement intent. @return {void} */
    function queueCurrentViewDetail() {
        if (destroyed || replacingBase || pendingBaseAbortController !== null ||
            current === null) {
            return;
        }
        if (!isRasterDetailZoom(leafletMap.getZoom(), current.baseZoom)) {
            clearDetailLayer();
            return;
        }
        const viewBounds = intersectRasterViewport(
            leafletMap.getBounds(),
            current.base.preview.rasterExtent
        );
        if (viewBounds === null) {
            clearDetailLayer();
            return;
        }
        const intentKey = JSON.stringify([
            current.key,
            rasterViewportKey(viewBounds)
        ]);
        if (current.detail?.intentKey === intentKey) {
            const changed = detailTimer !== null || pendingDetail !== null ||
                current.detailStatus !== "ready" ||
                current.detailError !== null;
            cancelDetailWork();
            current.requestedDetailKey = intentKey;
            current.detailStatus = "ready";
            current.detailError = null;
            if (changed) {
                onChange();
            }
            return;
        }
        if (pendingDetail?.intentKey === intentKey ||
            (detailTimer !== null && current.requestedDetailKey === intentKey)) {
            return;
        }
        cancelDetailWork();
        const requestDetailGeneration = detailGeneration;
        const sessionGeneration = generation;
        current.requestedDetailKey = intentKey;
        current.detailStatus = "loading";
        current.detailError = null;
        onChange();
        detailTimer = setTimer(() => {
            void loadCurrentViewDetail(
                sessionGeneration,
                requestDetailGeneration,
                intentKey,
                viewBounds
            );
        }, detailDebounceMilliseconds);
    }

    /** Respond to a completed Leaflet pan or zoom. @return {void} */
    function handleMoveEnd() {
        queueCurrentViewDetail();
    }
    leafletMap.on("moveend", handleMoveEnd);

    /**
     * Load and display one explicitly selected base sampled raster.
     *
     * @param {Object} item Selected Catalog raster.
     * @return {Promise<Object|null>} Current response or null when stale.
     * @throws {Error} If the current request or presentation fails.
     */
    async function show(item) {
        invalidate();
        const requestGeneration = generation;
        const abortController = new AbortController();
        pendingBaseAbortController = abortController;
        let preview;
        try {
            preview = await loadPreview(
                item,
                {
                    viewBounds: null
                },
                abortController.signal
            );
        } finally {
            if (pendingBaseAbortController === abortController) {
                pendingBaseAbortController = null;
            }
        }
        if (destroyed || requestGeneration !== generation ||
            abortController.signal.aborted) {
            return null;
        }
        const presentation = createPreviewLayer(leaflet, preview);
        try {
            presentation.layer.addTo(leafletMap);
        } catch (layerError) {
            disposePresentation(presentation);
            throw layerError;
        }
        const previous = current;
        const key = getCatalogRasterLayerKey(item);
        const changedFocusScope = previous === null || previous.key !== key ||
            !rasterDetailFocusBoundsMatch(
                previous.base.presentation.focusBounds,
                presentation.focusBounds
            );
        let baseZoom = previous?.baseZoom ?? null;
        if (changedFocusScope) {
            const maximumFocusZoom = 8;
            baseZoom = Math.max(
                leafletMap.getMinZoom(),
                Math.min(
                    leafletMap.getBoundsZoom(presentation.focusBounds),
                    maximumFocusZoom
                )
            );
            replacingBase = true;
            try {
                leafletMap.fitBounds(presentation.focusBounds, {
                    maxZoom: maximumFocusZoom,
                    animate: false
                });
            } catch (focusError) {
                disposePresentation(presentation);
                throw focusError;
            } finally {
                replacingBase = false;
            }
        }
        current = {
            key,
            item,
            base: {
                presentation,
                preview,
                style: preview.suggestedRange === null
                    ? presentation.style
                    : Object.freeze(presentation.style),
                styleEstablished: preview.suggestedRange !== null
            },
            detail: null,
            baseZoom,
            requestedDetailKey: null,
            detailStatus: "none",
            detailError: null
        };
        disposePresentation(previous?.detail?.presentation ?? null);
        disposePresentation(previous?.base.presentation ?? null);
        onChange();
        queueCurrentViewDetail();
        return preview;
    }

    /** Permanently clear state and the registered map listener. @return {void} */
    function destroy() {
        if (destroyed) {
            return;
        }
        destroyed = true;
        leafletMap.off("moveend", handleMoveEnd);
        clear();
    }

    return {
        show,
        contains,
        setStyle,
        remove,
        invalidate,
        getState,
        clear,
        destroy
    };
}
