import assert from "node:assert/strict";
import test from "node:test";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { createFakeResizeObservers } from "../../test-support/raster/fakes.js";
import {
  buildVectorFeatureProfile,
  numericFeatureFields,
  suggestFeatureProfileFields,
  suggestFeatureProfileTitle,
  vectorFeatureProfilePresentation,
  VectorFeatureProfileController,
} from "../../src/vector/feature-profile.js";

/** Return one immutable inspector observation with a time-like field family. */
function observation(overrides = {}) {
  return Object.freeze({
    sourceId: overrides.sourceId ?? "catalog|corridors",
    layerLabel: overrides.layerLabel ?? "corridors.shp",
    featureId: overrides.featureId ?? "corridors.1",
    focus: Object.freeze(overrides.focus ?? {
      center: Object.freeze([20, 10]),
      bounds: Object.freeze([19, 9, 21, 11]),
    }),
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

/** Build a feature-profile controller and capture its map and presentation callbacks.
 * @param {FakeRasterControlDocument} [documentContext] Test document with optional browser layout support.
 * @return {Object} Controller, controls, and recorded callback arguments.
 */
function fixture(documentContext = new FakeRasterControlDocument()) {
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
  const presentations = [];
  const navigationRequests = [];
  const featureZoomRequests = [];
  const controller = new VectorFeatureProfileController({
    documentContext,
    onVisibilityChange: (visible, moveFocus) => {
      visibility.push({ visible, moveFocus });
      documentContext.querySelector("#vector-feature-profile").hidden = !visible;
    },
    onPresentationChange: (identity) => presentations.push(identity),
    onNavigateFeature: (direction) => navigationRequests.push(direction),
    onFeatureZoom: (focus) => {
      featureZoomRequests.push(focus);
      return true;
    },
  });
  return {
    controller,
    documentContext,
    visibility,
    presentations,
    navigationRequests,
    featureZoomRequests,
  };
}

test("field discovery chooses repeated numeric names and a conventional title", () => {
  const current = observation();
  assert.deepEqual(numericFeatureFields(current), [
    "other_7",
    "R1999",
    "R2000",
    "R2001",
  ]);
  assert.deepEqual(suggestFeatureProfileFields(current), [
    "R1999",
    "R2000",
    "R2001",
  ]);
  assert.equal(suggestFeatureProfileTitle(current), "node_nm");
  assert.deepEqual(vectorFeatureProfilePresentation(current), {
    label: "Feature · Northern corridor",
    title: "Fields from Northern corridor · Layer: corridors.shp · " +
      "Feature ID: corridors.1",
    heading: "Northern corridor",
    context: "corridors.shp · Feature ID: corridors.1",
  });
  assert.equal(
    vectorFeatureProfilePresentation(observation({
      featureId: "corridors.2",
      properties: { node_nm: "", R2000: 2 },
    })).context,
    "corridors.shp · Feature ID: corridors.2",
  );
});

test("one-feature pickers open above the result and exact values follow the inspected feature", () => {
  const {controller,documentContext:doc}=fixture();
  const first=observation({properties:{name:"Site A",flow:0.123456789}});
  const next=observation({featureId:"other",properties:{name:"Site B",flow:0}});
  controller.setFeatureChoices([first,next]);
  controller.setCurrentObservation(first);
  const trigger=doc.querySelector("#vector-feature-profile-fields-button");
  trigger.dispatchEvent(new Event("click"));
  assert.equal(trigger.getAttribute("aria-expanded"),"true");
  assert.equal(doc.activeElement,doc.querySelector("#vector-feature-profile-field-search"));
  doc.querySelector("#vector-feature-profile-fields-done").dispatchEvent(new Event("click"));
  assert.equal(doc.activeElement,trigger);
  doc.querySelector("#vector-feature-profile-values-button").dispatchEvent(new Event("click"));
  const table=doc.querySelector("#vector-feature-profile-table-body");
  assert.equal(table.children[0].children[2].textContent,"0.123456789");
  controller.setCurrentObservation(next,{position:2,total:2,canPrevious:true,canNext:false});
  assert.equal(doc.querySelector("#vector-feature-profile-heading").textContent,"Site B");
  assert.equal(doc.querySelector("#vector-feature-profile-values").hidden,false);
  assert.equal(table.children[0].children[2].textContent,"0");
  table.children[0].children[0].children[0].dispatchEvent(new Event("click"));
  assert.equal(doc.querySelector("#vector-feature-profile-selection-text").textContent,"flow · 0");
  controller.destroy();
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

test("chemical digits and unrelated numeric names retain complete ordinal labels", () => {
  for (const selectedFields of [
    ["CO2_total", "CO2_mean"], ["CO2_total", "rainfall"], ["CO2_total"],
    ["R2020"], ["A2", "Z1"], ["R1", "R01"], ["R1", "R1.0"],
    ["a1#", "a#2"],
  ]) {
    for (const direction of ["ascending", "descending"]) {
      const properties = Object.fromEntries(selectedFields.map((field, index) => [field, index ? null : 3]));
      const profile = buildVectorFeatureProfile(observation({ properties }), { selectedFields, direction });
      assert.equal(profile.xScale, "ordinal", selectedFields.join(", "));
      assert.equal(profile.xAxisLabel, "Field");
      assert.deepEqual(profile.points.map(point => point.xLabel), profile.points.map(point => point.fieldName));
      assert.equal(profile.points.every(point => point.xValue === null), true);
      assert.equal(profile.finiteCount, 1);
      assert.equal(profile.missingCount, selectedFields.length - 1);
    }
  }
});

test("numeric families retain year and decimal coordinates around shared text", () => {
  for (const [selectedFields, expectedValues] of [
    [["resistance_R2005_mean", "resistance_R2000_mean"], [2000, 2005]],
    [["CO2_2005", "CO2_2000"], [2000, 2005]],
    [["depth4_m", "depth0.5_m", "depth1.5_m"], [0.5, 1.5, 4]],
  ]) {
    const properties = Object.fromEntries(selectedFields.map((field, index) => [field, index ? null : 3]));
    for (const direction of ["ascending", "descending"]) {
      const profile = buildVectorFeatureProfile(observation({ properties }), { selectedFields, direction });
      const ordered = direction === "ascending" ? expectedValues : [...expectedValues].reverse();
      assert.equal(profile.xScale, "numeric");
      assert.equal(profile.xAxisLabel, "Number in field name");
      assert.deepEqual(profile.points.map(point => point.xValue), ordered);
      assert.deepEqual(profile.points.map(point => point.xLabel), ordered.map(String));
      assert.equal(profile.missingCount, selectedFields.length - 1);
    }
  }
});

test("CO2 fields render distinct chart positions and complete axis and table labels", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation({ properties: { CO2_total: 3, CO2_mean: 2 } }));
  const chart = h.documentContext.querySelector("#vector-feature-profile-chart");
  const points = chart.querySelectorAll(".series-chart-point");
  assert.equal(points.length, 2);
  assert.notEqual(points[0].getAttribute("cx"), points[1].getAttribute("cx"));
  const labels = chart.querySelectorAll("text").map(element => element.textContent);
  assert.equal(labels.includes("CO2_mean"), true);
  assert.equal(labels.includes("CO2_total"), true);
  assert.equal(labels.includes("Field"), true);
  assert.equal(labels.includes("Number in field name"), false);
  const rows = h.documentContext.querySelector("#vector-feature-profile-table-body").children;
  assert.deepEqual(rows.map(row => [row.children[0].children[0].textContent, row.children[1].textContent]), [
    ["CO2_mean", "CO2_mean"], ["CO2_total", "CO2_total"],
  ]);
  h.controller.destroy();
});

test("mixed field names have one natural order for every selection permutation", () => {
  const current = observation({ properties: { A2: 2, M: null, Z1: 1 } });
  for (const selectedFields of [
    ["A2", "M", "Z1"], ["A2", "Z1", "M"], ["M", "A2", "Z1"],
    ["M", "Z1", "A2"], ["Z1", "A2", "M"], ["Z1", "M", "A2"],
  ]) {
    for (const direction of ["ascending", "descending"]) {
      const profile = buildVectorFeatureProfile(current, { selectedFields, direction });
      assert.deepEqual(profile.points.map(point => point.fieldName),
        direction === "ascending" ? ["A2", "M", "Z1"] : ["Z1", "M", "A2"]);
      assert.equal(profile.xScale, "ordinal");
      assert.equal(profile.points[1].yValue, null);
      assert.equal(profile.missingCount, 1);
    }
  }
});

test("checkbox selection history does not change mixed profile chart or table order", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation({ properties: { A2: 2, M: 3, Z1: 1 } }));
  const rows = h.documentContext.querySelector("#vector-feature-profile-field-list");
  for (const name of ["M", "Z1", "A2"]) {
    const checkbox = rows.children.find(row => row.children[0].value === name).children[0];
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
  }
  const table = h.documentContext.querySelector("#vector-feature-profile-table-body");
  assert.deepEqual(table.children.map(row => row.children[0].children[0].textContent), ["A2", "M", "Z1"]);
  const chart = h.documentContext.querySelector("#vector-feature-profile-chart");
  assert.deepEqual(chart.querySelectorAll(".series-chart-point")
    .map(element => element.getAttribute("aria-label")), ["A2: 2", "M: 3", "Z1: 1"]);
});

test("field selection, search and bulk actions retain focused checkbox controls", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation());
  const list = h.documentContext.querySelector("#vector-feature-profile-field-list");
  const originalRows = [...list.children];
  const checkbox = originalRows.find(row => row.children[0].value === "R2000").children[0];
  checkbox.focus();
  checkbox.checked = false;
  checkbox.dispatchEvent(new Event("change"));
  assert.equal(list.contains(checkbox), true);
  assert.ok(h.documentContext.activeElement === checkbox);
  assert.ok(list.children.every((row, index) => row === originalRows[index]));
  const table = h.documentContext.querySelector("#vector-feature-profile-table-body");
  assert.deepEqual(table.children.map(row => row.children[0].children[0].textContent), ["R1999", "R2001"]);

  let createdElements = 0;
  const createElement = h.documentContext.createElement.bind(h.documentContext);
  h.documentContext.createElement = tag => {
    createdElements++;
    return createElement(tag);
  };
  const search = h.documentContext.querySelector("#vector-feature-profile-field-search");
  search.focus();
  search.value = "R20";
  search.dispatchEvent(new Event("input"));
  assert.equal(createdElements, 0);
  assert.ok(h.documentContext.activeElement === search);
  assert.ok(list.children.every((row, index) => row === originalRows[index]));
  assert.deepEqual(list.children.filter(row => !row.hidden).map(row => row.children[0].value), ["R2000", "R2001"]);

  h.documentContext.querySelector("#vector-feature-profile-select-matching").dispatchEvent(new Event("click"));
  assert.equal(checkbox.checked, true);
  h.documentContext.querySelector("#vector-feature-profile-clear-fields").dispatchEvent(new Event("click"));
  assert.ok(list.children.every(row => !row.children[0].checked));
  checkbox.focus();
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
  assert.ok(h.documentContext.activeElement === checkbox);
  assert.ok(list.children.every((row, index) => row === originalRows[index]));
  assert.deepEqual(table.children.map(row => row.children[0].children[0].textContent), ["R2000"]);
});

test("retained field controls follow current feature values and source selections", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation());
  const list = h.documentContext.querySelector("#vector-feature-profile-field-list");
  const r2000 = list.children.find(row => row.children[0].value === "R2000");
  h.controller.setCurrentObservation(observation({ properties: { R2000: null, R2001: 8, A2: 2 } }));
  assert.ok(list.children.find(row => row.children[0].value === "R2000") === r2000);
  assert.equal(r2000.children[2].textContent, "No value");
  assert.equal(r2000.children[0].checked, true);
  assert.deepEqual(list.children.map(row => row.children[0].value), ["A2", "R1999", "R2000", "R2001"]);

  h.controller.setCurrentObservation(observation({ sourceId: "other", properties: { R2000: 20, R2002: 22 } }));
  assert.ok(list.children.find(row => row.children[0].value === "R2000") === r2000);
  assert.equal(r2000.children[2].textContent, "20");
  r2000.children[0].checked = false;
  r2000.children[0].dispatchEvent(new Event("change"));
  const table = h.documentContext.querySelector("#vector-feature-profile-table-body");
  assert.deepEqual(table.children.map(row => row.children[0].children[0].textContent), ["R2002"]);
  h.controller.setCurrentObservation(observation());
  assert.equal(r2000.children[0].checked, true);
  assert.deepEqual(table.children.map(row => row.children[0].children[0].textContent), ["R1999", "R2000", "R2001"]);

  h.controller.setCurrentObservation(null);
  assert.equal(list.children.length, 0);
  h.controller.setCurrentObservation(observation({ sourceId: "other", properties: { R2000: 30, R2002: 32 } }));
  assert.deepEqual(list.children.map(row => [row.children[0].value, row.children[0].checked]), [["R2000", false], ["R2002", true]]);
});

test("removing focused missing fields moves to a visible neighbor, then Find fields", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation({ properties: { R1999: 1, R2000: 2, R2001: 3 } }));
  h.controller.setCurrentObservation(observation({ properties: {} }));
  const list = h.documentContext.querySelector("#vector-feature-profile-field-list");
  const search = h.documentContext.querySelector("#vector-feature-profile-field-search");
  const [first, middle, last] = list.children.map(row => row.children[0]);

  middle.focus();
  middle.checked = false;
  middle.dispatchEvent(new Event("change"));
  assert.equal(list.contains(middle), false);
  assert.ok(h.documentContext.activeElement === last);
  assert.equal(list.contains(h.documentContext.activeElement), true);

  last.checked = false;
  last.dispatchEvent(new Event("change"));
  assert.equal(list.contains(last), false);
  assert.ok(h.documentContext.activeElement === first);
  assert.equal(list.contains(h.documentContext.activeElement), true);

  first.checked = false;
  first.dispatchEvent(new Event("change"));
  assert.equal(list.children.length, 0);
  assert.ok(h.documentContext.activeElement === search);
});

test("removing a focused missing field never focuses a filtered-out neighbor", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation({ properties: { R1999: 1, R2000: 2 } }));
  h.controller.setCurrentObservation(observation({ properties: { R2000: 3 } }));
  const list = h.documentContext.querySelector("#vector-feature-profile-field-list");
  const search = h.documentContext.querySelector("#vector-feature-profile-field-search");
  search.value = "1999";
  search.dispatchEvent(new Event("input"));
  const missing = list.children[0].children[0];
  missing.focus();
  missing.checked = false;
  missing.dispatchEvent(new Event("change"));
  assert.equal(list.contains(missing), false);
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].hidden, true);
  assert.ok(h.documentContext.activeElement === search);
});

test("dock resizes redraw the profile at the latest width after layout", () => {
  const documentContext = new FakeRasterControlDocument();
  const { ResizeObserver, instances } = createFakeResizeObservers();
  const frames = new Map();
  let serial = 0;
  Object.assign(documentContext.defaultView, {
    ResizeObserver,
    requestAnimationFrame: callback => { frames.set(++serial, callback); return serial; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  const {controller} = fixture(documentContext);
  controller.setCurrentObservation(observation());
  controller.open();
  const chart = documentContext.querySelector("#vector-feature-profile-chart");
  const initial = chart.getAttribute("viewBox");
  instances[0].resize(300);
  instances[0].resize(380);
  assert.equal(chart.getAttribute("viewBox"), initial, "measuring the plot must not resize it within the same layout notification");
  assert.equal(frames.size, 1);
  const [id, paint] = [...frames][0];
  frames.delete(id);
  paint();
  assert.equal(chart.getAttribute("viewBox").split(" ")[2], "380");
  instances[0].resize(400);
  controller.destroy();
  assert.equal(frames.size, 0);
  assert.ok(instances[0].disconnected);
});

test("controller plots suggested fields and updates from partial search actions", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation());
  h.controller.open();
  const chart = h.documentContext.querySelector("#vector-feature-profile-chart");
  assert.equal(chart.getAttribute("hidden"), null);
  assert.match(chart.getAttribute("aria-label"), /3 numeric fields/);
  const chartType = h.documentContext.querySelector("#vector-feature-profile-chart-type");
  assert.equal(chartType.value, "bar");
  assert.equal(chart.querySelectorAll(".series-chart-bar").length, 3);
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-heading")
      .textContent,
    "Northern corridor",
  );
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-context")
      .textContent,
    "corridors.shp · Feature ID: corridors.1",
  );
  assert.deepEqual(h.presentations.at(-1), {
    label: "Feature · Northern corridor",
    title: "Fields from Northern corridor · Layer: corridors.shp · " +
      "Feature ID: corridors.1",
  });
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
  assert.equal(chart.querySelectorAll(".series-chart-bar").length, 1);
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-table-body")
      .children.length,
    1,
  );
  assert.deepEqual(h.visibility, [{ visible: true, moveFocus: false }]);
});

test("feature navigation publishes intent and redraws the current observation", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation(), {
    position: 2,
    total: 3,
    canPrevious: true,
    canNext: true,
  });
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-position").textContent,
    "2 of 3 features",
  );
  const previous = h.documentContext.querySelector(
    "#previous-vector-feature-profile",
  );
  const next = h.documentContext.querySelector("#next-vector-feature-profile");
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, false);
  previous.dispatchEvent(new Event("click"));
  next.dispatchEvent(new Event("click"));
  assert.deepEqual(h.navigationRequests, ["previous", "next"]);
  const zoom = h.documentContext.querySelector(
    "#zoom-vector-feature-profile-feature",
  );
  assert.equal(zoom.disabled, false);
  zoom.dispatchEvent(new Event("click"));
  assert.deepEqual(h.featureZoomRequests, [{
    center: [20, 10], bounds: [19, 9, 21, 11],
  }]);

  h.controller.setCurrentObservation(observation({
    featureId: "corridors.2",
    focus: Object.freeze({ center: [30, 15], bounds: null }),
    properties: { node_nm: "Southern corridor", R1999: 2, R2000: 4, R2001: 8 },
  }), {
    position: 3,
    total: 3,
    canPrevious: true,
    canNext: false,
  });
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-heading").textContent,
    "Southern corridor",
  );
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, true);
  zoom.dispatchEvent(new Event("click"));
  assert.deepEqual(h.featureZoomRequests.at(-1), {
    center: [30, 15], bounds: null,
  });
  next.dispatchEvent(new Event("click"));
  assert.deepEqual(h.navigationRequests, ["previous", "next"]);
  assert.throws(
    () => h.controller.setCurrentObservation(observation(), {
      position: 1,
      total: 2,
      canPrevious: true,
      canNext: true,
    }),
    /Invalid feature-profile navigation state/,
  );
});

test("numeric field-name spacing is reflected on the horizontal axis", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation({ properties: {
    R2000: 1,
    R2001: 2,
    R2004: 3,
  } }));
  const chart = h.documentContext.querySelector("#vector-feature-profile-chart");
  const bars = chart.querySelectorAll(".series-chart-bar");
  assert.equal(bars.length, 3);
  const barPositions = bars.map(bar => Number(bar.getAttribute("cx")));
  assert.ok(barPositions[2] - barPositions[1] > 2 * (barPositions[1] - barPositions[0]));

  const chartType = h.documentContext.querySelector("#vector-feature-profile-chart-type");
  chartType.value = "line";
  chartType.dispatchEvent(new Event("change"));
  const circles = chart.querySelectorAll(".series-chart-point");
  assert.equal(circles.length, bars.length);
  const positions = circles.map(circle => Number(circle.getAttribute("cx")));
  assert.ok(positions[2] - positions[1] > 2 * (positions[1] - positions[0]));
});

test("per-source rules survive feature navigation and missing values break lines", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation());
  const chartType = h.documentContext.querySelector("#vector-feature-profile-chart-type");
  chartType.value = "line";
  chartType.dispatchEvent(new Event("change"));
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
    /One field has no numeric value/,
  );
  const path = h.documentContext.querySelector("#vector-feature-profile-chart")
    .children.find((element) => element.getAttribute("class") === "series-chart-line");
  assert.match(path.getAttribute("d"), /^M/);
  assert.doesNotMatch(path.getAttribute("d"), /L/);

  h.controller.setCurrentObservation(observation({ sourceId: "catalog|other-corridors" }));
  assert.equal(chartType.value, "bar");
  h.controller.setCurrentObservation(observation());
  assert.equal(chartType.value, "line");
});

test("active mode survives empty clicks, reopens, and ends on explicit close", () => {
  const h = fixture();
  h.controller.setCurrentObservation(observation());
  h.controller.open();
  const search = h.documentContext.querySelector(
    "#vector-feature-profile-field-search",
  );
  search.value = "R20";
  search.dispatchEvent(new Event("input"));
  h.documentContext.querySelector("#vector-feature-profile-select-matching")
    .dispatchEvent(new Event("click"));

  h.controller.setCurrentObservation(null);
  h.controller.setCurrentObservation(observation({
    featureId: "corridors.2",
    properties: {
      node_nm: "Southern corridor",
      R2000: 7,
      R2001: 8,
      other_7: 2,
    },
  }));
  assert.deepEqual(h.visibility, [
    { visible: true, moveFocus: false },
    { visible: false, moveFocus: false },
    { visible: true, moveFocus: false },
  ]);
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-heading")
      .textContent,
    "Southern corridor",
  );
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-table-body")
      .children.length,
    2,
  );

  h.controller.close({ moveFocus: true });
  h.controller.setCurrentObservation(null);
  h.controller.setCurrentObservation(observation({ featureId: "corridors.3" }));
  assert.deepEqual(h.visibility.at(-1), { visible: false, moveFocus: true });
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile").hidden,
    true,
  );
  assert.equal(
    h.documentContext.querySelector("#vector-feature-profile-table-body")
      .children.length,
    2,
  );
});


test("unavailable feature location leaves the chart usable with a readable explanation", () => {
  const h = fixture();
  h.controller.onFeatureZoom = () => false;
  h.controller.setCurrentObservation(observation({
    focus: Object.freeze({ center: [20, 10], bounds: null }),
  }));
  h.controller.open();
  const zoom = h.documentContext.querySelector("#zoom-vector-feature-profile-feature");
  zoom.dispatchEvent(new Event("click"));
  assert.equal(zoom.disabled, true);
  assert.equal(h.documentContext.querySelector("#vector-feature-profile-status").textContent,
    "Feature location is unavailable. The map has not moved.");
  assert.equal(h.documentContext.querySelector("#vector-feature-profile-chart").hidden, false);
  h.controller.destroy();
});
