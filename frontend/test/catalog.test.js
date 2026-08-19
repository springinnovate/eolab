import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatalogItemDetails,
  buildSubstringFilter,
  CatalogFootprintController,
  CatalogSearchClient,
  CatalogWorkspaceController,
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
          label: "Location",
          value: "file:///data/Model Outputs/grassland_2002.tif",
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
        datetime: "2024-06-15T00:00:00Z",
        title: "<img src=x onerror=alert(1)>",
      },
      assets: {},
    },
    [],
  );

  assert.equal(inspector.title, "<img src=x onerror=alert(1)>");
  assert.equal(inspector.description, null);
  assert.deepEqual(inspector.metadata, [
    { label: "Item ID", value: "minimal-item" },
    { label: "Collection", value: "sample" },
    { label: "Item datetime", value: "2024-06-15T00:00:00Z" },
  ]);
  assert.deepEqual(inspector.assets, []);
});

test("CatalogWorkspaceController expands and returns with Escape", () => {
  const classes = new Set();
  const attributes = new Map();
  let layoutChangeCount = 0;
  let focusCount = 0;
  let prevented = false;
  const appElement = {
    classList: {
      toggle(className, isPresent) {
        if (isPresent) {
          classes.add(className);
        } else {
          classes.delete(className);
        }
      },
    },
  };
  const toggleButton = {
    textContent: "Expand catalog",
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    focus() {
      focusCount += 1;
    },
  };
  const inspectorElement = {
    setAttribute(name, value) {
      attributes.set(`inspector:${name}`, value);
    },
  };
  const workspace = new CatalogWorkspaceController(
    appElement,
    toggleButton,
    inspectorElement,
    () => {
      layoutChangeCount += 1;
    },
  );

  workspace.toggle();

  assert.equal(classes.has("is-catalog-workspace"), true);
  assert.equal(attributes.get("aria-expanded"), "true");
  assert.equal(attributes.get("inspector:aria-hidden"), "false");
  assert.equal(toggleButton.textContent, "Return to map");

  workspace.handleKeyDown({
    key: "Escape",
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(classes.has("is-catalog-workspace"), false);
  assert.equal(attributes.get("aria-expanded"), "false");
  assert.equal(attributes.get("inspector:aria-hidden"), "true");
  assert.equal(toggleButton.textContent, "Expand catalog");
  assert.equal(layoutChangeCount, 2);
  assert.equal(focusCount, 1);
  assert.equal(prevented, true);
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
