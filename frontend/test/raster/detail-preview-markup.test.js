import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MARKUP = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const STYLE = readFileSync(
  new URL("../../src/style.css", import.meta.url),
  "utf8",
);

test("sampled raster visualization explains its three bounded policies", () => {
  assert.match(MARKUP, /<strong>Bounded sampled raster<\/strong>/);
  assert.match(MARKUP, /does not read or render every source pixel/);
  assert.match(MARKUP, /same selected density/);
  assert.match(MARKUP, /value="centerSample">Center sample in each proxy cell/);
  assert.match(MARKUP, /value="representativeSample">Representative samples in each proxy cell/);
  assert.match(MARKUP, /value="representativePatch">Representative, bounded detail patch/);
  assert.match(MARKUP, /id="raster-detail-preview-density"/);
  assert.match(MARKUP, /value="coarse">Coarse — exact 31 × 31 samples/);
  assert.match(MARKUP, /value="medium">Medium — exact 63 × 63 samples/);
  assert.match(MARKUP, /value="fine">Fine — exact 127 × 127 samples/);
  assert.match(MARKUP, /reports an error instead of substituting a coarser grid/);
  assert.match(MARKUP, /id="raster-detail-preview-resolution"/);
  assert.match(MARKUP, /id="show-raster-detail-preview"[^>]*type="button"/s);
  assert.match(MARKUP, /Show sampled raster/);
  assert.match(MARKUP, /id="remove-raster-detail-preview"[^>]*type="button"/s);
  assert.match(MARKUP, /Remove sampled raster/);
  assert.match(
    STYLE,
    /\.raster-sampled-proxy\s*\{[^}]*image-rendering:\s*pixelated;/s,
  );
});
