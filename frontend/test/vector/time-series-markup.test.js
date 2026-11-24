import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MARKUP = readFileSync(
  new URL("../../index.html", import.meta.url),
  "utf8",
);
const STYLESHEET = readFileSync(
  new URL("../../src/style.css", import.meta.url),
  "utf8",
);

test("vector time-series controls and accessible outputs are present", () => {
  for (const identifier of [
    "open-vector-time-series",
    "toggle-vector-inspector-details",
    "vector-feature-inspector-details",
    "zoom-inspected-vector-feature",
    "vector-time-series",
    "vector-time-series-heading",
    "vector-time-series-context",
    "vector-time-series-previous-selection",
    "vector-time-series-next-selection",
    "close-vector-time-series",
    "vector-time-series-x",
    "vector-time-series-fields-picker",
    "vector-time-series-field-list",
    "vector-time-series-direction",
    "vector-time-series-chart-type",
    "vector-time-series-legend",
    "vector-time-series-status",
    "vector-time-series-chart",
    "vector-time-series-selection",
    "vector-time-series-selection-text",
    "zoom-vector-time-series-feature",
    "vector-time-series-table",
    "vector-time-series-table-body",
  ]) {
    assert.match(MARKUP, new RegExp(`id="${identifier}"`));
  }
  assert.match(
    MARKUP,
    /id="open-vector-time-series"[^>]+aria-controls="vector-time-series"/,
  );
  assert.match(
    MARKUP,
    /id="toggle-vector-inspector-details"[^>]+aria-controls="vector-feature-inspector-details"[^>]+aria-expanded="true"/,
  );
  assert.match(
    MARKUP,
    /id="zoom-inspected-vector-feature"[^>]+aria-controls="map"[^>]*>Zoom to feature</,
  );
  assert.match(
    MARKUP,
    /id="zoom-vector-time-series-feature"[^>]+aria-controls="map"[^>]*>Zoom to feature</,
  );
  assert.match(MARKUP, /<label for="vector-time-series-x">/);
  assert.match(MARKUP, /<label for="vector-time-series-field-search">/);
  assert.match(MARKUP, /<label for="vector-time-series-direction">/);
  assert.match(MARKUP, /<label for="vector-time-series-chart-type">/);
  assert.match(MARKUP, /<select id="vector-time-series-chart-type">.*<option value="bar" selected>Bars<\/option>.*<option value="stacked">Stacked bars<\/option>/);
  assert.match(MARKUP, />Compare features<\/button>/);
  assert.match(MARKUP, />Compare features<\/h2>/);
  assert.match(MARKUP, /aria-label="Selection history"/);
  assert.match(MARKUP, /<\/span> Previous selection<\/button>/);
  assert.match(MARKUP, /disabled>Next selection <span aria-hidden="true">→<\/span>/);
  assert.doesNotMatch(MARKUP, />Time series<\/button>/);
  assert.match(MARKUP, /id="vector-time-series-chart"[^>]+role="group"/);
  assert.match(STYLESHEET, /#vector-time-series\[hidden\]/);
  assert.match(
    STYLESHEET,
    /#vector-feature-inspector:has\(#vector-feature-inspector-details\[hidden\]\)/,
  );
  assert.match(
    STYLESHEET,
    /\.vector-time-series-chart\[hidden\]\s*\{\s*display:\s*none;/,
  );
  assert.match(STYLESHEET, /\.series-chart-axis/);
  assert.match(STYLESHEET, /\.series-chart-point\.is-selected/);
  assert.match(STYLESHEET, /\.vector-time-series-selection\[hidden\]/);
  assert.match(STYLESHEET, /\.vector-series-context\[hidden\]/);
});

test("feature-field plotting has searchable, accessible series controls", () => {
  assert.match(MARKUP, /<select id="vector-feature-profile-chart-type">.*<option value="stacked">Stacked bars<\/option>/);
  for (const identifier of [
    "open-vector-feature-profile",
    "vector-feature-profile-action-help",
    "vector-feature-profile",
    "vector-feature-profile-heading",
    "vector-feature-profile-context",
    "close-vector-feature-profile",
    "previous-vector-feature-profile",
    "vector-feature-profile-position",
    "next-vector-feature-profile",
    "zoom-vector-feature-profile-feature",
    "vector-feature-profile-title-field",
    "vector-feature-profile-field-search",
    "vector-feature-profile-select-matching",
    "vector-feature-profile-clear-fields",
    "vector-feature-profile-field-list",
    "vector-feature-profile-direction",
    "vector-feature-profile-chart-type",
    "vector-feature-profile-values-button",
    "vector-feature-profile-status",
    "vector-feature-profile-chart",
    "vector-feature-profile-table",
    "vector-feature-profile-table-body",
  ]) {
    assert.match(MARKUP, new RegExp(`id="${identifier}"`));
  }
  assert.match(MARKUP, />Plot this feature<\/button>/);
  assert.match(MARKUP, />One feature<\/h2>/);
  assert.match(MARKUP, /<select id="vector-feature-profile-chart-type">.*<option value="bar" selected>Bars<\/option>/);
  assert.match(
    MARKUP,
    /class="vector-feature-navigation vector-feature-profile-navigation"[^>]+aria-label="Features in this inspection"/,
  );
  assert.match(
    MARKUP,
    /id="zoom-vector-feature-profile-feature"[^>]+aria-controls="map"[^>]*>Zoom to feature</,
  );
  assert.match(
    MARKUP,
    />Plot the numeric fields on this feature\.<\/span>/,
  );
  assert.match(
    MARKUP,
    />Select at least two features with Picker or Lasso to compare their fields\.<\/span>/,
  );
  assert.match(
    MARKUP,
    /id="open-vector-feature-profile"[^>]+aria-controls="vector-feature-profile"[^>]+aria-describedby="vector-feature-profile-action-help"/,
  );
  assert.match(STYLESHEET, /#vector-feature-profile\[hidden\]/);
  assert.match(STYLESHEET, /\.immediate-action-help:hover/);
  assert.match(STYLESHEET, /\.immediate-action-help:focus-within/);
});
