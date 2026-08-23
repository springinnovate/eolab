import assert from "node:assert/strict";
import test from "node:test";

import { supportsRasterDetailOnlyPreview } from "../../src/catalog.js";
import { MOUNTED_GEOTIFF_ITEM } from "../../test-support/raster/fixtures.js";

/**
 * Build one raster Item carrying controlled rendering metadata.
 *
 * @param {Object} rendering Scanner-owned rendering assessment.
 * @return {Object} Catalog Item fixture.
 */
function itemWithRendering(rendering) {
  return {
    ...MOUNTED_GEOTIFF_ITEM,
    assets: { data: { "eolab:rendering": rendering } },
  };
}

test("sampled raster UI allowlist requires overview reason and current reader", () => {
  const rendering = {
    policy: "raster-v3",
    eligible: false,
    reason_code: "internal_overviews_required",
    reader_contract: "geoserver-3.0.1-geotools-35.1-geotiff-v1",
    reader_compatible: true,
    bounded_blocks: true,
  };
  for (const reasonCode of [
    "internal_overviews_required",
    "incomplete_overview_pyramid",
    "coarsest_overview_dimension_exceeded",
    "coarsest_overview_decoded_size_exceeded",
  ]) {
    assert.equal(
      supportsRasterDetailOnlyPreview(itemWithRendering({
        ...rendering,
        reason_code: reasonCode,
      })),
      true,
    );
  }
  assert.equal(
    supportsRasterDetailOnlyPreview(itemWithRendering({
      ...rendering,
      reason_code: "blocks_too_large",
    })),
    false,
  );
  assert.equal(
    supportsRasterDetailOnlyPreview(itemWithRendering({
      ...rendering,
      bounded_blocks: false,
    })),
    false,
  );
  const { bounded_blocks: _boundedBlocks, ...missingBlockContract } = rendering;
  assert.equal(
    supportsRasterDetailOnlyPreview(itemWithRendering(missingBlockContract)),
    false,
  );
  assert.equal(
    supportsRasterDetailOnlyPreview(itemWithRendering({
      ...rendering,
      reader_compatible: false,
    })),
    false,
  );
  assert.equal(
    supportsRasterDetailOnlyPreview(itemWithRendering({
      ...rendering,
      reader_contract: "obsolete-reader",
    })),
    false,
  );
});
