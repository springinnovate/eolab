import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSubstringFilter,
  CatalogFootprintController,
  CatalogSearchClient,
  createDebouncedAction,
  findPaginationLink,
} from "../src/catalog.js";

test("buildSubstringFilter preserves literal filename text", () => {
  assert.deepEqual(buildSubstringFilter(" Grassland_2004%\\ABC "), {
    op: "or",
    args: ["title", "description"].map((propertyName) => ({
      op: "like",
      args: [
        { op: "casei", args: [{ property: propertyName }] },
        { op: "casei", args: ["%Grassland\\_2004\\%\\\\ABC%"] },
      ],
    })),
  });
  assert.equal(buildSubstringFilter("   "), null);
});

test("CatalogSearchClient sends a standard STAC CQL2 substring search", async () => {
  let capturedRequest;
  const client = new CatalogSearchClient(
    "/stac",
    async (url, options) => {
      capturedRequest = { url, options };
      return new Response(
        JSON.stringify({ type: "FeatureCollection", features: [], links: [] }),
        { status: 200 },
      );
    },
  );

  await client.search("2004");

  assert.equal(capturedRequest.url, "/stac/search");
  assert.equal(capturedRequest.options.method, "POST");
  assert.deepEqual(JSON.parse(capturedRequest.options.body), {
    limit: 20,
    "filter-lang": "cql2-json",
    filter: {
      op: "or",
      args: ["title", "description"].map((propertyName) => ({
        op: "like",
        args: [
          { op: "casei", args: [{ property: propertyName }] },
          { op: "casei", args: ["%2004%"] },
        ],
      })),
    },
  });
});

test("CatalogSearchClient invokes fetch with the global receiver", async () => {
  let invocationReceiver;
  async function receiverSensitiveFetch() {
    invocationReceiver = this;
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    return new Response(
      JSON.stringify({ type: "FeatureCollection", features: [], links: [] }),
      { status: 200 },
    );
  }
  const client = new CatalogSearchClient("/stac", receiverSensitiveFetch);

  await client.search("");

  assert.equal(invocationReceiver, globalThis);
});

test("CatalogSearchClient follows the provider pagination contract", async () => {
  let capturedRequest;
  const client = new CatalogSearchClient(
    "/stac",
    async (url, options) => {
      capturedRequest = { url, options };
      return new Response(
        JSON.stringify({ type: "FeatureCollection", features: [], links: [] }),
        { status: 200 },
      );
    },
  );

  await client.follow({
    rel: "next",
    href: "/stac/search",
    method: "POST",
    headers: { "Search-Context": "catalog" },
    body: {
      limit: 20,
      filter: { op: "like", args: [{ property: "title" }, "%2004%"] },
      token: "next:item-20",
    },
  });

  assert.equal(capturedRequest.url, "/stac/search");
  assert.equal(capturedRequest.options.headers.get("Search-Context"), "catalog");
  assert.deepEqual(JSON.parse(capturedRequest.options.body), {
    limit: 20,
    filter: { op: "like", args: [{ property: "title" }, "%2004%"] },
    token: "next:item-20",
  });
});

test("CatalogSearchClient ignores a superseded response", async () => {
  const pendingResponses = [];
  const client = new CatalogSearchClient("/stac", (url, options) => {
    return new Promise((resolve) => {
      pendingResponses.push({ url, options, resolve });
    });
  });

  const firstRequest = client.search("first");
  const secondRequest = client.search("second");
  pendingResponses[1].resolve(
    new Response(
      JSON.stringify({
        type: "FeatureCollection",
        features: [{ id: "second" }],
        links: [],
      }),
      { status: 200 },
    ),
  );
  pendingResponses[0].resolve(
    new Response(
      JSON.stringify({
        type: "FeatureCollection",
        features: [{ id: "first" }],
        links: [],
      }),
      { status: 200 },
    ),
  );

  assert.equal(await firstRequest, null);
  assert.equal((await secondRequest).features[0].id, "second");
  assert.equal(pendingResponses[0].options.signal.aborted, true);
});

test("findPaginationLink returns standard STAC pagination relations", () => {
  const nextLink = { rel: "next", href: "/next" };
  const previousLink = { rel: "prev", href: "/previous" };
  const document = { links: [nextLink, previousLink] };

  assert.equal(findPaginationLink(document, ["next"]), nextLink);
  assert.equal(findPaginationLink(document, ["prev"]), previousLink);
});

test("createDebouncedAction runs only the latest scheduled action", () => {
  const scheduledActions = new Map();
  const clearedIdentifiers = [];
  let nextIdentifier = 1;
  const calls = [];
  const timer = {
    setTimeout(action) {
      const identifier = nextIdentifier++;
      scheduledActions.set(identifier, action);
      return identifier;
    },
    clearTimeout(identifier) {
      clearedIdentifiers.push(identifier);
      scheduledActions.delete(identifier);
    },
  };
  const debouncedAction = createDebouncedAction(
    (value) => calls.push(value),
    300,
    timer,
  );

  debouncedAction("first");
  debouncedAction("second");
  scheduledActions.get(2)();

  assert.deepEqual(clearedIdentifiers, [1]);
  assert.deepEqual(calls, ["second"]);
});

test("CatalogFootprintController distinguishes selection and preview", () => {
  const removedLayers = [];
  const fitBoundsCalls = [];
  const map = {
    removeLayer(layer) {
      removedLayers.push(layer);
    },
    fitBounds(bounds, options) {
      fitBoundsCalls.push({ bounds, options });
    },
  };
  const layers = [];
  const layerFactory = (item, state) => {
    const paddedBounds = { item: item.id, padded: true };
    const layer = {
      item,
      state,
      addTo(receivedMap) {
        assert.equal(receivedMap, map);
        return this;
      },
      getBounds() {
        return {
          isValid: () => true,
          pad: () => paddedBounds,
        };
      },
    };
    layers.push(layer);
    return layer;
  };
  const controller = new CatalogFootprintController(map, layerFactory);
  const selectedItem = { id: "selected", collection: "catalog" };
  const previewItem = { id: "preview", collection: "catalog" };

  controller.select(selectedItem);
  controller.preview(previewItem);
  controller.clearPreview();
  controller.preview(selectedItem);

  assert.deepEqual(
    layers.map((layer) => layer.state),
    ["selected", "preview"],
  );
  assert.deepEqual(removedLayers, [layers[1]]);
  assert.deepEqual(fitBoundsCalls, [
    {
      bounds: { item: "selected", padded: true },
      options: { maxZoom: 9 },
    },
  ]);

  controller.clear();
  assert.deepEqual(removedLayers, [layers[1], layers[0]]);
});
