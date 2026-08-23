import assert from "node:assert/strict";
import test from "node:test";

import {
  createTemporaryAoiLayer,
  ensureTemporaryAoiPane,
  TEMPORARY_AOI_PANE,
  TemporaryAoiLayerController,
} from "../../src/temporary-aoi/leaflet.js";

const GEOMETRY = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [-122.5, 48.5] },
    },
  ],
};

/**
 * Create inspectable Leaflet map and namespace collaborators.
 *
 * @return {{leaflet: Object, map: Object, calls: Object}} Test collaborators.
 */
function createLeafletFixture() {
  const pane = { style: {} };
  const calls = {
    layers: [],
    removed: [],
    fitBounds: [],
    geoJson: [],
    createdPanes: [],
  };
  const map = {
    pane: null,
    getPane(name) {
      assert.equal(name, TEMPORARY_AOI_PANE);
      return this.pane;
    },
    createPane(name) {
      calls.createdPanes.push(name);
      this.pane = pane;
      return pane;
    },
    removeLayer(layer) {
      calls.removed.push(layer);
      calls.layers = calls.layers.filter((candidate) => candidate !== layer);
    },
    fitBounds(bounds, options) {
      calls.fitBounds.push({ bounds, options });
    },
  };
  const leaflet = {
    geoJSON(geometry, options) {
      const layer = {
        geometry,
        options,
        addTo(receivedMap) {
          assert.equal(receivedMap, map);
          calls.layers.push(this);
          return this;
        },
      };
      calls.geoJson.push({ geometry, options, layer });
      return layer;
    },
    latLngBounds(corners) {
      return {
        corners,
        isValid: () => true,
        pad(amount) {
          return { corners, amount };
        },
      };
    },
  };
  return { calls, leaflet, map };
}

test("temporary AOI pane is isolated above ordinary Leaflet overlays", () => {
  const { calls, map } = createLeafletFixture();

  const pane = ensureTemporaryAoiPane(map);

  assert.deepEqual(calls.createdPanes, [TEMPORARY_AOI_PANE]);
  assert.equal(pane.style.zIndex, "460");
  assert.equal(pane.style.pointerEvents, "none");
});

test("temporary AOI GeoJSON owns a distinct noninteractive high-contrast style", () => {
  const { calls, leaflet } = createLeafletFixture();

  const layer = createTemporaryAoiLayer(leaflet, GEOMETRY);

  assert.equal(layer, calls.geoJson[0].layer);
  assert.deepEqual(calls.geoJson[0].geometry, GEOMETRY);
  assert.equal(calls.geoJson[0].options.pane, TEMPORARY_AOI_PANE);
  assert.equal(calls.geoJson[0].options.interactive, false);
  assert.equal(
    calls.geoJson[0].options.style.className,
    "temporary-aoi-overlay",
  );
  assert.equal(calls.geoJson[0].options.style.weight >= 4, true);
});

test("temporary AOI layer supports show, hide, zoom, replace, and clear", () => {
  const { calls, leaflet, map } = createLeafletFixture();
  const controller = new TemporaryAoiLayerController(map, leaflet);

  controller.load({ geometry: GEOMETRY, bbox: [-123, 48, -122, 49] });
  const firstLayer = controller.activeLayer;

  assert.equal(controller.isVisible, true);
  assert.deepEqual(calls.layers, [firstLayer]);
  assert.deepEqual(calls.fitBounds[0], {
    bounds: {
      corners: [[48, -123], [49, -122]],
      amount: 0.15,
    },
    options: { maxZoom: 13 },
  });

  assert.equal(controller.hide(), true);
  assert.equal(controller.isVisible, false);
  assert.deepEqual(calls.removed, [firstLayer]);
  assert.equal(controller.show(), true);
  assert.equal(controller.isVisible, true);

  controller.load({ geometry: GEOMETRY, bbox: [-10, -5, 20, 15] });
  const secondLayer = controller.activeLayer;
  assert.notEqual(secondLayer, firstLayer);
  assert.deepEqual(calls.removed, [firstLayer, firstLayer]);
  assert.deepEqual(calls.layers, [secondLayer]);

  controller.clear();
  assert.equal(controller.activeLayer, null);
  assert.equal(controller.isVisible, false);
  assert.deepEqual(calls.removed, [firstLayer, firstLayer, secondLayer]);
});
