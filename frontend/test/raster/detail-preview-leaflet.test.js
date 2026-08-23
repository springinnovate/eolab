import assert from "node:assert/strict";
import test from "node:test";

import { createRasterDetailPreviewLayer } from "../../src/raster/detail-preview-leaflet.js";
import {
  CENTER_PIXEL_DETAIL_PREVIEW,
  PATCH_DETAIL_PREVIEW,
} from "../../test-support/raster/fixtures.js";

/**
 * Create an inspectable Leaflet construction boundary.
 *
 * @return {Object} Fake Leaflet namespace and construction log.
 */
function fakeLeaflet() {
  const constructed = [];
  return {
    constructed,
    rectangle(bounds, options) {
      const layer = { kind: "rectangle", bounds, options };
      constructed.push(layer);
      return layer;
    },
    circleMarker(position, options) {
      const layer = {
        kind: "marker",
        position,
        options,
        bindTooltip(text) { this.tooltip = text; },
      };
      constructed.push(layer);
      return layer;
    },
    imageOverlay(url, bounds, options) {
      const layer = { kind: "image", url, bounds, options };
      constructed.push(layer);
      return layer;
    },
    layerGroup(layers) {
      return { kind: "group", layers };
    },
  };
}

test("center nodata is visibly placed and labeled without becoming zero", () => {
  const leaflet = fakeLeaflet();
  const presentation = createRasterDetailPreviewLayer(
    leaflet,
    CENTER_PIXEL_DETAIL_PREVIEW,
  );

  assert.deepEqual(presentation.focusBounds, [[48, -123], [50, -121]]);
  assert.equal(presentation.layer.layers[0].options.dashArray, "7 5");
  assert.deepEqual(presentation.layer.layers[1].position, [49, -122]);
  assert.match(presentation.layer.layers[1].tooltip, /nodata/);
  assert.doesNotMatch(presentation.layer.layers[1].tooltip, /: 0$/);
});

test("representative PNG uses its warped detail bounds and retains raster extent", () => {
  const leaflet = fakeLeaflet();
  const presentation = createRasterDetailPreviewLayer(
    leaflet,
    PATCH_DETAIL_PREVIEW,
  );

  assert.deepEqual(presentation.focusBounds, [[48.9, -122.1], [49.1, -121.9]]);
  assert.deepEqual(
    presentation.layer.layers.map((layer) => layer.kind),
    ["rectangle", "image", "rectangle"],
  );
  assert.equal(
    presentation.layer.layers[1].url,
    PATCH_DETAIL_PREVIEW.imageDataUrl,
  );
});
