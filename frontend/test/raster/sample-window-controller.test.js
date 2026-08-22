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
  assert.equal(guidance.at(-1), "");
  const wrappedPreview = layers[0].boundsHistory.at(-1);
  assert.ok(wrappedPreview[0][1] < 238);
  assert.ok(wrappedPreview[1][1] > 238);

  map.emit("click", { latlng: { lng: 238, lat: 48 } });
  assert.equal(selections.length, 1);
  assert.ok(selections[0].west < -122);
  assert.ok(selections[0].east > -122);
  const wrappedSelection = layers.at(-1).boundsHistory.at(-1);
  assert.ok(wrappedSelection[0][1] < 238);
  assert.ok(wrappedSelection[1][1] > 238);

  map.emit("mousemove", { latlng: { lng: -122, lat: 48 } });
  controller.setWindowSize(50);
  assert.equal(layers[0].boundsHistory.length, 4);
  assert.equal(selections.length, 1);

  map.emit("click", { latlng: { lng: -122, lat: 48 } });
  assert.equal(selections.length, 2);
  assert.equal(layers.at(-1).kind, "selection");
  assert.deepEqual(controller.selectedBounds, selections[1]);
  assert.equal(guidance.at(-1), "");
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
