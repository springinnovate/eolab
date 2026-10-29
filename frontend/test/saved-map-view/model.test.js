import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";

test("version two accepts only portable annotation references and version one stays unchanged", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/saved-map-v2.json", import.meta.url), "utf8"));
  assert.deepEqual(parseSavedMapView(JSON.stringify(fixture)), fixture);
  const old = JSON.parse(readFileSync(new URL("../../../tests/fixtures/saved-map-v1.json", import.meta.url), "utf8"));
  assert.deepEqual(parseSavedMapView(JSON.stringify(old)), old);
  assert.throws(() => parseSavedMapView(JSON.stringify({ ...fixture, schemaVersion: 1 })), /version two/);
  for (const field of ["features", "credential", "contributorId", "browserHash", "collection"]) {
    const candidate = structuredClone(fixture);
    candidate.layers[0].sharedAnnotation[field] = "must not be exported";
    assert.throws(() => parseSavedMapView(JSON.stringify(candidate)), /unsupported fields/);
  }
  fixture.layers.push(structuredClone(fixture.layers[0]));
  assert.throws(() => parseSavedMapView(JSON.stringify(fixture)), /repeat/);
});

import {
  createSavedMapView,
  MAX_SAVED_MAP_VIEW_BYTES,
  parseSavedMapView,
  serializeSavedMapView,
} from "../../src/saved-map-view/model.js";

test("private upload references preserve appearance without accepting data or credentials", () => {
  const candidate = createSavedMapView({ ...savedMapCandidate(), layers: [{
    uploadId: "11111111-1111-4111-8111-111111111111", customName: "Wetlands",
    visible: false, opacity: 0.4, legendIncluded: false,
    style: { kind: "vector", definition: { fillColor: "#123456" } },
    filter: { enabled: true, match: "all", rules: [{ field: "label", operator: "eq", value: "Café wetlands" }] },
  }] });
  assert.deepEqual(parseSavedMapView(serializeSavedMapView(candidate)), candidate);
  for (const field of ["catalogItem", "sourcePath", "fields", "features", "browserHash", "publication"]) {
    const invalid = structuredClone(candidate);
    invalid.layers[0][field] = "not part of a map reference";
    assert.throws(() => parseSavedMapView(JSON.stringify(invalid)), /unsupported fields/);
  }
  const duplicate = structuredClone(candidate);
  duplicate.layers.push(structuredClone(duplicate.layers[0]));
  duplicate.layers[1].customName = "Another wetlands view";
  duplicate.layers[1].style.definition.fillColor = "#abcdef";
  assert.deepEqual(parseSavedMapView(JSON.stringify(duplicate)), duplicate);
  const older = structuredClone(candidate);
  older.schemaVersion = 2;
  delete older.basemap;
  assert.throws(() => parseSavedMapView(JSON.stringify(older)), /version three/);
  const invalidId = structuredClone(candidate);
  invalidId.layers[0].uploadId = "../private.gpkg";
  assert.throws(() => parseSavedMapView(JSON.stringify(invalidId)), /identifier/);
  const raster = structuredClone(candidate);
  raster.layers[0].style = savedMapCandidate().layers[0].style;
  assert.throws(() => parseSavedMapView(JSON.stringify(raster)), /vector style/);
});

test("saved map serialization preserves vector CSV rules as an opaque owner definition", async () => {
  const { parseCategoricalVectorCsv } = await import("../../src/vector/categorical-csv.js");
  const { normalizeVectorStyle } = await import("../../src/vector/style.js");
  const categorical = parseCategoricalVectorCsv("value,label,color,opacity\n01,Wetland,#0000ff,0.25\nA,Hidden,#00ff00,0", { name: "class", type: "str" }, { otherColor: "#abcdef", missingColor: "#112233" });
  const definition = normalizeVectorStyle({ geometryKind: "polygon", fillColor: "#ffffff", fillOpacity: 0.4,
    strokeColor: "#123456", strokeOpacity: 0.8, strokeWidth: 2, categorical });
  const candidate = savedMapCandidate();
  candidate.layers[0].catalogItem = { collection: "vectors", id: "landcover" };
  candidate.layers[0].style = { kind: "vector", definition };
  const restored = parseSavedMapView(serializeSavedMapView(createSavedMapView(candidate)));
  assert.deepEqual(normalizeVectorStyle(restored.layers[0].style.definition), definition);
  assert.deepEqual(restored.layers[0].catalogItem, candidate.layers[0].catalogItem);
});

test("backend parity fixture preserves the browser saved-map document", () => {
  const text = readFileSync(new URL("../../../tests/fixtures/saved-map-v1.json", import.meta.url), "utf8");
  assert.deepEqual(parseSavedMapView(text), JSON.parse(text));
  assert.deepEqual(JSON.parse(serializeSavedMapView(parseSavedMapView(text))), JSON.parse(text));
});

test("custom catalog names round-trip as bounded presentation text without changing identity", () => {
  const candidate = savedMapCandidate();
  const identity = structuredClone(candidate.layers[0].catalogItem);
  candidate.layers[0].customName = "  Protected areas <custom>  ";
  let parsed = parseSavedMapView(serializeSavedMapView(createSavedMapView(candidate)));
  assert.equal(parsed.layers[0].customName, "Protected areas <custom>");
  assert.deepEqual(parsed.layers[0].catalogItem, identity);
  for (const invalid of ["", "  ", 4, {}, "x".repeat(161)]) {
    candidate.layers[0].customName = invalid;
    assert.throws(() => createSavedMapView(candidate), /1 to 160/);
  }
  candidate.layers[0].customName = "🌲".repeat(160);
  assert.equal(createSavedMapView(candidate).layers[0].customName, candidate.layers[0].customName);
  candidate.layers[0].customName = null;
  assert.equal(createSavedMapView(candidate).layers[0].customName, null);
});

/**
 * Return one valid portable map candidate with one raster layer.
 *
 * @return {Object} Valid saved-map construction fields.
 */
function savedMapCandidate() {
  return {
    viewer: { version: "0.2.0", origin: "https://viewer.example" },
    createdAt: "2026-09-01T12:00:00Z",
    viewport: {
      center: { latitude: 12.5, longitude: -42.25 },
      zoom: 6,
    },
    layers: [{
      catalogItem: { collection: "rasters", id: "rainfall" },
      visible: true,
      opacity: 0.65,
      style: {
        kind: "raster", appearanceVersion: 1, mode: "continuous",
        continuous: { definition: { ...DEFAULT_RASTER_STYLE }, paletteName: "custom", styleWasEdited: true },
        categorical: null,
      },
    }],
  };
}

test("saved map model round trips the versioned bounded contract", () => {
  const saved = createSavedMapView(savedMapCandidate());
  const parsed = parseSavedMapView(serializeSavedMapView(saved));

  assert.deepEqual(parsed, saved);
  assert.equal(parsed.format, "eolab-map-view");
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(Object.isFrozen(parsed.layers), true);
});

test("saved map model preserves more than two visible layers", () => {
  const candidate = savedMapCandidate();
  for (const id of ["temperature", "vegetation"]) {
    candidate.layers.push({
      ...structuredClone(candidate.layers[0]),
      catalogItem: { collection: "rasters", id },
    });
  }

  const saved = createSavedMapView(candidate);

  assert.equal(saved.layers.length, 3);
  assert.ok(saved.layers.every((layer) => layer.visible));
});

test("saved map model rejects incompatible and unbounded input", () => {
  const incompatible = createSavedMapView(savedMapCandidate());
  assert.throws(
    () => parseSavedMapView(JSON.stringify({ ...incompatible, schemaVersion: 4 })),
    /schema 4 is not supported/,
  );

  const extended = savedMapCandidate();
  extended.sourcePath = "file:///not-authority/data.tif";
  assert.throws(() => createSavedMapView(extended), /unsupported fields/);

  const oldLayer = savedMapCandidate();
  oldLayer.layers[0].sourceRevision = null;
  assert.throws(() => createSavedMapView(oldLayer), /unsupported fields/);

  assert.throws(
    () => parseSavedMapView(" ".repeat(MAX_SAVED_MAP_VIEW_BYTES + 1)),
    /512 KiB/,
  );
});

test("saved maps retain repeated Catalog sources with independent appearance and order", () => {
  const candidate = savedMapCandidate();
  candidate.layers.push({...structuredClone(candidate.layers[0]), customName: "Another view", opacity: 0.25});
  const saved = createSavedMapView(candidate);
  assert.deepEqual(parseSavedMapView(serializeSavedMapView(saved)), saved);
  assert.deepEqual(saved.layers[0].catalogItem, saved.layers.at(-1).catalogItem);
  assert.equal(saved.layers.at(-1).customName, "Another view");
  assert.equal(saved.layers.at(-1).opacity, 0.25);
});

test("map legend preferences round-trip for catalog and shared layers without changing older maps", () => {
  const candidate = JSON.parse(readFileSync(new URL("../../../tests/fixtures/saved-map-v2.json", import.meta.url), "utf8"));
  candidate.mapLegend = { visible: false, collapsed: true };
  for (const layer of candidate.layers) layer.legendIncluded = false;
  assert.deepEqual(parseSavedMapView(JSON.stringify(candidate)), candidate);
  for (const value of [null, "false", 0, {}]) {
    assert.throws(() => parseSavedMapView(JSON.stringify({ ...candidate, mapLegend: value })));
    assert.throws(() => parseSavedMapView(JSON.stringify({ ...candidate, mapLegend: { visible: value, collapsed: true } })));
    for (let index = 0; index < candidate.layers.length; index++) {
      const invalid = structuredClone(candidate); invalid.layers[index].legendIncluded = value;
      assert.throws(() => parseSavedMapView(JSON.stringify(invalid)), /inclusion/);
    }
  }
});

test("versioned raster appearance round-trips both configurations without interpreting them", () => {
  const candidate = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/saved-map-v3-categorical.json", import.meta.url
  ), "utf8"));
  for (const mode of ["categorical", "continuous"]) {
    candidate.layers[0].style.mode = mode;
    assert.deepEqual(parseSavedMapView(serializeSavedMapView(candidate)), candidate);
  }
  candidate.layers[0].style.categorical = null;
  assert.deepEqual(parseSavedMapView(serializeSavedMapView(candidate)), candidate);
});

test("saved raster appearance rejects mixed envelopes, invalid edit state and unbounded definitions", () => {
  const fixture = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/saved-map-v3-categorical.json", import.meta.url
  ), "utf8"));
  for (const mutate of [
    style => { delete style.appearanceVersion; },
    style => { style.appearanceVersion = 2; },
    style => { style.appearanceVersion = true; },
    style => { style.mode = "unknown"; },
    style => { style.definition = {}; },
    style => { style.continuous = null; },
    style => { style.continuous.styleWasEdited = "false"; },
    style => { style.continuous.paletteName = "x".repeat(101); },
    style => { style.categorical = null; },
    style => { delete style.categorical; },
    style => { style.categorical = { text: "🌲".repeat(17000) }; },
    style => { style.continuous.definition = { text: "x".repeat(65536) }; }
  ]) {
    const candidate = structuredClone(fixture);
    mutate(candidate.layers[0].style);
    assert.throws(() => parseSavedMapView(JSON.stringify(candidate)));
  }
  const candidate = structuredClone(fixture);
  candidate.layers[0].style = { kind: "raster", definition: { ...DEFAULT_RASTER_STYLE }, paletteName: "custom" };
  assert.throws(() => parseSavedMapView(JSON.stringify(candidate)), /missing or unsupported fields/);
});


test("temporal views preserve explicit observations and independent appearance without rendering identities", () => {
  const candidate = savedMapCandidate();
  const layer = {
    temporalSource: { collectionId: "eolab-temporal-datasets", itemId: "era5", variable: "air_temperature",
      time: "2020-01-15T04:00:00-08:00" },
    customName: "Temperature", visible: true, opacity: 0.6, legendIncluded: false,
    style: candidate.layers[0].style,
  };
  candidate.layers = [layer, { ...structuredClone(layer), customName: "Comparison", opacity: 0.3 }];
  const parsed = parseSavedMapView(serializeSavedMapView(createSavedMapView(candidate)));
  for (const expected of candidate.layers) expected.temporalSource.time = "2020-01-15T12:00:00.000Z";
  assert.deepEqual(parsed.layers, candidate.layers);
  for (const time of [null, "bad date", "2020-01-15T12:00:00"]) {
    const invalid = structuredClone(candidate);
    invalid.layers[0].temporalSource.time = time;
    assert.throws(() => createSavedMapView(invalid), /timestamp with a timezone/);
  }
  for (const field of ["path", "publication", "viewId"]) {
    const invalid = structuredClone(candidate);
    invalid.layers[0].temporalSource[field] = "not saved";
    assert.throws(() => createSavedMapView(invalid), /unsupported fields/);
  }
  const invalidStyle = structuredClone(candidate);
  invalidStyle.layers[0].style = { kind: "vector", definition: {} };
  assert.throws(() => createSavedMapView(invalidStyle), /raster style/);
  const invalidFilter = structuredClone(candidate);
  invalidFilter.layers[0].filter = {};
  assert.throws(() => createSavedMapView(invalidFilter), /unsupported fields/);
});
