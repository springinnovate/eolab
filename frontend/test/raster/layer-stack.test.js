import assert from "node:assert/strict";
import test from "node:test";

import {
  getCatalogRasterLayerKey,
  MAX_VISIBLE_RASTER_LAYERS,
  RasterLayerStack,
  RasterLayerVisibilityLimitError,
} from "../../src/raster/layer-stack.js";

function catalogItem(collection, id) {
  return { collection, id };
}

test("catalog raster keys validate and preserve composite identity", () => {
  const splitAfterFirstCharacter = catalogItem("a", "bc");
  const splitBeforeLastCharacter = catalogItem("ab", "c");
  const delimiterValues = catalogItem("a\",\"b", "[c]");

  assert.equal(
    getCatalogRasterLayerKey(splitAfterFirstCharacter),
    getCatalogRasterLayerKey({ ...splitAfterFirstCharacter }),
  );
  assert.notEqual(
    getCatalogRasterLayerKey(splitAfterFirstCharacter),
    getCatalogRasterLayerKey(splitBeforeLastCharacter),
  );
  assert.notEqual(
    getCatalogRasterLayerKey(delimiterValues),
    getCatalogRasterLayerKey(catalogItem("a", "b\",\"[c]")),
  );

  for (const invalidItem of [
    null,
    {},
    catalogItem("", "item"),
    catalogItem("collection", ""),
    catalogItem(7, "item"),
    catalogItem("collection", 7),
  ]) {
    assert.throws(
      () => getCatalogRasterLayerKey(invalidItem),
      TypeError,
    );
  }
});

test("adding an existing layer is idempotent and activates it in place", () => {
  const stack = new RasterLayerStack();
  const firstItem = catalogItem("collection", "first");
  const secondItem = catalogItem("collection", "second");
  const firstResult = stack.add(firstItem, "first.tif");
  stack.add(secondItem, "second.tif");

  const repeatedResult = stack.add(
    { ...firstItem, properties: { changed: true } },
    "replacement.tif",
  );

  assert.equal(firstResult.added, true);
  assert.equal(repeatedResult.added, false);
  assert.equal(repeatedResult.entry, firstResult.entry);
  assert.equal(stack.entries.length, 2);
  assert.deepEqual(
    stack.entries.map((entry) => entry.item.id),
    ["second", "first"],
  );
  assert.equal(stack.activeKey, firstResult.entry.key);
  assert.equal(repeatedResult.entry.label, "first.tif");
});

test("new layers are inserted in top-first drawing order", () => {
  const stack = new RasterLayerStack();

  stack.add(catalogItem("collection", "bottom"), "bottom.tif");
  stack.add(catalogItem("collection", "middle"), "middle.tif");
  stack.add(catalogItem("collection", "top"), "top.tif");

  assert.deepEqual(
    stack.entries.map((entry) => entry.item.id),
    ["top", "middle", "bottom"],
  );
});

test("at most two retained raster layers can be visible", () => {
  const stack = new RasterLayerStack();
  const first = stack.add(catalogItem("collection", "first"), "first.tif").entry;
  const second = stack.add(
    catalogItem("collection", "second"),
    "second.tif",
  ).entry;
  const third = stack.add(catalogItem("collection", "third"), "third.tif").entry;

  assert.equal(MAX_VISIBLE_RASTER_LAYERS, 2);
  assert.equal(first.visible, true);
  assert.equal(second.visible, true);
  assert.equal(third.visible, false);
  assert.equal(stack.visibleCount, 2);
  assert.throws(
    () => stack.setVisible(third.key, true),
    RasterLayerVisibilityLimitError,
  );

  stack.setVisible(first.key, false);
  stack.setVisible(third.key, true);

  assert.equal(stack.visibleCount, 2);
  assert.equal(first.visible, false);
  assert.equal(third.visible, true);
  assert.throws(() => stack.setVisible(second.key, "yes"), TypeError);
});

test("active selection is independent of layer visibility", () => {
  const stack = new RasterLayerStack();
  const first = stack.add(catalogItem("collection", "first"), "first.tif").entry;
  stack.add(catalogItem("collection", "second"), "second.tif");
  const hidden = stack.add(catalogItem("collection", "hidden"), "hidden.tif").entry;

  assert.equal(hidden.visible, false);
  assert.equal(stack.activeKey, hidden.key);

  stack.activate(first.key);
  stack.setVisible(first.key, false);

  assert.equal(stack.activeKey, first.key);
  assert.equal(first.visible, false);

  stack.activate(hidden.key);
  assert.equal(stack.activeKey, hidden.key);
  assert.equal(hidden.visible, false);
  assert.throws(() => stack.activate("missing"), RangeError);
});

test("opacity accepts only finite values in the closed unit interval", () => {
  const stack = new RasterLayerStack();
  const entry = stack.add(catalogItem("collection", "item"), "item.tif").entry;

  for (const opacity of [0, 0.375, 1]) {
    assert.equal(stack.setOpacity(entry.key, opacity), entry);
    assert.equal(entry.opacity, opacity);
  }

  for (const opacity of [-0.001, 1.001, NaN, Infinity, -Infinity, "0.5"]) {
    assert.throws(() => stack.setOpacity(entry.key, opacity), RangeError);
  }
  assert.equal(entry.opacity, 1);
});

test("moving layers respects top and bottom boundaries", () => {
  const stack = new RasterLayerStack();
  const bottom = stack.add(catalogItem("collection", "bottom"), "bottom.tif").entry;
  const middle = stack.add(catalogItem("collection", "middle"), "middle.tif").entry;
  const top = stack.add(catalogItem("collection", "top"), "top.tif").entry;

  assert.equal(stack.move(top.key, "up"), false);
  assert.equal(stack.move(bottom.key, "down"), false);
  assert.equal(stack.move(middle.key, "up"), true);
  assert.deepEqual(
    stack.entries.map((entry) => entry.item.id),
    ["middle", "top", "bottom"],
  );
  assert.equal(stack.move(middle.key, "down"), true);
  assert.deepEqual(
    stack.entries.map((entry) => entry.item.id),
    ["top", "middle", "bottom"],
  );
  assert.throws(() => stack.move(middle.key, "sideways"), TypeError);
  assert.throws(() => stack.move("missing", "up"), RangeError);
});

test("removing the active layer chooses a deterministic adjacent fallback", () => {
  const stack = new RasterLayerStack();
  const bottom = stack.add(catalogItem("collection", "bottom"), "bottom.tif").entry;
  const middle = stack.add(catalogItem("collection", "middle"), "middle.tif").entry;
  const top = stack.add(catalogItem("collection", "top"), "top.tif").entry;

  stack.activate(middle.key);
  const middleRemoval = stack.remove(middle.key);

  assert.equal(middleRemoval.removed, middle);
  assert.equal(middleRemoval.activeKey, bottom.key);
  assert.equal(stack.activeKey, bottom.key);

  stack.activate(top.key);
  const inactiveRemoval = stack.remove(bottom.key);
  assert.equal(inactiveRemoval.activeKey, top.key);

  const finalRemoval = stack.remove(top.key);
  assert.equal(finalRemoval.activeKey, null);
  assert.equal(stack.activeKey, null);
  assert.throws(() => stack.remove("missing"), RangeError);
});

test("clear removes all entries, visibility, and active selection", () => {
  const stack = new RasterLayerStack();
  stack.add(catalogItem("collection", "first"), "first.tif");
  stack.add(catalogItem("collection", "second"), "second.tif");

  stack.clear();

  assert.deepEqual(stack.entries, []);
  assert.equal(stack.visibleCount, 0);
  assert.equal(stack.activeKey, null);
});
