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
        renderPointSamples(snapshot) {
            this.pointSamples = snapshot;
        },
        clearPointSamples() {
            this.pointSamples = null;
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
        announcement: "",
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
            this.announcement = message;
        },
        announceStatus(message) {
            this.status = "";
            this.announcement = message;
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

test("raster adapter exports and reapplies only validated portable appearance", async () => {
    const h = visibleLayerFixture();
    await h.viewer.show(createRasterItem("portable"));
    const record = h.mapLayers.retainedRecords[0];

    const exported = record.adapter.exportSavedState(record);
    assert.equal(exported.kind, "raster");
    assert.deepEqual(exported.definition, record.state.rasterStyle);
    assert.equal(exported.paletteName, "blue-yellow-red");
    assert.equal(
        record.adapter.checkSavedStateCompatibility(record, exported),
        null,
    );
    assert.match(
        record.adapter.checkSavedStateCompatibility(record, {
            kind: "vector",
            definition: {},
        }),
        /Only copied raster styles/,
    );
    assert.match(
        record.adapter.checkSavedStateCompatibility(record, {
            ...exported,
            paletteName: "not-a-palette",
        }),
        /palette is invalid/,
    );
    const restoredStyle = {
        ...DEFAULT_RASTER_STYLE,
        minimum: -5,
        midpoint: 0,
        maximum: 20,
        minimumColor: "#000000",
    };
    record.adapter.applySavedState(record, {
        kind: "raster",
        definition: restoredStyle,
        paletteName: "custom",
    });

    assert.deepEqual(record.state.rasterStyle, restoredStyle);
    assert.equal(record.state.paletteName, "custom");
    assert.equal(h.wmsLayers[0].parameters.styles, "dynamic-raster");
    assert.match(h.wmsLayers[0].parameters.env, /min:-5/);
    assert.throws(
        () => record.adapter.applySavedState(record, {
            kind: "raster",
            definition: { ...restoredStyle, sourcePath: "file:///data.tif" },
            paletteName: "custom",
        }),
        /unsupported fields/,
    );
    h.destroy();
});

test("saved style updates a staged raster before it is attached", async () => {
    const h = visibleLayerFixture();
    const staged = await h.viewer.stage(
        createRasterItem("staged-portable"),
        { visible: true, opacity: 0.6 },
    );
    const restoredStyle = {
        ...DEFAULT_RASTER_STYLE,
        minimum: 0.25,
        midpoint: 0.5,
        maximum: 0.75,
    };

    assert.equal(h.mapLayers.retainedRecords.length, 0);
    assert.equal(h.leafletMap.layers.size, 0);
    staged.record.adapter.applySavedState(staged.record, {
        kind: "raster",
        definition: restoredStyle,
        paletteName: "blue-yellow-red",
    });

    assert.deepEqual(staged.record.state.rasterStyle, restoredStyle);
    assert.equal(staged.layer.parameters.styles, "dynamic-raster");
    assert.match(staged.layer.parameters.env, /min:0.25/);
    assert.match(staged.layer.parameters.env, /med:0.5/);
    assert.match(staged.layer.parameters.env, /max:0.75/);
    assert.equal(h.leafletMap.layers.size, 0);

    h.mapLayers.commitStaged([staged], { fitToBounds: false });
    assert.equal(h.leafletMap.layers.has(staged.layer), true);
    assert.equal(staged.layer.opacity, 0.6);
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
    h.viewer.exploreAt({ lng: -74, lat: 41 });
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
    h.viewer.exploreAt({ lng: -74, lat: 41 });
    h.viewer.exploreAt({ lng: -72, lat: 43 });
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
    h.viewer.exploreAt({ lng: -70, lat: 45 });
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
    h.viewer.exploreAt({ lng: -74, lat: 41 });
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

test('one-shot map exploration replaces its footprint without a hidden pause mode', async () => {
    const requests = [];
    const h = visibleLayerFixture(async (item, area) => {
        requests.push({ item, area });
        return createLayerStatistics(item, selectedBoundsFromArea(area));
    });
    await h.viewer.show(createRasterItem('first'));
    await h.viewer.show(createRasterItem('second'));
    await flushPromises();
    h.viewer.exploreAt({ lng: 0, lat: 0 });
    await flushPromises();
    const statistics = h.controlsView.displayedStatistics;
    const footprint = [...h.leafletMap.layers].find(layer => layer.kind === 'selection');
    assert.ok(footprint);
    assert.equal(statistics.scope, 'selectedArea');
    const bounds = [...footprint.boundsHistory];
    const count = requests.length;
    h.leafletMap.emit('moveend', {});
    h.leafletMap.emit('zoomend', {});
    assert.equal(requests.length, count);
    assert.deepEqual(footprint.boundsHistory, bounds);
    h.viewer.exploreAt({ lng: 4, lat: 4 });
    await flushPromises();
    assert.ok(requests.length > count);
    assert.equal(h.leafletMap.layers.has(footprint), true);
    assert.equal(footprint.boundsHistory.length, bounds.length + 1);
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
    h.mapLayers.reorder(firstKey, 0);
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
        renderDescriptor: () => ({
            layerName: 'eolab:volcanoes',
            styleName: 'vector-point',
            styleDefinition: { geometryKind: 'point' },
        }),
        snapshot: () => ({ legend: { kind: 'fixed' } }), tileErrorMessage: 'Vector tile error',
    });
    const vectorRecord = h.mapLayers.retainedRecords.find(
        (record) => record.entry.item.id === vector.id,
    );
    assert.equal(vectorRecord.entry.visible, true);
    assert.equal(h.mapLayers.isAttached(vectorRecord.entry.key), true);
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

test('sequential raster removals release analysis before a vector is added', async () => {
    const h = visibleLayerFixture();
    await h.viewer.show(createRasterItem('bottom'));
    await h.viewer.show(createRasterItem('top'));
    await flushPromises();
    const [top, bottom] = h.mapLayers.snapshots();

    h.mapLayers.removeKey(top.key);
    assert.equal(h.mapLayers.activeKey, bottom.key);
    assert.equal(h.layerStackView.activeKey, bottom.key);
    assert.doesNotThrow(() => h.mapLayers.removeKey(bottom.key));

    const vector = { collection: 'vectors', id: 'reported-vector' };
    await assert.doesNotReject(() => h.mapLayers.show(vector, {
        label: () => 'SOKNOT_2024_node_score_comparison.shp',
        publish: async () => ({}),
        createState: () => ({}),
        createLayer: () => h.leaflet.tileLayer.wms('/geoserver/eolab/wms', {}),
        renderDescriptor: () => ({
            layerName: 'eolab:reported-vector',
            styleName: 'vector-point',
            styleDefinition: { geometryKind: 'point' },
        }),
        snapshot: () => ({ legend: { kind: 'fixed' } }),
        tileErrorMessage: 'Vector tile error',
    }));
    assert.equal(h.mapLayers.contains(vector), true);
    assert.deepEqual(h.controlsView.layerHistograms, []);
    h.destroy();
});

test('three visible rasters render while only the top two are analyzed', async () => {
    const requests = [];
    const pointRequests = [];
    const h = visibleLayerFixture(async (item, area) => {
        requests.push({
            id: item.id.replace(/^geotiff-/, ''),
            area: area.kind,
        });
        return createLayerStatistics(item, selectedBoundsFromArea(area));
    }, {
        samplePixel: async (item) => {
            pointRequests.push(item.id.replace(/^geotiff-/, ''));
            return { inBounds: true, value: 1 };
        },
    });
    const bottom = createRasterItem('bottom');
    const middle = createRasterItem('middle');
    const top = createRasterItem('top');
    await h.viewer.show(bottom);
    await h.viewer.show(middle);
    await h.viewer.show(top);
    await flushPromises();

    assert.equal(h.mapLayers.visibleCount, 3);
    assert.equal(
        h.wmsLayers.filter((layer) => h.leafletMap.layers.has(layer)).length,
        3,
    );
    assert.deepEqual(
        h.controlsView.layerHistograms.map((summary) => summary.label),
        ['top.tif', 'middle.tif'],
    );

    requests.length = 0;
    h.viewer.exploreAt({ lng: -74, lat: 41 });
    await flushPromises();
    assert.deepEqual(
        requests.map(({ id }) => id).sort(),
        ['middle', 'top'],
    );
    assert.deepEqual(pointRequests, ['top', 'middle']);
    assert.deepEqual(
        h.controlsView.pointSamples.samples.map(({ label }) => label),
        ['top.tif', 'middle.tif'],
    );
    h.destroy();
});

test('active 2D analysis follows the top raster pair and exposes X Y badges', async () => {
    const pairedRequests = [];
    const pointRequests = [];
    const h = visibleLayerFixture(undefined, {
        loadPairedStatistics: async (xItem, yItem) => {
            pairedRequests.push([
                xItem.id.replace(/^geotiff-/, ''),
                yItem.id.replace(/^geotiff-/, ''),
            ]);
            return pairedStatistics();
        },
        samplePixel: async (item) => {
            pointRequests.push(item.id);
            return { inBounds: true, value: item.id.endsWith('top') ? 9 : 4 };
        },
    });
    await h.viewer.show(createRasterItem('bottom'));
    await h.viewer.show(createRasterItem('middle'));
    await h.viewer.show(createRasterItem('top'));
    await flushPromises();
    const [top, middle, bottom] = h.mapLayers.snapshots();
    h.mapLayers.setOpacity(middle.key, 0.35);
    h.mapLayers.setOpacity(bottom.key, 0.4);

    h.controlsView.handlers.onBivariateModeChange('bivariate');
    await flushPromises();
    assert.deepEqual(pairedRequests.at(-1), ['top', 'middle']);
    assert.deepEqual(
        h.mapLayers.snapshots().map((layer) => layer.roleBadge?.label ?? null),
        ['X', 'Y', null],
    );
    assert.deepEqual(
        h.mapLayers.snapshots().map((layer) => layer.opacityLocked),
        [true, true, false],
    );
    assert.equal(h.mapLayers.getLeafletLayer(bottom.key).opacity, 0.4);
    h.viewer.exploreAt({ lng: -74, lat: 41 });
    await flushPromises();
    assert.deepEqual(
        h.controlsView.pointSamples.samples.map(({ label, axis }) => ({ label, axis })),
        [
            { label: 'top.tif', axis: 'X' },
            { label: 'middle.tif', axis: 'Y' },
        ],
    );

    h.controlsView.handlers.onBivariateSwapAxes();
    await flushPromises();
    assert.deepEqual(
        h.mapLayers.snapshots().map((layer) => layer.roleBadge?.label ?? null),
        ['Y', 'X', null],
    );
    assert.deepEqual(pairedRequests.at(-1), ['middle', 'top']);
    assert.equal(pointRequests.length, 2);
    assert.deepEqual(
        h.controlsView.pointSamples.samples.map(({ label, axis, value }) => ({
            label, axis, value,
        })),
        [
            { label: 'middle.tif', axis: 'X', value: 4 },
            { label: 'top.tif', axis: 'Y', value: 9 },
        ],
    );

    h.mapLayers.reorder(bottom.key, 1);
    await flushPromises();
    assert.equal(h.controlsView.bivariateMode.active, true);
    assert.deepEqual(
        h.mapLayers.snapshots().map((layer) => [
            layer.item.id.replace(/^geotiff-/, ''),
            layer.roleBadge?.label ?? null,
        ]),
        [['top', 'Y'], ['bottom', 'X'], ['middle', null]],
    );
    assert.deepEqual(pairedRequests.at(-1), ['bottom', 'top']);
    assert.equal(h.mapLayers.getLeafletLayer(middle.key).opacity, 0.35);
    assert.equal(
        h.mapLayers.getLeafletLayer(middle.key).container.style.mixBlendMode,
        'normal',
    );

    h.mapLayers.setVisible(top.key, false);
    await flushPromises();
    assert.equal(h.controlsView.bivariateMode.active, true);
    assert.deepEqual(
        h.mapLayers.snapshots().map((layer) => [
            layer.item.id.replace(/^geotiff-/, ''),
            layer.roleBadge?.label ?? null,
        ]),
        [['top', null], ['bottom', 'Y'], ['middle', 'X']],
    );
    assert.deepEqual(pairedRequests.at(-1), ['middle', 'bottom']);

    h.mapLayers.setVisible(middle.key, false);
    assert.equal(h.controlsView.bivariateMode.active, false);
    assert.ok(h.mapLayers.snapshots().every((layer) => layer.roleBadge === null));
    assert.equal(h.mapLayers.getLeafletLayer(bottom.key).opacity, 0.4);
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

test('color opacity stays per-layer, survives 2D, and resets with the style', async () => {
    const h = visibleLayerFixture();
    await h.viewer.show(createRasterItem('bottom'));
    await h.viewer.show(createRasterItem('top'));
    await flushPromises();
    const [top, bottom] = h.mapLayers.snapshots();
    h.viewer.openStyle(bottom.key);
    h.controlsView.style = { ...h.controlsView.style,
        minimumOpacity: 0, midpointOpacity: 0.25, maximumOpacity: 0.8 };
    h.controlsView.handlers.onStyleInput(false);
    h.viewer.closeStyle(); // A pending opacity edit must be committed on close.
    const ordinary = { ...h.mapLayers.getRecord(bottom.key).state.rasterStyle };
    assert.equal(ordinary.midpointOpacity, 0.25);
    assert.equal(h.mapLayers.getRecord(top.key).state.rasterStyle.midpointOpacity, 1);
    h.viewer.openStyle(top.key);
    assert.equal(h.controlsView.style.minimumOpacity, 1);
    h.viewer.openStyle(bottom.key);
    assert.equal(h.controlsView.style.minimumOpacity, 0);
    h.controlsView.handlers.onBivariateModeChange('bivariate');
    await flushPromises();
    assert.match(h.mapLayers.getLeafletLayer(bottom.key).parameters.env, /;amin:1;amed:1;amax:1$/);
    h.controlsView.handlers.onBivariateModeChange('overlay');
    assert.deepEqual(h.mapLayers.getRecord(bottom.key).state.rasterStyle, ordinary);
    assert.match(h.mapLayers.getLeafletLayer(bottom.key).parameters.env, /;amin:0;amed:0.25;amax:0.8$/);
    h.controlsView.handlers.onResetStyle();
    assert.equal(h.mapLayers.getRecord(bottom.key).state.rasterStyle.minimumOpacity, 1);
    assert.equal(h.mapLayers.getRecord(bottom.key).state.rasterStyle.midpointOpacity, 1);
    assert.equal(h.mapLayers.getRecord(bottom.key).state.rasterStyle.maximumOpacity, 1);
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

test('automatic samples exclude rasters below the top-two pair', async () => {
    const requests = [];
    const h = visibleLayerFixture(async item => {
        requests.push(item.id);
        return createLayerStatistics(item);
    });
    await h.viewer.show(createRasterItem('first'));
    await h.viewer.show(createRasterItem('second'));
    await h.viewer.show(createRasterItem('hidden'));
    await flushPromises();
    requests.length = 0;
    h.viewer.exploreAt({ lng: -74, lat: 41 });
    await flushPromises();
    assert.equal(requests.includes('geotiff-first'), false);
    const [, , first] = h.mapLayers.snapshots();
    h.mapLayers.reorder(first.key, 0);
    await flushPromises();
    assert.deepEqual(
        h.controlsView.layerHistograms.map(s => s.label),
        ['first.tif', 'hidden.tif'],
    );
    h.destroy();
});

test("selecting 2D opens paired analysis without a map interaction", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const pairedRequests = [];
    const pixelRequests = [];
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
            samplePixel: async (item, point) => {
                pixelRequests.push({ item, point });
                return {
                    inBounds: true,
                    value: item === secondItem ? 9 : 4,
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
    assert.equal(pixelRequests.length, 0);
    assert.match(
        controlsView.bivariateAvailability.guidance,
        /2D analyzes the X\/Y-badged rasters.*blending at 100% opacity/
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

    viewer.exploreAt({ lng: -122, lat: 49 });
    await flushPromises();
    assert.deepEqual(
        pixelRequests.map(({ item, point }) => ({ id: item.id, point })),
        [
            { id: secondItem.id, point: { longitude: -122, latitude: 49 } },
            { id: firstItem.id, point: { longitude: -122, latitude: 49 } },
        ]
    );
    assert.deepEqual(controlsView.pairedHighlight, { xValue: 9, yValue: 4 });
    assert.deepEqual(
        controlsView.pointSamples.samples.map(({ label, axis, state, value }) => ({
            label, axis, state, value,
        })),
        [
            { label: "second.tif", axis: "X", state: "value", value: 9 },
            { label: "first.tif", axis: "Y", state: "value", value: 4 },
        ]
    );

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
        }
    );

    assert.equal(leafletMap.container.listenerCount("pointermove"), 0);
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
    assert.deepEqual(pixelRequests, []);
    viewer.exploreAt({ lng: -122, lat: 48.5 });
    await flushPromises();
    assert.deepEqual(pixelRequests, [{
        item: MOUNTED_GEOTIFF_ITEM,
        point: { longitude: -122, latitude: 48.5 },
    }]);
    assert.equal(controlsView.pointSamples.samples[0].state, "value");
    assert.equal(controlsView.pointSamples.samples[0].value, 17);
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

test("raster viewer samples click values only inside the single map world", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, rectangleLayers } = createFakeLeaflet();
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
    assert.equal(rectangleLayers.length, 0);

    leafletMap.emit("mousemove", { latlng: { lng: -122, lat: 48 } });
    assert.deepEqual(pixelRequests, []);
    assert.equal(rectangleLayers.length, 1);
    viewer.exploreAt({ lng: -122, lat: 48 });
    await flushPromises();
    assert.deepEqual(pixelRequests, [{
        item: MOUNTED_GEOTIFF_ITEM,
        point: { longitude: -122, latitude: 48 },
    }]);
    assert.ok(rectangleLayers.some((layer) => layer.kind === "selection"));
    assert.equal(controlsView.pointSamples.samples[0].value, 1);
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

    viewer.exploreAt({ lng: -74, lat: 41 });
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

    viewer.exploreAt({ lng: -73, lat: 42 });
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

test("raster viewer renders every retained layer", async () => {
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
            [third.id, true],
            [second.id, true],
            [first.id, true],
        ]
    );
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        3
    );
    assert.deepEqual(controlsView.activeLayer, {
        label: "third.tif",
        visible: true,
    });

    const thirdKey = layerStackView.layers[0].key;
    const firstKey = layerStackView.layers[2].key;
    layerStackView.handlers.onVisibility(firstKey, false);
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        2
    );
    layerStackView.handlers.onVisibility(firstKey, true);
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        3
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
    viewer.exploreAt({ lng: -122, lat: 48.5 });
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
    const thirdKey = layerStackView.layers.find(
        ({ item }) => item === third,
    ).key;
    layerStackView.handlers.onVisibility(thirdKey, false);

    const wholeThirdRequest = statisticsRequests.find(
        ({ item, selectedBounds }) => item === third && selectedBounds === null
    );
    assert.ok(wholeThirdRequest);
    assert.equal(wholeThirdRequest.signal.aborted, false);
    assert.deepEqual(controlsView.activeLayer, {
        label: "hidden-work-third.tif",
        visible: false,
    });

    viewer.exploreAt({ lng: -74, lat: 41 });
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
    viewer.exploreAt({ lng: -74, lat: 41 });
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
    viewer.exploreAt({ lng: 12, lat: 34 });
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

    viewer.exploreAt({ lng: -73, lat: 42 });
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

test("AOI lifecycle restores whole-raster scope and replaces selected windows", async () => {
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

    viewer.exploreAt({ lng: 2, lat: 2 });
    await flushPromises();
    const selectedWindow = rectangleLayers.at(-1);
    assert.equal(selectedWindow.kind, "selection");
    assert.equal(leafletMap.layers.has(selectedWindow), true);

    viewer.setTemporaryAoi(replacementAoi);

    assert.equal(aoiRequests.length, 4);
    assert.equal(aoiRequests[3].temporaryAoiId, replacementId);
    assert.equal(controlsView.samplingAreaMode, "temporaryAoi");
    assert.equal(controlsView.availableTemporaryAoi.id, replacementId);
    assert.equal(leafletMap.layers.has(selectedWindow), false);
});
