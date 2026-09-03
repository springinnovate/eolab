import assert from "node:assert/strict";
import test from "node:test";

import {
  REMEMBERED_MAP_VIEW_STORAGE_KEY,
  SavedMapViewLocalStorage,
} from "../../src/saved-map-view/local-storage.js";

/** Build an inspectable browser Storage subset. @return {Object} Test storage. */
function createBrowserStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("saved map local storage owns one versioned opaque value", () => {
  const browserStorage = createBrowserStorage();
  const storage = new SavedMapViewLocalStorage(browserStorage);

  assert.equal(storage.read(), null);
  assert.equal(storage.write("{\"format\":\"opaque\"}"), true);
  assert.equal(
    browserStorage.values.get(REMEMBERED_MAP_VIEW_STORAGE_KEY),
    "{\"format\":\"opaque\"}",
  );
  assert.equal(storage.read(), "{\"format\":\"opaque\"}");
  assert.equal(storage.clear(), true);
  assert.equal(storage.read(), null);
});

test("saved map local storage is nonblocking when browser storage fails", () => {
  const failure = new Error("storage unavailable");
  const storage = new SavedMapViewLocalStorage({
    getItem() { throw failure; },
    setItem() { throw failure; },
    removeItem() { throw failure; },
  });

  assert.equal(storage.read(), null);
  assert.equal(storage.write("valid opaque text"), false);
  assert.equal(storage.clear(), false);
});

test("saved map local storage validates its narrow text contract", () => {
  assert.throws(() => new SavedMapViewLocalStorage(null, ""), /nonempty text/);
  const storage = new SavedMapViewLocalStorage(null);
  assert.throws(() => storage.write({}), /must be text/);
  assert.equal(storage.write("valid opaque text"), false);
  assert.equal(storage.clear(), false);
});
