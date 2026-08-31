import assert from "node:assert/strict";
import test from "node:test";

import { MapLayerController } from "../../src/map-layers/controller.js";
import { initializeRasterViewer } from "../../src/raster/raster-viewer.js";
import { RasterAnalysisRequestError } from "../../src/raster/analysis-api.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";
import {
    EXACT_RASTER_STATISTICS,
    MOUNTED_GEOTIFF_ITEM,
    RASTER_STATISTICS,
    TEMPORARY_AOI_ID,
    TEMPORARY_AOI_RASTER_STATISTICS,
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
    const panes = new Map();
    return {
        container,
        handlers,
        layers,
        panes,
        getPane(name) {
            return panes.get(name);
        },
        createPane(name) {
            const pane = { style: {} };
            panes.set(name, pane);
            return pane;
        },
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
            layer.detach?.();
        },
    };
}

/**
 * Create one Leaflet-compatible layer owned by a fake map.
 *
 * @param {Object} [details={}] Inspectable layer construction details.
 * @return {Object} Fake WMS or rectangle layer.
 */
function createFakeLayer(details = {}) {
    let container = { style: {} };
    return {
        ...details,
        eventHandlers: new Map(),
        parameters: null,
        parameterUpdates: [],
        boundsHistory: details.bounds === undefined ? [] : [details.bounds],
        get container() {
            return container;
        },
        getContainer() {
            return container;
        },
        addTo(map) {
            container ??= { style: {} };
            map.layers.add(this);
            return this;
        },
        detach() {
            container = null;
        },
        once(type, handler) {
            this.eventHandlers.set(type, handler);
        },
        setBounds(bounds) {
            this.boundsHistory.push(bounds);
        },
        setParams(parameters) {
            this.parameters = parameters;
            this.parameterUpdates.push(parameters);
        },
        setOpacity(opacity) {
            this.opacity = opacity;
        },
        setZIndex(zIndex) {
            this.zIndex = zIndex;
        },
    };
}

/**
 * Build the paired-result fields consumed by composition tests.
 *
 * @return {Object} Contract-shaped paired ranges and fixed histogram edges.
 */
function pairedStatistics() {
    return {
        pairedSampleCount: 1,
        histogram: {
            xEdges: Array.from({ length: 33 }, (_, index) => index),
            yEdges: Array.from({ length: 33 }, (_, index) => index + 100),
        },
    };
}

/**
 * Create the Leaflet namespace used by the raster viewer.
 *
 * @return {{leaflet: Object, wmsLayers: Object[], rectangleLayers: Object[]}}
 * Namespace and created layers.
 */
function createFakeLeaflet() {
    const wmsLayers = [];
    const rectangleLayers = [];
    return {
        wmsLayers,
        rectangleLayers,
        leaflet: {
            tileLayer: {
                wms(url, options) {
                    const layer = createFakeLayer({
                        kind: "wms",
                        url,
                        wmsOptions: options,
                    });
                    wmsLayers.push(layer);
                    return layer;
                },
            },
            rectangle(bounds, options) {
                const layer = createFakeLayer({
                    bounds,
                    kind: options.fill === false ? "preview" : "selection",
                    rectangleOptions: options,
                });
                rectangleLayers.push(layer);
                return layer;
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
        appearanceStatus: "",
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
        setAppearanceStatus(message) {
            this.appearanceStatus = message;
        },
        renderLegend(style) {
            this.legendStyle = { ...style };
        },
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
        renderHistogram(statistics, _style, valueLabel) {
            this.displayedStatistics = statistics;
            this.histogramValueLabel = valueLabel;
            this.renderedStatistics.push(statistics);
        },
        clearHistogram() {
            this.displayedStatistics = null;
        },
        setPercentileControlsVisible() {},
        setStatisticsRetryVisible(isVisible) {
            this.statisticsRetryVisible = isVisible;
        },
        setApplyPercentilesEnabled(isEnabled) {
            this.applyPercentilesEnabled = isEnabled;
        },
        setSampleWindowSize(sizeKm) {
            this.sampleWindowSizeKm = sizeKm;
        },
        setSampleWindowInvalid() {},
        setSampleWindowStatus(message) {
            this.sampleWindowStatus = message;
        },
        setClearSampleWindowEnabled(isEnabled) {
            this.clearSampleWindowEnabled = isEnabled;
        },
        setClearSampleWindowLabel(label) {
            this.clearSampleWindowLabel = label;
        },
        setTemporaryAoiAvailability(temporaryAoi) {
            this.availableTemporaryAoi = temporaryAoi;
        },
        setTemporaryAoiCompatible(isCompatible) {
            this.temporaryAoiCompatible = isCompatible;
        },
        setSamplingAreaMode(mode) {
            this.samplingAreaMode = mode;
        },
        showHistogramWidget() {
            this.histogramWidgetOpenCount =
                (this.histogramWidgetOpenCount ?? 0) + 1;
        },
        showAppearanceWidget() {
            this.appearanceWidgetOpenCount =
                (this.appearanceWidgetOpenCount ?? 0) + 1;
        },
        renderLayerHistograms(summaries, activeKey) {
            this.layerHistograms = summaries.map((summary) => ({
                ...summary,
                counts: summary.counts === null
                    ? null
                    : [...summary.counts],
            }));
            this.activeHistogramKey = activeKey;
        },
        setRenderingControlsAvailable(isAvailable) {
            this.renderingControlsAvailable = isAvailable;
        },
        setControlsVisible(isVisible) {
            this.controlsVisible = isVisible;
        },
        setAppearanceEnabled(isEnabled) {
            this.appearanceEnabled = isEnabled;
        },
        setUnivariateHistogramVisible(isVisible) {
            this.univariateHistogramVisible = isVisible;
        },
        setBivariateAvailability(canEnter, guidance) {
            this.bivariateAvailability = { canEnter, guidance };
        },
        renderBivariateMode(state) {
            this.bivariateMode = state;
        },
        setPairedStatisticsLoading(message) {
            this.pairedStatisticsLoading = message;
        },
        renderPairedStatistics(statistics, presentation) {
            this.pairedStatistics = statistics;
            this.pairedPresentation = presentation;
        },
        renderPairedStatisticsError(error, canRetry) {
            this.pairedStatisticsError = { error, canRetry };
        },
        clearPairedStatistics() {
            this.pairedStatistics = null;
            this.pairedStatisticsClearCount =
                (this.pairedStatisticsClearCount ?? 0) + 1;
        },
        highlightPairedStatistics(xValue, yValue) {
            this.pairedHighlight = { xValue, yValue };
        },
        setActiveLayer(label, visible) {
            this.activeLayer = { label, visible };
        },
        isPixelProbeVisible() {
            return this.probeVisible;
        },
        setPixelProbeContent(label, detail) {
            this.pixelProbeContent = { label, detail };
        },
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
 * Create a semantic layer-stack adapter for coordinator tests.
 *
 * @return {Object} Fake stack view with retained snapshots and handlers.
 */
function createFakeLayerStackView() {
    return {
        handlers: null,
        layers: [],
        activeKey: null,
        status: "",
        bind(handlers) {
            this.handlers = handlers;
        },
        unbind() {
            this.handlers = null;
        },
        render(layers, activeKey) {
            this.layers = layers;
            this.activeKey = activeKey;
        },
        setStatus(message) {
            this.status = message;
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
 * Build a distinct mounted GeoTIFF Item for layer-stack tests.
 *
 * @param {string} suffix Stable Item and filename suffix.
 * @return {Object} Catalog Item with valid composite identity and Asset URL.
 */
function createRasterItem(suffix) {
    return {
        collection: "eolab-mounted-geotiffs",
        id: `geotiff-${suffix}`,
        assets: {
            data: {
                href: `file:///scan-source/folder/${suffix}.tif`,
            },
        },
    };
}

/**
 * Build recognizable statistics for one layer and optional selected area.
 *
 * @param {Object} item Catalog Item owning the statistics.
 * @param {Object|null} [selectedBounds=null] Optional selected-area bounds.
 * @return {Object} Valid statistics with test-only layer identity.
 */
function createLayerStatistics(item, selectedBounds = null) {
    return {
        ...RASTER_STATISTICS,
        itemId: item.id,
        scope: selectedBounds === null ? "wholeRaster" : "selectedArea",
        selectedBounds,
    };
}

/**
 * Return rectangular bounds from one normalized test sampling area.
 *
 * @param {Object} samplingArea Whole, selected, or temporary-AOI area.
 * @return {Object|null} Selected rectangle or null for another scope.
 */
function selectedBoundsFromArea(samplingArea) {
    return samplingArea.kind === "selectedArea"
        ? samplingArea.selectedBounds
        : null;
}

/**
 * Allow pending async controller continuations to update their views.
 *
 * @return {Promise<void>} Resolves on the next event-loop turn.
 */
function flushPromises() {
    return new Promise((resolve) => setImmediate(resolve));
}

/** Exercise the real application's visible-layer policy and neutral controller. */
function visibleLayerFixture(loadStatistics = async (item) => createLayerStatistics(item), dependencies = {}) {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    let viewer;
    const mapLayers = new MapLayerController({ leafletMap, view: layerStackView,
        onLayersChange: () => viewer?.syncVisibleLayers() });
    viewer = initializeRasterViewer({ leafletMap, leaflet, wmsUrl: '/geoserver/eolab/wms', onTileError() {} }, {
        controlsView, mapLayerController: mapLayers, loadStatistics,
        publishRaster: async item => ({ layerName: `eolab:${item.id}`, bbox: [-180, -90, 180, 90] }),
        samplePixel: async () => ({ inBounds: true, value: 1 }),
        loadPairedStatistics: async () => pairedStatistics(),
        samplePairPixels: async () => ({}),
        viewport: { innerWidth: 1280, innerHeight: 720 },
        ...dependencies,
    });
    viewer.syncVisibleLayers();
    return { viewer, controlsView, mapLayers, layerStackView, wmsLayers, leaflet, leafletMap,
        destroy() { viewer.destroy(); mapLayers.destroy(); } };
}

test('histogram axis units follow each analyzed data asset', async () => {
    const h = visibleLayerFixture();
    const item = { ...MOUNTED_GEOTIFF_ITEM, assets: { data: {
        ...MOUNTED_GEOTIFF_ITEM.assets.data, "raster:bands": [{unit:"%"}],
    } } };
    await h.viewer.show(item);
    await flushPromises();
    assert.equal(h.controlsView.histogramValueLabel, "Raster value (%)");
    assert.equal(h.controlsView.layerHistograms[0].valueLabel, "Raster value (%)");
    h.destroy();
});

test('two uncached 1D histograms share one read slot and both complete', async () => {
    const reads = [];
    let inflight = 0;
    const h = visibleLayerFixture((item, area, signal) => {
        assert.equal(inflight++, 0, 'the actual viewer must not overlap statistics reads');
        const result = createDeferred();
        reads.push({ item, area, signal, result });
        return result.promise.finally(() => { inflight--; });
    });
    const first = createRasterItem('capacity-first'), second = createRasterItem('capacity-second');
    await h.viewer.show(first);
    reads[0].result.resolve(createLayerStatistics(first));
    await flushPromises();
    await h.viewer.show(second);
    reads[1].result.resolve(createLayerStatistics(second));
    await flushPromises();
    h.leafletMap.emit('click', { latlng: { lng: -74, lat: 41 } });
    assert.equal(reads.length, 3);
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.state), ['loading', 'loading']);
    reads[2].result.resolve(createLayerStatistics(reads[2].item, reads[2].area.selectedBounds));
    await flushPromises();
    assert.equal(reads.length, 4);
    reads[3].result.resolve(createLayerStatistics(reads[3].item, reads[3].area.selectedBounds));
    await flushPromises();
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.state), ['ready', 'ready']);
    assert.equal(inflight, 0);
    h.destroy();
});

test('rapid samples drop obsolete queued work and hidden-layer requests', async () => {
    const reads = [];
    const h = visibleLayerFixture((item, area, signal) => {
        if (area.kind === 'wholeRaster') return Promise.resolve(createLayerStatistics(item));
        const result = createDeferred();
        reads.push({ item, area, signal, result });
        return result.promise;
    });
    await h.viewer.show(createRasterItem('first'));
    await h.viewer.show(createRasterItem('second'));
    await flushPromises();
    h.leafletMap.emit('click', { latlng: { lng: -74, lat: 41 } });
    h.leafletMap.emit('click', { latlng: { lng: -72, lat: 43 } });
    assert.equal(reads.length, 1);
    assert.equal(reads[0].signal.aborted, true);
    const [, bottom] = h.mapLayers.snapshots();
    h.mapLayers.setVisible(bottom.key, false);
    reads[0].result.resolve(createLayerStatistics(reads[0].item, reads[0].area.selectedBounds));
    await flushPromises();
    assert.equal(reads.length, 2);
    assert.notEqual(reads[1].item.id, reads[0].item.id);
    assert.ok(reads[1].area.selectedBounds.west > -74);
    reads[1].result.resolve(createLayerStatistics(reads[1].item, reads[1].area.selectedBounds));
    await flushPromises();
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.state), ['ready']);
    h.leafletMap.emit('click', { latlng: { lng: -70, lat: 45 } });
    h.destroy();
    assert.equal(reads[2].signal.aborted, true);
    reads[2].result.resolve(createLayerStatistics(reads[2].item, reads[2].area.selectedBounds));
    await flushPromises();
    assert.equal(reads.length, 3);
});

test('mode changes cancel queued 1D reads and share the slot with 2D', async () => {
    const reads = [];
    let pairedCalls = 0;
    const h = visibleLayerFixture((item, area, signal) => {
        if (area.kind === 'wholeRaster') return Promise.resolve(createLayerStatistics(item));
        const result = createDeferred();
        reads.push({ item, area, signal, result });
        return result.promise;
    }, { loadPairedStatistics: async () => { pairedCalls++; return pairedStatistics(); } });
    await h.viewer.show(createRasterItem('first'));
    await h.viewer.show(createRasterItem('second'));
    await flushPromises();
    h.leafletMap.emit('click', { latlng: { lng: -74, lat: 41 } });
    h.controlsView.handlers.onBivariateModeChange('bivariate');
    assert.equal(reads.length, 1);
    assert.equal(reads[0].signal.aborted, true);
    assert.equal(pairedCalls, 0);
    reads[0].result.resolve(createLayerStatistics(reads[0].item, reads[0].area.selectedBounds));
    await flushPromises();
    assert.equal(pairedCalls, 1);
    assert.equal(reads.length, 1, 'the canceled second 1D request must never start');
    h.controlsView.handlers.onBivariateModeChange('overlay');
    for (let i = 1; i <= 2; i++) {
        assert.equal(reads.length, i + 1);
        reads[i].result.resolve(createLayerStatistics(reads[i].item, reads[i].area.selectedBounds));
        await flushPromises();
    }
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.state), ['ready', 'ready']);
    h.destroy();
});

test('closing histogram sampling preserves its footprint and results across map and layer changes', async () => {
    const requests = [];
    const h = visibleLayerFixture(async (item, area) => {
        requests.push({ item, area });
        return createLayerStatistics(item, selectedBoundsFromArea(area));
    });
    await h.viewer.show(createRasterItem('first'));
    await h.viewer.show(createRasterItem('second'));
    await flushPromises();
    h.leafletMap.emit('click', { latlng: { lng: 0, lat: 0 } });
    await flushPromises();
    const statistics = h.controlsView.displayedStatistics;
    const footprint = [...h.leafletMap.layers].find(layer => layer.kind === 'selection');
    assert.ok(footprint);
    assert.equal(statistics.scope, 'selectedArea');
    const bounds = [...footprint.boundsHistory];
    h.viewer.stopSampleWindowSelection();
    assert.match(h.controlsView.sampleWindowStatus, /Selection paused/);
    assert.equal(h.controlsView.displayedStatistics, statistics);
    assert.equal(h.leafletMap.layers.has(footprint), true);
    assert.equal([...h.leafletMap.layers].some(layer => layer.kind === 'preview'), false);
    const count = requests.length;
    h.leafletMap.emit('moveend', {});
    h.leafletMap.emit('zoomend', {});
    h.leafletMap.emit('click', { latlng: { lng: 4, lat: 4 } });
    await flushPromises();
    assert.equal(requests.length, count);
    assert.deepEqual(footprint.boundsHistory, bounds);
    h.mapLayers.setVisible(h.mapLayers.snapshots()[0].key, false);
    await flushPromises();
    const afterVisibility = requests.length;
    h.leafletMap.emit('click', { latlng: { lng: 8, lat: 8 } });
    await flushPromises();
    assert.equal(requests.length, afterVisibility, 'layer changes must not re-arm sampling');
    assert.equal(h.controlsView.displayedStatistics.scope, 'selectedArea');
    h.controlsView.handlers.onSelectSampleWindow();
    h.leafletMap.emit('click', { latlng: { lng: 4, lat: 4 } });
    await flushPromises();
    assert.ok(requests.length > afterVisibility);
    assert.notDeepEqual(h.controlsView.displayedStatistics.selectedBounds, statistics.selectedBounds);
    h.destroy();
});

test('visible raster histograms follow order, skip vectors and never follow the style editor', async () => {
    const h = visibleLayerFixture();
    const first = createRasterItem('first'), second = createRasterItem('second');
    await h.viewer.show(first);
    await h.viewer.show(second);
    await flushPromises();
    const [secondKey, firstKey] = h.mapLayers.snapshots().map(layer => layer.key);
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.label), ['second.tif', 'first.tif']);
    assert.ok(h.controlsView.layerHistograms.every(s => s.automatic && s.state === 'ready'));
    assert.equal(h.controlsView.bivariateMode.active, false);
    assert.equal(h.viewer.openStyle(firstKey), true);
    h.controlsView.style = { ...h.controlsView.style, minimum: -2, midpoint: 4, maximum: 25 };
    h.controlsView.handlers.onStyleInput(false);
    h.controlsView.handlers.onStyleChange();
    assert.equal(h.mapLayers.activeKey, secondKey);
    assert.equal(h.mapLayers.getRecord(firstKey).state.rasterStyle.minimum, -2);
    assert.notEqual(h.mapLayers.getRecord(secondKey).state.rasterStyle.minimum, -2);
    h.mapLayers.move(firstKey, 'up');
    assert.equal(h.controlsView.style.minimum, -2);
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.label), ['first.tif', 'second.tif']);
    h.mapLayers.setVisible(firstKey, false);
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.label), ['second.tif']);
    h.controlsView.paletteName = 'viridis';
    h.controlsView.handlers.onPaletteChange();
    assert.equal(h.mapLayers.getRecord(firstKey).entry.visible, false);
    assert.equal(h.mapLayers.getRecord(firstKey).state.paletteName, 'viridis');
    assert.equal(h.mapLayers.getRecord(secondKey).state.paletteName, 'blue-yellow-red');
    const vector = { collection: 'vectors', id: 'volcanoes' };
    await h.mapLayers.show(vector, {
        label: () => 'volcanoes.gpkg', publish: async () => ({}), createState: () => ({}),
        createLayer: () => h.leaflet.tileLayer.wms('/geoserver/eolab/wms', {}),
        snapshot: () => ({ legend: { kind: 'fixed' } }), tileErrorMessage: 'Vector tile error',
    });
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.label), ['second.tif']);
    h.mapLayers.setVisible(secondKey, false);
    assert.deepEqual(h.controlsView.layerHistograms, []);
    assert.equal(h.controlsView.controlsVisible, false);
    h.viewer.activateAnalysis(first);
    assert.deepEqual(h.controlsView.layerHistograms, [], 'Catalog details cannot steal histogram input');
    h.mapLayers.removeKey(firstKey);
    h.viewer.closeStyle();
    h.destroy();
});

test('visible policy keeps 2D explicit and restores ordinary opacity when a pair is hidden', async () => {
    const h = visibleLayerFixture();
    await h.viewer.show(createRasterItem('x'));
    await h.viewer.show(createRasterItem('y'));
    await flushPromises();
    const [top, bottom] = h.mapLayers.snapshots();
    h.mapLayers.setOpacity(bottom.key, 0.35);
    assert.equal(h.controlsView.bivariateMode.active, false);
    h.controlsView.handlers.onBivariateModeChange('bivariate');
    await flushPromises();
    assert.equal(h.controlsView.bivariateMode.active, true);
    assert.ok(h.mapLayers.snapshots().every(layer => layer.opacityLocked));
    h.viewer.openStyle(bottom.key);
    assert.equal(h.controlsView.appearanceEnabled, false);
    h.mapLayers.setVisible(top.key, false);
    assert.equal(h.controlsView.bivariateMode.active, false);
    assert.equal(h.mapLayers.getLeafletLayer(bottom.key).opacity, 0.35);
    assert.equal(h.controlsView.appearanceEnabled, true);
    h.destroy();
});

test('a late histogram cannot overwrite another layer editor or an edited range', async () => {
    const pending = createDeferred();
    const h = visibleLayerFixture(item => item.id.endsWith('later')
        ? pending.promise : Promise.resolve(createLayerStatistics(item)));
    const first = createRasterItem('first'), later = createRasterItem('later');
    await h.viewer.show(first);
    await flushPromises();
    const firstKey = h.mapLayers.snapshots()[0].key;
    await h.viewer.show(later);
    h.viewer.openStyle(firstKey);
    h.controlsView.style = { ...h.controlsView.style, minimum: -2, midpoint: 4, maximum: 25 };
    h.controlsView.handlers.onStyleInput(false);
    pending.resolve(createLayerStatistics(later));
    await flushPromises();
    assert.equal(h.controlsView.style.minimum, -2);
    h.mapLayers.removeKey(firstKey);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.notEqual(h.mapLayers.snapshots()[0].legend.labels[0], -2);
    h.destroy();
});

test('explicit low-resolution previews retain styling and histogram access', async () => {
    const h = visibleLayerFixture();
    const item = createRasterItem('sampled');
    const edits = [];
    h.viewer.activateSampled(item, DEFAULT_RASTER_STYLE, style => edits.push(style));
    await flushPromises();
    const summary = h.controlsView.layerHistograms[0];
    assert.match(summary.label, /sampled/);
    assert.equal(h.viewer.getSampledStyleTarget(summary.key).sampled, true);
    assert.equal(h.viewer.openStyle(summary.key), true);
    h.controlsView.paletteName = 'viridis';
    h.controlsView.handlers.onPaletteChange();
    assert.equal(edits.at(-1).minimumColor, '#440154');
    h.viewer.removeSampled(item);
    h.viewer.closeStyle();
    assert.deepEqual(h.controlsView.layerHistograms, []);
    h.destroy();
});

test('hidden candidates do not request automatic histograms until made visible', async () => {
    const requests = [];
    const h = visibleLayerFixture(async item => {
        requests.push(item.id);
        return createLayerStatistics(item);
    });
    await h.viewer.show(createRasterItem('first'));
    await h.viewer.show(createRasterItem('second'));
    await h.viewer.show(createRasterItem('hidden'));
    await flushPromises();
    assert.equal(requests.includes('geotiff-hidden'), false);
    const [hidden, second] = h.mapLayers.snapshots();
    h.mapLayers.setVisible(second.key, false);
    h.mapLayers.setVisible(hidden.key, true);
    await flushPromises();
    assert.equal(requests.includes('geotiff-hidden'), true);
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.label), ['hidden.tif', 'first.tif']);
    h.destroy();
});

test("selecting 2D opens paired analysis without a map interaction", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const pairedRequests = [];
    const pairedPixelRequests = [];
    let histogramPresentationRequests = 0;
    const firstItem = createRasterItem("first");
    const secondItem = createRasterItem("second");
    const mapLayerController = new MapLayerController({ leafletMap, view: layerStackView });
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
            onHistogramRequested() {
                histogramPresentationRequests += 1;
            },
        },
        {
            controlsView,
            layerStackView,
            mapLayerController,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async () => RASTER_STATISTICS,
            loadPairedStatistics: async (xItem, yItem, area) => {
                pairedRequests.push({ xItem, yItem, area });
                return pairedStatistics();
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            samplePairPixels: async (pair, point) => {
                pairedPixelRequests.push({ pair, point });
                return {
                    x: {
                        available: true,
                        pixel: { inBounds: true, value: 9 },
                        error: null,
                    },
                    y: {
                        available: true,
                        pixel: { inBounds: true, value: 4 },
                        error: null,
                    },
                };
            },
            viewport: { innerWidth: 1280, innerHeight: 720 },
        },
    );

    viewer.activateAnalysis(firstItem);
    await flushPromises();
    await viewer.show(firstItem);
    await flushPromises();
    viewer.activateAnalysis(secondItem);
    await flushPromises();
    await viewer.show(secondItem);
    await flushPromises();
    assert.equal(controlsView.bivariateAvailability.canEnter, true);
    const [top, bottom] = layerStackView.layers;
    mapLayerController.setOpacity(bottom.key, 0.4);
    controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();

    assert.deepEqual(
        pairedRequests.map(({ xItem, yItem, area }) => ({
            x: xItem.id,
            y: yItem.id,
            area: area.kind,
        })),
        [{ x: secondItem.id, y: firstItem.id, area: "wholeOverlap" }],
    );
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(histogramPresentationRequests, 1);
    assert.equal(pairedPixelRequests.length, 0);
    assert.match(
        controlsView.bivariateAvailability.guidance,
        /2D comparison styles both rasters.*blending at 100% opacity/
    );
    assert.equal(controlsView.appearanceEnabled, false);
    assert.equal(controlsView.univariateHistogramVisible, false);
    assert.equal(controlsView.temporaryAoiCompatible, false);
    assert.ok(layerStackView.layers.every((layer) => layer.opacityLocked));
    assert.ok(layerStackView.layers.every(
        (layer) => layer.effectiveOpacity === 1,
    ));
    assert.equal(wmsLayers[0].opacity, 1);
    assert.equal(wmsLayers[1].opacity, 1);
    assert.equal(wmsLayers[0].container.style.mixBlendMode, "normal");
    assert.equal(wmsLayers[1].container.style.mixBlendMode, "plus-lighter");
    assert.deepEqual(
        [
            controlsView.bivariateMode.xStyle.minimum,
            controlsView.bivariateMode.xStyle.midpoint,
            controlsView.bivariateMode.xStyle.maximum,
        ],
        [-4, 3, 20],
    );
    assert.deepEqual(
        [
            controlsView.bivariateMode.yStyle.minimum,
            controlsView.bivariateMode.yStyle.midpoint,
            controlsView.bivariateMode.yStyle.maximum,
        ],
        [-4, 3, 20],
    );

    controlsView.handlers.onBivariatePaletteChange("steelRose");
    assert.equal(controlsView.bivariateMode.paletteName, "steelRose");
    assert.match(wmsLayers[0].parameters.env, /cmin:#111827/);
    assert.match(wmsLayers[1].parameters.env, /cmin:#111827/);

    leafletMap.emit("mousemove", { latlng: { lng: -122, lat: 49 } });
    await flushPromises();
    assert.equal(pairedPixelRequests.length, 1);
    assert.deepEqual(controlsView.pairedHighlight, { xValue: 9, yValue: 4 });
    assert.match(controlsView.pixelProbeContent.detail, /second\.tif: 9/);
    assert.match(controlsView.pixelProbeContent.detail, /first\.tif: 4/);

    wmsLayers[0].eventHandlers.get("tileerror")();
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(controlsView.bivariateAvailability.canEnter, true);

    layerStackView.handlers.onVisibility(top.key, false);
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(controlsView.bivariateAvailability.canEnter, true);
    assert.equal(controlsView.appearanceEnabled, false);
    assert.equal(controlsView.univariateHistogramVisible, false);
    assert.equal(wmsLayers[0].opacity, 1);
    assert.equal(wmsLayers[0].container.style.mixBlendMode, "normal");
    assert.equal(wmsLayers[1].container, null);

    controlsView.handlers.onBivariateModeChange("overlay");
    assert.equal(controlsView.bivariateMode.active, false);
    controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();
    assert.equal(wmsLayers[0].container.style.mixBlendMode, "normal");
    assert.equal(wmsLayers[1].container, null);

    layerStackView.handlers.onVisibility(top.key, true);
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(wmsLayers[1].container.style.mixBlendMode, "plus-lighter");
    layerStackView.handlers.onRemove(bottom.key);
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(controlsView.bivariateAvailability.canEnter, true);
    assert.equal(wmsLayers[1].container.style.mixBlendMode, "normal");
    assert.equal(viewer.contains(firstItem), false);
    assert.equal(viewer.contains(secondItem), true);
    controlsView.handlers.onBivariateModeChange("overlay");
    assert.equal(controlsView.bivariateMode.active, false);
    viewer.destroy();
    mapLayerController.destroy();
});

test("catalog selections enable paired analysis without publication", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const pairedRequests = [];
    const firstItem = createRasterItem("analysis-only-first");
    const secondItem = createRasterItem("analysis-only-second");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => {
                throw new Error("paired analysis must not publish WMS");
            },
            loadStatistics: (_item, _area, signal) => new Promise((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
            loadPairedStatistics: async (xItem, yItem, area) => {
                pairedRequests.push({ xItem, yItem, area });
                const statistics = pairedStatistics();
                statistics.histogram.xEdges = Array.from(
                    { length: 33 },
                    (_, index) => index * 100 / 32,
                );
                return statistics;
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            samplePairPixels: async () => ({
                x: { available: true, pixel: { value: 1 }, error: null },
                y: { available: true, pixel: { value: 2 }, error: null },
            }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        },
    );

    viewer.activateAnalysis(firstItem);
    await flushPromises();
    viewer.activateAnalysis(secondItem);
    await flushPromises();

    assert.equal(wmsLayers.length, 0);
    assert.equal(controlsView.bivariateAvailability.canEnter, true);
    controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();

    assert.equal(controlsView.bivariateMode.active, true);
    assert.deepEqual(
        pairedRequests.map(({ xItem, yItem, area }) => ({
            x: xItem.id,
            y: yItem.id,
            area: area.kind,
        })),
        [{
            x: secondItem.id,
            y: firstItem.id,
            area: "wholeOverlap",
        }],
    );
    assert.equal(
        controlsView.pairedPresentation.xLabel,
        "analysis-only-second.tif",
    );
    assert.equal(
        controlsView.pairedPresentation.yLabel,
        "analysis-only-first.tif",
    );
    assert.deepEqual(
        [
            controlsView.bivariateMode.xStyle.minimum,
            controlsView.bivariateMode.xStyle.midpoint,
            controlsView.bivariateMode.xStyle.maximum,
        ],
        [0, 50, 100],
    );
    assert.deepEqual(
        [
            controlsView.bivariateMode.yStyle.minimum,
            controlsView.bivariateMode.yStyle.midpoint,
            controlsView.bivariateMode.yStyle.maximum,
        ],
        [100, 116, 132],
    );
    viewer.activateAnalysis(secondItem);
    await flushPromises();
    assert.deepEqual(
        [
            controlsView.bivariateMode.xStyle.minimum,
            controlsView.bivariateMode.xStyle.midpoint,
            controlsView.bivariateMode.xStyle.maximum,
        ],
        [0, 50, 100],
    );
    viewer.activateSampled(secondItem, DEFAULT_RASTER_STYLE, () => {});
    const firstFiniteStyle = {
        ...DEFAULT_RASTER_STYLE,
        minimum: -10,
        midpoint: 10,
        maximum: 30,
    };
    viewer.updateSampledInitialStyle(secondItem, firstFiniteStyle);
    assert.deepEqual(
        [
            controlsView.pairedPresentation.xStyle.minimum,
            controlsView.pairedPresentation.xStyle.midpoint,
            controlsView.pairedPresentation.xStyle.maximum,
        ],
        [-10, 10, 30],
    );
    viewer.removeSampled(secondItem);
    viewer.deactivateAnalysis(secondItem);
    assert.equal(controlsView.controlsVisible, true);
    leafletMap.emit("click", { latlng: { lng: -100, lat: 40 } });
    await flushPromises();
    assert.equal(pairedRequests.at(-1).area.kind, "selectedArea");
    controlsView.handlers.onBivariateModeChange("overlay");
    assert.equal(controlsView.controlsVisible, false);
    assert.equal(wmsLayers.length, 0);
    viewer.destroy();
});

test("2D sampling remains independent from raster sessions and renderers", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const pairedRequests = [];
    const ordinaryRequests = [];
    let resolveSelectedPair;
    const firstItem = createRasterItem("sampling-first");
    const secondItem = createRasterItem("sampling-second");
    const renderingOnlyItem = createRasterItem("rendering-only");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, area) => {
                ordinaryRequests.push({ item, area });
                return RASTER_STATISTICS;
            },
            loadPairedStatistics: async (xItem, yItem, area) => {
                pairedRequests.push({ xItem, yItem, area });
                if (pairedRequests.length === 2) {
                    return new Promise((resolve) => {
                        resolveSelectedPair = resolve;
                    });
                }
                return pairedStatistics();
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            samplePairPixels: async () => ({
                x: { available: true, pixel: { value: 1 }, error: null },
                y: { available: true, pixel: { value: 2 }, error: null },
            }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        },
    );

    viewer.activateAnalysis(firstItem);
    await flushPromises();
    viewer.activateAnalysis(secondItem);
    await flushPromises();
    leafletMap.emit("click", { latlng: { lng: -80, lat: 20 } });
    await flushPromises();
    const ordinaryBounds = ordinaryRequests.at(-1).area.selectedBounds;
    controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();
    assert.equal(controlsView.pairedStatistics.pairedSampleCount, 1);

    const clearsBeforeSelection = controlsView.pairedStatisticsClearCount;
    leafletMap.emit("click", { latlng: { lng: -100, lat: 40 } });
    assert.equal(pairedRequests.length, 2);
    assert.equal(pairedRequests[1].area.kind, "selectedArea");
    assert.equal(controlsView.pairedStatistics, null);
    assert.equal(
        controlsView.pairedStatisticsClearCount,
        clearsBeforeSelection + 1,
    );

    resolveSelectedPair(pairedStatistics());
    await flushPromises();
    assert.equal(controlsView.pairedStatistics.pairedSampleCount, 1);

    controlsView.handlers.onBivariateModeChange("overlay");
    assert.equal(controlsView.samplingAreaMode, "selectedArea");
    controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();
    assert.deepEqual(
        pairedRequests.at(-1).area.selectedBounds,
        ordinaryBounds,
    );
    viewer.activateAnalysis(firstItem);
    await flushPromises();
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(controlsView.samplingAreaMode, "selectedArea");
    assert.equal(pairedRequests.length, 3);

    const ordinaryCountBeforeClear = ordinaryRequests.length;
    controlsView.handlers.onClearSampleWindow();
    await flushPromises();
    assert.equal(pairedRequests.at(-1).area.kind, "wholeOverlap");
    assert.equal(controlsView.samplingAreaMode, "wholeRaster");
    assert.equal(ordinaryRequests.length, ordinaryCountBeforeClear);

    viewer.activateSampled(
        renderingOnlyItem,
        {
            minimum: 0,
            midpoint: 1,
            maximum: 2,
            minimumColor: "#000000",
            midpointColor: "#777777",
            maximumColor: "#ffffff",
        },
        () => {},
    );
    await viewer.show(renderingOnlyItem);
    await flushPromises();
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(controlsView.bivariateMode.xLabel, "sampling-second.tif");
    assert.equal(controlsView.bivariateMode.yLabel, "sampling-first.tif");
    viewer.destroy();
});

test("raster viewer owns the displayed layer lifecycle and detaches cleanly", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
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

    layerStackView.setStatus("Previous layer message");
    viewer.clear();
    assert.equal(viewer.isDisplayed, false);
    assert.equal(controlsView.controlsVisible, false);
    assert.equal(layerStackView.status, "");
    assert.equal(leafletMap.layers.has(wmsLayers[0]), false);
    assert.equal(leafletMap.handlers.get("mousemove").size, 1);

    viewer.destroy();
    assert.equal(controlsView.handlers, null);
    assert.equal(leafletMap.container.listenerCount("pointermove"), 0);
    assert.equal(leafletMap.handlers.get("mousemove").size, 0);
});

test("renderer-independent analysis supports exact windows without publication", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const statisticsRequests = [];
    const pixelRequests = [];
    let publicationCalls = 0;
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => {
                publicationCalls += 1;
                throw new Error("analysis must not publish a raster");
            },
            loadStatistics: async (item, samplingArea, signal) => {
                statisticsRequests.push({ item, samplingArea, signal });
                return samplingArea.kind === "wholeRaster"
                    ? EXACT_RASTER_STATISTICS
                    : {
                        ...EXACT_RASTER_STATISTICS,
                        scope: "selectedArea",
                        selectedBounds: samplingArea.selectedBounds,
                    };
            },
            samplePixel: async (item, point) => {
                pixelRequests.push({ item, point });
                return { inBounds: true, value: 17 };
            },
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    viewer.activateAnalysis(MOUNTED_GEOTIFF_ITEM);
    await flushPromises();

    assert.equal(viewer.isDisplayed, false);
    assert.equal(publicationCalls, 0);
    assert.equal(wmsLayers.length, 0);
    assert.equal(controlsView.controlsVisible, true);
    assert.equal(controlsView.renderingControlsAvailable, false);
    assert.equal(controlsView.activeLayer.label, "annual temperature.tif");
    assert.deepEqual(
        statisticsRequests.map(({ samplingArea }) => samplingArea.kind),
        ["wholeRaster"]
    );
    assert.match(controlsView.statisticsStatus, /Whole-raster exact/);
    assert.equal(controlsView.displayedStatistics.estimated, false);

    leafletMap.emit("mousemove", { latlng: { lng: -122, lat: 48.5 } });
    await flushPromises();
    assert.deepEqual(pixelRequests, [{
        item: MOUNTED_GEOTIFF_ITEM,
        point: { longitude: -122, latitude: 48.5 },
    }]);
    leafletMap.emit("click", { latlng: { lng: -122, lat: 48.5 } });
    await flushPromises();
    assert.equal(controlsView.histogramWidgetOpenCount, 1);
    assert.equal(statisticsRequests.at(-1).samplingArea.kind, "selectedArea");
    assert.match(controlsView.statisticsStatus, /Selected-area exact/);

    controlsView.setPaletteName("viridis");
    controlsView.handlers.onPaletteChange();
    assert.equal(controlsView.legendStyle.minimumColor, "#440154");
    assert.equal(controlsView.appearanceStatus, "Applied the Viridis palette.");
    controlsView.handlers.onApplyPercentiles();
    assert.match(controlsView.appearanceStatus, /histogram percentile range/);
    assert.match(controlsView.appearanceStatus, /histogram percentile range/);
    controlsView.handlers.onResetStyle();
    assert.match(controlsView.statisticsStatus, /exact bounded histogram/);
    assert.equal(
        controlsView.appearanceStatus,
        "Restored the initial colors and range."
    );

    viewer.deactivateAnalysis(MOUNTED_GEOTIFF_ITEM);
    assert.equal(controlsView.controlsVisible, false);
    viewer.destroy();
});

test("WMS activation adopts the existing renderer-neutral analysis session", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    let statisticsRequests = 0;
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => ({
                layerName: "eolab:test-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async () => {
                statisticsRequests += 1;
                return RASTER_STATISTICS;
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    viewer.activateAnalysis(MOUNTED_GEOTIFF_ITEM);
    await flushPromises();
    assert.equal(statisticsRequests, 1);
    assert.equal(controlsView.activeLayer.label, "annual temperature.tif");

    await viewer.show(MOUNTED_GEOTIFF_ITEM);

    assert.equal(statisticsRequests, 1);
    assert.equal(wmsLayers.length, 1);
    assert.equal(viewer.isDisplayed, true);
    assert.equal(controlsView.renderingControlsAvailable, true);
    assert.equal(controlsView.activeLayer.visible, true);
    assert.equal(controlsView.displayedStatistics, RASTER_STATISTICS);
    viewer.destroy();
});

test("a pending WMS publication cannot steal newer Catalog analysis", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const publication = createDeferred();
    const publishing = createRasterItem("pending-publication");
    const selected = createRasterItem("newer-analysis");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: () => publication.promise,
            loadStatistics: async (item, samplingArea) =>
                createLayerStatistics(
                    item,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    viewer.activateAnalysis(publishing);
    await flushPromises();
    const pendingShow = viewer.show(publishing);
    viewer.activateAnalysis(selected);
    await flushPromises();
    publication.resolve({
        layerName: `eolab:${publishing.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await pendingShow;
    await flushPromises();

    assert.equal(viewer.contains(publishing), true);
    assert.equal(layerStackView.activeKey, null);
    assert.match(controlsView.activeLayer.label, /newer-analysis/);
    assert.equal(controlsView.activeLayer.label, "newer-analysis.tif");
    assert.equal(controlsView.displayedStatistics.itemId, selected.id);
    viewer.destroy();
});

test("reaffirming Catalog analysis invalidates a pending WMS activation", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const publication = createDeferred();
    const item = createRasterItem("reaffirmed-analysis");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: () => publication.promise,
            loadStatistics: async (requestedItem, samplingArea) =>
                createLayerStatistics(
                    requestedItem,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    viewer.activateAnalysis(item);
    await flushPromises();
    const pendingShow = viewer.show(item);
    viewer.activateAnalysis(item);
    publication.resolve({
        layerName: `eolab:${item.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await pendingShow;

    assert.equal(viewer.contains(item), true);
    assert.equal(layerStackView.activeKey, null);
    assert.match(controlsView.activeLayer.label, /reaffirmed-analysis/);
    assert.equal(controlsView.activeLayer.label, "reaffirmed-analysis.tif");
    assert.equal(controlsView.displayedStatistics.itemId, item.id);
    viewer.destroy();
});

test("clearing analysis invalidates a pending renderer activation", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const publication = createDeferred();
    const item = createRasterItem("cleared-analysis");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: () => publication.promise,
            loadStatistics: async (requestedItem, samplingArea) =>
                createLayerStatistics(
                    requestedItem,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    viewer.activateAnalysis(item);
    const pendingShow = viewer.show(item);
    viewer.deactivateAnalysis(item);
    publication.resolve({
        layerName: `eolab:${item.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await pendingShow;

    assert.equal(controlsView.controlsVisible, false);
    assert.equal(viewer.contains(item), true);
    viewer.destroy();
});

test("renderer changes abort and ignore obsolete analysis responses", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const requests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            loadStatistics(_item, samplingArea, signal) {
                const result = createDeferred();
                requests.push({ samplingArea, signal, result });
                return result.promise;
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const style = {
        minimum: 0,
        midpoint: 50,
        maximum: 100,
        minimumColor: "#2b83ba",
        midpointColor: "#ffffbf",
        maximumColor: "#d7191c",
    };

    viewer.activateAnalysis(MOUNTED_GEOTIFF_ITEM);
    viewer.activateSampled(MOUNTED_GEOTIFF_ITEM, style, () => {});

    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, true);
    requests[0].result.resolve(RASTER_STATISTICS);
    await flushPromises();
    assert.equal(requests.length, 2);
    requests[1].result.resolve(EXACT_RASTER_STATISTICS);
    await flushPromises();

    assert.equal(controlsView.displayedStatistics, EXACT_RASTER_STATISTICS);
    assert.match(controlsView.activeLayer.label, /sampled raster/);
    controlsView.handlers.onResetStyle();
    assert.match(controlsView.statisticsStatus, /exact bounded histogram/);
    viewer.destroy();
});

test("a ready AOI owns detail-only statistics before map-window handlers", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, rectangleLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const statisticsRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            loadStatistics: async (item, samplingArea, signal) => {
                statisticsRequests.push({ item, samplingArea, signal });
                return TEMPORARY_AOI_RASTER_STATISTICS;
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const temporaryAoi = Object.freeze({
        id: TEMPORARY_AOI_ID,
        filename: "detail-area.gpkg",
        selectedDataset: "boundary",
        expiresAt: "2030-01-01T01:00:00Z",
    });
    const style = {
        minimum: 0,
        midpoint: 50,
        maximum: 100,
        minimumColor: "#2b83ba",
        midpointColor: "#ffffbf",
        maximumColor: "#d7191c",
    };

    viewer.setTemporaryAoi(temporaryAoi);
    viewer.activateAnalysis(MOUNTED_GEOTIFF_ITEM);
    await flushPromises();
    viewer.activateSampled(MOUNTED_GEOTIFF_ITEM, style, () => {});
    await flushPromises();

    assert.deepEqual(
        statisticsRequests.map(({ samplingArea }) => samplingArea),
        [{ kind: "temporaryAoi", temporaryAoiId: TEMPORARY_AOI_ID }]
    );
    assert.equal(controlsView.samplingAreaMode, "temporaryAoi");
    const requestCount = statisticsRequests.length;
    leafletMap.emit("click", { latlng: { lng: -122, lat: 48.5 } });
    assert.equal(statisticsRequests.length, requestCount);
    assert.equal(rectangleLayers.length, 0);

    viewer.destroy();
});

test("sampled rasters reuse color controls and bounded click histograms", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const styleChanges = [];
    const histogramRequests = [];
    const pixelRequests = [];
    let wholeStatisticsRequests = 0;
    const initialStyle = {
        minimum: -12,
        midpoint: 4,
        maximum: 30,
        minimumColor: "#2b83ba",
        midpointColor: "#ffffbf",
        maximumColor: "#d7191c",
    };
    const firstFiniteStyle = {
        ...initialStyle,
        minimum: -20,
        midpoint: 2,
        maximum: 45,
    };
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => {
                throw new Error("sampled raster must not publish WMS");
            },
            loadStatistics: async (item, samplingArea, signal) => {
                if (samplingArea.kind === "wholeRaster") {
                    wholeStatisticsRequests += 1;
                    return RASTER_STATISTICS;
                }
                const selectedBounds = samplingArea.selectedBounds;
                histogramRequests.push({ item, signal, selectedBounds });
                return {
                    ...RASTER_STATISTICS,
                    scope: "selectedArea",
                    selectedBounds,
                    sourceWidth: 127,
                    sourceHeight: 127,
                    sourcePixelCount: 127 * 127,
                    sampleWidth: 127,
                    sampleHeight: 127,
                    sampledPixelCount: 127 * 127,
                    samplingMethod: "sampleGrid",
                };
            },
            samplePixel: async (...request) => {
                pixelRequests.push(request);
                return { inBounds: true, value: 1 };
            },
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    viewer.activateSampled(
        MOUNTED_GEOTIFF_ITEM,
        initialStyle,
        (style) => styleChanges.push({ ...style })
    );
    await flushPromises();
    assert.equal(viewer.isDisplayed, true);
    assert.equal(controlsView.controlsVisible, true);
    assert.equal(controlsView.renderingControlsAvailable, true);
    assert.match(controlsView.activeLayer.label, /sampled raster/);
    assert.equal(controlsView.samplingAreaMode, "wholeRaster");
    assert.equal(controlsView.clearSampleWindowLabel, "Use whole raster");
    assert.equal(controlsView.availableTemporaryAoi, null);
    assert.match(controlsView.statisticsStatus, /Whole-raster approximate/);
    assert.equal(wholeStatisticsRequests, 1);
    assert.equal(wmsLayers.length, 0);

    viewer.updateSampledInitialStyle(
        MOUNTED_GEOTIFF_ITEM,
        firstFiniteStyle
    );
    assert.deepEqual(controlsView.style, firstFiniteStyle);

    leafletMap.emit("mousemove", { latlng: { lng: -122, lat: 48.5 } });
    await flushPromises();
    assert.equal(pixelRequests.length, 1);
    assert.equal(pixelRequests[0][0], MOUNTED_GEOTIFF_ITEM);
    assert.deepEqual(pixelRequests[0][1], {
      longitude: -122,
      latitude: 48.5,
    });
    assert.equal(controlsView.probeVisible, true);
    assert.match(controlsView.pixelProbeContent.detail, /Pixel: 1\.000e\+0/);
    leafletMap.emit("click", { latlng: { lng: -122, lat: 48.5 } });
    await flushPromises();
    assert.equal(histogramRequests.length, 1);
    assert.equal(histogramRequests[0].item, MOUNTED_GEOTIFF_ITEM);
    assert.equal(controlsView.displayedStatistics.samplingMethod, "sampleGrid");
    assert.match(
      controlsView.statisticsStatus,
      /127 × 127 bounded center grid/,
    );

    controlsView.setPaletteName("viridis");
    controlsView.handlers.onPaletteChange();
    assert.equal(styleChanges.length, 2);
    assert.equal(styleChanges[1].minimumColor, "#440154");
    assert.equal(controlsView.displayedStatistics.samplingMethod, "sampleGrid");

    controlsView.handlers.onResetStyle();
    assert.equal(styleChanges.length, 3);
    assert.deepEqual(styleChanges[2], firstFiniteStyle);
    assert.match(controlsView.appearanceStatus, /initial colors and range/);

    viewer.updateSampledInitialStyle(MOUNTED_GEOTIFF_ITEM, initialStyle);
    assert.deepEqual(controlsView.style, firstFiniteStyle);

    controlsView.handlers.onClearSampleWindow();
    assert.equal(controlsView.samplingAreaMode, "wholeRaster");
    assert.equal(controlsView.displayedStatistics, RASTER_STATISTICS);
    assert.match(controlsView.statisticsStatus, /Whole-raster approximate/);

    viewer.removeSampled(MOUNTED_GEOTIFF_ITEM);
    assert.equal(viewer.isDisplayed, false);
    assert.equal(controlsView.controlsVisible, true);
    assert.equal(controlsView.activeLayer.label, "annual temperature.tif");
    assert.equal(controlsView.displayedStatistics, RASTER_STATISTICS);
    assert.equal(wholeStatisticsRequests, 1);
    viewer.destroy();
});

test("late sampled histogram responses cannot replace a newer clicked window", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const requests = [];
    const style = {
        minimum: 0,
        midpoint: 50,
        maximum: 100,
        minimumColor: "#2b83ba",
        midpointColor: "#ffffbf",
        maximumColor: "#d7191c",
    };
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            loadStatistics(_item, samplingArea, signal) {
                if (samplingArea.kind === "wholeRaster") {
                    return Promise.resolve(RASTER_STATISTICS);
                }
                const result = createDeferred();
                requests.push({
                    signal,
                    selectedBounds: samplingArea.selectedBounds,
                    result,
                });
                return result.promise;
            },
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    viewer.activateSampled(MOUNTED_GEOTIFF_ITEM, style, () => {});
    await flushPromises();

    leafletMap.emit("click", { latlng: { lng: -122, lat: 48 } });
    leafletMap.emit("click", { latlng: { lng: -121, lat: 49 } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, true);
    requests[0].result.resolve({
        ...RASTER_STATISTICS, scope: "selectedArea", selectedBounds: requests[0].selectedBounds,
    });
    await flushPromises();
    assert.equal(requests.length, 2);
    const currentStatistics = {
        ...RASTER_STATISTICS,
        scope: "selectedArea",
        selectedBounds: requests[1].selectedBounds,
        samplingMethod: "sampleGrid",
    };
    requests[1].result.resolve(currentStatistics);
    await flushPromises();

    assert.equal(controlsView.displayedStatistics, currentStatistics);
    viewer.destroy();
});

test("raster viewer samples pixels only inside the single map world", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const pixelRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => ({
                layerName: "eolab:test-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: () => new Promise(() => {}),
            samplePixel: async (item, point) => {
                pixelRequests.push({ item, point });
                return { inBounds: true, value: 1 };
            },
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(MOUNTED_GEOTIFF_ITEM);
    leafletMap.emit("mousemove", { latlng: { lng: 238, lat: 48 } });
    assert.equal(pixelRequests.length, 0);
    assert.equal(controlsView.probeVisible, false);

    leafletMap.emit("mousemove", { latlng: { lng: -122, lat: 48 } });
    assert.deepEqual(pixelRequests, [{
        item: MOUNTED_GEOTIFF_ITEM,
        point: { longitude: -122, latitude: 48 },
    }]);
    await flushPromises();
    assert.equal(controlsView.probeVisible, true);
    viewer.destroy();
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
            layerStackView: createFakeLayerStackView(),
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
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => ({
                layerName: "eolab:test-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: (item, samplingArea) => {
                const selectedBounds = selectedBoundsFromArea(samplingArea);
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
            layerStackView: createFakeLayerStackView(),
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

test("raster viewer retains candidates while enforcing two visible layers", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const publicationCounts = new Map();
    const mapLayerController = new MapLayerController({ leafletMap, view: layerStackView });
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            mapLayerController,
            publishRaster: async (item) => {
                publicationCounts.set(
                    item.id,
                    (publicationCounts.get(item.id) ?? 0) + 1
                );
                return {
                    layerName: `eolab:${item.id}`,
                    bbox: [-180, -90, 180, 90],
                };
            },
            loadStatistics: () => new Promise(() => {}),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("first");
    const second = createRasterItem("second");
    const third = createRasterItem("third");

    await viewer.show(first);
    await viewer.show(second);
    await viewer.show(third);

    assert.equal(layerStackView.layers.length, 3);
    assert.deepEqual(
        layerStackView.layers.map((layer) => [layer.item.id, layer.visible]),
        [
            [third.id, false],
            [second.id, true],
            [first.id, true],
        ]
    );
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        2
    );
    assert.deepEqual(controlsView.activeLayer, {
        label: "third.tif",
        visible: false,
    });

    const thirdKey = layerStackView.layers[0].key;
    const firstKey = layerStackView.layers[2].key;
    layerStackView.handlers.onVisibility(thirdKey, true);
    assert.equal(layerStackView.layers[0].visible, false);
    assert.match(layerStackView.status, /Only 2 map layers/);

    layerStackView.handlers.onVisibility(firstKey, false);
    layerStackView.handlers.onVisibility(thirdKey, true);
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        2
    );
    assert.equal(wmsLayers[2].opacity, 1);
    mapLayerController.setOpacity(thirdKey, 0.4);
    assert.equal(wmsLayers[2].opacity, 0.4);
    assert.deepEqual(
        [...publicationCounts.values()],
        [1, 1, 1]
    );

    await viewer.show(third);
    assert.equal(publicationCounts.get(third.id), 1);
    assert.equal(viewer.contains(third), true);
    viewer.destroy();
    mapLayerController.destroy();
});

test("active layers restore isolated styles and completed statistics", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const first = createRasterItem("first-state");
    const second = createRasterItem("second-state");
    const statisticsById = new Map([
        [first.id, RASTER_STATISTICS],
        [
            second.id,
            {
                ...RASTER_STATISTICS,
                sampleMinimum: 100,
                sampleMaximum: 200,
                histogram: {
                    counts: [...RASTER_STATISTICS.histogram.counts],
                    edges: Array.from(
                        { length: 65 },
                        (_, index) => 100 + index * 100 / 64
                    ),
                },
            },
        ],
    ]);
    const statisticsCounts = new Map();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item) => {
                statisticsCounts.set(
                    item.id,
                    (statisticsCounts.get(item.id) ?? 0) + 1
                );
                return statisticsById.get(item.id);
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(first);
    await flushPromises();
    const firstKey = layerStackView.activeKey;
    assert.equal(controlsView.displayedStatistics, RASTER_STATISTICS);
    controlsView.style = {
        ...controlsView.style,
        minimum: -5,
        midpoint: 5,
        maximum: 15,
    };
    controlsView.handlers.onStyleChange();
    const firstStyle = { ...controlsView.style };

    await viewer.show(second);
    await flushPromises();
    const secondKey = layerStackView.activeKey;
    assert.notEqual(secondKey, firstKey);
    assert.equal(controlsView.displayedStatistics, statisticsById.get(second.id));
    assert.notDeepEqual(controlsView.style, firstStyle);

    viewer.activateAnalysis(layerStackView.layers.find(({ key }) => key === firstKey).item);
    assert.deepEqual(controlsView.style, firstStyle);
    assert.equal(controlsView.displayedStatistics, RASTER_STATISTICS);
    assert.equal(statisticsCounts.get(first.id), 1);
    assert.equal(statisticsCounts.get(second.id), 1);
    assert.ok(wmsLayers[0].parameterUpdates.length > 0);
    viewer.destroy();
});

test("raster analysis summaries select a labeled retained histogram", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const statisticsCounts = new Map();
    let histogramPresentationRequests = 0;
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
            onHistogramRequested() {
                histogramPresentationRequests += 1;
            },
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, samplingArea) => {
                statisticsCounts.set(
                    item.id,
                    (statisticsCounts.get(item.id) ?? 0) + 1
                );
                return createLayerStatistics(
                    item,
                    selectedBoundsFromArea(samplingArea)
                );
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("tool-first");
    const second = createRasterItem("tool-second");
    await viewer.show(first);
    await flushPromises();
    await viewer.show(second);
    await flushPromises();
    const firstLayer = layerStackView.layers.find(({ item }) => item === first);
    const firstHistogram = controlsView.layerHistograms.find(
        ({ key }) => key === firstLayer.key
    );

    assert.equal(controlsView.layerHistograms.length, 2);
    assert.equal(firstHistogram.scope, "Whole raster");
    assert.equal(firstHistogram.state, "ready");
    assert.equal(firstHistogram.counts.length, 64);

    controlsView.handlers.onSelectHistogram(firstLayer.key);
    await flushPromises();

    assert.equal(layerStackView.activeKey, firstLayer.key);
    assert.equal(controlsView.activeHistogramKey, firstLayer.key);
    assert.equal(controlsView.histogramWidgetOpenCount, 1);
    assert.equal(histogramPresentationRequests, 1);
    assert.equal(statisticsCounts.get(first.id), 1);
    assert.equal(statisticsCounts.get(second.id), 1);
    viewer.destroy();
});

test("a restored whole-raster statistics error retries the active layer", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const first = createRasterItem("retry-error-first");
    const second = createRasterItem("retry-error-second");
    const statisticsRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, samplingArea, signal) => {
                const selectedBounds = selectedBoundsFromArea(samplingArea);
                statisticsRequests.push({ item, selectedBounds, signal });
                const firstAttemptCount = statisticsRequests.filter(
                    (request) => request.item === first
                ).length;
                if (item === first && firstAttemptCount === 1) {
                    throw new Error("First histogram failed");
                }
                return createLayerStatistics(item, selectedBounds);
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(first);
    await flushPromises();
    const firstKey = layerStackView.activeKey;
    assert.match(controlsView.statisticsStatus, /First histogram failed/);
    assert.equal(controlsView.statisticsRetryVisible, true);

    await viewer.show(second);
    await flushPromises();
    assert.equal(controlsView.displayedStatistics.itemId, second.id);
    viewer.activateAnalysis(layerStackView.layers.find(({ key }) => key === firstKey).item);
    assert.match(controlsView.statisticsStatus, /First histogram failed/);
    assert.equal(controlsView.statisticsRetryVisible, true);

    controlsView.handlers.onRetryStatistics();
    await flushPromises();
    const firstRequests = statisticsRequests.filter(
        ({ item }) => item === first
    );
    assert.equal(firstRequests.length, 2);
    assert.equal(firstRequests[1].selectedBounds, null);
    assert.equal(firstRequests[1].signal.aborted, false);
    assert.equal(controlsView.displayedStatistics.itemId, first.id);
    assert.equal(controlsView.displayedStatistics.scope, "wholeRaster");
    assert.equal(controlsView.statisticsRetryVisible, false);
    viewer.destroy();
});

test("exhausted capacity retries offer manual recovery without stale histograms", async () => {
    const timers = new Map();
    const clock = {
        /** Retain the next retry until explicitly advanced. @return {Function} Timer token. */
        setTimeout(callback, delay) { timers.set(callback, delay); return callback; },
        /** Remove an aborted retry timer. @return {void} */
        clearTimeout(callback) { timers.delete(callback); },
    };
    let busy = true;
    let attempts = 0;
    const h = visibleLayerFixture(async (item) => {
        attempts++;
        if (busy) throw new RasterAnalysisRequestError("Capacity occupied", 409, "statistics_capacity_busy");
        return createLayerStatistics(item);
    }, { clock });
    await h.viewer.show(MOUNTED_GEOTIFF_ITEM);
    for (const delay of [250, 500, 1000, 2000, 4000]) {
        await flushPromises();
        assert.equal(h.controlsView.layerHistograms[0].state, "loading");
        assert.deepEqual([...timers.values()], [delay]);
        const callback = timers.keys().next().value;
        timers.delete(callback);
        callback();
    }
    await flushPromises();
    assert.equal(attempts, 6);
    assert.equal(h.controlsView.layerHistograms[0].state, "error");
    assert.equal(h.controlsView.statisticsRetryVisible, true);
    busy = false;
    h.controlsView.handlers.onRetryStatistics();
    await flushPromises();
    assert.equal(attempts, 7);
    assert.equal(h.controlsView.layerHistograms[0].state, "ready");
    assert.equal(h.controlsView.statisticsRetryVisible, false);
    h.destroy();
});

test("a deterministic selected-area conflict does not offer Retry", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
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
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => ({
                layerName: "eolab:striped-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (_item, samplingArea) => {
                if (samplingArea.kind === "wholeRaster") {
                    return RASTER_STATISTICS;
                }
                throw new RasterAnalysisRequestError(
                    "The native raster block is too large for bounded reads.",
                    409
                );
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(MOUNTED_GEOTIFF_ITEM);
    await flushPromises();
    leafletMap.emit("click", { latlng: { lng: -122, lat: 48.5 } });
    await flushPromises();

    assert.match(
        controlsView.statisticsStatus,
        /native raster block is too large/
    );
    assert.equal(controlsView.statisticsRetryVisible, false);
    viewer.destroy();
});

test("out-of-order publications do not steal the latest active selection", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const first = createRasterItem("slow-first");
    const second = createRasterItem("fast-second");
    const publications = new Map([
        [first.id, createDeferred()],
        [second.id, createDeferred()],
    ]);
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: (item) => publications.get(item.id).promise,
            loadStatistics: () => new Promise(() => {}),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    const firstRequest = viewer.show(first);
    const secondRequest = viewer.show(second);
    publications.get(second.id).resolve({
        layerName: `eolab:${second.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await secondRequest;
    const expectedActiveKey = layerStackView.activeKey;
    publications.get(first.id).resolve({
        layerName: `eolab:${first.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await firstRequest;

    assert.equal(layerStackView.layers.length, 2);
    assert.equal(layerStackView.activeKey, expectedActiveKey);
    assert.deepEqual(
        layerStackView.layers.map((layer) => layer.item.id),
        [second.id, first.id]
    );
    assert.equal(
        layerStackView.layers.find((layer) => layer.key === expectedActiveKey)
            .item.id,
        second.id
    );
    viewer.destroy();
});

test("manual activation outranks an earlier deferred publication", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const slowPublication = createDeferred();
    const statisticsRequests = [];
    const retained = createRasterItem("manual-activation-retained");
    const slow = createRasterItem("manual-activation-slow");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => {
                if (item === slow) {
                    return slowPublication.promise;
                }
                return {
                    layerName: `eolab:${item.id}`,
                    bbox: [-180, -90, 180, 90],
                };
            },
            loadStatistics: async (item, samplingArea, signal) => {
                const selectedBounds = selectedBoundsFromArea(samplingArea);
                statisticsRequests.push({ item, signal, selectedBounds });
                return createLayerStatistics(item, selectedBounds);
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(retained);
    await flushPromises();
    const retainedKey = layerStackView.activeKey;
    const slowRequest = viewer.show(slow);
    viewer.activateAnalysis(layerStackView.layers.find(({ key }) => key === retainedKey).item);
    slowPublication.resolve({
        layerName: `eolab:${slow.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await slowRequest;

    assert.equal(viewer.contains(slow), true);
    assert.equal(layerStackView.layers.length, 2);
    assert.equal(layerStackView.activeKey, retainedKey);
    assert.deepEqual(controlsView.activeLayer, {
        label: "manual-activation-retained.tif",
        visible: true,
    });
    assert.equal(controlsView.displayedStatistics.itemId, retained.id);
    assert.equal(
        statisticsRequests.filter(({ item }) => item === slow).length,
        0
    );
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        2
    );
    viewer.destroy();
});

test("hidden WMS renderers do not gate active Catalog analysis", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const statisticsRequests = [];
    const pixelRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: (item, samplingArea, signal) => {
                const selectedBounds = selectedBoundsFromArea(samplingArea);
                if (item.id !== "geotiff-hidden-work-third") {
                    return Promise.resolve(createLayerStatistics(item, selectedBounds));
                }
                const deferred = createDeferred();
                signal.addEventListener("abort", () => deferred.reject(signal.reason), { once: true });
                statisticsRequests.push({
                    deferred,
                    item,
                    selectedBounds,
                    signal,
                });
                return deferred.promise;
            },
            samplePixel: async (item, point) => {
                pixelRequests.push({ item, point });
                return { inBounds: true, value: 1 };
            },
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("hidden-work-first");
    const second = createRasterItem("hidden-work-second");
    const third = createRasterItem("hidden-work-third");

    await viewer.show(first);
    await viewer.show(second);
    await viewer.show(third);

    const wholeThirdRequest = statisticsRequests.find(
        ({ item, selectedBounds }) => item === third && selectedBounds === null
    );
    assert.ok(wholeThirdRequest);
    assert.equal(wholeThirdRequest.signal.aborted, false);
    assert.deepEqual(controlsView.activeLayer, {
        label: "hidden-work-third.tif",
        visible: false,
    });

    leafletMap.emit("click", { latlng: { lng: -74, lat: 41 } });
    leafletMap.emit("mousemove", {
        latlng: { lng: -74, lat: 41 },
    });
    await flushPromises();
    const selectedThirdRequest = statisticsRequests.find(
        ({ item, selectedBounds }) =>
            item === third && selectedBounds !== null
    );
    assert.ok(selectedThirdRequest);
    assert.equal(wholeThirdRequest.signal.aborted, true);
    assert.equal(selectedThirdRequest.signal.aborted, false);
    assert.equal(pixelRequests.length, 1);
    assert.equal(pixelRequests[0].item, third);

    const firstKey = layerStackView.layers.find(
        ({ item }) => item === first
    ).key;
    const thirdKey = layerStackView.layers.find(
        ({ item }) => item === third
    ).key;
    layerStackView.handlers.onVisibility(firstKey, false);
    layerStackView.handlers.onVisibility(thirdKey, true);
    layerStackView.handlers.onVisibility(thirdKey, false);
    assert.equal(selectedThirdRequest.signal.aborted, false);

    selectedThirdRequest.deferred.resolve(
        createLayerStatistics(third, selectedThirdRequest.selectedBounds)
    );
    await flushPromises();
    assert.equal(controlsView.displayedStatistics.itemId, third.id);
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");
    wholeThirdRequest.deferred.resolve(createLayerStatistics(third));
    await flushPromises();
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");

    layerStackView.handlers.onVisibility(thirdKey, true);
    const thirdRequests = statisticsRequests.filter(
        ({ item }) => item === third
    );
    assert.equal(thirdRequests.length, 2);
    assert.equal(controlsView.displayedStatistics.itemId, third.id);
    viewer.destroy();
});

test("explicit sampling refreshes every raster layer to one shared area", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, rectangleLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const statisticsRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, samplingArea, signal) => {
                const selectedBounds = selectedBoundsFromArea(samplingArea);
                statisticsRequests.push({ item, selectedBounds, signal });
                return createLayerStatistics(item, selectedBounds);
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("selection-first");
    const second = createRasterItem("selection-second");

    await viewer.show(first);
    await flushPromises();
    const firstKey = layerStackView.activeKey;
    controlsView.handlers.onSampleWindowNumberInput("42");
    leafletMap.emit("click", { latlng: { lng: -74, lat: 41 } });
    await flushPromises();
    const firstSelectedRequest = statisticsRequests.find(
        ({ item, selectedBounds }) =>
            item === first && selectedBounds !== null
    );
    assert.ok(firstSelectedRequest);
    const firstSelectionLayer = rectangleLayers.find(
        (layer) => layer.kind === "selection" &&
            leafletMap.layers.has(layer)
    );
    assert.ok(firstSelectionLayer);
    assert.equal(controlsView.displayedStatistics.itemId, first.id);
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");
    controlsView.handlers.onSampleWindowNumberInput("55");
    assert.match(
        controlsView.sampleWindowStatus,
        /current histogram still uses the 42 km window/
    );

    await viewer.show(second);
    await flushPromises();
    controlsView.handlers.onSampleWindowNumberInput("80");
    leafletMap.emit("click", { latlng: { lng: 12, lat: 34 } });
    await flushPromises();
    assert.equal(controlsView.displayedStatistics.itemId, second.id);
    assert.equal(controlsView.sampleWindowSizeKm, 80);

    const firstSelectedRequests = statisticsRequests.filter(
        ({ item, selectedBounds }) =>
            item === first && selectedBounds !== null
    );
    assert.equal(firstSelectedRequests.length, 2);
    const sharedFirstRequest = firstSelectedRequests.at(-1);
    const secondSelectedRequest = statisticsRequests.findLast(
        ({ item, selectedBounds }) =>
            item === second && selectedBounds !== null
    );
    assert.deepEqual(
        sharedFirstRequest.selectedBounds,
        secondSelectedRequest.selectedBounds
    );
    viewer.activateAnalysis(layerStackView.layers.find(({ key }) => key === firstKey).item);

    assert.equal(controlsView.sampleWindowSizeKm, 80);
    assert.equal(controlsView.displayedStatistics.itemId, first.id);
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");
    assert.deepEqual(
        controlsView.displayedStatistics.selectedBounds,
        sharedFirstRequest.selectedBounds
    );
    assert.equal(
        statisticsRequests.filter(
            ({ item, selectedBounds }) =>
                item === first && selectedBounds !== null
        ).length,
        firstSelectedRequests.length
    );
    const attachedSelections = rectangleLayers.filter(
        (layer) => layer.kind === "selection" && leafletMap.layers.has(layer)
    );
    assert.equal(attachedSelections.length, 1);
    assert.deepEqual(
        attachedSelections[0].boundsHistory.at(-1),
        [
            [
                sharedFirstRequest.selectedBounds.south,
                sharedFirstRequest.selectedBounds.west,
            ],
            [
                sharedFirstRequest.selectedBounds.north,
                sharedFirstRequest.selectedBounds.east,
            ],
        ]
    );
    assert.equal(leafletMap.layers.has(firstSelectionLayer), false);
    viewer.destroy();
});

test("removing an active WMS renderer preserves analysis before adjacent restore", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const statisticsRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, samplingArea) => {
                statisticsRequests.push({ item, samplingArea });
                return createLayerStatistics(
                    item,
                    selectedBoundsFromArea(samplingArea)
                );
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("remove-first");
    const second = createRasterItem("remove-second");
    const third = createRasterItem("remove-third");

    await viewer.show(first);
    await flushPromises();
    await viewer.show(second);
    await flushPromises();
    await viewer.show(third);
    await flushPromises();
    const keys = new Map(
        layerStackView.layers.map(({ item, key }) => [item, key])
    );

    leafletMap.emit("click", { latlng: { lng: -73, lat: 42 } });
    await flushPromises();
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");
    controlsView.setPaletteName("viridis");
    controlsView.handlers.onPaletteChange();
    const thirdRequestCount = statisticsRequests.filter(
        ({ item }) => item === third
    ).length;

    layerStackView.handlers.onRemove(keys.get(third));
    assert.equal(layerStackView.activeKey, null);
    assert.match(controlsView.activeLayer.label, /remove-third/);
    assert.equal(controlsView.activeLayer.label, "remove-third.tif");
    assert.equal(controlsView.displayedStatistics.itemId, third.id);
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");
    assert.equal(controlsView.paletteName, "viridis");
    assert.equal(
        statisticsRequests.filter(({ item }) => item === third).length,
        thirdRequestCount
    );
    assert.equal(
        wmsLayers.some(
            (layer) =>
                layer.wmsOptions.layers === `eolab:${third.id}` &&
                leafletMap.layers.has(layer)
        ),
        false
    );

    viewer.deactivateAnalysis(third);
    assert.equal(layerStackView.activeKey, keys.get(second));
    assert.equal(controlsView.displayedStatistics.itemId, second.id);
    layerStackView.handlers.onRemove(keys.get(second));
    assert.equal(layerStackView.activeKey, null);
    assert.match(controlsView.activeLayer.label, /remove-second/);
    assert.equal(controlsView.activeLayer.label, "remove-second.tif");
    viewer.deactivateAnalysis(second);
    assert.equal(layerStackView.activeKey, keys.get(first));
    assert.equal(controlsView.displayedStatistics.itemId, first.id);
    layerStackView.handlers.onRemove(keys.get(first));
    assert.equal(layerStackView.layers.length, 0);
    assert.equal(controlsView.controlsVisible, true);
    assert.equal(controlsView.activeLayer.label, "remove-first.tif");
    viewer.deactivateAnalysis(first);
    assert.equal(controlsView.controlsVisible, false);
    assert.equal(
        wmsLayers.some((layer) => leafletMap.layers.has(layer)),
        false
    );
    viewer.destroy();
});

test("tile failures remain associated with their owning raster layer", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const tileErrors = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError: (message, item) => tileErrors.push({ message, item }),
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, samplingArea) =>
                createLayerStatistics(
                    item,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("tile-error-first");
    const second = createRasterItem("tile-error-second");

    await viewer.show(first);
    await flushPromises();
    await viewer.show(second);
    await flushPromises();
    const firstLayer = wmsLayers.find(
        (layer) => layer.wmsOptions.layers === `eolab:${first.id}`
    );
    firstLayer.eventHandlers.get("tileerror")();

    assert.deepEqual(tileErrors, [{
        message: "Map tiles could not be rendered.",
        item: first,
    }]);
    assert.equal(
        layerStackView.layers.find(({ item }) => item === first).error,
        "Map tiles could not be rendered."
    );
    assert.equal(
        layerStackView.layers.find(({ item }) => item === second).error,
        null
    );
    assert.equal(layerStackView.activeKey,
        layerStackView.layers.find(({ item }) => item === second).key);
    assert.equal(controlsView.displayedStatistics.itemId, second.id);
    viewer.destroy();
});

test("a removed layer's late tile failure cannot mark its replacement", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const tileErrors = [];
    const item = createRasterItem("tile-error-replacement");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError: (message, failedItem) =>
                tileErrors.push({ message, item: failedItem }),
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async () => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (requestedItem, samplingArea) =>
                createLayerStatistics(
                    requestedItem,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(item);
    await flushPromises();
    const removedLayer = wmsLayers[0];
    viewer.remove(item);
    await viewer.show(item);
    await flushPromises();
    assert.equal(wmsLayers.length, 2);

    removedLayer.eventHandlers.get("tileerror")();

    assert.deepEqual(tileErrors, []);
    assert.equal(layerStackView.layers[0].error, null);
    assert.equal(controlsView.displayedStatistics.itemId, item.id);
    viewer.destroy();
});

test("a failed publication preserves existing layers and can be retried", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const publicationCounts = new Map();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => {
                const count = (publicationCounts.get(item.id) ?? 0) + 1;
                publicationCounts.set(item.id, count);
                if (item.id.endsWith("publication-second") && count === 1) {
                    throw new Error("GeoServer publication failed");
                }
                return {
                    layerName: `eolab:${item.id}`,
                    bbox: [-180, -90, 180, 90],
                };
            },
            loadStatistics: async (item, samplingArea) =>
                createLayerStatistics(
                    item,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("publication-first");
    const second = createRasterItem("publication-second");

    await viewer.show(first);
    await flushPromises();
    const firstKey = layerStackView.activeKey;
    await assert.rejects(
        viewer.show(second),
        /GeoServer publication failed/
    );
    assert.equal(viewer.contains(first), true);
    assert.equal(viewer.contains(second), false);
    assert.equal(layerStackView.activeKey, firstKey);
    assert.equal(controlsView.displayedStatistics.itemId, first.id);
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        1
    );

    await viewer.show(second);
    await flushPromises();
    assert.equal(publicationCounts.get(second.id), 2);
    assert.equal(viewer.contains(second), true);
    assert.equal(layerStackView.layers.length, 2);
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        2
    );
    viewer.destroy();
});

test("AOI hide restores hover windows and show restores AOI sampling", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, rectangleLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const aoiRequests = [];
    const replacementId = "R".repeat(32);
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => ({
                layerName: "eolab:test-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (
                _item,
                samplingArea,
                signal
            ) => {
                if (samplingArea.kind !== "temporaryAoi") {
                    return createLayerStatistics(
                        MOUNTED_GEOTIFF_ITEM,
                        selectedBoundsFromArea(samplingArea)
                    );
                }
                const deferred = createDeferred();
                const temporaryAoiId = samplingArea.temporaryAoiId;
                aoiRequests.push({ deferred, signal, temporaryAoiId });
                return deferred.promise;
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    await viewer.show(MOUNTED_GEOTIFF_ITEM);
    await flushPromises();
    const firstAoi = Object.freeze({
        id: TEMPORARY_AOI_ID,
        filename: "area.gpkg",
        selectedDataset: "boundary",
        expiresAt: "2030-01-01T01:00:00Z",
    });
    const replacementAoi = Object.freeze({
        ...firstAoi,
        id: replacementId,
        filename: "replacement.zip",
        selectedDataset: "inside/boundary.shp",
    });

    viewer.setTemporaryAoi(firstAoi);

    assert.equal(aoiRequests.length, 1);
    assert.equal(aoiRequests[0].temporaryAoiId, TEMPORARY_AOI_ID);
    assert.equal(controlsView.samplingAreaMode, "temporaryAoi");
    assert.equal(controlsView.availableTemporaryAoi.id, TEMPORARY_AOI_ID);
    const requestCountBeforeMapClick = aoiRequests.length;
    leafletMap.emit("click", { latlng: { lng: 0, lat: 0 } });
    assert.equal(aoiRequests.length, requestCountBeforeMapClick);

    viewer.setTemporaryAoi(replacementAoi);

    assert.equal(aoiRequests.length, 1);
    assert.equal(aoiRequests[0].signal.aborted, true);
    aoiRequests[0].deferred.resolve(TEMPORARY_AOI_RASTER_STATISTICS);
    await flushPromises();
    assert.equal(aoiRequests.length, 2);
    assert.equal(aoiRequests[1].temporaryAoiId, replacementId);
    aoiRequests[1].deferred.resolve({
        ...TEMPORARY_AOI_RASTER_STATISTICS,
        temporaryAoiId: replacementId,
    });
    await flushPromises();

    assert.equal(controlsView.displayedStatistics.temporaryAoiId, replacementId);
    assert.match(controlsView.statisticsStatus, /replacement\.zip/);
    assert.match(controlsView.statisticsStatus, /inside\/boundary\.shp/);

    controlsView.handlers.onClearSampleWindow();
    assert.equal(controlsView.samplingAreaMode, "wholeRaster");
    controlsView.handlers.onUseTemporaryAoi();
    await flushPromises();
    assert.equal(aoiRequests.length, 3);
    assert.equal(aoiRequests[2].temporaryAoiId, replacementId);

    viewer.setTemporaryAoi(null);
    aoiRequests[2].deferred.resolve(TEMPORARY_AOI_RASTER_STATISTICS);
    await flushPromises();

    assert.equal(aoiRequests[2].signal.aborted, true);
    assert.equal(controlsView.samplingAreaMode, "wholeRaster");
    assert.equal(controlsView.availableTemporaryAoi, null);
    assert.equal(controlsView.displayedStatistics.scope, "wholeRaster");

    leafletMap.emit("mousemove", { latlng: { lng: 2, lat: 2 } });
    const hoverWindow = rectangleLayers.at(-1);
    assert.equal(hoverWindow.kind, "preview");
    assert.equal(leafletMap.layers.has(hoverWindow), true);

    viewer.setTemporaryAoi(replacementAoi);

    assert.equal(aoiRequests.length, 4);
    assert.equal(aoiRequests[3].temporaryAoiId, replacementId);
    assert.equal(controlsView.samplingAreaMode, "temporaryAoi");
    assert.equal(controlsView.availableTemporaryAoi.id, replacementId);
    assert.equal(leafletMap.layers.has(hoverWindow), false);
});
