import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MARKUP = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const STYLE = readFileSync(
  new URL("../../src/style.css", import.meta.url),
  "utf8",
);

test("low-resolution raster rendering explains its bounded detail handoff", () => {
  assert.match(MARKUP, /<strong>Low-resolution raster rendering<\/strong>/);
  assert.match(MARKUP, /too large for standard whole-raster rendering/);
  assert.match(MARKUP, /show a bounded sample grid/);
  assert.match(MARKUP, /Close views automatically use complete source-window detail/);
  assert.match(MARKUP, /visible area satisfies server-owned limits/);
  assert.doesNotMatch(MARKUP, /raster-detail-preview-mode/);
  assert.doesNotMatch(MARKUP, /raster-detail-preview-density/);
  assert.doesNotMatch(MARKUP, /Adaptive bounded raster detail/);
  assert.doesNotMatch(MARKUP, /Show adaptive raster|Remove adaptive raster/);
  assert.match(MARKUP, /Sample grids use smooth display interpolation/);
  assert.match(MARKUP, /exact close-view windows use crisp nearest-neighbor presentation/);
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
  assert.match(MARKUP, /Show low-resolution rendering/);
  assert.match(MARKUP, /id="remove-raster-detail-preview"[^>]*type="button"/s);
  assert.match(MARKUP, /Remove low-resolution rendering/);
  assert.match(MARKUP, /id="reassess-detail-raster"[^>]*type="button"/s);
  assert.match(MARKUP, /Check for full visualization/);
  assert.match(
    STYLE,
    /\.raster-sample-grid\s*\{[^}]*image-rendering:\s*auto;/s,
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

test("low-resolution controls are owned by the Rendering workspace", () => {
  const renderingStart = MARKUP.indexOf('id="eomap-map-layers-region"');
  const previewStart = MARKUP.indexOf('id="raster-detail-preview-controls"');
  const analysisStart = MARKUP.indexOf('id="eomap-raster-interpretation-region"');

  assert.ok(renderingStart >= 0);
  assert.ok(renderingStart < previewStart);
  assert.ok(previewStart < analysisStart);
  assert.match(
    MARKUP,
    /id="eomap-map-layers-region"[^>]*role="tabpanel"[^>]*aria-labelledby="toggle-map-layers eomap-map-layers-heading"/s,
  );
});
