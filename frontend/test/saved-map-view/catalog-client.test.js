import assert from "node:assert/strict";
import test from "node:test";

import { SavedMapViewCatalogClient } from "../../src/saved-map-view/catalog-client.js";

test("saved map Catalog client resolves one exact encoded STAC identity", async () => {
  const requests = [];
  const item = { collection: "risk layers", id: "wind/yearly" };
  const client = new SavedMapViewCatalogClient(
    "https://example.test/stac/",
    async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => item };
    },
  );

  assert.equal(await client.get(item), item);
  assert.equal(
    requests[0].url,
    "https://example.test/stac/collections/risk%20layers/items/wind%2Fyearly",
  );
  assert.deepEqual(requests[0].options.headers, {
    Accept: "application/geo+json",
  });
});

test("saved map Catalog client rejects missing and substituted Items", async () => {
  const identity = { collection: "vectors", id: "roads" };
  const missing = new SavedMapViewCatalogClient(
    "/stac",
    async () => ({ ok: false, status: 404 }),
  );
  await assert.rejects(() => missing.get(identity), /no longer available/);

  const substituted = new SavedMapViewCatalogClient(
    "/stac",
    async () => ({
      ok: true,
      json: async () => ({ collection: "vectors", id: "buildings" }),
    }),
  );
  await assert.rejects(() => substituted.get(identity), /different Item/);
});
