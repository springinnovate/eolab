import assert from "node:assert/strict";
import test from "node:test";

import {
  assessCatalogRaster,
  loadCatalogRasterDetailStatistics,
  loadCatalogRasterStatistics,
  loadCatalogRasterDetailPreview,
  publishCatalogRaster,
  RenderingRequestError,
  sampleCatalogRasterDetailPixel,
  sampleCatalogRasterPixel,
  validateRasterDetailPreview,
} from "../../src/raster/api.js";
import {
  MOUNTED_GEOTIFF_ITEM,
  CENTER_SAMPLE_DETAIL_PREVIEW,
  CURRENT_VIEW_DETAIL_PREVIEW,
  EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
  NODATA_DETAIL_PREVIEW,
  PATCH_DETAIL_PREVIEW,
  RASTER_DETAIL_PREVIEW_LIMITS,
  RASTER_STATISTICS,
  SELECTED_BOUNDS,
  SELECTED_RASTER_STATISTICS,
  TEMPORARY_AOI_ID,
  TEMPORARY_AOI_RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

test("detail preview sends only identity, fixed mode, and density", async () => {
  const requests = [];
  const abortController = new AbortController();

  assert.deepEqual(
    await loadCatalogRasterDetailPreview(
      MOUNTED_GEOTIFF_ITEM,
      { mode: "centerSample", density: "coarse" },
      abortController.signal,
      async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify(CENTER_SAMPLE_DETAIL_PREVIEW), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    ),
    CENTER_SAMPLE_DETAIL_PREVIEW,
  );
  assert.deepEqual(requests, [{
    url: "/api/rendering/detail-previews",
    options: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        collectionId: MOUNTED_GEOTIFF_ITEM.collection,
        itemId: MOUNTED_GEOTIFF_ITEM.id,
        mode: "centerSample",
        density: "coarse",
      }),
      signal: abortController.signal,
    },
  }]);
  assert.equal("width" in JSON.parse(requests[0].options.body), false);
  assert.equal("bounds" in JSON.parse(requests[0].options.body), false);
  assert.equal("path" in JSON.parse(requests[0].options.body), false);
});

test("detail preview preserves an actionable backend failure", async () => {
  const request = loadCatalogRasterDetailPreview(
    MOUNTED_GEOTIFF_ITEM,
    { mode: "centerSample", density: "coarse" },
    new AbortController().signal,
    async () => new Response(
      JSON.stringify({ detail: "Sampled raster source blocks are unsafe." }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ),
  );

  await assert.rejects(request, (error) => {
    assert.equal(error instanceof RenderingRequestError, true);
    assert.equal(error.status, 409);
    assert.equal(error.message, "Sampled raster source blocks are unsafe.");
    return true;
  });
});

test("detail preview sends one canonical current-view rectangle", async () => {
  const viewBounds = { west: -122.5, south: 48.5, east: -121.5, north: 49.5 };
  let requestBody = null;
  const preview = await loadCatalogRasterDetailPreview(
    MOUNTED_GEOTIFF_ITEM,
    { mode: "centerSample", density: "coarse", viewBounds },
    new AbortController().signal,
    async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify(CURRENT_VIEW_DETAIL_PREVIEW), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.equal(preview.scope, "currentView");
  assert.deepEqual(requestBody, {
    collectionId: MOUNTED_GEOTIFF_ITEM.collection,
    itemId: MOUNTED_GEOTIFF_ITEM.id,
    mode: "centerSample",
    density: "coarse",
    viewBounds,
  });
  assert.equal("width" in requestBody, false);
  assert.equal("path" in requestBody, false);
});

test("detail preview rejects extra request and view-bound fields", async () => {
  let requestCount = 0;
  const fetchImplementation = async () => {
    requestCount += 1;
    throw new Error("request should not be sent");
  };
  const requestCases = [
    {
      mode: "centerSample",
      density: "coarse",
      width: 31,
    },
    {
      mode: "centerSample",
      density: "coarse",
      viewBounds: {
        west: -122.5,
        south: 48.5,
        east: -121.5,
        north: 49.5,
        path: "file:///untrusted.tif",
      },
    },
  ];

  for (const options of requestCases) {
    await assert.rejects(
      loadCatalogRasterDetailPreview(
        MOUNTED_GEOTIFF_ITEM,
        options,
        new AbortController().signal,
        fetchImplementation,
      ),
      /unsupported fields|view bounds are invalid/,
    );
  }
  assert.equal(requestCount, 0);
});

test("detail preview accepts numeric images and honest all-nodata proxies", () => {
  assert.equal(
    validateRasterDetailPreview(
      CENTER_SAMPLE_DETAIL_PREVIEW,
      { mode: "centerSample", density: "coarse" },
    ),
    CENTER_SAMPLE_DETAIL_PREVIEW,
  );
  assert.equal(
    validateRasterDetailPreview(
      NODATA_DETAIL_PREVIEW,
      { mode: "centerSample", density: "coarse" },
    ),
    NODATA_DETAIL_PREVIEW,
  );
  assert.equal(
    validateRasterDetailPreview(
      PATCH_DETAIL_PREVIEW,
      { mode: "representativePatch" },
    ),
    PATCH_DETAIL_PREVIEW,
  );
});

test("fine density puts exactly 127 cells on the viewport's longest edge", () => {
  const finePreview = {
    ...CENTER_SAMPLE_DETAIL_PREVIEW,
    density: "fine",
    imageWidth: 127,
    imageHeight: 64,
    pixelValues: new Array(127 * 64).fill(1),
    actual: {
      ...CENTER_SAMPLE_DETAIL_PREVIEW.actual,
      sampleGridWidth: 127,
      sampleGridHeight: 64,
    },
  };
  assert.equal(
    validateRasterDetailPreview(
      finePreview,
      { mode: "centerSample", density: "fine" },
    ),
    finePreview,
  );

  assert.throws(
    () => validateRasterDetailPreview({
      ...finePreview,
      imageWidth: 15,
      imageHeight: 7,
      pixelValues: new Array(15 * 7).fill(1),
      actual: {
        ...finePreview.actual,
        sampleGridWidth: 15,
        sampleGridHeight: 7,
      },
    }, { mode: "centerSample", density: "fine" }),
    /exceeds its fixed limit/,
  );
});

test("detail preview rejects arbitrary modes before sending a request", async () => {
  await assert.rejects(
    loadCatalogRasterDetailPreview(
      MOUNTED_GEOTIFF_ITEM,
      { mode: "fullExtent", density: "coarse" },
      new AbortController().signal,
      async () => {
        throw new Error("request should not be sent");
      },
    ),
    /Unsupported raster detail preview mode/,
  );
});

test("detail preview strictly validates v6 adaptive identity and shape", () => {
  const invalidPreviews = [
    ["mismatched mode", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      mode: "representativeSample",
    }],
    ["legacy policy", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      policyVersion: "bounded-detail-preview-v1",
    }],
    ["empty label", { ...CENTER_SAMPLE_DETAIL_PREVIEW, label: "" }],
    ["unordered image bounds", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      imageBounds: [-123, 48, -123, 50],
    }],
    ["out-of-world raster extent", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      rasterExtent: [-181, 48, -121, 50],
    }],
    ["out-of-world image bounds", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      imageBounds: [-123, -91, -121, 50],
    }],
    ["zero width", { ...CENTER_SAMPLE_DETAIL_PREVIEW, imageWidth: 0 }],
    ["over-limit width", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      imageWidth: 128,
    }],
    ["short value array", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      pixelValues: [0, 50],
    }],
    ["nonfinite value", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      pixelValues: [0, 50, 100, Number.POSITIVE_INFINITY, 25, 75],
    }],
    ["missing finite-value range", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      suggestedRange: null,
    }],
    ["unordered range", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      suggestedRange: { minimum: 0, midpoint: 100, maximum: 50 },
    }],
    ["changed resource contract", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      limits: {
        ...CENTER_SAMPLE_DETAIL_PREVIEW.limits,
        maximumSourceBlockReads: 16130,
      },
    }],
    ["changed transformed-position contract", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      limits: {
        ...CENTER_SAMPLE_DETAIL_PREVIEW.limits,
        maximumTransformedPositions: 80644,
      },
    }],
    ["over-limit actual block reads", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      actual: {
        ...CENTER_SAMPLE_DETAIL_PREVIEW.actual,
        sourceBlockReadCount: 16130,
      },
    }],
    ["over-limit actual decoded bytes", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      actual: {
        ...CENTER_SAMPLE_DETAIL_PREVIEW.actual,
        decodedSourceBytes: 9663676417,
      },
    }],
    ["negative candidate count", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      actual: {
        ...CENTER_SAMPLE_DETAIL_PREVIEW.actual,
        candidateWindowCount: -1,
      },
    }],
    ["inconsistent center probes", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      actual: {
        ...CENTER_SAMPLE_DETAIL_PREVIEW.actual,
        pointsPerCell: 5,
      },
    }],
  ];

  for (const [caseName, preview] of invalidPreviews) {
    assert.throws(
      () => validateRasterDetailPreview(
        preview,
        { mode: "centerSample", density: "coarse" },
      ),
      /Detail-only preview/,
      `accepted invalid sampled-raster case: ${caseName}`,
    );
  }
  assert.throws(
    () => validateRasterDetailPreview({
      ...PATCH_DETAIL_PREVIEW,
      imageWidth: 129,
      pixelValues: new Array(129 * PATCH_DETAIL_PREVIEW.imageHeight).fill(10),
      actual: {
        ...PATCH_DETAIL_PREVIEW.actual,
        sampleGridWidth: 129,
      },
    }, { mode: "representativePatch" }),
    /exceeds its fixed limit/,
  );
});

test("exact current-view detail requires bounded source-window provenance", () => {
  const request = {
    mode: "centerSample",
    density: "coarse",
    viewBounds: {
      west: -122.5,
      south: 48.5,
      east: -121.5,
      north: 49.5,
    },
  };
  assert.equal(
    validateRasterDetailPreview(EXACT_CURRENT_VIEW_DETAIL_PREVIEW, request),
    EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
  );

  for (const [caseName, preview] of [
    ["missing source window", {
      ...EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
      actual: {
        ...EXACT_CURRENT_VIEW_DETAIL_PREVIEW.actual,
        sourceWindow: null,
      },
    }],
    ["mismatched source width", {
      ...EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
      actual: {
        ...EXACT_CURRENT_VIEW_DETAIL_PREVIEW.actual,
        sourceWindow: {
          ...EXACT_CURRENT_VIEW_DETAIL_PREVIEW.actual.sourceWindow,
          width: 5,
        },
      },
    }],
    ["sampled-proxy resource limit", {
      ...EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
      limits: RASTER_DETAIL_PREVIEW_LIMITS,
    }],
  ]) {
    assert.throws(
      () => validateRasterDetailPreview(preview, request),
      /Detail-only preview/,
      `accepted invalid exact-detail case: ${caseName}`,
    );
  }

  assert.throws(
    () => validateRasterDetailPreview(
      EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
      { mode: "centerSample", density: "coarse" },
    ),
    /Detail-only preview/,
  );
});

test("detail preview requires null color range only for all-nodata images", () => {
  assert.throws(
    () => validateRasterDetailPreview({
      ...NODATA_DETAIL_PREVIEW,
      suggestedRange: { minimum: 0, midpoint: 50, maximum: 100 },
    }, { mode: "centerSample", density: "coarse" }),
    /color range is invalid/,
  );
  assert.throws(
    () => validateRasterDetailPreview({
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      actual: {
        ...CENTER_SAMPLE_DETAIL_PREVIEW.actual,
        sourceBlockReadCount: 0,
        decodedSourceBytes: 0,
      },
    }, { mode: "centerSample", density: "coarse" }),
    /color range is invalid/,
  );
  assert.equal(
    validateRasterDetailPreview({
      ...NODATA_DETAIL_PREVIEW,
      actual: {
        ...NODATA_DETAIL_PREVIEW.actual,
        sourceBlockReadCount: 0,
        decodedSourceBytes: 0,
      },
    }, { mode: "centerSample", density: "coarse" }).suggestedRange,
    null,
  );
});

test("representative patches require positive bounded source reads", () => {
  assert.throws(
    () => validateRasterDetailPreview({
      ...PATCH_DETAIL_PREVIEW,
      pixelValues: new Array(4).fill(null),
      suggestedRange: null,
      actual: {
        ...PATCH_DETAIL_PREVIEW.actual,
        sourceBlockReadCount: 0,
        decodedSourceBytes: 0,
      },
    }, { mode: "representativePatch" }),
    /color range is invalid/,
  );
});

test("every detail image must stay inside its raster and requested view", () => {
  assert.throws(
    () => validateRasterDetailPreview(
      {
        ...CENTER_SAMPLE_DETAIL_PREVIEW,
        imageBounds: [-123.5, 48.5, -121.5, 49.5],
      },
      { mode: "centerSample", density: "coarse" },
    ),
    /placement is invalid/,
  );
  assert.throws(
    () => validateRasterDetailPreview(
      {
        ...PATCH_DETAIL_PREVIEW,
        imageBounds: [-120.9, 48.9, -120.7, 49.1],
      },
      { mode: "representativePatch" },
    ),
    /placement is invalid/,
  );
  assert.throws(
    () => validateRasterDetailPreview(
      {
        ...CURRENT_VIEW_DETAIL_PREVIEW,
        imageBounds: [-123.5, 48.5, -121.5, 49.5],
      },
      {
        mode: "centerSample",
        density: "coarse",
        viewBounds: {
          west: -122.5,
          south: 48.5,
          east: -121.5,
          north: 49.5,
        },
      },
    ),
    /placement is invalid/,
  );
});

test("assessCatalogRaster sends only the STAC Item identity", async () => {
  const requests = [];
  const assessedItem = {
    ...MOUNTED_GEOTIFF_ITEM,
    assets: {
      data: {
        "eolab:rendering": { policy: "raster-v3", eligible: true },
      },
    },
  };

  assert.deepEqual(
    await assessCatalogRaster(MOUNTED_GEOTIFF_ITEM, async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify(assessedItem), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
    assessedItem,
  );
  assert.deepEqual(requests, [
    {
      url: "/api/rendering/assessments",
      options: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          collectionId: "eolab-mounted-geotiffs",
          itemId: "geotiff-0123456789abcdef01234567",
        }),
      },
    },
  ]);
});

test("publishCatalogRaster sends only the STAC Item identity", async () => {
  const requests = [];
  const publishedRaster = await publishCatalogRaster(
    MOUNTED_GEOTIFF_ITEM,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({
          layerName: `eolab:${MOUNTED_GEOTIFF_ITEM.id}`,
          bbox: [-123, 48, -122, 49],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );

  assert.deepEqual(publishedRaster, {
    layerName: `eolab:${MOUNTED_GEOTIFF_ITEM.id}`,
    bbox: [-123, 48, -122, 49],
  });
  assert.deepEqual(requests, [
    {
      url: "/api/rendering/layers",
      options: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          collectionId: "eolab-mounted-geotiffs",
          itemId: "geotiff-0123456789abcdef01234567",
        }),
      },
    },
  ]);
});

test("publishCatalogRaster reports the backend detail", async () => {
  await assert.rejects(
    publishCatalogRaster(
      MOUNTED_GEOTIFF_ITEM,
      async () => new Response(
        JSON.stringify({ detail: "Catalog Item not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    ),
    /Catalog Item not found/,
  );
});

test("publishCatalogRaster preserves an actionable failure category", async () => {
  const publication = publishCatalogRaster(
    MOUNTED_GEOTIFF_ITEM,
    async () => new Response(
      JSON.stringify({
        detail: {
          category: "reader_rejection",
          message: "GeoServer could not read this raster.",
        },
      }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    ),
  );

  await assert.rejects(publication, (error) => {
    assert.equal(error instanceof RenderingRequestError, true);
    assert.equal(error.category, "reader_rejection");
    assert.equal(error.status, 422);
    assert.equal(error.message, "GeoServer could not read this raster.");
    return true;
  });
});

test("loadCatalogRasterStatistics sends only Item identity and validates data", async () => {
  const requests = [];
  const abortController = new AbortController();

  assert.deepEqual(
    await loadCatalogRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      abortController.signal,
      null,
      async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify(RASTER_STATISTICS), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    ),
    RASTER_STATISTICS,
  );
  assert.deepEqual(requests, [
    {
      url: "/api/rendering/statistics",
      options: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          collectionId: "eolab-mounted-geotiffs",
          itemId: "geotiff-0123456789abcdef01234567",
        }),
        signal: abortController.signal,
      },
    },
  ]);
});

test("loadCatalogRasterStatistics adds only validated selected bounds", async () => {
  const requests = [];
  const abortController = new AbortController();

  assert.deepEqual(
    await loadCatalogRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      abortController.signal,
      SELECTED_BOUNDS,
      async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify(SELECTED_RASTER_STATISTICS), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    ),
    SELECTED_RASTER_STATISTICS,
  );
  assert.deepEqual(
    JSON.parse(requests[0].options.body),
    {
      collectionId: "eolab-mounted-geotiffs",
      itemId: "geotiff-0123456789abcdef01234567",
      selectedBounds: SELECTED_BOUNDS,
    },
  );
  assert.equal(requests[0].options.signal, abortController.signal);

  await assert.rejects(
    loadCatalogRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      abortController.signal,
      SELECTED_BOUNDS,
      async () => new Response(JSON.stringify({
        ...SELECTED_RASTER_STATISTICS,
        selectedBounds: { ...SELECTED_BOUNDS, west: -124 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
    /invalid selected-area response bounds/,
  );
});

test("sampled raster histogram requires and sends only selected bounds", async () => {
  const requests = [];
  const abortController = new AbortController();
  const statistics = await loadCatalogRasterDetailStatistics(
    MOUNTED_GEOTIFF_ITEM,
    abortController.signal,
    SELECTED_BOUNDS,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify(SELECTED_RASTER_STATISTICS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.equal(statistics.samplingMethod, "sampledGrid");
  assert.deepEqual(requests, [{
    url: "/api/rendering/detail-statistics",
    options: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        collectionId: MOUNTED_GEOTIFF_ITEM.collection,
        itemId: MOUNTED_GEOTIFF_ITEM.id,
        selectedBounds: SELECTED_BOUNDS,
      }),
      signal: abortController.signal,
    },
  }]);
  await assert.rejects(
    loadCatalogRasterDetailStatistics(
      MOUNTED_GEOTIFF_ITEM,
      abortController.signal,
      null,
      async () => new Response(),
    ),
    /invalid selected bounds/,
  );
});

test("sampled raster histogram preserves bounded errors and response identity", async () => {
  await assert.rejects(
    loadCatalogRasterDetailStatistics(
      MOUNTED_GEOTIFF_ITEM,
      new AbortController().signal,
      SELECTED_BOUNDS,
      async () => new Response(
        JSON.stringify({ detail: "No finite, non-nodata points were found." }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    ),
    /No finite, non-nodata/,
  );
  await assert.rejects(
    loadCatalogRasterDetailStatistics(
      MOUNTED_GEOTIFF_ITEM,
      new AbortController().signal,
      SELECTED_BOUNDS,
      async () => new Response(JSON.stringify({
        ...SELECTED_RASTER_STATISTICS,
        selectedBounds: { ...SELECTED_BOUNDS, east: -120 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
    /invalid selected-area response bounds/,
  );
});

test("loadCatalogRasterStatistics sends only one opaque temporary AOI identity", async () => {
  const requests = [];
  const abortController = new AbortController();

  const statistics = await loadCatalogRasterStatistics(
    MOUNTED_GEOTIFF_ITEM,
    abortController.signal,
    null,
    TEMPORARY_AOI_ID,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify(TEMPORARY_AOI_RASTER_STATISTICS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.equal(statistics.temporaryAoiId, TEMPORARY_AOI_ID);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    collectionId: "eolab-mounted-geotiffs",
    itemId: "geotiff-0123456789abcdef01234567",
    temporaryAoiId: TEMPORARY_AOI_ID,
  });
  assert.equal("geometry" in JSON.parse(requests[0].options.body), false);
  await assert.rejects(
    loadCatalogRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      abortController.signal,
      SELECTED_BOUNDS,
      TEMPORARY_AOI_ID,
      async () => new Response(),
    ),
    /mutually exclusive/,
  );
});

test("loadCatalogRasterStatistics reports backend and response errors", async () => {
  await assert.rejects(
    loadCatalogRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      new AbortController().signal,
      null,
      async () => new Response(
        JSON.stringify({ detail: "No valid sampled pixels were found" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    ),
    /No valid sampled pixels/,
  );
  for (const errorResponse of [
    new Response("upstream unavailable", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    }),
    new Response(JSON.stringify({ detail: [{ type: "missing" }] }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    }),
  ]) {
    await assert.rejects(
      loadCatalogRasterStatistics(
        MOUNTED_GEOTIFF_ITEM,
        new AbortController().signal,
        null,
        async () => errorResponse,
      ),
      new RegExp(
        `Raster statistics request failed \\(${errorResponse.status}\\)`,
      ),
    );
  }
  await assert.rejects(
    loadCatalogRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      new AbortController().signal,
      null,
      async () => new Response(JSON.stringify({
        ...RASTER_STATISTICS,
        band: 2,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
    /invalid band identity/,
  );
});

test("sampleCatalogRasterPixel sends only Item identity and WGS 84 position", async () => {
  const requests = [];
  const abortController = new AbortController();
  const pixel = await sampleCatalogRasterPixel(
    MOUNTED_GEOTIFF_ITEM,
    { longitude: -122.25, latitude: 48.75 },
    abortController.signal,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({
          longitude: -122.25,
          latitude: 48.75,
          row: 2,
          column: 4,
          inBounds: true,
          value: 12.5,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );

  assert.equal(pixel.value, 12.5);
  assert.deepEqual(requests, [
    {
      url: "/api/rendering/pixels",
      options: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          collectionId: "eolab-mounted-geotiffs",
          itemId: "geotiff-0123456789abcdef01234567",
          longitude: -122.25,
          latitude: 48.75,
        }),
        signal: abortController.signal,
      },
    },
  ]);
});

test("detail-only pixel sampling uses its catalog-authorized endpoint", async () => {
  const requests = [];
  const abortController = new AbortController();
  const pixel = await sampleCatalogRasterDetailPixel(
    MOUNTED_GEOTIFF_ITEM,
    { longitude: -122.25, latitude: 48.75 },
    abortController.signal,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({
        longitude: -122.25,
        latitude: 48.75,
        row: 10,
        column: 20,
        inBounds: true,
        value: 42.5,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.equal(pixel.value, 42.5);
  assert.deepEqual(requests, [{
    url: "/api/rendering/detail-pixels",
    options: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        collectionId: MOUNTED_GEOTIFF_ITEM.collection,
        itemId: MOUNTED_GEOTIFF_ITEM.id,
        longitude: -122.25,
        latitude: 48.75,
      }),
      signal: abortController.signal,
    },
  }]);
});
