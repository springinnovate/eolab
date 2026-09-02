import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const STYLESHEET = readFileSync(
  new URL("../src/style.css", import.meta.url),
  "utf8",
);

test("application styling exposes shared visual state tokens", () => {
  for (const token of [
    "--font-sans:",
    "--surface-hover:",
    "--surface-selected:",
    "--focus-ring:",
    "--disabled-opacity:",
    "--elevation-panel:",
  ]) {
    assert.match(STYLESHEET, new RegExp(token));
  }
});

test("controls retain distinct interactive and accessibility states", () => {
  assert.match(STYLESHEET, /summary:focus-visible/);
  assert.match(STYLESHEET, /\.secondary-button:hover:not\(:disabled\)/);
  assert.match(STYLESHEET, /\.secondary-button:active:not\(:disabled\)/);
  assert.match(STYLESHEET, /\[aria-busy="true"\]/);
  assert.match(STYLESHEET, /\[aria-disabled="true"\]/);
  assert.match(STYLESHEET, /\.catalog-result:has\(\.catalog-result-details\.is-selected\)/);
  assert.match(STYLESHEET, /\.temporary-aoi-error/);
});

test("catalog rows can shrink while their action buttons wrap at compact widths", () => {
  assert.match(STYLESHEET, /\.catalog-result\s*\{[^}]*min-width:\s*0;/s);
  assert.match(STYLESHEET, /\.catalog-result-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
});

test("map-layer reorder handles expose grab and insertion feedback", () => {
  assert.match(
    STYLESHEET,
    /\.raster-layer-list\s*\{[^}]*padding:\s*6px 0;/s,
  );
  assert.match(
    STYLESHEET,
    /\.map-layer-drag-handle\s*\{[^}]*touch-action:\s*none;[^}]*cursor:\s*grab;/s,
  );
  assert.match(
    STYLESHEET,
    /\.raster-layer-row\.is-dragging\s*\{[^}]*box-shadow:[^}]*opacity:/s,
  );
  assert.match(STYLESHEET, /\.raster-layer-row\.is-drop-before::before/);
  assert.match(STYLESHEET, /\.raster-layer-row\.is-drop-after::after/);
});

test("map-layer style clipboard actions stay compact and visually distinct", () => {
  assert.match(
    STYLESHEET,
    /\.map-layer-style-actions\s*\{[^}]*display:\s*flex;[^}]*gap:\s*4px;/s,
  );
  assert.match(
    STYLESHEET,
    /\.raster-layer-row \.map-layer-style-icon-button\s*\{[^}]*width:\s*27px;[^}]*height:\s*27px;/s,
  );
  assert.match(STYLESHEET, /\.map-layer-style-copy-icon::before/);
  assert.match(STYLESHEET, /\.map-layer-style-copy-icon::after/);
  assert.match(STYLESHEET, /\.map-layer-style-paste-icon::before/);
  assert.match(STYLESHEET, /\.map-layer-style-paste-icon::after/);
});

test("map overlays and inspection surfaces retain contrast contracts", () => {
  assert.match(
    STYLESHEET,
    /\.eolab-basemap\s*\{[^}]*opacity:[^}]*filter:/s,
  );
  assert.match(
    STYLESHEET,
    /\.temporary-aoi-overlay\s*\{[^}]*stroke:[^}]*stroke-width:/s,
  );
  assert.match(
    STYLESHEET,
    /\.catalog-footprint\.is-selected\s*\{[^}]*fill:[^}]*stroke:/s,
  );
  assert.match(
    STYLESHEET,
    /\.raster-pixel-probe\s*\{[^}]*border:[^}]*background:/s,
  );
  assert.match(STYLESHEET, /\.raster-histogram-bar\.is-hovered/);
});
