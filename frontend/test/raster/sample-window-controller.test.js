import assert from "node:assert/strict";
import test from "node:test";

import { RasterSampleWindowController } from "../../src/raster/sample-window-controller.js";
import {
  createFakeLeafletMap,
  createFakeSampleLayerFactory,
} from "../../test-support/raster/fakes.js";

test("sample window previews on movement and requests only on click", () => {
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

  controller.enable();
  assert.equal(controller.isEnabled, true);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].kind, "preview");
  assert.equal(selections.length, 0);

  assert.doesNotThrow(() => {
    map.emit("mousemove", { latlng: { lng: 238, lat: 48 } });
  });
  assert.match(guidance.at(-1), /inside the map bounds/);
  assert.equal(map.layers.length, 0);

  map.emit("click", { latlng: { lng: 238, lat: 48 } });
  assert.equal(selections.length, 0);
  assert.equal(map.layers.length, 0);

  map.emit("mousemove", { latlng: { lng: -122, lat: 48 } });
  assert.equal(layers.length, 2);
  assert.equal(layers[1].kind, "preview");
  controller.setWindowSize(50);
  assert.equal(layers[1].boundsHistory.length, 2);
  assert.equal(selections.length, 0);

  map.emit("click", { latlng: { lng: -122, lat: 48 } });
  assert.equal(selections.length, 1);
  assert.ok(selections[0].west < -122);
  assert.ok(selections[0].east > -122);
  assert.equal(layers.at(-1).kind, "selection");
  assert.deepEqual(controller.selectedBounds, selections[0]);
  assert.equal(guidance.at(-1), "");
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

test("sample window supports map-center selection and complete teardown", () => {
  const map = createFakeLeafletMap({ lng: 12, lat: 34 });
  const layers = [];
  const selections = [];
  const guidance = [];
  const controller = new RasterSampleWindowController(
    map,
    createFakeSampleLayerFactory(layers),
    (bounds) => selections.push(bounds),
    (message) => guidance.push(message),
  );

  controller.sampleMapCenter();
  assert.equal(selections.length, 1);
  assert.equal(layers[0].kind, "selection");
  controller.enable();
  map.emit("mousemove", { latlng: { lng: 179.8, lat: 0 } });
  assert.match(guidance.at(-1), /pole or date line/);

  controller.clear();
  assert.equal(controller.isEnabled, false);
  assert.equal(controller.selectedBounds, null);
  assert.equal(map.layers.length, 0);
  for (const eventName of ["mousemove", "mouseout", "mouseover", "click"]) {
    assert.equal(map.listenerCount(eventName), 0);
  }
});
