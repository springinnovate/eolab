import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MARKUP = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("detail-only visualization exposes three explicit bounded choices", () => {
  assert.match(MARKUP, /<strong>Detail-only visualization<\/strong>/);
  assert.match(MARKUP, /approximate preview does not render the whole raster/);
  assert.match(MARKUP, /value="centerPixel">Center-pixel sample/);
  assert.match(MARKUP, /value="samplingGrid">Small, bounded sampling grid/);
  assert.match(MARKUP, /value="representativePatch">Representative, bounded detail patch/);
  assert.match(MARKUP, /id="show-raster-detail-preview"[^>]*type="button"/s);
  assert.match(MARKUP, /id="remove-raster-detail-preview"[^>]*type="button"/s);
});
