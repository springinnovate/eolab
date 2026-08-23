import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MARKUP = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const STYLE = readFileSync(
  new URL("../../src/style.css", import.meta.url),
  "utf8",
);

test("adaptive raster detail explains sampling and exact-view handoff", () => {
  assert.match(MARKUP, /<strong>Adaptive bounded raster detail<\/strong>/);
  assert.match(MARKUP, /Broad views use the selected approximate sample grid/);
  assert.match(MARKUP, /complete bounded source-pixel detail/);
  assert.match(MARKUP, /value="centerSample">Center sample in each proxy cell/);
  assert.match(MARKUP, /value="representativeSample">Representative samples in each proxy cell/);
  assert.match(MARKUP, /value="representativePatch">Representative, bounded detail patch/);
  assert.match(MARKUP, /id="raster-detail-preview-density"/);
  assert.match(MARKUP, /value="coarse">Coarse — 31 samples on the longest edge/);
  assert.match(MARKUP, /value="medium">Medium — 63 samples on the longest edge/);
  assert.match(MARKUP, /value="fine">Fine — 127 samples on the longest edge/);
  assert.match(MARKUP, /shorter edge preserves the displayed rectangle's aspect ratio/);
  assert.match(MARKUP, /active map area, source window, native blocks, and decoded work/);
  assert.match(MARKUP, /id="raster-detail-preview-resolution"/);
  assert.match(MARKUP, /id="show-raster-detail-preview"[^>]*type="button"/s);
  assert.match(MARKUP, /Show adaptive raster/);
  assert.match(MARKUP, /id="remove-raster-detail-preview"[^>]*type="button"/s);
  assert.match(MARKUP, /Remove adaptive raster/);
  assert.match(
    STYLE,
    /\.raster-sampled-proxy\s*\{[^}]*image-rendering:\s*pixelated;/s,
  );
});
