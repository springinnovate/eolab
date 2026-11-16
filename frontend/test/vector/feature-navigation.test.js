import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fetchVectorFeatureInfo, VectorFeatureInfoError } from "../../src/vector/feature-info.js";
import { vectorInspectionObservation } from "../../src/vector/feature-inspector.js";
import { validateVectorFeatureFocus } from "../../src/vector/inspection-observation.js";

/**
 * Load the actual composition callback with a map spy, without application startup.
 * @return {{zoom:(focus:Object)=>boolean,fits:Object[]}} Navigation and recorded map fits.
 */
function navigation() {
  const source = readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  const start = source.indexOf("function zoomInspectedVectorFeature(focus)");
  const end = source.indexOf("\n    /**", start);
  const fits = [];
  const map = { fitBounds: (bounds, options) => fits.push({ bounds, options }) };
  const leaflet = { latLngBounds: corners => ({ pad: proportion => ({ corners, proportion }) }) };
  const zoom = new Function("leafletMap", "L", "validateVectorFeatureFocus",
    source.slice(start, end) + "\nreturn zoomInspectedVectorFeature;")(
    map, leaflet, validateVectorFeatureFocus);
  return { zoom, fits };
}

/**
 * Read features through the real external response boundary.
 * @param {Object[]} features External GeoJSON features.
 * @return {Promise<Object[]>} Validated feature response.
 */
function readFeatures(features) {
  return fetchVectorFeatureInfo({
    wmsUrl: "/wms",
    publication: { layerName: "eolab:habitats", styleName: "vector-polygon", style: {} },
    propertyNames: ["name"],
    includeBounds: true,
    viewport: { crs: "EPSG:3857", bbox: [-1e6, -1e6, 1e6, 1e6], width: 800, height: 600, x: 200, y: 300 },
    signal: new AbortController().signal,
  }, async (_url, { body }) => {
    assert.equal(body.get("propertyName"), "name");
    assert.equal(body.get("vector_feature_bounds"), "true");
    return { ok: true, json: async () => ({ type: "FeatureCollection", features }) };
  });
}

/**
 * Publish a feature selected by a buffered click outside its envelope.
 * @param {Object} feature Validated response feature.
 * @return {Object} Immutable analysis observation.
 */
function observation(feature) {
  return vectorInspectionObservation({ feature,
    target: { sourceId: "catalog|habitats", label: "Habitats" },
    inspectionPosition: { lng: -100.01, lat: 30 },
  });
}

test("attribute-only overlapping features navigate to their distinct full envelopes", async () => {
  const features = await readFeatures([
    { type: "Feature", id: "habitats.1", geometry: null, bbox: [-100, 20, -80, 40], properties: { name: "Broad habitat" } },
    { type: "Feature", id: "habitats.2", geometry: null, bbox: [-99.9, 29.9, -99.8, 30.1], properties: { name: "Small habitat" } },
  ]);
  const { zoom, fits } = navigation();
  for (const feature of features) assert.equal(zoom(observation(feature).focus), true);
  assert.deepEqual(fits, [
    { bounds: { corners: [[20, -100], [40, -80]], proportion: 0.15 }, options: { padding: [24, 24], maxZoom: 14 } },
    { bounds: { corners: [[29.9, -99.9], [30.1, -99.8]], proportion: 0.15 }, options: { padding: [24, 24], maxZoom: 14 } },
  ]);
  assert.deepEqual(observation(features[0]).focus.center, [-90, 30]);
});

test("point and world-spanning bounds retain real location with a bounded close zoom", async () => {
  const features = await readFeatures([
    { type: "Feature", geometry: null, bbox: [12, 50, 12, 50], properties: {} },
    { type: "Feature", geometry: null, bbox: [-180, -20, 180, 20], properties: {} },
  ]);
  const { zoom, fits } = navigation();
  for (const feature of features) assert.equal(zoom(observation(feature).focus), true);
  assert.deepEqual(fits[0].bounds.corners, [[50, 12], [50, 12]]);
  assert.deepEqual(fits[1].bounds.corners, [[-20, -180], [20, 180]]);
  assert.equal(fits[0].options.maxZoom, 14);
});

test("absent bounds never turn an inspection click into a fabricated feature location", async () => {
  const features = await readFeatures([
    { type: "Feature", geometry: null, bbox: null, properties: {} },
    { type: "Feature", geometry: null, properties: {} },
  ]);
  const { zoom, fits } = navigation();
  for (const feature of features) assert.equal(zoom(observation(feature).focus), false);
  assert.deepEqual(fits, []);
});

test("invalid external feature bounds cannot reach map navigation", async () => {
  for (const bbox of [[], [1, 2, 3], [0, 0, NaN, 1], [0, 0, Infinity, 1],
    [4, 0, 1, 3], [0, 4, 1, 3], [-181, 0, 1, 1], [0, 0, 181, 1],
    [0, -91, 1, 1], [0, 0, 1, 91], ["0", 0, 1, 1]]) {
    await assert.rejects(readFeatures([{ type: "Feature", geometry: null, bbox, properties: {} }]),
      VectorFeatureInfoError);
  }
  const { zoom, fits } = navigation();
  assert.equal(zoom({ center: [0, 0], bounds: [0, 0, 181, 1] }), false);
  assert.deepEqual(fits, []);
});
