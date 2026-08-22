import assert from "node:assert/strict";
import test from "node:test";

import {
  createRasterSampleWindowLayer,
  createRasterWmsLayer,
  RasterLeafletLayerSet,
  rasterSampleBoundsToLeaflet,
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

test("RasterLeafletLayerSet retains hidden layers without tile traffic", () => {
  const attachedLayers = [];
  const removedLayers = [];
  const leafletMap = {
    removeLayer(layer) {
      removedLayers.push(layer);
    },
  };
  const createLayer = (name) => ({
    name,
    opacity: null,
    zIndex: null,
    addCount: 0,
    addTo(map) {
      assert.equal(map, leafletMap);
      this.addCount += 1;
      attachedLayers.push(this);
      return this;
    },
    setOpacity(opacity) {
      this.opacity = opacity;
    },
    setZIndex(zIndex) {
      this.zIndex = zIndex;
    },
  });
  const first = createLayer("first");
  const second = createLayer("second");
  const layers = new RasterLeafletLayerSet(leafletMap);

  layers.add("first", first, { visible: true, opacity: 0.75 });
  layers.add("second", second, { visible: false, opacity: 0.5 });
  assert.deepEqual(attachedLayers, [first]);
  assert.equal(first.opacity, 0.75);
  assert.equal(second.opacity, 0.5);
  assert.equal(layers.isAttached("second"), false);

  layers.setVisible("first", false);
  layers.setVisible("second", true);
  layers.setVisible("second", true);
  assert.deepEqual(removedLayers, [first]);
  assert.equal(second.addCount, 1);
  assert.equal(layers.get("second"), second);
});

test("RasterLeafletLayerSet applies top-first order and isolated opacity", () => {
  const leafletMap = { removeLayer() {} };
  const createLayer = () => ({
    opacity: null,
    zIndex: null,
    addTo() {
      return this;
    },
    setOpacity(opacity) {
      this.opacity = opacity;
    },
    setZIndex(zIndex) {
      this.zIndex = zIndex;
    },
  });
  const top = createLayer();
  const bottom = createLayer();
  const layers = new RasterLeafletLayerSet(leafletMap);
  layers.add("top", top, { visible: true, opacity: 1 });
  layers.add("bottom", bottom, { visible: true, opacity: 1 });

  layers.setOrder(["top", "bottom"]);
  layers.setOpacity("bottom", 0.25);
  assert.ok(top.zIndex > bottom.zIndex);
  assert.equal(top.opacity, 1);
  assert.equal(bottom.opacity, 0.25);
  assert.throws(() => layers.setOrder(["top", "top"]), /complete layer set|duplicate/);

  layers.clear();
  assert.equal(layers.get("top"), null);
  assert.equal(layers.get("bottom"), null);
});
