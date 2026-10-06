import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_UNMAPPED_RASTER_APPEARANCE,
  MAX_CATEGORICAL_RASTER_CATEGORIES,
  MAX_CATEGORICAL_RASTER_STYLE_BYTES,
  normalizeCategoricalRasterStyle,
} from "../../src/raster/categorical-style.js";

/**
 * Build an editable minimal style candidate for boundary tests.
 * @return {{mode: string, categories: {value: number, label: string,
 * color: string}[]}} One-category style with omitted default fields.
 */
function candidateStyle() {
  return {
    mode: "categorical",
    categories: [{ value: 41, label: " Forest ", color: "#22ABCC" }],
  };
}

test("categorical styles normalize labels, colors, and defaults without sorting", () => {
  const style = candidateStyle();
  style.categories.push(
    { value: -3, label: "Water", color: "#112233", opacity: 0.5 },
    { value: -0, label: "Bare land", color: "#AABBCC", opacity: 0 },
  );
  const normalized = normalizeCategoricalRasterStyle(style);
  assert.deepEqual(normalized, {
    mode: "categorical",
    categories: [
      { value: 41, label: "Forest", color: "#22abcc", opacity: 1 },
      { value: -3, label: "Water", color: "#112233", opacity: 0.5 },
      { value: 0, label: "Bare land", color: "#aabbcc", opacity: 0 },
    ],
    unmapped: { color: "#808080", opacity: 1 },
  });
  assert.deepEqual(normalized.unmapped, DEFAULT_UNMAPPED_RASTER_APPEARANCE);
  assert.equal(Object.is(normalized.categories[2].value, -0), false);
});

test("normalization copies and freezes the entire style independently of its input", () => {
  const style = candidateStyle();
  style.unmapped = { color: "#FFEECC", opacity: 0.2 };
  const normalized = normalizeCategoricalRasterStyle(style);
  assert.notEqual(normalized, style);
  assert.notEqual(normalized.categories, style.categories);
  assert.notEqual(normalized.categories[0], style.categories[0]);
  assert.notEqual(normalized.unmapped, style.unmapped);
  for (const part of [normalized, normalized.categories,
    normalized.categories[0], normalized.unmapped]) {
    assert.equal(Object.isFrozen(part), true);
  }
  style.categories[0].label = "Edited";
  style.categories.push({ value: 7, label: "Other", color: "#ffffff" });
  style.unmapped.color = "#000000";
  assert.equal(normalized.categories.length, 1);
  assert.equal(normalized.categories[0].label, "Forest");
  assert.equal(normalized.unmapped.color, "#ffeecc");
  assert.throws(() => { normalized.categories[0].value = 7; }, TypeError);
  assert.deepEqual(normalizeCategoricalRasterStyle(normalized), normalized);
});

test("exact matching accepts safe integer extrema and rejects coercion or rounding", () => {
  for (const value of [0, -1, 41.0, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
    const style = candidateStyle();
    style.categories[0].value = value;
    assert.equal(normalizeCategoricalRasterStyle(style).categories[0].value, value);
  }
  for (const value of [0.5, "41", null, undefined, true, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
    const style = candidateStyle();
    style.categories[0].value = value;
    assert.throws(() => normalizeCategoricalRasterStyle(style), /safe integer/);
  }
});

test("category codes are unique including positive and negative zero", () => {
  for (const values of [[41, 41], [0, -0]]) {
    const style = candidateStyle();
    style.categories = values.map((value) => ({ value, label: "Same", color: "#123456" }));
    assert.throws(() => normalizeCategoricalRasterStyle(style), /duplicates/);
  }
  const style = candidateStyle();
  style.categories.push({ value: 42, label: "Forest", color: "#22abcc" });
  assert.equal(normalizeCategoricalRasterStyle(style).categories.length, 2);
});

test("category labels are trimmed and bounded by Unicode code points", () => {
  const style = candidateStyle();
  style.categories[0].label = ` \t${"🌲".repeat(128)}\n `;
  assert.equal(normalizeCategoricalRasterStyle(style).categories[0].label, "🌲".repeat(128));
  for (const label of ["", "  \n\t ", null, undefined, 41, "a".repeat(129),
    "🌲".repeat(129), "\ud800", "\udc00"]) {
    style.categories[0].label = label;
    assert.throws(() => normalizeCategoricalRasterStyle(style), /label/);
  }
});

test("colors require six hex digits and explicit unmapped opacity defaults to one", () => {
  const style = candidateStyle();
  style.unmapped = { color: "#ABCDEF" };
  assert.deepEqual(normalizeCategoricalRasterStyle(style).unmapped,
    { color: "#abcdef", opacity: 1 });
  for (const color of ["red", "#fff", "#11223344", "112233", " #112233", "#GG1122",
    null, undefined, 123456]) {
    assert.throws(() => normalizeCategoricalRasterStyle({
      ...candidateStyle(), categories: [{ value: 1, label: "One", color }],
    }), /six-digit hex/);
    if (color !== undefined) {
      assert.throws(() => normalizeCategoricalRasterStyle({
        ...candidateStyle(), unmapped: { color },
      }), /six-digit hex/);
    }
  }
  assert.deepEqual(normalizeCategoricalRasterStyle({
    ...candidateStyle(), unmapped: {},
  }).unmapped, { color: "#808080", opacity: 1 });
  assert.deepEqual(normalizeCategoricalRasterStyle({
    ...candidateStyle(), unmapped: { opacity: 0.5 },
  }).unmapped, { color: "#808080", opacity: 0.5 });
});

test("category and unmapped opacity reject invalid data and preserve transparency", () => {
  for (const opacity of [0, 0.4, 1]) {
    const style = candidateStyle();
    style.categories[0].opacity = opacity;
    style.unmapped = { color: "#123456", opacity };
    const normalized = normalizeCategoricalRasterStyle(style);
    assert.equal(normalized.categories[0].opacity, opacity);
    assert.equal(normalized.unmapped.opacity, opacity);
  }
  for (const opacity of [-0.1, 1.1, "0.5", null, true, NaN, Infinity, -Infinity]) {
    const style = candidateStyle();
    style.categories[0].opacity = opacity;
    assert.throws(() => normalizeCategoricalRasterStyle(style), /opacity/);
    assert.throws(() => normalizeCategoricalRasterStyle({
      ...candidateStyle(), unmapped: { color: "#123456", opacity },
    }), /opacity/);
  }
});

test("style, category, and unmapped records reject unknown fields and invalid shapes", () => {
  for (const value of [null, undefined, [], 41, "categorical", new Date()]) {
    assert.throws(() => normalizeCategoricalRasterStyle(value), /object/);
    assert.throws(() => normalizeCategoricalRasterStyle({
      ...candidateStyle(), categories: [value],
    }), /object/);
    if (value !== undefined) {
      assert.throws(() => normalizeCategoricalRasterStyle({
        ...candidateStyle(), unmapped: value,
      }), /object/);
    }
  }
  for (const extra of [{ minimum: 0 }, { path: "/raster.tif" }, { [Symbol("extra")]: 1 }]) {
    assert.throws(() => normalizeCategoricalRasterStyle({ ...candidateStyle(), ...extra }),
      /unknown fields/);
    const style = candidateStyle();
    style.categories[0] = { ...style.categories[0], ...extra };
    assert.throws(() => normalizeCategoricalRasterStyle(style), /unknown fields/);
    assert.throws(() => normalizeCategoricalRasterStyle({
      ...candidateStyle(), unmapped: { color: "#123456", ...extra },
    }), /unknown fields/);
  }
  for (const mode of [undefined, "continuous", "Categorical"]) {
    assert.throws(() => normalizeCategoricalRasterStyle({ ...candidateStyle(), mode }),
      /mode must be categorical/);
  }
  assert.throws(() => normalizeCategoricalRasterStyle({
    ...candidateStyle(), categories: Array(1),
  }), /Category 1 must be an object/);
});

test("category count is bounded before normalization", () => {
  for (const categories of [undefined, null, {}, [], Array(257)]) {
    assert.throws(() => normalizeCategoricalRasterStyle({ ...candidateStyle(), categories }),
      /1 to 256 rows/);
  }
  const style = candidateStyle();
  style.categories = Array.from({ length: MAX_CATEGORICAL_RASTER_CATEGORIES },
    (_, value) => ({ value, label: `Category ${value}`, color: "#123456" }));
  assert.equal(normalizeCategoricalRasterStyle(style).categories.length, 256);
});

test("serialized style budget counts UTF-8 bytes as well as table and label limits", () => {
  const style = candidateStyle();
  style.categories = Array.from({ length: 256 },
    (_, value) => ({ value, label: "e".repeat(128), color: "#123456" }));
  assert.doesNotThrow(() => normalizeCategoricalRasterStyle(style));
  style.categories.forEach((category) => { category.label = "é".repeat(128); });
  assert.ok(JSON.stringify(style).length < MAX_CATEGORICAL_RASTER_STYLE_BYTES);
  assert.ok(new TextEncoder().encode(JSON.stringify(style)).byteLength >
    MAX_CATEGORICAL_RASTER_STYLE_BYTES);
  assert.throws(() => normalizeCategoricalRasterStyle(style), /65536 UTF-8 bytes/);
});
