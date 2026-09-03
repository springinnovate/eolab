import assert from "node:assert/strict";
import test from "node:test";

import {
    createRasterSampleWindowLayer,
    createRasterWmsLayer,
    ensureRasterSampleWindowPane,
    RASTER_SAMPLE_WINDOW_PANE,
    rasterSampleBoundsToLeaflet,
    setRasterLayerAdditiveBlend,
} from "../../src/raster/leaflet.js";
import { SELECTED_BOUNDS } from "../../test-support/raster/fixtures.js";

test("sample bounds convert to canonical single-world Leaflet corners", () => {
  assert.deepEqual(
    rasterSampleBoundsToLeaflet(SELECTED_BOUNDS),
    [
      [48, -123],
      [50, -121],
    ],
  );
});
test("sample-window pane stays above bounded raster images", () => {
  const panes = new Map();
  const map = {
    getPane(name) { return panes.get(name); },
    createPane(name) {
      const pane = { style: {} };
      panes.set(name, pane);
      return pane;
    },
  };

  const pane = ensureRasterSampleWindowPane(map);

  assert.equal(panes.get(RASTER_SAMPLE_WINDOW_PANE), pane);
  assert.equal(pane.style.zIndex, "450");
  assert.equal(pane.style.pointerEvents, "none");
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
      tiled: true,
      tilesorigin: "-20037508.342789244,-20037508.342789244",
      version: "1.3.0",
      noWrap: true,
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
      pane: RASTER_SAMPLE_WINDOW_PANE,
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
      pane: RASTER_SAMPLE_WINDOW_PANE,
      color: "#2563eb",
      weight: 2,
      fillColor: "#3b82f6",
      fillOpacity: 0.12,
      interactive: false,
    },
  });
});

test("raster WMS blending uses the ESOS-C plus-lighter mode", () => {
  const container = { style: {} };
  const layer = { getContainer: () => container };

  setRasterLayerAdditiveBlend(layer, true);
  assert.equal(container.style.mixBlendMode, "plus-lighter");
  setRasterLayerAdditiveBlend(layer, false);
  assert.equal(container.style.mixBlendMode, "normal");
  assert.throws(
    () => setRasterLayerAdditiveBlend({}, true),
    /container is unavailable/,
  );
});
