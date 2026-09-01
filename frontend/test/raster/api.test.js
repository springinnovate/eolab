import assert from "node:assert/strict";
import test from "node:test";

import {
  publishCatalogRaster,
  RenderingRequestError,
} from "../../src/raster/api.js";
import {
  loadCatalogRasterStatistics,
  RasterAnalysisRequestError,
  isRasterStatisticsCapacityError,
  sampleCatalogRasterPixel,
} from "../../src/raster/analysis-api.js";
import {
  MOUNTED_GEOTIFF_ITEM,
  RASTER_STATISTICS,
  SELECTED_BOUNDS,
  SELECTED_RASTER_STATISTICS,
  TEMPORARY_AOI_ID,
  TEMPORARY_AOI_RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

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
      { kind: "wholeRaster" },
      abortController.signal,
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
      url: "/api/raster-analysis/statistics",
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
      { kind: "selectedArea", selectedBounds: SELECTED_BOUNDS },
      abortController.signal,
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
      { kind: "selectedArea", selectedBounds: SELECTED_BOUNDS },
      abortController.signal,
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
    { kind: "temporaryAoi", temporaryAoiId: TEMPORARY_AOI_ID },
    abortController.signal,
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
      {
        kind: "selectedArea",
        selectedBounds: SELECTED_BOUNDS,
        temporaryAoiId: TEMPORARY_AOI_ID,
      },
      abortController.signal,
      async () => new Response(),
    ),
    /sampling area is invalid/,
  );
});

test("statistics capacity is classified without matching user-facing message text", async () => {
  for (const code of ["statistics_capacity_busy", "invalid_area", null]) {
    await assert.rejects(loadCatalogRasterStatistics(
      MOUNTED_GEOTIFF_ITEM, { kind: "wholeRaster" }, new AbortController().signal,
      async () => new Response(JSON.stringify({ detail: { code, message: "Server guidance" } }),
        { status: 409, headers: { "Content-Type": "application/json" } }),
    ), error => {
      assert.equal(error.message, "Server guidance");
      assert.equal(isRasterStatisticsCapacityError(error), code === "statistics_capacity_busy");
      return true;
    });
  }
  assert.equal(isRasterStatisticsCapacityError(new RasterAnalysisRequestError(
    "Raster statistics capacity is busy; retry after the current bounded read finishes.", 409)), false);
});

test("loadCatalogRasterStatistics reports backend and response errors", async () => {
  await assert.rejects(
    loadCatalogRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      { kind: "wholeRaster" },
      new AbortController().signal,
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
        { kind: "wholeRaster" },
        new AbortController().signal,
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
      { kind: "wholeRaster" },
      new AbortController().signal,
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
      url: "/api/raster-analysis/pixels",
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

test("pixel analysis preserves catalog-source failures", async () => {
  const request = sampleCatalogRasterPixel(
    MOUNTED_GEOTIFF_ITEM,
    { longitude: -122.25, latitude: 48.75 },
    new AbortController().signal,
    async () => new Response(
      JSON.stringify({
        detail: "The cataloged raster changed; scan it again before analysis.",
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ),
  );

  await assert.rejects(request, (error) => {
    assert.equal(error instanceof RasterAnalysisRequestError, true);
    assert.equal(error.status, 409);
    assert.match(error.message, /scan it again/);
    return true;
  });
});
