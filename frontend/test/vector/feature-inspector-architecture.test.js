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
  assert.match(COMPOSITION_SOURCE, /onActiveChange:\s*\(active\)\s*=>/);
  for (const forbiddenMapImplementation of [
    "leafletMap",
    ".getBounds(",
    ".getSize(",
  ]) {
    assert.equal(FEATURE_INFO_SOURCE.includes(forbiddenMapImplementation), false);
  }
  assert.doesNotMatch(
    STYLESHEET,
    /#open-map-histogram\[hidden\]\)\s+#open-vector-inspector/,
  );
});
