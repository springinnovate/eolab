import assert from "node:assert/strict";
import test from "node:test";

import { RasterCursorValuesView } from "../../src/raster/cursor-values-view.js";
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
  assert.equal(limit.textContent, "2 additional in-bounds rasters omitted.");

  view.clear();
  assert.equal(root.hidden, true);
  assert.equal(root.getAttribute("aria-busy"), "false");
  assert.equal(list.children.length, 0);
});

test("cursor-value view hides when every server result is outside", () => {
  const documentContext = new FakeRasterControlDocument();
  const view = new RasterCursorValuesView(documentContext);

  view.render({
    omittedCount: 0,
    samples: [
      { label: "outside", state: "outside", value: null, errorMessage: "" },
    ],
  });

  assert.equal(documentContext.querySelector("#raster-cursor-values").hidden, true);
});
