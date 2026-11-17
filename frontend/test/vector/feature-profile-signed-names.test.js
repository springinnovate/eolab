import assert from "node:assert/strict";
import test from "node:test";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { vectorInspectionObservation } from "../../src/vector/feature-inspector.js";
import {
  buildVectorFeatureProfile,
  suggestFeatureProfileFields,
  VectorFeatureProfileController,
} from "../../src/vector/feature-profile.js";

/**
 * Produce one real inspector observation from source attributes.
 * @param {Object<string, number|string|null>} properties Scalar feature attributes.
 * @return {import("../../src/vector/inspection-observation.js").VectorInspectionObservation} Immutable profile input.
 */
function observation(properties) {
  return vectorInspectionObservation({
    target: { sourceId: "catalog:temperature-sites", label: "Temperature sites" },
    feature: { id: "site-7", properties, bbox: [1, 2, 3, 4] },
    inspectionPosition: { lng: 2, lat: 3 },
  });
}

/**
 * Connect production profile and chart rendering to observable DOM controls.
 * @param {Object<string, number|string|null>} properties Source attributes.
 * @return {{controller:VectorFeatureProfileController,document:FakeRasterControlDocument}} Rendered profile fixture.
 */
function renderProfile(properties) {
  const document = new FakeRasterControlDocument();
  const events = new EventTarget();
  document.addEventListener = events.addEventListener.bind(events);
  document.removeEventListener = events.removeEventListener.bind(events);
  const controller = new VectorFeatureProfileController({
    documentContext: document,
    onVisibilityChange() {}, onPresentationChange() {},
    onNavigateFeature() {}, onFeatureZoom: () => true,
  });
  controller.setCurrentObservation(observation(properties));
  return { controller, document };
}

for (const fields of [
  ["response(-5°C)", "response(-20°C)"],
  ["Depth_-0.5_m", "Depth_-2.0_m"],
  ["depth_-.5_m", "depth_-.25_m"],
  ["response(−5°C)", "response(−20°C)"],
  ["response(- 5°C)", "response(- 20°C)"],
  ["year-2000", "year-2005"],
]) {
  test(`ambiguous signs retain complete axis labels: ${fields.join(", ")}`, () => {
    const properties = { name: "Cold site", [fields[0]]: 5, [fields[1]]: -12, unrelated: 99 };
    const current = observation(properties);
    assert.deepEqual(suggestFeatureProfileFields(current), fields,
      "sign handling must not change the suggested family or include unrelated fields");
    const f = renderProfile(properties);
    const direction = f.document.querySelector("#vector-feature-profile-direction");
    for (const order of ["ascending", "descending"]) {
      direction.value = order;
      direction.dispatchEvent(new Event("change"));
      const expectedFields = order === "ascending" ? fields : [...fields].reverse();
      const model = buildVectorFeatureProfile(current, { selectedFields: fields, direction: order });
      assert.equal(model.xScale, "ordinal");
      assert.deepEqual(model.points.map(point => point.xValue), [null, null]);
      const rows = f.document.querySelector("#vector-feature-profile-table-body").children;
      assert.deepEqual(rows.map(row => row.children.slice(0, 2).map(cell => cell.textContent)),
        expectedFields.map(field => [field, field]));
      const chart = f.document.querySelector("#vector-feature-profile-chart");
      const labels = chart.querySelectorAll("text").map(element => element.textContent);
      assert.ok(labels.includes("Field"));
      assert.ok(!labels.includes("Number in field name"));
      for (const field of fields) assert.ok(labels.includes(field), field);
      const markers = chart.querySelectorAll(".series-chart-point");
      assert.deepEqual(markers.map(marker => marker.getAttribute("aria-label")),
        expectedFields.map(field => `${field}: ${properties[field]}`));
      assert.ok(Number(markers[0].getAttribute("cx")) < Number(markers[1].getAttribute("cx")),
        "full categorical labels and their measurements must occupy distinct ordered positions");
      assert.match(f.document.querySelector("#vector-feature-profile-context").textContent,
        /Cold site.*Temperature sites.*site-7/);
    }
    f.controller.destroy();
  });
}

test("unsigned year and decimal families keep their actual numeric spacing", () => {
  for (const [fields, values] of [
    [["CO2_2000", "CO2_2005", "CO2_2020"], [2000, 2005, 2020]],
    [["depth.5_m", "depth1.5_m", "depth4.5_m"], [0.5, 1.5, 4.5]],
  ]) {
    const f = renderProfile(Object.fromEntries(fields.map((field, index) => [field, index - 1])));
    const chart = f.document.querySelector("#vector-feature-profile-chart");
    const positions = chart.querySelectorAll(".series-chart-point").map(marker => Number(marker.getAttribute("cx")));
    assert.ok(Math.abs((positions[1] - positions[0]) / (positions[2] - positions[0]) -
      (values[1] - values[0]) / (values[2] - values[0])) < 1e-12);
    const rows = f.document.querySelector("#vector-feature-profile-table-body").children;
    assert.deepEqual(rows.map(row => row.children[1].textContent), values.map(String));
    f.controller.destroy();
  }
});

test("changing selected signed fields preserves labels, missing gaps and source values", () => {
  const fields = ["temperature_-20_C", "temperature_5_C", "temperature_10_C"];
  const properties = Object.fromEntries(fields.map((field, index) => [field, index + 1]));
  const f = renderProfile(properties);
  const list = f.document.querySelector("#vector-feature-profile-field-list");
  const negative = list.children.find(row => row.children[0].value === fields[0]).children[0];
  negative.checked = true;
  negative.dispatchEvent(new Event("change"));
  const rows = () => f.document.querySelector("#vector-feature-profile-table-body").children;
  assert.deepEqual(rows().map(row => row.children[1].textContent), fields);
  negative.checked = false;
  negative.dispatchEvent(new Event("change"));
  assert.deepEqual(rows().map(row => row.children[1].textContent), ["5", "10"]);
  negative.checked = true;
  negative.dispatchEvent(new Event("change"));
  f.controller.setCurrentObservation(observation({ ...properties, [fields[1]]: null }));
  assert.deepEqual(rows().map(row => row.children[1].textContent), fields);
  assert.deepEqual(rows().map(row => row.children[2].textContent), ["1", "No value", "3"]);
  const markers = f.document.querySelector("#vector-feature-profile-chart").querySelectorAll(".series-chart-point");
  assert.deepEqual(markers.map(marker => marker.getAttribute("aria-label")),
    ["temperature_-20_C: 1", "temperature_10_C: 3"]);
  assert.ok(Number(markers[0].getAttribute("cx")) < Number(markers[1].getAttribute("cx")));
  assert.match(f.document.querySelector("#vector-feature-profile-status").textContent, /1 missing value/);
  assert.deepEqual(properties, { "temperature_-20_C": 1, temperature_5_C: 2, temperature_10_C: 3 });
  f.controller.destroy();
});
