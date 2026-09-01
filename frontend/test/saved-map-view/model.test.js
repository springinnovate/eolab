import assert from "node:assert/strict";
import test from "node:test";

import {
  createSavedMapView,
  hashSavedMapSourceRevision,
  MAX_SAVED_MAP_VIEW_BYTES,
  parseSavedMapView,
  serializeSavedMapView,
} from "../../src/saved-map-view/model.js";

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
  assert.equal(parsed.schemaVersion, 1);
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
    () => parseSavedMapView(JSON.stringify({ ...incompatible, schemaVersion: 2 })),
    /schema 2 is not supported/,
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
