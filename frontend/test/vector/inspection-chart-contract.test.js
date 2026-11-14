import assert from "node:assert/strict";
import test from "node:test";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { vectorInspectionObservation } from "../../src/vector/feature-inspector.js";
import { VectorFeatureProfileController } from "../../src/vector/feature-profile.js";
import { VectorTimeSeriesController } from "../../src/vector/time-series.js";

test("both chart controllers consume the inspector's immutable scalar observation", () => {
  const observation = vectorInspectionObservation({
    feature: {
      id: "habitat.1",
      geometry: { type: "Point", coordinates: [20, 10] },
      properties: { R1999: 1, R2000: 2, nested: { ignored: true } },
    },
    target: { sourceId: "catalog|habitat", label: "Habitat" },
    inspectionPosition: { lng: 21, lat: 11 },
  });
  const documentContext = new FakeRasterControlDocument();
  const events = new EventTarget();
  documentContext.addEventListener = events.addEventListener.bind(events);
  documentContext.removeEventListener = events.removeEventListener.bind(events);
  const zooms = [];
  const configuration = {
    documentContext,
    onVisibilityChange() {},
    onPresentationChange() {},
    onNavigateFeature() {},
    onFeatureZoom(focus) { zooms.push(focus); return true; },
  };
  const profile = new VectorFeatureProfileController(configuration);
  const series = new VectorTimeSeriesController(configuration);
  profile.setCurrentObservation(observation);
  series.setSample(Object.freeze({
    state: "ready", message: "Ready", observations: Object.freeze([observation]),
  }));
  profile.render();
  series.render();

  assert.equal(profile.currentObservation, observation);
  assert.equal(series.observations[0], observation);
  assert.deepEqual(documentContext.querySelector("#vector-feature-profile-table-body")
    .children.map(row => row.children[0].textContent), ["R1999", "R2000"]);
  assert.equal(documentContext.querySelector("#vector-time-series-table-body")
    .children[0].children[3].textContent, "1");
  documentContext.querySelector("#zoom-vector-feature-profile-feature").dispatchEvent(new Event("click"));
  assert.deepEqual(zooms, [{ center: [20, 10], bounds: [20, 10, 20, 10] }]);
  assert.deepEqual(observation.properties, { R1999: 1, R2000: 2 });
  assert.equal(Object.isFrozen(observation.properties), true);
  profile.destroy();
  series.destroy();
});
