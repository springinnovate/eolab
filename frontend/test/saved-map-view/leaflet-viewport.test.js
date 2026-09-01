import assert from "node:assert/strict";
import test from "node:test";

import { createSavedMapLeafletViewport } from "../../src/saved-map-view/leaflet-viewport.js";

test("saved map Leaflet adapter snapshots and restores the neutral viewport", () => {
  const calls = [];
  const viewport = createSavedMapLeafletViewport({
    getCenter: () => ({ lat: 44.5, lng: -120.25 }),
    getZoom: () => 7,
    setView: (...arguments_) => calls.push(arguments_),
  });

  const snapshot = viewport.snapshot();
  assert.deepEqual(snapshot, {
    center: { latitude: 44.5, longitude: -120.25 },
    zoom: 7,
  });
  viewport.restore(snapshot);
  assert.deepEqual(calls, [[[44.5, -120.25], 7]]);
});
