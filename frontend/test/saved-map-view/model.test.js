import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

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
  hashSavedMapSourceRevision,
  MAX_SAVED_MAP_VIEW_BYTES,
  parseSavedMapView,
  serializeSavedMapView,
} from "../../src/saved-map-view/model.js";

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
      sourceRevision: null,
      visible: true,
      opacity: 0.65,
      style: {
        kind: "raster",
        definition: { minimum: 0 },
        paletteName: "custom",
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

test("saved map model rejects incompatible, duplicate, and unbounded input", () => {
  const incompatible = createSavedMapView(savedMapCandidate());
  assert.throws(
    () => parseSavedMapView(JSON.stringify({ ...incompatible, schemaVersion: 4 })),
    /schema 4 is not supported/,
  );

  const duplicate = savedMapCandidate();
  duplicate.layers.push(structuredClone(duplicate.layers[0]));
  assert.throws(() => createSavedMapView(duplicate), /cannot repeat/);

  const extended = savedMapCandidate();
  extended.sourcePath = "file:///not-authority/data.tif";
  assert.throws(() => createSavedMapView(extended), /unsupported fields/);

  assert.throws(
    () => parseSavedMapView(" ".repeat(MAX_SAVED_MAP_VIEW_BYTES + 1)),
    /512 KiB/,
  );
});

test("source revisions are exported only as SHA-256 fingerprints", async () => {
  const revision = [["secret/location/data.shp", 123, 456]];
  const fingerprint = await hashSavedMapSourceRevision(revision);

  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(fingerprint.includes("secret"), false);
  assert.equal(await hashSavedMapSourceRevision(null), null);
});
