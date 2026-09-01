import assert from "node:assert/strict";
import test from "node:test";

import { RasterSampleWindowController } from "../../src/raster/sample-window-controller.js";
import {
  createFakeLeafletMap,
  createFakeSampleLayerFactory,
} from "../../test-support/raster/fakes.js";

test("sample window previews and commits composition-owned positions", () => {
  const map = createFakeLeafletMap();
  const layers = [];
  const selections = [];
  const guidance = [];
  const controller = new RasterSampleWindowController(
    map,
    createFakeSampleLayerFactory(layers),
    (bounds) => selections.push(bounds),
    (message) => guidance.push(message),
  );

  assert.equal(controller.selectAt({ lng: 238, lat: 48 }), null);
  assert.match(guidance.at(-1), /inside the map bounds/);
  assert.equal(selections.length, 0);
  assert.equal(map.layers.length, 0);

  controller.setWindowSize(50);
  assert.equal(controller.previewAt({ lng: -122, lat: 48 }), true);
  assert.equal(selections.length, 0);
  assert.equal(layers[0].kind, "preview");
  assert.equal(map.layers.length, 1);
  assert.equal(controller.previewAt({ lng: -121, lat: 47 }), true);
  assert.equal(layers[0].boundsHistory.length, 2);

  const bounds = controller.selectAt({ lng: -122, lat: 48 });
  assert.equal(selections.length, 1);
  assert.equal(bounds, selections[0]);
  assert.ok(bounds.west < -122);
  assert.ok(bounds.east > -122);
  assert.equal(layers.at(-1).kind, "selection");
  assert.equal(map.layers.length, 2);
  assert.deepEqual(controller.selectedBounds, bounds);
  assert.equal(guidance.at(-1), "");
  for (const eventName of ["mousemove", "mouseout", "mouseover", "click"]) {
    assert.equal(map.listenerCount(eventName), 0);
  }

  controller.clearPreview();
  assert.equal(map.layers.length, 1);
});

test("sample window restores a retained selection in the canonical world", () => {
  const map = createFakeLeafletMap();
  const layers = [];
  const controller = new RasterSampleWindowController(
    map,
    createFakeSampleLayerFactory(layers),
    () => {},
    () => {},
  );
  const bounds = { west: -123, south: 47, east: -121, north: 49 };

  controller.restoreSelection(bounds);

  assert.deepEqual(controller.selectedBounds, bounds);
  assert.deepEqual(layers[0].boundsHistory[0], [
    [47, -123],
    [49, -121],
  ]);
});

test("sample window replaces its rectangle and supports complete teardown", () => {
  const map = createFakeLeafletMap();
  const layers = [];
  const selections = [];
  const guidance = [];
  const controller = new RasterSampleWindowController(
    map,
    createFakeSampleLayerFactory(layers),
    (bounds) => selections.push(bounds),
    (message) => guidance.push(message),
  );

  controller.selectAt({ lng: 12, lat: 34 });
  controller.selectAt({ lng: 13, lat: 35 });
  assert.equal(selections.length, 2);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].boundsHistory.length, 2);
  assert.equal(controller.selectAt({ lng: 179.8, lat: 0 }), null);
  assert.match(guidance.at(-1), /pole or date line/);

  controller.clear();
  assert.equal(controller.selectedBounds, null);
  assert.equal(map.layers.length, 0);
  assert.equal(guidance.at(-1), "");
});
