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
  assert.match(
    STYLESHEET,
    /\.saved-map-view-action\[hidden\]\s*\{[^}]*display:\s*none;/s,
  );
});

test("catalog rows can shrink while their action buttons wrap at compact widths", () => {
  assert.match(STYLESHEET, /\.catalog-result\s*\{[^}]*min-width:\s*0;/s);
  assert.match(STYLESHEET, /\.catalog-result-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
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
    /\.raster-point-samples\s*\{[^}]*border-bottom:/s,
  );
  assert.match(STYLESHEET, /\.raster-histogram-bar\.is-hovered/);
});
