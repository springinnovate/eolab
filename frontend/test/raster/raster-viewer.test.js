import assert from "node:assert/strict";
import test from "node:test";

import { initializeRasterViewer } from "../../src/raster/raster-viewer.js";
import {
    MOUNTED_GEOTIFF_ITEM,
    RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

/** Minimal add/remove event source with inspectable listener ownership. */
class FakeEventSource {
    /** Create an event source without listeners. */
    constructor() {
        this.listeners = new Map();
    }

    /**
     * Attach one listener.
     *
     * @param {string} type Event type.
     * @param {(event: Object) => void} listener Event callback.
     * @return {void}
     */
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type).add(listener);
    }

    /**
     * Remove one listener.
     *
     * @param {string} type Event type.
     * @param {(event: Object) => void} listener Event callback.
     * @return {void}
     */
    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
    }

    /**
     * Count listeners attached for one event type.
     *
     * @param {string} type Event type.
     * @return {number} Attached listener count.
     */
    listenerCount(type) {
        return this.listeners.get(type)?.size ?? 0;
    }
}

/**
 * Create a Leaflet-compatible map with inspectable layers and handlers.
 *
 * @return {Object} Fake Leaflet map.
 */
function createFakeMap() {
    const container = new FakeEventSource();
    const handlers = new Map();
    const layers = new Set();
    return {
        container,
        handlers,
        layers,
        getContainer() {
            return container;
        },
        getCenter() {
            return { lng: 0, lat: 0 };
        },
        on(type, handler) {
            if (!handlers.has(type)) {
                handlers.set(type, new Set());
            }
            handlers.get(type).add(handler);
        },
        off(type, handler) {
            handlers.get(type)?.delete(handler);
        },
        emit(type, event) {
            for (const handler of handlers.get(type) ?? []) {
                handler(event);
            }
        },
        removeLayer(layer) {
            layers.delete(layer);
        },
    };
}

/**
 * Create one Leaflet-compatible layer owned by a fake map.
 *
 * @return {Object} Fake WMS or rectangle layer.
 */
function createFakeLayer() {
    return {
        eventHandlers: new Map(),
        parameters: null,
        parameterUpdates: [],
        addTo(map) {
            map.layers.add(this);
            return this;
        },
        once(type, handler) {
            this.eventHandlers.set(type, handler);
        },
        setBounds() {},
        setParams(parameters) {
            this.parameters = parameters;
            this.parameterUpdates.push(parameters);
        },
    };
}

/**
 * Create the Leaflet namespace used by the raster viewer.
 *
 * @return {{leaflet: Object, wmsLayers: Object[]}} Namespace and WMS layers.
 */
function createFakeLeaflet() {
    const wmsLayers = [];
    return {
        wmsLayers,
        leaflet: {
            tileLayer: {
                wms() {
                    const layer = createFakeLayer();
                    wmsLayers.push(layer);
                    return layer;
                },
            },
            rectangle() {
                return createFakeLayer();
            },
        },
    };
}

/**
 * Create a semantic controls adapter for coordinator lifecycle tests.
 *
 * @return {Object} Fake controls view with inspectable presentation state.
 */
function createFakeControlsView() {
    return {
        controlsVisible: false,
        probeVisible: false,
        paletteName: "blue-yellow-red",
        style: null,
        handlers: null,
        displayedStatistics: null,
        renderedStatistics: [],
        percentilePresentation: null,
        applyPercentilesEnabled: true,
        statisticsStatus: "",
        populatePalettes() {},
        bind(handlers) {
            this.handlers = handlers;
        },
        unbind() {
            this.handlers = null;
        },
        readStyle() {
            return { ...this.style };
        },
        setStyle(style, paletteName) {
            this.style = { ...style };
            this.paletteName = paletteName;
        },
        getPaletteName() {
            return this.paletteName;
        },
        setPaletteName(paletteName) {
            this.paletteName = paletteName;
        },
        renderStyleError() {},
        renderLegend() {},
        resetPercentiles() {},
        readPercentiles() {
            return { lower: 5, middle: 50, upper: 95 };
        },
        renderPercentileValues(
            percentiles,
            values,
            isOrdered,
            isApplicable
        ) {
            this.percentilePresentation = {
                percentiles,
                values,
                isOrdered,
                isApplicable,
            };
            this.applyPercentilesEnabled = isOrdered && isApplicable;
        },
        clearStatistics() {
            this.displayedStatistics = null;
        },
        setStatisticsBusy() {},
        setStatisticsStatus(message) {
            this.statisticsStatus = message;
        },
        renderHistogram(statistics) {
            this.displayedStatistics = statistics;
            this.renderedStatistics.push(statistics);
        },
        clearHistogram() {
            this.displayedStatistics = null;
        },
        showHistogramAxis() {},
        hideHistogramAxis() {},
        setPercentileControlsVisible() {},
        setStatisticsRetryVisible() {},
        setApplyPercentilesEnabled(isEnabled) {
            this.applyPercentilesEnabled = isEnabled;
        },
        setSampleWindowSize() {},
        setSampleWindowInvalid() {},
        setSampleWindowStatus() {},
        setClearSampleWindowEnabled() {},
        setControlsVisible(isVisible) {
            this.controlsVisible = isVisible;
        },
        isPixelProbeVisible() {
            return this.probeVisible;
        },
        setPixelProbeContent() {},
        showPixelProbe() {
            this.probeVisible = true;
            return { width: 100, height: 40 };
        },
        positionPixelProbe() {},
        hidePixelProbe() {
            this.probeVisible = false;
        },
    };
}

/**
 * Create an externally resolvable promise.
 *
 * @return {{promise: Promise<*>, resolve: (value: *) => void,
 * reject: (error: Error) => void}} Deferred promise contract.
 */
function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

/**
 * Allow pending async controller continuations to update their views.
 *
 * @return {Promise<void>} Resolves on the next event-loop turn.
 */
function flushPromises() {
    return new Promise((resolve) => setImmediate(resolve));
}

test("raster viewer owns the displayed layer lifecycle and detaches cleanly", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            publishRaster: async () => ({
                layerName: "eolab:test-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: () => new Promise(() => {}),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    assert.equal(leafletMap.container.listenerCount("pointermove"), 1);
    assert.equal(leafletMap.handlers.get("mousemove").size, 1);
    const published = await viewer.show(MOUNTED_GEOTIFF_ITEM);
    assert.equal(published.layerName, "eolab:test-raster");
    assert.equal(viewer.isDisplayed, true);
    assert.equal(controlsView.controlsVisible, true);
    assert.equal(wmsLayers.length, 1);
    assert.equal(leafletMap.layers.has(wmsLayers[0]), true);

    viewer.clear();
    assert.equal(viewer.isDisplayed, false);
    assert.equal(controlsView.controlsVisible, false);
    assert.equal(leafletMap.layers.has(wmsLayers[0]), false);
    assert.equal(leafletMap.handlers.get("mousemove").size, 1);

    viewer.destroy();
    assert.equal(controlsView.handlers, null);
    assert.equal(leafletMap.container.listenerCount("pointermove"), 0);
    assert.equal(leafletMap.handlers.get("mousemove").size, 0);
});

test("raster viewer ignores publication completed after a reset", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const publication = createDeferred();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            publishRaster: () => publication.promise,
            loadStatistics: () => new Promise(() => {}),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    const showResult = viewer.show(MOUNTED_GEOTIFF_ITEM);
    viewer.reset();
    publication.resolve({
        layerName: "eolab:stale-raster",
        bbox: [-180, -90, 180, 90],
    });

    assert.equal(await showResult, null);
    assert.equal(viewer.isDisplayed, false);
    assert.equal(controlsView.controlsVisible, false);
    assert.equal(wmsLayers.length, 0);
    viewer.destroy();
});

test("selected statistics remain draft-only until the user applies them", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const wholeStatistics = createDeferred();
    const selectedRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            publishRaster: async () => ({
                layerName: "eolab:test-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: (item, signal, selectedBounds) => {
                if (selectedBounds === null) {
                    return wholeStatistics.promise;
                }
                const request = createDeferred();
                selectedRequests.push({ request, selectedBounds });
                return request.promise;
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    await viewer.show(MOUNTED_GEOTIFF_ITEM);
    wholeStatistics.resolve(RASTER_STATISTICS);
    await flushPromises();
    assert.equal(controlsView.displayedStatistics, RASTER_STATISTICS);
    assert.equal(wmsLayers[0].parameterUpdates.length, 1);

    leafletMap.emit("click", { latlng: { lng: -74, lat: 41 } });
    assert.equal(selectedRequests.length, 1);
    assert.equal(controlsView.applyPercentilesEnabled, false);
    const selectedStatistics = {
        ...RASTER_STATISTICS,
        scope: "selectedArea",
        selectedBounds: selectedRequests[0].selectedBounds,
    };
    selectedRequests[0].request.resolve(selectedStatistics);
    await flushPromises();

    assert.equal(controlsView.displayedStatistics, selectedStatistics);
    assert.equal(controlsView.percentilePresentation.isApplicable, true);
    assert.equal(wmsLayers[0].parameterUpdates.length, 1);
    controlsView.handlers.onApplyPercentiles();
    assert.equal(wmsLayers[0].parameterUpdates.length, 2);

    leafletMap.emit("click", { latlng: { lng: -73, lat: 42 } });
    assert.equal(selectedRequests.length, 2);
    selectedRequests[1].request.reject(new Error("selected sample failed"));
    await flushPromises();
    assert.equal(controlsView.displayedStatistics, selectedStatistics);
    assert.equal(controlsView.applyPercentilesEnabled, false);
    assert.match(controlsView.statisticsStatus, /reference/);

    controlsView.handlers.onClearSampleWindow();
    assert.equal(controlsView.displayedStatistics, RASTER_STATISTICS);
    assert.equal(controlsView.percentilePresentation.isApplicable, true);
    viewer.destroy();
});

test("manual style edits prevent late whole-raster automatic rescaling", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const wholeStatistics = createDeferred();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            publishRaster: async () => ({
                layerName: "eolab:test-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: () => wholeStatistics.promise,
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    await viewer.show(MOUNTED_GEOTIFF_ITEM);

    controlsView.style.minimum = 1;
    controlsView.handlers.onStyleInput(false);
    controlsView.handlers.onStyleChange();
    assert.equal(wmsLayers[0].parameterUpdates.length, 1);

    wholeStatistics.resolve(RASTER_STATISTICS);
    await flushPromises();
    assert.equal(wmsLayers[0].parameterUpdates.length, 1);
    assert.equal(controlsView.style.minimum, 1);
    assert.match(
        controlsView.statisticsStatus,
        /current appearance was preserved/
    );
    viewer.destroy();
});
