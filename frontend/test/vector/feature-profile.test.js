import assert from "node:assert/strict";
import test from "node:test";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import {
  buildVectorFeatureProfile,
  fieldNameNumber,
  numericFeatureFields,
  suggestFeatureProfileFields,
  suggestFeatureProfileTitle,
  VectorFeatureProfileController,
} from "../../src/vector/feature-profile.js";

/** Return one immutable inspector observation with a time-like field family. */
function observation(overrides = {}) {
  return Object.freeze({
    sourceId: overrides.sourceId ?? "catalog|corridors",
    layerLabel: overrides.layerLabel ?? "corridors.shp",
    featureId: overrides.featureId ?? "corridors.1",
    properties: Object.freeze(overrides.properties ?? {
      node_nm: "Northern corridor",
      R1999: 1.5,
      R2000: 2.5,
      R2001: 4.5,
      other_7: 9,
      category: "core",
    }),
  });
}

/** Build a feature-profile controller with a minimal document and visibility spy. */
function fixture() {
  const documentContext = new FakeRasterControlDocument();
  const events = new EventTarget();
  documentContext.addEventListener = events.addEventListener.bind(events);
  documentContext.removeEventListener = events.removeEventListener.bind(events);
  documentContext.dispatchEvent = events.dispatchEvent.bind(events);
  documentContext.querySelector("#vector-feature-profile").hidden = true;
  documentContext.querySelector("#vector-feature-profile-chart").setAttribute(
    "hidden",
    "",
  );
  documentContext.querySelector("#vector-feature-profile-table").hidden = true;
  const visibility = [];
  const controller = new VectorFeatureProfileController({
    documentContext,
    onVisibilityChange: (visible, moveFocus) => {
      visibility.push({ visible, moveFocus });
      documentContext.querySelector("#vector-feature-profile").hidden = !visible;
    },
  });
  return { controller, documentContext, visibility };
}

test("field discovery chooses repeated numeric names and a conventional title", () => {
  const current = observation();
  assert.deepEqual(numericFeatureFields(current), [
    "other_7",
    "R1999",
    "R2000",
    "R2001",
  ]);
  assert.equal(fieldNameNumber("resistance_R2001_mean"), 2001);
  assert.equal(fieldNameNumber("resistance"), null);
  assert.deepEqual(suggestFeatureProfileFields(current), [
    "R1999",
    "R2000",
    "R2001",
  ]);
  assert.equal(suggestFeatureProfileTitle(current), "node_nm");
});

test("profile points use field-name numbers and preserve missing-value gaps", () => {
  const current = observation({ properties: {
    R1999: 1.5,
    R2000: null,
    R2001: 4.5,
  } });
  const profile = buildVectorFeatureProfile(current, {
    selectedFields: ["R2001", "R1999", "R2000"],
    direction: "ascending",
  });
  assert.deepEqual(profile.points.map((point) => [
    point.fieldName,
    point.xLabel,
    point.yValue,
  ]), [
    ["R1999", "1999", 1.5],
    ["R2000", "2000", null],
    ["R2001", "2001", 4.5],
  ]);
  assert.equal(profile.finiteCount, 2);
  assert.equal(profile.missingCount, 1);
  assert.equal(profile.xAxisLabel, "Number in field name");
  assert.equal(profile.xScale, "numeric");
});

test("controller plots suggested fields and updates from partial search actions", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation());
  h.controller.open();
  const chart = h.documentContext.querySelector("#vector-feature-profile-chart");
  assert.equal(chart.getAttribute("hidden"), null);
  assert.match(chart.getAttribute("aria-label"), /3 numeric fields/);
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-chart-title")
      .textContent,
    "Northern corridor",
  );
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-field-list")
      .children.length,
    4,
  );

  const search = h.documentContext.querySelector(
    "#vector-feature-profile-field-search",
  );
  search.value = "2000";
  search.dispatchEvent(new Event("input"));
  h.documentContext.querySelector("#vector-feature-profile-select-matching")
    .dispatchEvent(new Event("click"));
  assert.match(chart.getAttribute("aria-label"), /1 numeric fields/);
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-table-body")
      .children.length,
    1,
  );
  assert.deepEqual(h.visibility, [{ visible: true, moveFocus: false }]);
});

test("numeric field-name spacing is reflected on the horizontal axis", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation({ properties: {
    R2000: 1,
    R2001: 2,
    R2004: 3,
  } }));
  const circles = h.documentContext.querySelector("#vector-feature-profile-chart")
    .children.filter((element) =>
      element.getAttribute("class") === "series-chart-point"
    );
  const positions = circles.map((circle) => Number(circle.getAttribute("cx")));
  assert.ok(positions[2] - positions[1] > 2 * (positions[1] - positions[0]));
});

test("per-source rules survive feature navigation and missing values break lines", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation());
  const search = h.documentContext.querySelector(
    "#vector-feature-profile-field-search",
  );
  search.value = "R20";
  search.dispatchEvent(new Event("input"));
  h.documentContext.querySelector("#vector-feature-profile-select-matching")
    .dispatchEvent(new Event("click"));

  h.controller.setCurrentObservation(observation({
    featureId: "corridors.2",
    properties: {
      node_nm: "Southern corridor",
      R2000: null,
      R2001: 8,
      other_7: 2,
    },
  }));
  const tableBody = h.documentContext.querySelector(
    "#vector-feature-profile-table-body",
  );
  assert.equal(tableBody.children.length, 2);
  assert.equal(tableBody.children[0].children[2].textContent, "No value");
  assert.match(
    h.documentContext.querySelector("#vector-feature-profile-status").textContent,
    /1 missing value is shown as a gap/,
  );
  const path = h.documentContext.querySelector("#vector-feature-profile-chart")
    .children.find((element) => element.getAttribute("class") === "series-chart-line");
  assert.match(path.getAttribute("d"), /^M/);
  assert.doesNotMatch(path.getAttribute("d"), /L/);
});

test("clearing the inspector observation closes presentation but retains rules", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation());
  h.controller.open();
  h.controller.setCurrentObservation(null);
  assert.deepEqual(h.visibility, [
    { visible: true, moveFocus: false },
    { visible: false, moveFocus: false },
  ]);
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-status").textContent,
    "Inspect a vector feature first.",
  );
});
