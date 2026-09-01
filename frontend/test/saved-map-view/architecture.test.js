import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SAVED_MAP_MODULES = [
  "catalog-client.js",
  "controller.js",
  "dom-view.js",
  "leaflet-viewport.js",
  "model.js",
];

test("saved map modules do not import dataset feature implementations", async () => {
  for (const moduleName of SAVED_MAP_MODULES) {
    const source = await readFile(
      new URL(`../../src/saved-map-view/${moduleName}`, import.meta.url),
      "utf8",
    );

    assert.doesNotMatch(source, /\.\.\/raster\//);
    assert.doesNotMatch(source, /\.\.\/vector\//);
  }
});

test("composition alone assembles the saved map coordinator", async () => {
  const composition = await readFile(
    new URL("../../src/main.js", import.meta.url),
    "utf8",
  );
  const controller = await readFile(
    new URL("../../src/saved-map-view/controller.js", import.meta.url),
    "utf8",
  );

  assert.match(composition, /new SavedMapViewController\(/);
  assert.match(composition, /new SavedMapViewCatalogClient\(catalogUrl\)/);
  assert.doesNotMatch(controller, /fetch\(/);
  assert.doesNotMatch(controller, /layerName|styleName|sourceUri|href/);
});
