import assert from "node:assert/strict";
import test from "node:test";

import { formatRasterDetailPreviewResolution } from "../../src/raster/detail-preview-status.js";
import {
  CENTER_SAMPLE_DETAIL_PREVIEW,
  CURRENT_VIEW_DETAIL_PREVIEW,
  EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
  PATCH_DETAIL_PREVIEW,
} from "../../test-support/raster/fixtures.js";

test("detail preview resolution distinguishes patches from adaptive grids", () => {
  assert.equal(
    formatRasterDetailPreviewResolution(null),
    "Base raster detail: —; active view: —",
  );
  assert.equal(
    formatRasterDetailPreviewResolution(null, "loading"),
    "Base raster detail: loading…; active view: —",
  );
  assert.equal(
    formatRasterDetailPreviewResolution(null, "error"),
    "Base raster detail: request failed; active view: —",
  );
  assert.match(
    formatRasterDetailPreviewResolution({
      mode: "representativePatch",
      basePreview: PATCH_DETAIL_PREVIEW,
      detailPreview: null,
      detailStatus: "none",
    }),
    /Base: representative patch 2 × 2; source window at column 20, row 30; .*4 native blocks \/ 64\.0 KiB; automatic current-view refinement: off/,
  );
  assert.match(
    formatRasterDetailPreviewResolution({
      mode: "centerSample",
      basePreview: CENTER_SAMPLE_DETAIL_PREVIEW,
      detailPreview: CURRENT_VIEW_DETAIL_PREVIEW,
      detailStatus: "ready",
    }),
    /Base: sampled proxy 31 × 31 center samples; .*Active view: sampled proxy 31 × 31 center samples;/,
  );
  assert.match(
    formatRasterDetailPreviewResolution({
      mode: "centerSample",
      basePreview: CENTER_SAMPLE_DETAIL_PREVIEW,
      detailPreview: EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
      detailStatus: "ready",
    }),
    /Active view: exact bounded detail 4 × 3; source columns 400–403, rows 250–252; W -122\.5000, S 48\.5000, E -121\.5000, N 49\.5000; 2 native blocks \/ 40\.0 KiB/,
  );
});

test("detail preview resolution reports pending and retained update states", () => {
  assert.match(
    formatRasterDetailPreviewResolution({
      mode: "centerSample",
      basePreview: CENTER_SAMPLE_DETAIL_PREVIEW,
      detailPreview: null,
      detailStatus: "loading",
    }),
    /Active view: updating…$/,
  );
  assert.match(
    formatRasterDetailPreviewResolution({
      mode: "centerSample",
      basePreview: CENTER_SAMPLE_DETAIL_PREVIEW,
      detailPreview: CURRENT_VIEW_DETAIL_PREVIEW,
      detailStatus: "error",
    }),
    /Active view: sampled proxy 31 × 31 center samples; .+ \(retained; update failed\)$/,
  );
});
