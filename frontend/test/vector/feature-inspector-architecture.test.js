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
  new URL("../../src/charts/series-chart.js", import.meta.url),
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
const MAP_INSPECTION_SOURCE = readFileSync(
  new URL("../../src/map-inspection-controller.js", import.meta.url),
  "utf8",
);

test("hover shares presentation through composition without annotation/vector sibling imports", () => {
  const hover = readFileSync(new URL("../../src/map-feature-hover.js", import.meta.url), "utf8");
  const query = readFileSync(new URL("../../src/vector/feature-hover.js", import.meta.url), "utf8");
  const annotations = readFileSync(new URL("../../src/annotations/controller.js", import.meta.url), "utf8");
  assert.doesNotMatch(hover, /^import\s/m);
  assert.doesNotMatch(hover, /GetFeatureInfo|polygonsAt|retainedRecords/);
  assert.doesNotMatch(query, /from ["'].*(?:annotations|raster|main|feature-inspector)\.js["']/);
  assert.doesNotMatch(annotations, /from ["'].*vector\//);
});

test("map-tool docking remains a presentation-only peer coordinator", () => {
  const strip = readFileSync(new URL("../../src/tool-tab-strip.js", import.meta.url), "utf8");
  assert.doesNotMatch(strip, /^import\s/m);
  for (const forbiddenSubsystemKnowledge of [
    "Catalog",
    "GeoServer",
    "GetFeatureInfo",
    "MapLayerController",
    "RasterViewer",
    "VectorFeatureInspectorController",
    "VectorTimeSeriesController",
  ]) {
    assert.equal(
      (MAP_INSPECTION_SOURCE + strip).includes(forbiddenSubsystemKnowledge),
      false,
    );
  }
});

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
  assert.doesNotMatch(INSPECTOR_SOURCE, /\.on\("click"/);
  for (const forbiddenMapImplementation of [
    "leafletMap",
    ".getBounds(",
    ".getSize(",
  ]) {
    assert.equal(FEATURE_INFO_SOURCE.includes(forbiddenMapImplementation), false);
  }
  assert.doesNotMatch(STYLESHEET, /is-inspecting-vector-features/);
  assert.doesNotMatch(INSPECTOR_SOURCE, /MapLayerStyleEditor/);
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
  assert.match(FEATURE_PROFILE_SOURCE, /from "\.\.\/charts\/series-chart\.js"/);
  assert.match(TIME_SERIES_SOURCE, /from "\.\.\/charts\/series-chart\.js"/);
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
});

test("composition does not interpret vector-owned storage or rebuild vector metadata", () => {
  assert.doesNotMatch(COMPOSITION_SOURCE,
    /record\.state\??\.(?:item|style|labelFields|defaultStyleNotice|filter\w*)\b/);
  assert.doesNotMatch(COMPOSITION_SOURCE, /\b(?:vectorLabelFields|vectorFilterStatus)\b/);
});
