import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeSavedMapViewFragment,
  encodeSavedMapViewFragment,
  isSavedMapViewFragment,
  SAVED_MAP_VIEW_FRAGMENT_PREFIX,
} from "../../src/saved-map-view/fragment-codec.js";

test("saved map fragments round-trip UTF-8 through gzip and Base64URL", async () => {
  const serialized = JSON.stringify({ title: "Café 🌍", layers: [1, 2, 3] });
  const fragment = await encodeSavedMapViewFragment(serialized, {
    maximumInputBytes: 1024,
  });

  assert.match(fragment, /^#view=[A-Za-z0-9_-]+$/);
  assert.equal(fragment.includes("="), true);
  assert.equal(fragment.slice(SAVED_MAP_VIEW_FRAGMENT_PREFIX.length)
    .includes("="), false);
  assert.equal(isSavedMapViewFragment(fragment), true);
  assert.equal(await decodeSavedMapViewFragment(fragment, {
    maximumOutputBytes: 1024,
  }), serialized);
});

test("saved map fragment decoder rejects invalid syntax before decompression", async () => {
  await assert.rejects(
    decodeSavedMapViewFragment("#view=not+base64", {
      maximumOutputBytes: 1024,
    }),
    /invalid encoded view/,
  );
  await assert.rejects(
    decodeSavedMapViewFragment("#other=value", {
      maximumOutputBytes: 1024,
    }),
    /does not contain an EOLab map view/,
  );
});

test("saved map fragment decoder bounds decompressed content", async () => {
  const fragment = await encodeSavedMapViewFragment("x".repeat(4096), {
    maximumInputBytes: 4096,
  });

  await assert.rejects(
    decodeSavedMapViewFragment(fragment, { maximumOutputBytes: 64 }),
    /Saved map content must be/,
  );
});

test("saved map fragment codec rejects absent browser compression support", async () => {
  await assert.rejects(
    encodeSavedMapViewFragment("{}", {
      maximumInputBytes: 1024,
      CompressionStreamClass: null,
    }),
    /cannot compress shared map links/,
  );
  await assert.rejects(
    decodeSavedMapViewFragment("#view=H4sI", {
      maximumOutputBytes: 1024,
      DecompressionStreamClass: null,
    }),
    /cannot open compressed shared map links/,
  );
});
