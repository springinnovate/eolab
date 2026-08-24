import assert from "node:assert/strict";
import test from "node:test";

import {
  createRasterDetailPreviewLayer,
  ensureRasterDetailPreviewPanes,
  RASTER_DETAIL_PREVIEW_BOUNDARY_PANE,
  RASTER_DETAIL_PREVIEW_IMAGE_PANE,
} from "../../src/raster/detail-preview-leaflet.js";
import {
  CENTER_SAMPLE_DETAIL_PREVIEW,
  CURRENT_VIEW_DETAIL_PREVIEW,
  EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
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

test("sampled raster panes keep boundaries above opaque images", () => {
  const panes = new Map();
  const map = {
    getPane(name) { return panes.get(name); },
    createPane(name) {
      const pane = { style: {} };
      panes.set(name, pane);
      return pane;
    },
  };

  const result = ensureRasterDetailPreviewPanes(map);

  assert.equal(result.imagePane.style.zIndex, "420");
  assert.equal(result.boundaryPane.style.zIndex, "440");
  assert.equal(result.imagePane.style.pointerEvents, "none");
  assert.equal(result.boundaryPane.style.pointerEvents, "none");
});

test("full-extent fixed sample uses one colored image at warped bounds", () => {
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
    "raster-detail-image raster-sampled-proxy",
  );
  assert.equal(presentation.layer.layers[1].options.opacity, 1);
  assert.equal(
    presentation.layer.layers[0].options.pane,
    RASTER_DETAIL_PREVIEW_BOUNDARY_PANE,
  );
  assert.equal(
    presentation.layer.layers[1].options.pane,
    RASTER_DETAIL_PREVIEW_IMAGE_PANE,
  );
});

test("current-view detail uses the base style and no duplicate raster extent", () => {
  const leaflet = fakeLeaflet();
  const style = { minimum: 0, midpoint: 50, maximum: 100 };
  const presentation = createRasterDetailPreviewLayer(
    leaflet,
    CURRENT_VIEW_DETAIL_PREVIEW,
    {
      style,
      encodeImage(_preview, actualStyle) {
        assert.equal(actualStyle, style);
        return "data:image/png;base64,current-view";
      },
    },
  );

  assert.deepEqual(
    presentation.layer.layers.map((layer) => layer.kind),
    ["image", "rectangle"],
  );
  assert.equal(
    presentation.layer.layers[1].options.className,
    "raster-current-view-detail-boundary",
  );
  assert.equal(
    presentation.layer.layers[0].options.pane,
    RASTER_DETAIL_PREVIEW_IMAGE_PANE,
  );
  assert.equal(
    presentation.layer.layers[1].options.pane,
    RASTER_DETAIL_PREVIEW_BOUNDARY_PANE,
  );
  assert.equal(presentation.style, style);

  const exactPresentation = createRasterDetailPreviewLayer(
    fakeLeaflet(),
    EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
    {
      style,
      encodeImage: () => "data:image/png;base64,exact-current-view",
    },
  );
  assert.equal(
    exactPresentation.layer.layers[0].options.className,
    "raster-detail-image raster-source-detail",
  );
});
