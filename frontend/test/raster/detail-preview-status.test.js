import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRasterDetailMapNotice,
  formatRasterDetailPreviewResolution,
  isRasterDetailPreviewProcessing,
} from "../../src/raster/detail-preview-status.js";
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
      detailError: "The bounded detail-only preview could not be read.",
    }),
    /Active view: sampled proxy 31 × 31 center samples; .+ \(retained; update failed: The bounded detail-only preview could not be read\.\)$/,
  );
});

test("map processing state follows only current-view refinement work", () => {
  assert.equal(isRasterDetailPreviewProcessing(null), false);
  assert.equal(isRasterDetailPreviewProcessing({
    detailStatus: "none",
  }), false);
  assert.equal(isRasterDetailPreviewProcessing({
    detailStatus: "ready",
  }), false);
  assert.equal(isRasterDetailPreviewProcessing({
    detailStatus: "error",
  }), false);
  assert.equal(isRasterDetailPreviewProcessing({
    detailStatus: "loading",
  }), true);
});

test("map notice explains overview limits and the active representation", () => {
  assert.equal(formatRasterDetailMapNotice(null), "");
  assert.match(
    formatRasterDetailMapNotice({
      basePreview: CENTER_SAMPLE_DETAIL_PREVIEW,
      detailPreview: CURRENT_VIEW_DETAIL_PREVIEW,
    }),
    /DETAIL-ONLY RASTER.*does not have a usable overview pyramid.*sampled current view is not the raster's native resolution.*Current view sampling grid: 31 × 31 proxy cells \(center-sampled\)/,
  );
  assert.match(
    formatRasterDetailMapNotice({
      basePreview: CENTER_SAMPLE_DETAIL_PREVIEW,
      detailPreview: EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
    }),
    /ZOOMED IN TO FULL SOURCE DETAIL.*display every native source pixel in the bounded window \(4 × 3\).*true source detail; zooming out will return to sampled detail/s,
  );
  assert.match(
    formatRasterDetailMapNotice({
      basePreview: PATCH_DETAIL_PREVIEW,
      detailPreview: null,
    }),
    /representative bounded 2 × 2 source patch; it is not a whole-raster rendering/,
  );
});
