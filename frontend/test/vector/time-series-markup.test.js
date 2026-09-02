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
    "vector-time-series-status",
    "vector-time-series-chart",
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
  assert.match(MARKUP, /id="vector-time-series-chart"[^>]+role="img"/);
  assert.match(STYLESHEET, /#vector-time-series\[hidden\]/);
  assert.match(
    STYLESHEET,
    /\.vector-time-series-chart\[hidden\]\s*\{\s*display:\s*none;/,
  );
  assert.match(STYLESHEET, /\.vector-time-series-axis/);
});
