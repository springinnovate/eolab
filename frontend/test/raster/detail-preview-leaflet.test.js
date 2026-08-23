import assert from "node:assert/strict";
import test from "node:test";

import { createRasterDetailPreviewLayer } from "../../src/raster/detail-preview-leaflet.js";
import {
  CENTER_SAMPLE_DETAIL_PREVIEW,
  PATCH_DETAIL_PREVIEW,
  REPRESENTATIVE_SAMPLE_DETAIL_PREVIEW,
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
    circleMarker() {
      throw new Error("numeric sampled rasters must not create point markers");
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

test("full-extent sampled modes use one colored image at warped bounds", () => {
  const leaflet = fakeLeaflet();
  const presentation = createRasterDetailPreviewLayer(
    leaflet,
    CENTER_SAMPLE_DETAIL_PREVIEW,
    { encodeImage(preview, style) {
      assert.equal(preview, CENTER_SAMPLE_DETAIL_PREVIEW);
      assert.deepEqual(
        [style.minimum, style.midpoint, style.maximum],
        [0, 50, 100],
      );
      return "data:image/png;base64,center-proxy";
    } },
  );

  assert.deepEqual(presentation.focusBounds, [[48, -123], [50, -121]]);
  assert.equal(presentation.layer.layers[0].options.dashArray, "7 5");
  assert.deepEqual(
    presentation.layer.layers.map((layer) => layer.kind),
    ["rectangle", "image"],
  );
  assert.deepEqual(
    presentation.layer.layers[1].bounds,
    [[48.1, -122.9], [49.9, -121.1]],
  );
  assert.equal(
    presentation.layer.layers[1].url,
    "data:image/png;base64,center-proxy",
  );
  assert.equal(
    presentation.layer.layers[1].options.className,
    "raster-sampled-proxy",
  );
  assert.equal(presentation.layer.layers[1].options.opacity, 1);

  const representative = createRasterDetailPreviewLayer(
    fakeLeaflet(),
    REPRESENTATIVE_SAMPLE_DETAIL_PREVIEW,
    { encodeImage: () => "data:image/png;base64,representative-proxy" },
  );
  assert.deepEqual(representative.focusBounds, [[48, -123], [50, -121]]);
});

test("representative patch focuses its numeric image and retains raster extent", () => {
  const leaflet = fakeLeaflet();
  const presentation = createRasterDetailPreviewLayer(
    leaflet,
    PATCH_DETAIL_PREVIEW,
    { encodeImage: () => "data:image/png;base64,detail-patch" },
  );

  assert.deepEqual(presentation.focusBounds, [[48.9, -122.1], [49.1, -121.9]]);
  assert.deepEqual(
    presentation.layer.layers.map((layer) => layer.kind),
    ["rectangle", "image", "rectangle"],
  );
  assert.equal(
    presentation.layer.layers[1].url,
    "data:image/png;base64,detail-patch",
  );
  assert.equal(
    presentation.layer.layers[2].options.className,
    "raster-detail-patch-boundary",
  );
});
