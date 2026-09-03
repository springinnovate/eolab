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
    "vector-time-series",
    "close-vector-time-series",
    "vector-time-series-x",
    "vector-time-series-y",
    "vector-time-series-direction",
    "vector-time-series-chart-type",
    "vector-time-series-status",
    "vector-time-series-chart",
    "vector-time-series-selection",
    "vector-time-series-selection-text",
    "zoom-vector-time-series-source",
    "vector-time-series-table",
    "vector-time-series-table-body",
  ]) {
    assert.match(MARKUP, new RegExp(`id="${identifier}"`));
  }
  assert.match(
    MARKUP,
    /id="open-vector-time-series"[^>]+aria-controls="vector-time-series"/,
  );
  assert.match(MARKUP, /<label for="vector-time-series-x">/);
  assert.match(MARKUP, /<label for="vector-time-series-y">/);
  assert.match(MARKUP, /<label for="vector-time-series-direction">/);
  assert.match(MARKUP, /<label for="vector-time-series-chart-type">/);
  assert.match(MARKUP, />Plot one field across features<\/button>/);
  assert.match(MARKUP, />Series plot<\/h2>/);
  assert.doesNotMatch(MARKUP, />Time series<\/button>/);
  assert.match(MARKUP, /id="vector-time-series-chart"[^>]+role="img"/);
  assert.match(STYLESHEET, /#vector-time-series\[hidden\]/);
  assert.match(
    STYLESHEET,
    /\.vector-time-series-chart\[hidden\]\s*\{\s*display:\s*none;/,
  );
  assert.match(STYLESHEET, /\.series-chart-axis/);
  assert.match(STYLESHEET, /\.series-chart-point\.is-selected/);
  assert.match(STYLESHEET, /\.vector-time-series-selection\[hidden\]/);
});

test("feature-field plotting has searchable, accessible series controls", () => {
  for (const identifier of [
    "open-vector-feature-profile",
    "vector-feature-profile-action-help",
    "vector-feature-profile",
    "close-vector-feature-profile",
    "vector-feature-profile-title-field",
    "vector-feature-profile-field-search",
    "vector-feature-profile-select-matching",
    "vector-feature-profile-clear-fields",
    "vector-feature-profile-field-list",
    "vector-feature-profile-direction",
    "vector-feature-profile-chart-type",
    "vector-feature-profile-chart-title",
    "vector-feature-profile-status",
    "vector-feature-profile-chart",
    "vector-feature-profile-table",
    "vector-feature-profile-table-body",
  ]) {
    assert.match(MARKUP, new RegExp(`id="${identifier}"`));
  }
  assert.match(MARKUP, />Plot fields from this feature<\/button>/);
  assert.match(
    MARKUP,
    />Plot several numeric fields from this feature, such as R2000–R2024\.<\/span>/,
  );
  assert.match(
    MARKUP,
    />One numeric field across all features found at this location\.<\/span>/,
  );
  assert.match(
    MARKUP,
    /id="open-vector-feature-profile"[^>]+aria-controls="vector-feature-profile"[^>]+aria-describedby="vector-feature-profile-action-help"/,
  );
  assert.match(STYLESHEET, /#vector-feature-profile\[hidden\]/);
  assert.match(STYLESHEET, /\.immediate-action-help:hover/);
  assert.match(STYLESHEET, /\.immediate-action-help:focus-within/);
});
