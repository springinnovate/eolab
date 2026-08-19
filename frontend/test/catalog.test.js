import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatalogItemDetails,
  buildSubstringFilter,
  CatalogFootprintController,
  CatalogResultStream,
  CatalogSearchClient,
  createDebouncedAction,
  findPaginationLink,
  formatCatalogItemCount,
} from "../src/catalog.js";

const emptyItemCollection = {
  type: "FeatureCollection",
  features: [],
  links: [],
  numberMatched: 0,
};

function itemCollectionResponse(
  itemCollection = emptyItemCollection,
  numberMatchedEstimated = false,
) {
  return new Response(JSON.stringify(itemCollection), {
    status: 200,
    headers: {
      "X-EOLab-Number-Matched-Estimated": String(numberMatchedEstimated),
    },
  });
}

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
      return itemCollectionResponse();
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
    return itemCollectionResponse();
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
      return itemCollectionResponse();
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
    itemCollectionResponse(
      {
        type: "FeatureCollection",
        features: [{ id: "second" }],
        links: [],
        numberMatched: 1,
      },
    ),
  );
  pendingResponses[0].resolve(
    itemCollectionResponse(
      {
        type: "FeatureCollection",
        features: [{ id: "first" }],
        links: [],
        numberMatched: 1,
      },
    ),
  );

  assert.equal(await firstRequest, null);
  assert.equal((await secondRequest).features[0].id, "second");
  assert.equal(pendingResponses[0].options.signal.aborted, true);
});

test("formatCatalogItemCount displays loaded and matched totals", () => {
  const itemCollection = {
    features: Array.from({ length: 20 }),
    numberMatched: 106967,
  };

  assert.equal(
    formatCatalogItemCount(itemCollection, 20, false),
    "Showing 20 of 106,967 Items",
  );
  itemCollection.numberMatchedEstimated = true;
  assert.equal(
    formatCatalogItemCount(itemCollection, 20, false),
    "Showing 20 of 106,967 (est.) Items",
  );
  assert.equal(
    formatCatalogItemCount(
      { features: Array.from({ length: 5 }), numberMatched: 25 },
      25,
      false,
    ),
    "Showing 25 of 25 Items",
  );
});

test("formatCatalogItemCount handles empty, singular, and filtered results", () => {
  assert.equal(formatCatalogItemCount(emptyItemCollection, 0, false), "0 Items");
  assert.equal(
    formatCatalogItemCount({ features: [{}], numberMatched: 1 }, 1, false),
    "Showing 1 of 1 Item",
  );
  assert.equal(
    formatCatalogItemCount({ features: [{}], numberMatched: 1 }, 1, true),
    "Showing 1 of 1 matching Item",
  );
});

test("CatalogSearchClient requires a valid numberMatched", async () => {
  const client = new CatalogSearchClient("/stac", async () => {
    return itemCollectionResponse(
      { type: "FeatureCollection", features: [], links: [] },
    );
  });

  await assert.rejects(
    client.search(""),
    /STAC Item Search response has no valid numberMatched/,
  );
});

test("CatalogSearchClient requires count estimate provenance", async () => {
  const client = new CatalogSearchClient("/stac", async () => {
    return new Response(JSON.stringify(emptyItemCollection), { status: 200 });
  });

  await assert.rejects(
    client.search(""),
    /Catalog response has no count estimate header/,
  );
});

test("findPaginationLink returns standard STAC pagination relations", () => {
  const nextLink = { rel: "next", href: "/next" };
  const previousLink = { rel: "prev", href: "/previous" };
  const document = { links: [nextLink, previousLink] };

  assert.equal(findPaginationLink(document, ["next"]), nextLink);
  assert.equal(findPaginationLink(document, ["prev"]), previousLink);
});

test("CatalogResultStream prevents duplicate next-page requests", async () => {
  let resolveNextPage;
  const followedLinks = [];
  const nextLink = { rel: "next", href: "/next-page" };
  const searchClient = {
    async search() {
      return { ...emptyItemCollection, links: [nextLink], numberMatched: 2 };
    },
    follow(link) {
      followedLinks.push(link);
      return new Promise((resolve) => {
        resolveNextPage = resolve;
      });
    },
  };
  const resultStream = new CatalogResultStream(searchClient);
  await resultStream.restart("");

  const pendingPage = resultStream.loadNextPage();
  assert.equal(await resultStream.loadNextPage(), null);
  assert.deepEqual(followedLinks, [nextLink]);

  resolveNextPage({ ...emptyItemCollection, numberMatched: 2 });
  assert.notEqual(await pendingPage, null);
  assert.equal(resultStream.hasNextPage, false);
  assert.equal(await resultStream.loadNextPage(), null);
  assert.equal(followedLinks.length, 1);
});

test("CatalogResultStream retains a failed page for retry", async () => {
  const followedLinks = [];
  const nextLink = { rel: "next", href: "/retry-page" };
  const searchClient = {
    async search() {
      return { ...emptyItemCollection, links: [nextLink], numberMatched: 1 };
    },
    async follow(link) {
      followedLinks.push(link);
      if (followedLinks.length === 1) {
        throw new Error("temporary failure");
      }
      return { ...emptyItemCollection, numberMatched: 1 };
    },
  };
  const resultStream = new CatalogResultStream(searchClient);
  await resultStream.restart("");

  await assert.rejects(resultStream.loadNextPage(), /temporary failure/);
  assert.equal(resultStream.hasNextPage, true);
  assert.notEqual(await resultStream.loadNextPage(), null);
  assert.deepEqual(followedLinks, [nextLink, nextLink]);
});

test("CatalogResultStream ignores a page from a superseded search", async () => {
  let resolveOldPage;
  const searchClient = {
    async search(searchText) {
      return {
        ...emptyItemCollection,
        links: searchText === "old"
          ? [{ rel: "next", href: "/old-page" }]
          : [],
        numberMatched: searchText === "old" ? 2 : 0,
      };
    },
    follow() {
      return new Promise((resolve) => {
        resolveOldPage = resolve;
      });
    },
  };
  const resultStream = new CatalogResultStream(searchClient);
  await resultStream.restart("old");
  const oldPageRequest = resultStream.loadNextPage();

  await resultStream.restart("new");
  resolveOldPage({ ...emptyItemCollection, numberMatched: 2 });

  assert.equal(await oldPageRequest, null);
  assert.equal(resultStream.hasNextPage, false);
});

test("buildCatalogItemDetails presents scanned GeoTIFF metadata", () => {
  const inspector = buildCatalogItemDetails(
    {
      id: "stable-item-id",
      collection: "eolab-mounted-geotiffs",
      bbox: [-123, 48.8, -122.7, 49],
      geometry: { type: "Polygon", coordinates: [] },
      properties: {
        datetime: "2025-02-11T17:31:52Z",
        title: "Model Outputs/grassland_2002.tif",
        description: "Item datetime uses the filesystem modification time.",
        "proj:epsg": 4326,
        "proj:shape": [2, 3],
      },
      assets: {
        data: {
          href: "file:///data/Model Outputs/grassland_2002.tif",
          type: "image/tiff; application=geotiff",
          title: "Model Outputs/grassland_2002.tif",
          roles: ["data"],
          updated: "2025-02-11T17:31:52Z",
          "raster:bands": [{ data_type: "uint8", nodata: 0 }],
        },
      },
    },
    [{ id: "eolab-mounted-geotiffs", title: "Mounted GeoTIFFs" }],
    "bigboi -- Z:\\bigbucket",
  );

  assert.equal(inspector.title, "Model Outputs/grassland_2002.tif");
  assert.equal(
    inspector.description,
    "Item datetime uses the filesystem modification time.",
  );
  assert.deepEqual(inspector.metadata, [
    { label: "Item ID", value: "stable-item-id" },
    {
      label: "Collection",
      value: "Mounted GeoTIFFs (eolab-mounted-geotiffs)",
    },
    { label: "Item datetime", value: "2025-02-11T17:31:52Z" },
    { label: "Geometry", value: "Polygon" },
    { label: "Bounding box", value: "-123, 48.8, -122.7, 49" },
    { label: "Coordinate reference system", value: "EPSG:4326" },
    { label: "Raster dimensions", value: "3 × 2 pixels" },
  ]);
  assert.deepEqual(inspector.assets, [
    {
      key: "data",
      title: "Model Outputs/grassland_2002.tif",
      metadata: [
        {
          label: "Original location",
          value: "bigboi -- Z:\\bigbucket\\Model Outputs\\grassland_2002.tif",
        },
        { label: "Media type", value: "image/tiff; application=geotiff" },
        { label: "Roles", value: "data" },
        { label: "File modified", value: "2025-02-11T17:31:52Z" },
      ],
      bands: [
        {
          title: "Band 1",
          metadata: [
            { label: "Data type", value: "uint8" },
            { label: "Nodata", value: "0" },
          ],
        },
      ],
    },
  ]);
});

test("buildCatalogItemDetails omits unavailable optional metadata", () => {
  const inspector = buildCatalogItemDetails(
    {
      id: "minimal-item",
      collection: "sample",
      geometry: null,
      properties: {
        datetime: null,
        start_datetime: "2024-06-15T00:00:00Z",
        end_datetime: "2024-06-16T00:00:00Z",
        title: "<img src=x onerror=alert(1)>",
      },
      assets: {},
    },
    [],
    "/shared/bigbucket",
  );

  assert.equal(inspector.title, "<img src=x onerror=alert(1)>");
  assert.equal(inspector.description, null);
  assert.deepEqual(inspector.metadata, [
    { label: "Item ID", value: "minimal-item" },
    { label: "Collection", value: "sample" },
    {
      label: "Item datetime range",
      value: "2024-06-15T00:00:00Z – 2024-06-16T00:00:00Z",
    },
  ]);
  assert.deepEqual(inspector.assets, []);
});

test("buildCatalogItemDetails preserves non-file Asset locations", () => {
  const inspector = buildCatalogItemDetails(
    {
      id: "remote-item",
      collection: "sample",
      geometry: null,
      properties: { datetime: "2025-01-01T00:00:00Z" },
      assets: {
        data: { href: "https://example.test/data.tif" },
      },
    },
    [],
    "bigboi -- Z:\\bigbucket",
  );

  assert.deepEqual(inspector.assets[0].metadata, [
    { label: "Location", value: "https://example.test/data.tif" },
  ]);
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
