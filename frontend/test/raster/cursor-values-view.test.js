import assert from "node:assert/strict";
import test from "node:test";

import { RasterCursorValuesView } from "../../src/raster/cursor-values-view.js";
import { formatRasterCursorValuesForClipboard } from "../../src/raster/cursor-values-view.js";
import { presentRasterPixelSnapshot } from "../../src/raster/categorical-presentation.js";
import { normalizeCategoricalRasterStyle } from "../../src/raster/categorical-style.js";
import {
  FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";

test("cursor-value view presents progressive values and omits outside rasters", () => {
  const documentContext = new FakeRasterControlDocument();
  const view = new RasterCursorValuesView(documentContext);
  const root = documentContext.querySelector("#raster-cursor-values");
  const list = documentContext.querySelector("#raster-cursor-value-list");
  const limit = documentContext.querySelector("#raster-cursor-value-limit");

  view.render({
    position: { latitude: -2.75, longitude: 36.8 },
    omittedCount: 2,
    samples: [
      { label: "temperature", state: "value", value: 12.5, errorMessage: "" },
      { label: "rainfall", state: "loading", value: null, errorMessage: "" },
      { label: "habitat", state: "nodata", value: null, errorMessage: "" },
      { label: "outside", state: "outside", value: null, errorMessage: "" },
      { label: "broken", state: "error", value: null, errorMessage: "Timed out" },
    ],
  });

  assert.equal(root.hidden, false);
  assert.equal(root.getAttribute("aria-busy"), "true");
  assert.equal(
    documentContext.querySelector("#raster-cursor-position").textContent,
    "Lat -2.75000 · Lng 36.80000",
  );
  assert.equal(list.children.length, 4);
  assert.deepEqual(
    list.children.map(row => [
      row.children[0].textContent,
      row.children[1].textContent,
    ]),
    [
      ["temperature", "1.250e+1"],
      ["rainfall", "Reading…"],
      ["habitat", "No data"],
      ["broken", "Unavailable: Timed out"],
    ],
  );
  assert.equal(limit.hidden, false);
  assert.equal(limit.textContent, "2 additional rasters omitted.");

  view.clear();
  assert.equal(root.hidden, true);
  assert.equal(root.getAttribute("aria-busy"), "false");
  assert.equal(list.children.length, 0);
});

test("cursor-value view hides when every server result is outside", () => {
  const documentContext = new FakeRasterControlDocument();
  const view = new RasterCursorValuesView(documentContext);

  view.render({
    position: { latitude: 0, longitude: 0 },
    omittedCount: 0,
    samples: [
      { label: "outside", state: "outside", value: null, errorMessage: "" },
    ],
  });

  assert.equal(documentContext.querySelector("#raster-cursor-values").hidden, true);
});

test("cursor values and clipboard consume literal prepared text without changing NoData", () => {
  const documentContext = new FakeRasterControlDocument();
  const view = new RasterCursorValuesView(documentContext);
  const displayValue = '<img src=x onerror="alert(1)"> (0)';
  const snapshot = {
    position: { latitude: 1, longitude: 2 }, omittedCount: 0,
    samples: [
      { key: "category", label: "Classes", state: "value", value: 0, displayValue, errorMessage: "" },
      { key: "nodata", label: "Missing", state: "nodata", value: null, displayValue: "Ignored", errorMessage: "" },
      { key: "continuous", label: "Continuous", state: "value", value: 7, errorMessage: "" },
    ],
  };
  view.render(snapshot);
  const list = documentContext.querySelector("#raster-cursor-value-list");
  assert.equal(list.children[0].children[1].textContent, displayValue);
  assert.equal(list.children[0].children[1].children.length, 0);
  assert.equal(list.children[1].children[1].textContent, "No data");
  assert.equal(list.children[2].children[1].textContent, "7.000e+0");
  assert.equal(formatRasterCursorValuesForClipboard(snapshot),
    `Latitude\t1\nLongitude\t2\nClasses\t${displayValue}\nMissing\tNo data\nContinuous\t7.000e+0`);
});

test("presentation refresh preserves a retained pick during new loading and updates its clipboard", async () => {
  const documentContext = new FakeRasterControlDocument();
  const copied = [];
  const view = new RasterCursorValuesView(documentContext, {
    async writeText(text) { copied.push(text); },
  });
  view.bind({ onHide() {}, onShow() {} });
  const root = documentContext.querySelector("#raster-cursor-values");
  const marker = documentContext.querySelector("#raster-cursor-marker");
  const pending = documentContext.querySelector("#raster-cursor-pending");
  const list = documentContext.querySelector("#raster-cursor-value-list");
  const raw = {
    position: { latitude: 1, longitude: 2 }, omittedCount: 0,
    samples: [{ key: "land", label: "Land cover", state: "value", value: 7, errorMessage: "" }],
  };
  view.move({ clientX: 100, clientY: 100 });
  view.render(raw);
  view.move({ clientX: 200, clientY: 200 });
  view.render({ ...raw, position: { latitude: 3, longitude: 4 }, samples: [
    { ...raw.samples[0], state: "loading", value: null },
  ] });
  const style = normalizeCategoricalRasterStyle({
    mode: "categorical", categories: [{ value: 7, label: "Forest", color: "#008800", opacity: 0 }],
  });
  view.refreshPresentation(snapshot => presentRasterPixelSnapshot(snapshot, () => style));
  assert.equal(list.children[0].children[1].textContent, "Forest (7)");
  assert.equal(marker.style.left, "100px");
  assert.equal(root.style.left, "114px");
  assert.equal(pending.hidden, false);
  assert.equal(root.getAttribute("aria-busy"), "true");
  assert.equal(documentContext.querySelector("#raster-cursor-position").textContent,
    "Lat 1.00000 · Lng 2.00000");
  const copy = new Event("keydown", { cancelable: true });
  Object.assign(copy, { key: "c", ctrlKey: true });
  documentContext.dispatchEvent(copy);
  await Promise.resolve();
  assert.equal(copied[0], "Latitude\t1\nLongitude\t2\nLand cover\tForest (7)");
  view.refreshPresentation(snapshot => presentRasterPixelSnapshot(snapshot, () => null));
  assert.equal(list.children[0].children[1].textContent, "7.000e+0");
  assert.equal(pending.hidden, false);
  assert.equal(root.getAttribute("aria-busy"), "true");
  documentContext.dispatchEvent(copy);
  await Promise.resolve();
  assert.equal(copied[1], "Latitude\t1\nLongitude\t2\nLand cover\t7.000e+0");
  view.render({ ...raw, position: { latitude: 3, longitude: 4 } });
  assert.equal(marker.style.left, "200px");
  assert.equal(pending.hidden, true);
  assert.equal(root.getAttribute("aria-busy"), "false");
  view.clear();
  view.refreshPresentation(() => assert.fail("Cleared picker must stay cleared"));
  view.unbind();
});

test("presentation refresh rejects changing the sampled point or numeric result", () => {
  const documentContext = new FakeRasterControlDocument();
  const view = new RasterCursorValuesView(documentContext);
  const raw = {
    position: { latitude: 1, longitude: 2 }, omittedCount: 0,
    samples: [{ key: "land", label: "Land", state: "value", value: 7, errorMessage: "" }],
  };
  view.render(raw);
  assert.throws(() => view.refreshPresentation(snapshot => ({
    ...snapshot, position: { latitude: 3, longitude: 4 },
  })), /preserve the retained sample/);
  assert.throws(() => view.refreshPresentation(snapshot => ({
    ...snapshot, samples: [{ ...snapshot.samples[0], value: 8 }],
  })), /preserve the retained sample/);
  assert.equal(documentContext.querySelector("#raster-cursor-value-list").children[0].children[1].textContent,
    "7.000e+0");
});

test("pixel picker anchors its marker and readout inside the viewport", () => {
  const documentContext = new FakeRasterControlDocument();
  documentContext.defaultView = { innerWidth: 300, innerHeight: 220 };
  const view = new RasterCursorValuesView(documentContext);
  const root = documentContext.querySelector("#raster-cursor-values");

  view.move({ clientX: 290, clientY: 210 });
  view.render({
    position: { latitude: 1, longitude: 2 },
    omittedCount: 0,
    samples: [
      { label: "elevation", state: "value", value: 50, errorMessage: "" },
    ],
  });

  assert.equal(root.style.left, "156px");
  assert.equal(root.style.top, "148px");
  const marker = documentContext.querySelector("#raster-cursor-marker");
  assert.equal(marker.style.left, "290px");
  assert.equal(marker.style.top, "210px");
  assert.equal(marker.hidden, false);
  view.clear();
  assert.equal(marker.hidden, true);
});

test("replacement loading keeps the old marker, values, and clipboard until a result arrives", async () => {
  const documentContext = new FakeRasterControlDocument();
  const copied = [];
  const view = new RasterCursorValuesView(documentContext, {
    async writeText(text) { copied.push(text); },
  });
  view.bind({ onHide() {}, onShow() {} });
  const root = documentContext.querySelector("#raster-cursor-values");
  const marker = documentContext.querySelector("#raster-cursor-marker");
  const pending = documentContext.querySelector("#raster-cursor-pending");
  const list = documentContext.querySelector("#raster-cursor-value-list");
  const old = {
    position: { latitude: 1, longitude: 2 }, omittedCount: 0,
    samples: [{ label: "rain", state: "value", value: 12, errorMessage: "" }],
  };
  view.move({ clientX: 100, clientY: 100 });
  view.render(old);
  const previousRows = list.children;
  view.move({ clientX: 200, clientY: 200 });
  view.render({ ...old, position: { latitude: 3, longitude: 4 }, samples: [
    { label: "rain", state: "outside", value: null, errorMessage: "" },
    { label: "height", state: "loading", value: null, errorMessage: "" },
  ] });
  assert.equal(root.hidden, false);
  assert.equal(root.style.left, "114px");
  assert.equal(marker.style.left, "100px");
  assert.equal(list.children, previousRows);
  assert.equal(pending.hidden, false);
  const copyEvent = new Event("keydown", { cancelable: true });
  Object.assign(copyEvent, { key: "c", ctrlKey: true });
  documentContext.dispatchEvent(copyEvent);
  await Promise.resolve();
  assert.deepEqual(copied, [formatRasterCursorValuesForClipboard(old)]);
  view.render({ ...old, position: { latitude: 3, longitude: 4 }, samples: [
    { label: "height", state: "nodata", value: null, errorMessage: "" },
  ] });
  assert.equal(marker.style.left, "200px");
  assert.equal(root.style.left, "214px");
  assert.equal(pending.hidden, true);
  assert.equal(list.children[0].children[1].textContent, "No data");
  assert.equal(documentContext.querySelector("#raster-cursor-position").textContent,
    "Lat 3.00000 · Lng 4.00000");
  view.unbind();
});

test("pixel picker shortcuts copy, hide, and restore without owning policy", async () => {
  const documentContext = new FakeRasterControlDocument();
  const copied = [];
  const timers = new Map();
  let nextTimer = 1;
  const clock = {
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const view = new RasterCursorValuesView(documentContext, {
    async writeText(text) { copied.push(text); },
  }, clock);
  const root = documentContext.querySelector("#raster-cursor-values");
  const restore = documentContext.querySelector("#restore-raster-cursor-values");
  const feedback = documentContext.querySelector("#raster-cursor-copy-feedback");
  const state = { hidden: 0, shown: 0 };
  view.bind({
    onHide() { state.hidden += 1; view.setEnabled(false); },
    onShow() { state.shown += 1; view.setEnabled(true); },
  });
  const snapshot = {
    position: { latitude: 4.5, longitude: -7.25 },
    omittedCount: 0,
    samples: [
      { label: "rainfall", state: "value", value: 12.5, errorMessage: "" },
      { label: "mask", state: "nodata", value: null, errorMessage: "" },
      { label: "outside", state: "outside", value: null, errorMessage: "" },
    ],
  };
  view.render(snapshot);

  const copyEvent = new Event("keydown", { cancelable: true });
  Object.assign(copyEvent, { key: "c", ctrlKey: true, metaKey: false, altKey: false });
  documentContext.dispatchEvent(copyEvent);
  await Promise.resolve();
  assert.deepEqual(copied, [formatRasterCursorValuesForClipboard(snapshot)]);
  assert.doesNotMatch(copied[0], /outside/);
  assert.equal(feedback.hidden, false);
  assert.equal(root.classList.contains("is-copy-confirmed"), true);
  assert.equal(timers.size, 1);
  timers.values().next().value();
  assert.equal(feedback.hidden, true);
  assert.equal(root.classList.contains("is-copy-confirmed"), false);

  const hideEvent = new Event("keydown", { cancelable: true });
  Object.assign(hideEvent, { key: "Escape", ctrlKey: false, metaKey: false, altKey: false });
  documentContext.dispatchEvent(hideEvent);
  assert.equal(state.hidden, 1);
  assert.equal(root.hidden, true);
  assert.equal(restore.hidden, false);

  const showEvent = new Event("keydown", { cancelable: true });
  Object.assign(showEvent, { key: "p", ctrlKey: false, metaKey: false, altKey: false });
  documentContext.dispatchEvent(showEvent);
  assert.equal(state.shown, 1);
  assert.equal(restore.hidden, true);

  view.setEnabled(false);
  restore.dispatchEvent(new Event("click"));
  assert.equal(state.shown, 2);
  view.unbind();
});
