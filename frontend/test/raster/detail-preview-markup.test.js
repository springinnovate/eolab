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
  assert.match(MARKUP, /low-resolution proxy covers the raster extent/);
  assert.match(MARKUP, /does not read or render every source pixel/);
  assert.match(MARKUP, /Each displayed cell represents a larger source region/);
  assert.match(MARKUP, /value="centerSample">Center sample in each proxy cell/);
  assert.match(MARKUP, /value="representativeSample">Representative samples in each proxy cell/);
  assert.match(MARKUP, /value="representativePatch">Representative, bounded detail patch/);
  assert.match(MARKUP, /id="show-raster-detail-preview"[^>]*type="button"/s);
  assert.match(MARKUP, /Show sampled raster/);
  assert.match(MARKUP, /id="remove-raster-detail-preview"[^>]*type="button"/s);
  assert.match(MARKUP, /Remove sampled raster/);
  assert.match(
    STYLE,
    /\.raster-sampled-proxy\s*\{[^}]*image-rendering:\s*pixelated;/s,
  );
});
