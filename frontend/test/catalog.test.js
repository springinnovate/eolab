import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatalogItemDetails,
  buildCatalogFilter,
  buildSubstringFilter,
  CatalogFootprintController,
  CatalogResultStream,
  CatalogSearchClient,
  CatalogSearchSyntaxError,
  createDebouncedAction,
  findPaginationLink,
  formatCatalogItemCount,
  formatScanTiming,
  formatScanStatusSummary,
  getRasterVisualization,
} from "../src/catalog.js";

const emptyItemCollection = {
  type: "FeatureCollection",
  features: [],
  links: [],
  numberMatched: 0,
};
const expectedSubstringProperties = [
  "title",
  "description",
  "eolab_datetime_text",
  "eolab_end_datetime_text",
];
const cogMediaType =
  "image/tiff; application=geotiff; profile=cloud-optimized";

function expectedSubstringFilter(searchText) {
  return {
    op: "or",
    args: expectedSubstringProperties.map((propertyName) => ({
      op: "like",
      args: [
        { op: "casei", args: [{ property: propertyName }] },
        { op: "casei", args: [`%${searchText}%`] },
      ],
    })),
  };
}

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

test("buildSubstringFilter preserves literal filename and date text", () => {
  assert.deepEqual(buildSubstringFilter(" Grassland_2004%\\ABC "), {
    op: "or",
    args: expectedSubstringProperties.map((propertyName) => ({
      op: "like",
      args: [
        { op: "casei", args: [{ property: propertyName }] },
        { op: "casei", args: ["%Grassland\\_2004\\%\\\\ABC%"] },
      ],
    })),
  });
  assert.equal(buildSubstringFilter("   "), null);
});

test("buildSubstringFilter treats partial and invalid dates as literal text", () => {
  const partialDateFilter = buildSubstringFilter(" 2025-01 ");
  const invalidDateFilter = buildSubstringFilter("2025-13");

  assert.deepEqual(
    partialDateFilter.args.map((comparison) => comparison.args[1]),
    Array(expectedSubstringProperties.length).fill({
      op: "casei",
      args: ["%2025-01%"],
    }),
  );
  assert.deepEqual(
    invalidDateFilter.args.map((comparison) => comparison.args[1]),
    Array(expectedSubstringProperties.length).fill({
      op: "casei",
      args: ["%2025-13%"],
    }),
  );
});

test("buildCatalogFilter combines literal text and COG metadata", () => {
  const combinedFilter = {
    op: "and",
    args: [
      expectedSubstringFilter("barley"),
      {
        op: "=",
        args: [
          { property: "assets.data.type" },
          cogMediaType,
        ],
      },
    ],
  };
  assert.deepEqual(buildCatalogFilter(" barley FORMAT:COG "), combinedFilter);
  assert.deepEqual(buildCatalogFilter("format:cog barley"), combinedFilter);
  assert.deepEqual(buildCatalogFilter("format:cog"), {
    op: "=",
    args: [
      { property: "assets.data.type" },
      cogMediaType,
    ],
  });
  assert.deepEqual(
    buildCatalogFilter("my_cog_filename.tif"),
    expectedSubstringFilter("my\\_cog\\_filename.tif"),
  );
  assert.deepEqual(
    buildCatalogFilter("2025-01-01T12:30"),
    expectedSubstringFilter("2025-01-01T12:30"),
  );
  assert.deepEqual(
    buildCatalogFilter("Z:\\bigbucket\\barley.tif"),
    expectedSubstringFilter("Z:\\\\bigbucket\\\\barley.tif"),
  );
  assert.equal(buildCatalogFilter("  "), null);
});

test("buildCatalogFilter rejects syntax outside the field contract", () => {
  const invalidSearches = [
    "format:",
    "format:geotiff",
    "format:cog format:cog",
    "datatype:cog",
    "collection:rasters",
    "barley & format:cog",
  ];
  for (const invalidSearch of invalidSearches) {
    assert.throws(
      () => buildCatalogFilter(invalidSearch),
      CatalogSearchSyntaxError,
    );
  }
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
      args: expectedSubstringProperties.map((propertyName) => ({
        op: "like",
        args: [
          { op: "casei", args: [{ property: propertyName }] },
          { op: "casei", args: ["%2004%"] },
        ],
      })),
    },
  });
});

test("CatalogSearchClient sends the parsed COG filter", async () => {
  let capturedRequest;
  const client = new CatalogSearchClient("/stac", async (url, options) => {
    capturedRequest = { url, options };
    return itemCollectionResponse();
  });

  await client.search("barley format:cog");

  assert.equal(capturedRequest.url, "/stac/search");
  assert.deepEqual(JSON.parse(capturedRequest.options.body).filter, {
    op: "and",
    args: [
      expectedSubstringFilter("barley"),
      {
        op: "=",
        args: [
          { property: "assets.data.type" },
          cogMediaType,
        ],
      },
    ],
  });
});

test("CatalogSearchClient rejects invalid syntax without a request", () => {
  let requestCount = 0;
  const client = new CatalogSearchClient("/stac", async () => {
    requestCount += 1;
    return itemCollectionResponse();
  });

  assert.throws(
    () => client.search("format:geotiff"),
    CatalogSearchSyntaxError,
  );
  assert.equal(requestCount, 0);
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

test("formatCatalogItemCount displays exact and estimated totals", () => {
  const itemCollection = {
    features: Array.from({ length: 20 }),
    numberMatched: 106967,
  };

  assert.equal(
    formatCatalogItemCount(itemCollection, false),
    "106,967 Items",
  );
  itemCollection.numberMatchedEstimated = true;
  assert.equal(
    formatCatalogItemCount(itemCollection, false),
    "106,967 (est.) Items",
  );
});

test("formatCatalogItemCount handles empty, singular, and filtered results", () => {
  assert.equal(formatCatalogItemCount(emptyItemCollection, false), "0 Items");
  assert.equal(
    formatCatalogItemCount({ features: [{}], numberMatched: 1 }, false),
    "1 Item",
  );
  assert.equal(
    formatCatalogItemCount({ features: [{}], numberMatched: 1 }, true),
    "1 matching Item",
  );
  assert.equal(
    formatCatalogItemCount({ features: [], numberMatched: 534 }, true),
    "534 matching Items",
  );
});

test("formatScanStatusSummary distinguishes scan and dataset failures", () => {
  assert.equal(
    formatScanStatusSummary({ state: "not_started", failed: 0 }),
    "Scan status: Not started",
  );
  assert.equal(
    formatScanStatusSummary({ state: "discovering", failed: 0 }),
    "Scan status: In progress",
  );
  assert.equal(
    formatScanStatusSummary({ state: "scanning", failed: 12 }),
    "Scan status: In progress",
  );
  assert.equal(
    formatScanStatusSummary({ state: "completed", failed: 0 }),
    "Scan status: Complete",
  );
  assert.equal(
    formatScanStatusSummary({ state: "completed", failed: 1 }),
    "Scan status: Complete · 1 dataset error",
  );
  assert.equal(
    formatScanStatusSummary({ state: "completed", failed: 2487 }),
    "Scan status: Complete · 2,487 dataset errors",
  );
  assert.equal(
    formatScanStatusSummary({ state: "failed", failed: 0 }),
    "Scan status: Failed",
  );
  assert.throws(
    () => formatScanStatusSummary({ state: "complete", failed: 0 }),
    /Unknown scan state: complete/,
  );
});

test("formatScanTiming distinguishes wall and cumulative worker clocks", () => {
  assert.deepEqual(
    formatScanTiming(
      {
        elapsedSeconds: 3723.4,
        catalogInventorySeconds: 0.023,
        discoverySeconds: 62,
        metadataResultWaitSeconds: 59.6,
        metadataWorkerSeconds: 10800,
        metadataIoWaitSeconds: 9000,
        metadataProcessingSeconds: 1800,
        catalogWriteSeconds: 4.25,
        cacheInvalidationSeconds: 0,
      },
      32,
      2,
      100,
    ),
    [
      { label: "Elapsed wall time", value: "1h 2m 3s" },
      { label: "Catalog inventory", value: "23 ms" },
      { label: "Dataset discovery", value: "1m 2s" },
      { label: "Waiting for metadata results", value: "59.6 s" },
      { label: "Metadata workers (32, cumulative)", value: "3h 0m 0s" },
      {
        label: "Metadata I/O wait (estimated, cumulative)",
        value: "2h 30m 0s",
      },
      {
        label: "Metadata processing CPU (cumulative)",
        value: "30m 0s",
      },
      {
        label: "Catalog writes (2 writers, 100 Items/batch, cumulative)",
        value: "4.3 s",
      },
      { label: "Search-count refresh", value: "0 ms" },
    ],
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

test("CatalogResultStream keeps one provider page ready", async () => {
  let resolvePrefetch;
  const followedLinks = [];
  const secondPageLink = { rel: "next", href: "/second-page" };
  const thirdPageLink = { rel: "next", href: "/third-page" };
  const secondPage = {
    ...emptyItemCollection,
    links: [thirdPageLink],
    numberMatched: 60,
  };
  const searchClient = {
    async search() {
      return {
        ...emptyItemCollection,
        links: [secondPageLink],
        numberMatched: 60,
      };
    },
    follow(link) {
      followedLinks.push(link);
      return new Promise((resolve) => {
        resolvePrefetch = resolve;
      });
    },
  };
  const resultStream = new CatalogResultStream(searchClient);
  await resultStream.restart("");

  const firstPrefetch = resultStream.prefetchNextPage();
  const sharedPrefetch = resultStream.prefetchNextPage();
  resolvePrefetch(secondPage);

  assert.equal(await firstPrefetch, secondPage);
  assert.equal(await sharedPrefetch, secondPage);
  assert.equal(await resultStream.loadNextPage(), secondPage);
  assert.deepEqual(followedLinks, [secondPageLink]);
  assert.equal(resultStream.hasNextPage, true);
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
  const renderingMetadata = {
    policy: "raster-v2",
    eligible: true,
    bounded_blocks: true,
    block_shapes: [[256, 256]],
    overview_factors: [[2, 4]],
    overview_storage: "internal",
    compression: "DEFLATE",
    estimated_uncompressed_bytes: 12 * 1024 * 1024,
  };
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
          type: "image/tiff; application=geotiff; profile=cloud-optimized",
          title: "Model Outputs/grassland_2002.tif",
          roles: ["data"],
          updated: "2025-02-11T17:31:52Z",
          "file:size": 2048,
          "raster:bands": [{ data_type: "uint8", nodata: 0 }],
          "eolab:rendering": renderingMetadata,
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
    { label: "Dataset type", value: "Raster" },
    { label: "Item datetime", value: "2025-02-11T17:31:52Z" },
    { label: "Footprint geometry", value: "Polygon" },
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
        {
          label: "Media type",
          value: "image/tiff; application=geotiff; profile=cloud-optimized",
        },
        { label: "Roles", value: "data" },
        { label: "File modified", value: "2025-02-11T17:31:52Z" },
        { label: "File size", value: "2 KiB" },
        { label: "Storage profile", value: "Cloud Optimized GeoTIFF" },
        { label: "Block shapes", value: "256 × 256 pixels" },
        { label: "Overview storage", value: "Internal" },
        { label: "Overview factors", value: "Band 1: 2×, 4×" },
        { label: "Compression", value: "DEFLATE" },
        {
          label: "Estimated full-resolution pixel data",
          value: "12 MiB",
        },
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
  assert.deepEqual(inspector.fields, []);
});

test("getRasterVisualization distinguishes unassessed and non-raster Items", () => {
  const legacyRaster = {
    collection: "eolab-mounted-geotiffs",
    assets: { data: {} },
  };

  assert.equal(getRasterVisualization(legacyRaster), undefined);
  assert.equal(
    getRasterVisualization({
      collection: "eolab-mounted-geotiffs",
      assets: {
        data: {
          "eolab:rendering": { policy: "raster-v1", eligible: false },
        },
      },
    }),
    undefined,
  );
  assert.equal(
    getRasterVisualization({
      collection: "eolab-mounted-vectors",
      assets: {},
    }),
    null,
  );
});

test("getRasterVisualization returns the scanner decision", () => {
  const renderingMetadata = {
    policy: "raster-v2",
    eligible: false,
    reason:
      "Visualization unavailable: this raster needs smaller internal blocks.",
  };

  assert.equal(
    getRasterVisualization({
      collection: "eolab-mounted-geotiffs",
      assets: { data: { "eolab:rendering": renderingMetadata } },
    }),
    renderingMetadata,
  );
});

test("buildCatalogItemDetails presents mounted Shapefile metadata", () => {
  const inspector = buildCatalogItemDetails(
    {
      id: "shapefile-stable-id",
      collection: "eolab-mounted-vectors",
      bbox: [-123, 48, -122, 49],
      geometry: { type: "Polygon", coordinates: [] },
      properties: {
        datetime: "2025-04-03T12:30:00Z",
        title: "Vectors/habitat.shp",
        description: "Item datetime uses the latest component modification time.",
        "proj:epsg": 3857,
        "table:row_count": 12345,
        "table:columns": [
          { name: "geometry", type: "Polygon" },
          { name: "habitat", type: "str:80" },
          { name: "rank", type: "int:18" },
        ],
        "table:primary_geometry": "geometry",
      },
      assets: {
        shp: {
          href: "file:///scan-source/Vectors/habitat.shp",
          type: "application/vnd.shp",
          title: "Vectors/habitat.shp",
          roles: ["data"],
          updated: "2025-04-03T12:30:00Z",
        },
        dbf: {
          href: "file:///scan-source/Vectors/habitat.dbf",
          type: "application/vnd.dbf",
          title: "Vectors/habitat.dbf",
          roles: ["data"],
        },
      },
    },
    [{ id: "eolab-mounted-vectors", title: "Mounted vector datasets" }],
    "bigboi -- Z:\\bigbucket",
  );

  assert.deepEqual(inspector.metadata, [
    { label: "Item ID", value: "shapefile-stable-id" },
    {
      label: "Collection",
      value: "Mounted vector datasets (eolab-mounted-vectors)",
    },
    { label: "Dataset type", value: "Vector" },
    { label: "Item datetime", value: "2025-04-03T12:30:00Z" },
    { label: "Footprint geometry", value: "Polygon" },
    { label: "Bounding box", value: "-123, 48, -122, 49" },
    { label: "Coordinate reference system", value: "EPSG:3857" },
    { label: "Feature count", value: "12,345" },
    { label: "Declared feature geometry type", value: "Polygon" },
  ]);
  assert.deepEqual(inspector.fields, [
    { label: "habitat", value: "str:80" },
    { label: "rank", value: "int:18" },
  ]);
  assert.deepEqual(
    inspector.assets.map((asset) => ({
      key: asset.key,
      location: asset.metadata[0],
      bands: asset.bands,
    })),
    [
      {
        key: "shp",
        location: {
          label: "Original location",
          value: "bigboi -- Z:\\bigbucket\\Vectors\\habitat.shp",
        },
        bands: [],
      },
      {
        key: "dbf",
        location: {
          label: "Original location",
          value: "bigboi -- Z:\\bigbucket\\Vectors\\habitat.dbf",
        },
        bands: [],
      },
    ],
  );
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
  assert.deepEqual(inspector.fields, []);
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

test("buildCatalogItemDetails classifies only known mounted Collections", () => {
  const inspector = buildCatalogItemDetails(
    {
      id: "external-item",
      collection: "constructor",
      geometry: null,
      properties: { datetime: "2025-01-01T00:00:00Z" },
      assets: { data: { href: "file:///external/data.tif" } },
    },
    [],
    "bigboi -- Z:\\bigbucket",
  );

  assert.equal(
    inspector.metadata.some(({ label }) => label === "Dataset type"),
    false,
  );
  assert.deepEqual(inspector.assets[0].metadata, [
    { label: "Location", value: "file:///external/data.tif" },
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
