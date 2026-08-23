import assert from "node:assert/strict";
import test from "node:test";

import {
  assessCatalogRaster,
  loadCatalogRasterStatistics,
  loadCatalogRasterDetailPreview,
  publishCatalogRaster,
  RenderingRequestError,
  sampleCatalogRasterPixel,
  validateRasterDetailPreview,
} from "../../src/raster/api.js";
import {
  MOUNTED_GEOTIFF_ITEM,
  CENTER_SAMPLE_DETAIL_PREVIEW,
  NODATA_DETAIL_PREVIEW,
  PATCH_DETAIL_PREVIEW,
  RASTER_STATISTICS,
  SELECTED_BOUNDS,
  SELECTED_RASTER_STATISTICS,
  TEMPORARY_AOI_ID,
  TEMPORARY_AOI_RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

test("detail preview sends only Item identity and selected fixed mode", async () => {
  const requests = [];
  const abortController = new AbortController();

  assert.deepEqual(
    await loadCatalogRasterDetailPreview(
      MOUNTED_GEOTIFF_ITEM,
      "centerSample",
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
    "centerSample",
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

test("detail preview accepts numeric images and honest all-nodata proxies", () => {
  assert.equal(
    validateRasterDetailPreview(
      CENTER_SAMPLE_DETAIL_PREVIEW,
      "centerSample",
    ),
    CENTER_SAMPLE_DETAIL_PREVIEW,
  );
  assert.equal(
    validateRasterDetailPreview(NODATA_DETAIL_PREVIEW, "centerSample"),
    NODATA_DETAIL_PREVIEW,
  );
  assert.equal(
    validateRasterDetailPreview(PATCH_DETAIL_PREVIEW, "representativePatch"),
    PATCH_DETAIL_PREVIEW,
  );
});

test("detail preview rejects arbitrary modes before sending a request", async () => {
  await assert.rejects(
    loadCatalogRasterDetailPreview(
      MOUNTED_GEOTIFF_ITEM,
      "fullExtent",
      new AbortController().signal,
      async () => {
        throw new Error("request should not be sent");
      },
    ),
    /Unsupported raster detail preview mode/,
  );
});

test("detail preview strictly validates v2 numeric image identity and shape", () => {
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
        maximumSourceBlockReads: 1025,
      },
    }],
    ["over-limit actual block reads", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      actual: {
        ...CENTER_SAMPLE_DETAIL_PREVIEW.actual,
        sourceBlockReadCount: 1025,
      },
    }],
    ["over-limit actual decoded bytes", {
      ...CENTER_SAMPLE_DETAIL_PREVIEW,
      actual: {
        ...CENTER_SAMPLE_DETAIL_PREVIEW.actual,
        decodedSourceBytes: 67108865,
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
      () => validateRasterDetailPreview(preview, "centerSample"),
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
    }, "representativePatch"),
    /exceeds its fixed limit/,
  );
});

test("detail preview requires null color range only for all-nodata images", () => {
  assert.throws(
    () => validateRasterDetailPreview({
      ...NODATA_DETAIL_PREVIEW,
      suggestedRange: { minimum: 0, midpoint: 50, maximum: 100 },
    }, "centerSample"),
    /color range is invalid/,
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
