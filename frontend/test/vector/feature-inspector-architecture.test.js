import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const INSPECTOR_SOURCE = readFileSync(
  new URL("../../src/vector/feature-inspector.js", import.meta.url),
  "utf8",
);
const FEATURE_INFO_SOURCE = readFileSync(
  new URL("../../src/vector/feature-info.js", import.meta.url),
  "utf8",
);
const STYLE_CONTROLS_SOURCE = readFileSync(
  new URL("../../src/vector/style-controls.js", import.meta.url),
  "utf8",
);
const TIME_SERIES_SOURCE = readFileSync(
  new URL("../../src/vector/time-series.js", import.meta.url),
  "utf8",
);
const COMPOSITION_SOURCE = readFileSync(
  new URL("../../src/main.js", import.meta.url),
  "utf8",
);
const STYLESHEET = readFileSync(
  new URL("../../src/style.css", import.meta.url),
  "utf8",
);

test("vector inspection coordination remains in the browser composition root", () => {
  for (const forbiddenPeerKnowledge of [
    "MapLayerController",
    "MapInspectionController",
    "retainedRecords",
    "vectorAdapter",
    "mapLayers",
  ]) {
    assert.doesNotMatch(INSPECTOR_SOURCE, new RegExp(forbiddenPeerKnowledge));
  }
  assert.match(COMPOSITION_SOURCE, /getVisibleTargets:\s*\(\)\s*=>/);
  assert.match(COMPOSITION_SOURCE, /onInspectionChange:\s*\(visible\)\s*=>/);
  assert.match(COMPOSITION_SOURCE, /onSampleChange:\s*\(sample\)\s*=>/);
  assert.match(COMPOSITION_SOURCE, /onTimeSeriesRequested:\s*\(\)\s*=>/);
  assert.match(COMPOSITION_SOURCE, /leafletMap\.on\("click", exploreMap\)/);
  assert.match(
    COMPOSITION_SOURCE,
    /getContainer\(\)\.classList\.add\("leaflet-crosshair"\)/,
  );
  assert.match(COMPOSITION_SOURCE, /rasterVisualization\.exploreAt\(event\.latlng\)/);
  assert.match(COMPOSITION_SOURCE, /vectorFeatureInspector\.inspect\(event\)/);
  assert.doesNotMatch(INSPECTOR_SOURCE, /\.on\("click"/);
  for (const forbiddenMapImplementation of [
    "leafletMap",
    ".getBounds(",
    ".getSize(",
  ]) {
    assert.equal(FEATURE_INFO_SOURCE.includes(forbiddenMapImplementation), false);
  }
  assert.doesNotMatch(STYLESHEET, /is-inspecting-vector-features/);
});

test("time-series analysis consumes neutral samples without sibling knowledge", () => {
  for (const forbiddenSibling of [
    "feature-inspector",
    "MapLayerController",
    "MapInspectionController",
    "retainedRecords",
    "leafletMap",
    "GeoServer",
    "GetFeatureInfo",
    "../raster/",
    "../map-layers/",
  ]) {
    assert.equal(TIME_SERIES_SOURCE.includes(forbiddenSibling), false);
  }
  assert.match(
    COMPOSITION_SOURCE,
    /new VectorTimeSeriesController\(\{/,
  );
  assert.match(
    COMPOSITION_SOURCE,
    /onSampleChange:\s*\(sample\)\s*=>\s*vectorTimeSeries\.setSample\(sample\)/,
  );
  assert.doesNotMatch(INSPECTOR_SOURCE, /VectorTimeSeriesController/);
  assert.doesNotMatch(TIME_SERIES_SOURCE, /VectorFeatureInspectorController/);
});

test("vector style controls expose intent without knowing sibling subsystems", () => {
  for (const forbiddenSibling of [
    "../map-layers/",
    "../raster/",
    "MapLayerController",
    "rasterViewer",
    "leafletMap",
  ]) {
    assert.equal(STYLE_CONTROLS_SOURCE.includes(forbiddenSibling), false);
  }
  assert.match(COMPOSITION_SOURCE, /getVectorStyleTarget:\s*\(key\)\s*=>/);
  assert.match(COMPOSITION_SOURCE, /fields:\s*record\.state\.labelFields/);
  assert.match(
    COMPOSITION_SOURCE,
    /record\.adapter\.summarizeCategories\(record, field\)/,
  );
  assert.match(
    COMPOSITION_SOURCE,
    /record\.adapter\.classifyNumbers\(record, field, method, classCount\)/,
  );
  assert.match(COMPOSITION_SOURCE, /record\.adapter\.applyStyle\(record, style\)/);
});
