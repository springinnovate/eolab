import assert from "node:assert/strict";
import test from "node:test";

import { formatRasterDetailPreviewResolution } from "../../src/raster/detail-preview-status.js";
import {
  CENTER_SAMPLE_DETAIL_PREVIEW,
  CURRENT_VIEW_DETAIL_PREVIEW,
  PATCH_DETAIL_PREVIEW,
} from "../../test-support/raster/fixtures.js";

test("detail preview resolution distinguishes patches from adaptive grids", () => {
  assert.equal(
    formatRasterDetailPreviewResolution(null),
    "Base sample grid: —; current-view detail: —",
  );
  assert.equal(
    formatRasterDetailPreviewResolution(null, "loading"),
    "Base sample grid: loading…; current-view detail: —",
  );
  assert.equal(
    formatRasterDetailPreviewResolution(null, "error"),
    "Base sample grid: request failed; current-view detail: —",
  );
  assert.equal(
    formatRasterDetailPreviewResolution({
      mode: "representativePatch",
      basePreview: PATCH_DETAIL_PREVIEW,
      detailPreview: null,
      detailStatus: "none",
    }),
    "Representative patch: 2 × 2; automatic current-view refinement: off",
  );
  assert.equal(
    formatRasterDetailPreviewResolution({
      mode: "centerSample",
      basePreview: CENTER_SAMPLE_DETAIL_PREVIEW,
      detailPreview: CURRENT_VIEW_DETAIL_PREVIEW,
      detailStatus: "ready",
    }),
    "Base sample grid: 31 × 31; current-view detail: 31 × 31",
  );
});

test("detail preview resolution reports pending and retained update states", () => {
  assert.equal(
    formatRasterDetailPreviewResolution({
      mode: "centerSample",
      basePreview: CENTER_SAMPLE_DETAIL_PREVIEW,
      detailPreview: null,
      detailStatus: "loading",
    }),
    "Base sample grid: 31 × 31; current-view detail: loading…",
  );
  assert.equal(
    formatRasterDetailPreviewResolution({
      mode: "centerSample",
      basePreview: CENTER_SAMPLE_DETAIL_PREVIEW,
      detailPreview: CURRENT_VIEW_DETAIL_PREVIEW,
      detailStatus: "error",
    }),
    "Base sample grid: 31 × 31; current-view detail: 31 × 31 " +
      "(retained; update failed)",
  );
});
