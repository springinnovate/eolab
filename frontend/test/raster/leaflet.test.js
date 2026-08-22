import assert from "node:assert/strict";
import test from "node:test";

import {
  CatalogRasterLayerController,
  createRasterSampleWindowLayer,
  createRasterWmsLayer,
  rasterSampleBoundsToLeaflet,
} from "../../src/raster/leaflet.js";
import { SELECTED_BOUNDS } from "../../test-support/raster/fixtures.js";

test("sample bounds retain their visible Leaflet world-copy offset", () => {
  assert.deepEqual(
    rasterSampleBoundsToLeaflet(SELECTED_BOUNDS, 360),
    [
      [48, 237],
      [50, 239],
    ],
  );
});

test("Leaflet adapters own WMS and sample-window presentation options", () => {
  let capturedWms;
  let capturedRectangle;
  let tileErrorHandler;
  const wmsLayer = {
    once(type, handler) {
      assert.equal(type, "tileerror");
      tileErrorHandler = handler;
    },
  };
  const rectangleLayer = {};
  const leaflet = {
    tileLayer: {
      wms(url, options) {
        capturedWms = { url, options };
        return wmsLayer;
      },
    },
    rectangle(bounds, options) {
      capturedRectangle = { bounds, options };
      return rectangleLayer;
    },
  };
  let tileErrorCount = 0;

  assert.equal(
    createRasterWmsLayer(
      leaflet,
      "/geoserver/eolab/wms",
      { layerName: "eolab:test", bbox: [-10, -5, 20, 15] },
      "min:0;med:50;max:100;cmin:#000000;cmed:#888888;cmax:#ffffff",
      () => {
        tileErrorCount += 1;
      },
    ),
    wmsLayer,
  );
  assert.deepEqual(capturedWms, {
    url: "/geoserver/eolab/wms",
    options: {
      layers: "eolab:test",
      styles: "dynamic-raster",
      env: "min:0;med:50;max:100;cmin:#000000;cmed:#888888;cmax:#ffffff",
      format: "image/png",
      transparent: true,
      version: "1.3.0",
      bounds: [[-5, -10], [15, 20]],
    },
  });
  tileErrorHandler();
  assert.equal(tileErrorCount, 1);

  assert.equal(
    createRasterSampleWindowLayer(
      leaflet,
      [[48, -123], [50, -121]],
      "preview",
    ),
    rectangleLayer,
  );
  assert.deepEqual(capturedRectangle, {
    bounds: [[48, -123], [50, -121]],
    options: {
      color: "#f97316",
      weight: 2,
      fill: false,
      interactive: false,
    },
  });

  createRasterSampleWindowLayer(
    leaflet,
    [[10, 20], [11, 21]],
    "selection",
  );
  assert.deepEqual(capturedRectangle, {
    bounds: [[10, 20], [11, 21]],
    options: {
      color: "#2563eb",
      weight: 2,
      fillColor: "#3b82f6",
      fillOpacity: 0.12,
      interactive: false,
    },
  });
});

test("CatalogRasterLayerController ignores stale publication results", async () => {
  const leafletMap = { removeLayer() {} };
  const resolvers = [];
  const controller = new CatalogRasterLayerController(
    leafletMap,
    () => new Promise((resolve) => resolvers.push(resolve)),
    ({ layerName }) => ({
      layerName,
      addTo(map) {
        this.map = map;
        return this;
      },
    }),
  );

  const staleRequest = controller.show({ id: "first" });
  controller.clear();
  resolvers[0]({ layerName: "eolab:first", bbox: [0, 0, 1, 1] });

  assert.equal(await staleRequest, null);
  assert.equal(controller.activeLayer, null);
});

test("CatalogRasterLayerController keeps only the latest layer", async () => {
  const removedLayers = [];
  const leafletMap = { removeLayer: (layer) => removedLayers.push(layer) };
  const publications = [
    { layerName: "eolab:first", bbox: [0, 0, 1, 1] },
    { layerName: "eolab:second", bbox: [1, 1, 2, 2] },
  ];
  const controller = new CatalogRasterLayerController(
    leafletMap,
    async () => publications.shift(),
    ({ layerName }) => ({
      layerName,
      addTo(map) {
        this.map = map;
        return this;
      },
    }),
  );

  await controller.show({ id: "first" });
  const firstLayer = controller.activeLayer;
  await controller.show({ id: "second" });

  assert.deepEqual(removedLayers, [firstLayer]);
  assert.equal(controller.activeLayer.layerName, "eolab:second");
});
