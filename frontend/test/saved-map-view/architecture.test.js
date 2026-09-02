import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const SAVED_MAP_MODULES = [
  "catalog-client.js",
  "controller.js",
  "dom-view.js",
  "fragment-codec.js",
  "leaflet-viewport.js",
  "model.js",
];
const SOURCE_ROOT = new URL("../../src/", import.meta.url);

test("saved map modules do not import sibling implementations", async () => {
  for (const moduleName of SAVED_MAP_MODULES) {
    const source = await readFile(
      new URL(`../../src/saved-map-view/${moduleName}`, import.meta.url),
      "utf8",
    );

    assert.doesNotMatch(source, /\.\.\/raster\//);
    assert.doesNotMatch(source, /\.\.\/vector\//);
    assert.doesNotMatch(source, /\.\.\/map-layers\//);
    assert.doesNotMatch(source, /\.\.\/catalog-visualization\.js/);
  }
});

test("only the composition root imports the saved map package", async () => {
  const sourceFiles = await readdir(SOURCE_ROOT, { recursive: true });
  const violations = [];

  for (const sourceFile of sourceFiles) {
    const normalizedPath = sourceFile.replaceAll("\\", "/");
    if (!normalizedPath.endsWith(".js") || normalizedPath === "main.js" ||
        normalizedPath.startsWith("saved-map-view/")) {
      continue;
    }
    const source = await readFile(new URL(normalizedPath, SOURCE_ROOT), "utf8");
    if (/from\s+["'][^"']*saved-map-view\//.test(source)) {
      violations.push(normalizedPath);
    }
  }

  assert.deepEqual(violations, []);
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
  const codec = await readFile(
    new URL("../../src/saved-map-view/fragment-codec.js", import.meta.url),
    "utf8",
  );

  assert.match(composition, /new SavedMapViewController\(/);
  assert.match(composition, /new SavedMapViewCatalogClient\(catalogUrl\)/);
  assert.doesNotMatch(controller, /fetch\(/);
  assert.doesNotMatch(controller, /layerName|styleName|sourceUri|href/);
  assert.doesNotMatch(codec, /^import\s/m);
  assert.doesNotMatch(codec, /fetch\(|localStorage|sessionStorage/);
});
