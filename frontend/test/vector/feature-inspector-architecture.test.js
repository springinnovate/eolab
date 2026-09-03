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
const FEATURE_PROFILE_SOURCE = readFileSync(
  new URL("../../src/vector/feature-profile.js", import.meta.url),
  "utf8",
);
const SERIES_CHART_SOURCE = readFileSync(
  new URL("../../src/vector/series-chart.js", import.meta.url),
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
  assert.match(
    COMPOSITION_SOURCE,
    /bbox:\s*\[\.\.\.record\.entry\.item\.bbox\]/,
  );
  assert.match(COMPOSITION_SOURCE, /onInspectionChange:\s*\(visible\)\s*=>/);
  assert.match(COMPOSITION_SOURCE, /onSampleChange:\s*\(sample\)\s*=>/);
  assert.match(COMPOSITION_SOURCE, /onCurrentObservationChange:\s*\(observation\)\s*=>/);
  assert.match(COMPOSITION_SOURCE, /onFeatureProfileRequested:\s*\(\)\s*=>/);
  assert.match(COMPOSITION_SOURCE, /onTimeSeriesRequested:\s*\(\)\s*=>/);
  assert.match(COMPOSITION_SOURCE, /vectorTimeSeries\.close\(\);/);
  assert.match(COMPOSITION_SOURCE, /vectorFeatureProfile\.close\(\);/);
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

test("feature-field analysis is a sibling behind neutral observation and chart contracts", () => {
  for (const forbiddenSibling of [
    "feature-inspector",
    "time-series",
    "MapLayerController",
    "MapInspectionController",
    "retainedRecords",
    "leafletMap",
    "GeoServer",
    "GetFeatureInfo",
    "../raster/",
    "../map-layers/",
  ]) {
    assert.equal(FEATURE_PROFILE_SOURCE.includes(forbiddenSibling), false);
  }
  assert.match(
    COMPOSITION_SOURCE,
    /new VectorFeatureProfileController\(\{/,
  );
  assert.match(
    COMPOSITION_SOURCE,
    /vectorFeatureProfile\.setCurrentObservation\(observation\)/,
  );
  assert.match(
    FEATURE_PROFILE_SOURCE,
    /from "\.\/inspection-observation\.js"/,
  );
  assert.match(TIME_SERIES_SOURCE, /from "\.\/inspection-observation\.js"/);
  assert.match(FEATURE_PROFILE_SOURCE, /from "\.\/series-chart\.js"/);
  assert.match(TIME_SERIES_SOURCE, /from "\.\/series-chart\.js"/);
  for (const forbiddenOwner of [
    "feature-inspector",
    "time-series",
    "MapLayerController",
    "MapInspectionController",
  ]) {
    assert.equal(SERIES_CHART_SOURCE.includes(forbiddenOwner), false);
  }
  assert.doesNotMatch(INSPECTOR_SOURCE, /VectorFeatureProfileController/);
  assert.doesNotMatch(FEATURE_PROFILE_SOURCE, /VectorFeatureInspectorController/);
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
  assert.match(COMPOSITION_SOURCE, /sourceId:\s*record\.entry\.key/);
  assert.match(COMPOSITION_SOURCE, /onSourceLayerZoom:\s*\(sourceId\)\s*=>/);
  assert.match(
    COMPOSITION_SOURCE,
    /return zoomRetainedMapLayer\(record\.entry\.item\)/,
  );
  for (const forbiddenNavigationKnowledge of [
    "getCatalogItemMapBounds",
    "fitBounds",
  ]) {
    assert.equal(TIME_SERIES_SOURCE.includes(forbiddenNavigationKnowledge), false);
  }
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
