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
  assert.match(
    MARKUP,
    /class="raster-detail-map-notice"[^>]*id="raster-detail-map-notice"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/s,
  );
  assert.match(
    MARKUP,
    /class="raster-detail-processing"[^>]*id="raster-detail-processing"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-busy="false"[^>]*hidden/s,
  );
  assert.match(MARKUP, /Processing raster detail…/);
  assert.match(MARKUP, /The displayed raster will\s+update when it is ready/);
  assert.match(MARKUP, /id="show-raster-detail-preview"[^>]*type="button"/s);
  assert.match(MARKUP, /Show adaptive raster/);
  assert.match(MARKUP, /id="remove-raster-detail-preview"[^>]*type="button"/s);
  assert.match(MARKUP, /Remove adaptive raster/);
  assert.match(
    STYLE,
    /\.raster-sampled-proxy\s*\{[^}]*image-rendering:\s*auto;/s,
  );
  assert.match(
    STYLE,
    /\.raster-source-detail\s*\{[^}]*image-rendering:\s*pixelated;/s,
  );
  assert.match(
    STYLE,
    /\.raster-detail-map-notice\s*\{[^}]*z-index:\s*1000;[^}]*pointer-events:\s*none;[^}]*border:\s*2px solid/s,
  );
  assert.match(
    STYLE,
    /\.raster-detail-processing\s*\{[^}]*z-index:\s*990;[^}]*pointer-events:\s*none;[^}]*backdrop-filter:\s*grayscale\(85%\) brightness\(72%\)/s,
  );
  assert.match(
    STYLE,
    /\.raster-detail-processing-spinner\s*\{[^}]*animation:\s*raster-detail-processing-spin 800ms linear infinite/s,
  );
});
