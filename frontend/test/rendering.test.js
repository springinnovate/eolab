import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRasterColorPalette,
  assessCatalogRaster,
  buildRasterLegend,
  buildRasterSampleWindowBounds,
  CatalogRasterLayerController,
  clearRasterHistogramChart,
  DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
  DEFAULT_RASTER_PERCENTILES,
  DEFAULT_RASTER_STYLE,
  deriveInitialRasterStyleFromStatistics,
  deriveRasterStyleFromStatistics,
  estimateRasterHistogramPercentile,
  formatRasterPixelValue,
  getCatalogRasterBasename,
  getRasterPixelProbePosition,
  loadCatalogRasterStatistics,
  loadWmsCapabilities,
  RasterPixelProbeController,
  renderRasterHistogramChart,
  RasterSampleWindowController,
  RasterStatisticsController,
  publishCatalogRaster,
  rasterStatisticsMatchesSelection,
  sampleCatalogRasterPixel,
  serializeRasterStyle,
  validateRasterSampleWindowSize,
  validateRasterSelectedBounds,
  validateRasterStatistics,
} from "../src/rendering.js";

const MOUNTED_GEOTIFF_ITEM = Object.freeze({
  collection: "eolab-mounted-geotiffs",
  id: "geotiff-0123456789abcdef01234567",
  assets: {
    data: {
      href: "file:///scan-source/folder/annual%20temperature.tif",
    },
  },
});

const RASTER_STATISTICS = Object.freeze({
  band: 1,
  scope: "wholeRaster",
  selectedBounds: null,
  sourceWidth: 1024,
  sourceHeight: 512,
  sourcePixelCount: 524288,
  sampleWidth: 512,
  sampleHeight: 256,
  sampledPixelCount: 131072,
  validSampleCount: 128000,
  estimated: true,
  sampleMinimum: -10,
  sampleMaximum: 30,
  percentiles: { p05: -4, p50: 3, p95: 20 },
  histogram: {
    counts: [2000, ...new Array(63).fill(2000)],
    edges: Array.from({ length: 65 }, (_, index) => -10 + index * 0.625),
  },
  suggestedRange: { minimum: -4, midpoint: 3, maximum: 20 },
});

const SELECTED_BOUNDS = Object.freeze({
  west: -123,
  south: 48,
  east: -121,
  north: 50,
});

const SELECTED_RASTER_STATISTICS = Object.freeze({
  ...RASTER_STATISTICS,
  scope: "selectedArea",
  selectedBounds: SELECTED_BOUNDS,
});

class FakeSvgElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.classNames = [];
    this.classList = { add: (name) => this.classNames.push(name) };
    this.textContent = "";
  }

  append(child) {
    this.children.push(child);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }
}

const FAKE_SVG_DOCUMENT = Object.freeze({
  createElementNS: (_namespace, tagName) => new FakeSvgElement(tagName),
});

test("raster style serializes the dynamic SLD contract", () => {
  assert.equal(
    serializeRasterStyle(DEFAULT_RASTER_STYLE),
    "min:0;med:50;max:100;cmin:#2b83ba;cmed:#ffffbf;cmax:#d7191c",
  );
});

test("raster palettes preserve thresholds and drive the numeric legend", () => {
  const style = applyRasterColorPalette(
    { ...DEFAULT_RASTER_STYLE, midpoint: 25 },
    "viridis",
  );

  assert.deepEqual(style, {
    minimum: 0,
    midpoint: 25,
    maximum: 100,
    minimumColor: "#440154",
    midpointColor: "#21918c",
    maximumColor: "#fde725",
  });
  assert.deepEqual(buildRasterLegend(style), {
    midpointPosition: 25,
    gradient:
      "linear-gradient(90deg, #440154 0%, #21918c 25%, #fde725 100%)",
    description:
      "Color ramp: 0 at #440154, 25 at #21918c, and 100 at #fde725.",
  });
});

test("raster style rejects values outside its six-field contract", () => {
  assert.throws(
    () => serializeRasterStyle({ ...DEFAULT_RASTER_STYLE, minimum: NaN }),
    /finite numbers/,
  );
  assert.throws(
    () => serializeRasterStyle({ ...DEFAULT_RASTER_STYLE, midpoint: 100 }),
    /Minimum must be less/,
  );
  assert.throws(
    () => serializeRasterStyle({
      ...DEFAULT_RASTER_STYLE,
      maximumColor: "red",
    }),
    /six-digit hex/,
  );
  assert.throws(
    () => applyRasterColorPalette(DEFAULT_RASTER_STYLE, "constructor"),
    /Unknown raster palette/,
  );
});

test("raster statistics validate their fixed bounded response contract", () => {
  assert.equal(validateRasterStatistics(RASTER_STATISTICS), RASTER_STATISTICS);
  assert.deepEqual(
    validateRasterStatistics(SELECTED_RASTER_STATISTICS),
    SELECTED_RASTER_STATISTICS,
  );

  assert.throws(
    () => validateRasterStatistics({
      ...RASTER_STATISTICS,
      sourcePixelCount: 1,
    }),
    /invalid sample counts/,
  );
  assert.throws(
    () => validateRasterStatistics({
      ...RASTER_STATISTICS,
      histogram: {
        ...RASTER_STATISTICS.histogram,
        counts: new Array(64).fill(1),
      },
    }),
    /invalid histogram counts/,
  );
  assert.throws(
    () => validateRasterStatistics({
      ...RASTER_STATISTICS,
      suggestedRange: { minimum: 1, midpoint: 1, maximum: 2 },
    }),
    /invalid suggested range/,
  );
  assert.throws(
    () => validateRasterStatistics({
      ...RASTER_STATISTICS,
      selectedBounds: SELECTED_BOUNDS,
    }),
    /invalid whole-raster scope/,
  );
  assert.throws(
    () => validateRasterStatistics({
      ...SELECTED_RASTER_STATISTICS,
      selectedBounds: { ...SELECTED_BOUNDS, west: 179, east: -179 },
    }),
    /invalid selected bounds/,
  );
});

test("raster statistics apply only to their current whole or selected scope", () => {
  const otherBounds = { ...SELECTED_BOUNDS, west: -120, east: -118 };

  assert.equal(rasterStatisticsMatchesSelection(RASTER_STATISTICS, null), true);
  assert.equal(
    rasterStatisticsMatchesSelection(RASTER_STATISTICS, SELECTED_BOUNDS),
    false,
  );
  assert.equal(
    rasterStatisticsMatchesSelection(SELECTED_RASTER_STATISTICS, SELECTED_BOUNDS),
    true,
  );
  assert.equal(
    rasterStatisticsMatchesSelection(SELECTED_RASTER_STATISTICS, otherBounds),
    false,
  );
});

test("sample windows use ground distance instead of projected map metres", () => {
  const equatorial = buildRasterSampleWindowBounds(
    { longitude: 0, latitude: 0 },
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
  );
  const highLatitude = buildRasterSampleWindowBounds(
    { longitude: 0, latitude: 60 },
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
  );

  assert.ok(Math.abs(equatorial.south + 0.8993) < 0.01);
  assert.ok(Math.abs(equatorial.north - 0.8993) < 0.01);
  assert.ok(Math.abs(equatorial.west + 0.8994) < 0.01);
  assert.ok(Math.abs(equatorial.east - 0.8994) < 0.01);
  assert.ok(highLatitude.east - highLatitude.west > 3.5);
  assert.equal(validateRasterSelectedBounds(equatorial), equatorial);
});

test("sample window contract rejects invalid sizes and unsupported crossings", () => {
  assert.equal(validateRasterSampleWindowSize(1), 1);
  assert.equal(validateRasterSampleWindowSize(300), 300);
  assert.throws(() => validateRasterSampleWindowSize(0), /between 1 and 300/);
  assert.throws(() => validateRasterSampleWindowSize(1.5), /between 1 and 300/);
  assert.throws(
    () => buildRasterSampleWindowBounds(
      { longitude: 179.5, latitude: 0 },
      200,
    ),
    /pole or date line/,
  );
  assert.throws(
    () => buildRasterSampleWindowBounds(
      { longitude: 0, latitude: 89.5 },
      200,
    ),
    /pole or date line/,
  );
});

test("raster histogram percentiles drive strict canonical styles", () => {
  assert.equal(DEFAULT_RASTER_PERCENTILES.lower, 5);
  assert.equal(estimateRasterHistogramPercentile(RASTER_STATISTICS, 5), -4);
  assert.equal(estimateRasterHistogramPercentile(RASTER_STATISTICS, 25), 0);
  assert.equal(estimateRasterHistogramPercentile(RASTER_STATISTICS, 95), 20);

  assert.deepEqual(
    deriveRasterStyleFromStatistics(DEFAULT_RASTER_STYLE, RASTER_STATISTICS),
    {
      ...DEFAULT_RASTER_STYLE,
      minimum: -4,
      midpoint: 3,
      maximum: 20,
    },
  );
  assert.deepEqual(
    deriveRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      RASTER_STATISTICS,
      { lower: 0, middle: 25, upper: 100 },
    ),
    {
      ...DEFAULT_RASTER_STYLE,
      minimum: -10,
      midpoint: 0,
      maximum: 30,
    },
  );
  assert.throws(
    () => deriveRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      RASTER_STATISTICS,
      { lower: 50, middle: 50, upper: 95 },
    ),
    /in increasing order/,
  );

  const estimates = Array.from(
    { length: 101 },
    (_, percentile) => estimateRasterHistogramPercentile(
      RASTER_STATISTICS,
      percentile,
    ),
  );
  assert.ok(estimates.slice(1).every(
    (estimate, index) => estimate >= estimates[index],
  ));
});

test("constant and tiny raster suggestions preserve strict style ordering", () => {
  const constantStatistics = {
    ...RASTER_STATISTICS,
    sampleMinimum: 7,
    sampleMaximum: 7,
    percentiles: { p05: 7, p50: 7, p95: 7 },
    suggestedRange: { minimum: 6.999993, midpoint: 7, maximum: 7.000007 },
  };
  const tinyStatistics = {
    ...RASTER_STATISTICS,
    sampleMinimum: -0.0000002,
    sampleMaximum: 0.0000003,
    percentiles: { p05: -0.0000001, p50: 0, p95: 0.0000001 },
    suggestedRange: {
      minimum: -0.0000001,
      midpoint: 0,
      maximum: 0.0000001,
    },
  };

  assert.doesNotThrow(() => serializeRasterStyle(
    deriveRasterStyleFromStatistics(DEFAULT_RASTER_STYLE, constantStatistics),
  ));
  assert.equal(
    estimateRasterHistogramPercentile(constantStatistics, 25),
    7,
  );
  assert.doesNotThrow(() => serializeRasterStyle(
    deriveRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      constantStatistics,
      { lower: 10, middle: 50, upper: 90 },
    ),
  ));
  assert.deepEqual(
    deriveRasterStyleFromStatistics(DEFAULT_RASTER_STYLE, tinyStatistics),
    {
      ...DEFAULT_RASTER_STYLE,
      minimum: -0.0000001,
      midpoint: 0,
      maximum: 0.0000001,
    },
  );
});

test("late statistics never replace a manually revised style", () => {
  assert.deepEqual(
    deriveInitialRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      RASTER_STATISTICS,
      2,
      3,
    ),
    null,
  );
  assert.equal(
    deriveInitialRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      RASTER_STATISTICS,
      3,
      3,
    ).minimum,
    -4,
  );
});

test("loadWmsCapabilities validates the public WMS endpoint", async () => {
  const requestedUrls = [];
  const capabilitiesUrl = await loadWmsCapabilities(
    "/geoserver/eolab/wms",
    async (url, options) => {
      requestedUrls.push({ url, options });
      return new Response(
        '<?xml version="1.0"?><WMS_Capabilities version="1.3.0"/>',
        {
          status: 200,
          headers: { "Content-Type": "application/xml" },
        }
      );
    }
  );

  assert.equal(
    capabilitiesUrl,
    "/geoserver/eolab/wms?service=WMS&version=1.3.0&request=GetCapabilities"
  );
  assert.deepEqual(requestedUrls, [
    {
      url: capabilitiesUrl,
      options: { headers: { Accept: "application/xml" } },
    },
  ]);
});

test("loadWmsCapabilities rejects an unavailable service", async () => {
  await assert.rejects(
    loadWmsCapabilities(
      "/geoserver/eolab/wms",
      async () => new Response("", { status: 502 })
    ),
    /returned 502/
  );
});

test("loadWmsCapabilities rejects a non-WMS document", async () => {
  await assert.rejects(
    loadWmsCapabilities(
      "/geoserver/eolab/wms",
      async () => new Response("<html>not WMS</html>", { status: 200 })
    ),
    /unexpected document/
  );
});

test("assessCatalogRaster sends only the STAC Item identity", async () => {
  const requests = [];
  const assessedItem = {
    ...MOUNTED_GEOTIFF_ITEM,
    assets: {
      data: {
        "eolab:rendering": { policy: "raster-v2", eligible: true },
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

test("raster histogram rendering displays all 64 SVG bars", () => {
  const chart = new FakeSvgElement("svg");
  chart.setAttribute("hidden", "");

  renderRasterHistogramChart(chart, RASTER_STATISTICS, FAKE_SVG_DOCUMENT);

  assert.equal(chart.hasAttribute("hidden"), false);
  assert.equal(chart.children[0].tagName, "title");
  assert.equal(chart.children.slice(1).length, 64);
  assert.ok(chart.children.slice(1).every(
    (bar) => bar.tagName === "rect" &&
      bar.classNames.includes("raster-histogram-bar"),
  ));

  clearRasterHistogramChart(chart);
  assert.equal(chart.hasAttribute("hidden"), true);
  assert.equal(chart.children.length, 0);
});

test("selected histogram percentiles replace the whole-raster display range", () => {
  const selectedStatistics = {
    ...SELECTED_RASTER_STATISTICS,
    percentiles: { p05: 0.002, p50: 0.015, p95: 0.4 },
    suggestedRange: { minimum: 0.002, midpoint: 0.015, maximum: 0.4 },
  };

  assert.deepEqual(
    deriveRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      selectedStatistics,
      DEFAULT_RASTER_PERCENTILES,
    ),
    {
      ...DEFAULT_RASTER_STYLE,
      minimum: 0.002,
      midpoint: 0.015,
      maximum: 0.4,
    },
  );
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
      async () => new Response(JSON.stringify({ ...RASTER_STATISTICS, band: 2 }), {
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

test("RasterPixelProbeController samples immediately then keeps the latest point", async () => {
  const clock = createFakeClock();
  const requests = [];
  const results = [];
  const controller = new RasterPixelProbeController(
    (_item, point, signal) => {
      requests.push({ point, signal });
      return Promise.resolve({ inBounds: true, value: point.longitude });
    },
    (result, point) => results.push({ result, point }),
    () => assert.fail("Unexpected pixel error"),
    { clock, now: () => clock.time },
  );

  controller.activate(MOUNTED_GEOTIFF_ITEM);
  controller.move({ longitude: 1, latitude: 10 });
  await Promise.resolve();
  clock.time = 20;
  controller.move({ longitude: 2, latitude: 20 });
  clock.time = 50;
  controller.move({ longitude: 3, latitude: 30 });

  assert.equal(requests.length, 1);
  clock.advanceTo(100);
  await Promise.resolve();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, false);
  assert.deepEqual(requests[1].point, {
    longitude: 3,
    latitude: 30,
  });
  assert.deepEqual(results, [
    {
      result: { inBounds: true, value: 1 },
      point: { longitude: 1, latitude: 10 },
    },
    {
      result: { inBounds: true, value: 3 },
      point: { longitude: 3, latitude: 30 },
    },
  ]);
});

test("RasterPixelProbeController aborts and ignores cleared work", async () => {
  const requests = [];
  const results = [];
  const controller = new RasterPixelProbeController(
    (_item, point, signal) => new Promise((resolve) => {
      requests.push({ point, signal, resolve });
    }),
    (result) => results.push(result),
    () => assert.fail("Unexpected pixel error"),
  );

  controller.activate(MOUNTED_GEOTIFF_ITEM);
  controller.move({ longitude: 1, latitude: 2 });
  controller.clear();
  requests[0].resolve({ inBounds: true, value: 7 });
  await Promise.resolve();

  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(results, []);
});

test("RasterPixelProbeController completes one read before sampling the latest point", async () => {
  const clock = createFakeClock();
  const requests = [];
  const results = [];
  const controller = new RasterPixelProbeController(
    (_item, point, signal) => new Promise((resolve) => {
      requests.push({ point, signal, resolve });
    }),
    (result, point) => results.push({ result, point }),
    () => assert.fail("Unexpected pixel error"),
    { clock, now: () => clock.time },
  );

  controller.activate(MOUNTED_GEOTIFF_ITEM);
  controller.move({ longitude: 1, latitude: 10 });
  clock.time = 20;
  controller.move({ longitude: 2, latitude: 20 });
  requests[0].resolve({ inBounds: true, value: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests[0].signal.aborted, false);
  assert.deepEqual(results, [
    {
      result: { inBounds: true, value: 1 },
      point: { longitude: 1, latitude: 10 },
    },
  ]);
  clock.advanceTo(100);
  assert.deepEqual(requests[1].point, { longitude: 2, latitude: 20 });
});

test("pixel probe position follows the pointer and flips at viewport edges", () => {
  const probeSize = { width: 100, height: 40 };
  const viewport = { width: 500, height: 300 };

  assert.deepEqual(
    getRasterPixelProbePosition({ x: 100, y: 100 }, probeSize, viewport),
    { x: 112, y: 112 },
  );
  assert.deepEqual(
    getRasterPixelProbePosition({ x: 490, y: 290 }, probeSize, viewport),
    { x: 378, y: 238 },
  );
});

test("pixel probe formats small values with four significant digits", () => {
  assert.equal(formatRasterPixelValue(0.0001), "1.000e-4");
  assert.equal(formatRasterPixelValue(0.0000123456), "1.235e-5");
  assert.equal(formatRasterPixelValue(-0.0001), "-1.000e-4");
  assert.equal(formatRasterPixelValue(0), "0");
});

test("pixel probe labels the selected raster by its decoded basename", () => {
  assert.equal(
    getCatalogRasterBasename(MOUNTED_GEOTIFF_ITEM),
    "annual temperature.tif",
  );
});

function createFakeLeafletMap(center = { lng: 0, lat: 0 }) {
  const handlers = new Map();
  return {
    center,
    layers: [],
    removedLayers: [],
    on(eventName, handler) {
      const eventHandlers = handlers.get(eventName) ?? new Set();
      eventHandlers.add(handler);
      handlers.set(eventName, eventHandlers);
    },
    off(eventName, handler) {
      handlers.get(eventName)?.delete(handler);
    },
    emit(eventName, event = {}) {
      for (const handler of handlers.get(eventName) ?? []) {
        handler(event);
      }
    },
    getCenter() {
      return this.center;
    },
    removeLayer(layer) {
      this.removedLayers.push(layer);
      this.layers = this.layers.filter((candidate) => candidate !== layer);
    },
    listenerCount(eventName) {
      return handlers.get(eventName)?.size ?? 0;
    },
  };
}

function createFakeSampleLayerFactory(createdLayers) {
  return (bounds, kind) => {
    const layer = {
      kind,
      boundsHistory: [bounds],
      addTo(map) {
        map.layers.push(this);
        return this;
      },
      setBounds(nextBounds) {
        this.boundsHistory.push(nextBounds);
      },
    };
    createdLayers.push(layer);
    return layer;
  };
}

test("sample window previews on movement and requests only on click", () => {
  const map = createFakeLeafletMap();
  const layers = [];
  const selections = [];
  const guidance = [];
  const controller = new RasterSampleWindowController(
    map,
    createFakeSampleLayerFactory(layers),
    (bounds) => selections.push(bounds),
    (message) => guidance.push(message),
  );

  controller.enable();
  assert.equal(controller.isEnabled, true);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].kind, "preview");
  assert.equal(selections.length, 0);

  assert.doesNotThrow(() => {
    map.emit("mousemove", { latlng: { lng: 238, lat: 48 } });
  });
  assert.equal(guidance.at(-1), "");
  const wrappedPreview = layers[0].boundsHistory.at(-1);
  assert.ok(wrappedPreview[0][1] < 238);
  assert.ok(wrappedPreview[1][1] > 238);

  map.emit("click", { latlng: { lng: 238, lat: 48 } });
  assert.equal(selections.length, 1);
  assert.ok(selections[0].west < -122);
  assert.ok(selections[0].east > -122);
  const wrappedSelection = layers.at(-1).boundsHistory.at(-1);
  assert.ok(wrappedSelection[0][1] < 238);
  assert.ok(wrappedSelection[1][1] > 238);

  map.emit("mousemove", { latlng: { lng: -122, lat: 48 } });
  controller.setWindowSize(50);
  assert.equal(layers[0].boundsHistory.length, 4);
  assert.equal(selections.length, 1);

  map.emit("click", { latlng: { lng: -122, lat: 48 } });
  assert.equal(selections.length, 2);
  assert.equal(layers.at(-1).kind, "selection");
  assert.deepEqual(controller.selectedBounds, selections[1]);
  assert.equal(guidance.at(-1), "");
});

test("sample window supports map-center selection and complete teardown", () => {
  const map = createFakeLeafletMap({ lng: 12, lat: 34 });
  const layers = [];
  const selections = [];
  const guidance = [];
  const controller = new RasterSampleWindowController(
    map,
    createFakeSampleLayerFactory(layers),
    (bounds) => selections.push(bounds),
    (message) => guidance.push(message),
  );

  controller.sampleMapCenter();
  assert.equal(selections.length, 1);
  assert.equal(layers[0].kind, "selection");
  controller.enable();
  map.emit("mousemove", { latlng: { lng: 179.8, lat: 0 } });
  assert.match(guidance.at(-1), /pole or date line/);

  controller.clear();
  assert.equal(controller.isEnabled, false);
  assert.equal(controller.selectedBounds, null);
  assert.equal(map.layers.length, 0);
  for (const eventName of ["mousemove", "mouseout", "mouseover", "click"]) {
    assert.equal(map.listenerCount(eventName), 0);
  }
});

test("RasterStatisticsController aborts and ignores stale Item results", async () => {
  const requests = [];
  const loading = [];
  const results = [];
  const controller = new RasterStatisticsController(
    (item, signal) => new Promise((resolve) => {
      requests.push({ item, signal, resolve });
    }),
    (item, context) => loading.push({ item, context }),
    (statistics, item, context) => results.push({ statistics, item, context }),
    () => assert.fail("Unexpected statistics error"),
  );
  const secondItem = { ...MOUNTED_GEOTIFF_ITEM, id: "geotiff-second" };

  const firstRequest = controller.activate(
    MOUNTED_GEOTIFF_ITEM,
    { styleRevision: 0 },
  );
  const secondRequest = controller.activate(
    secondItem,
    { styleRevision: 1 },
  );
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(RASTER_STATISTICS);
  requests[1].resolve(RASTER_STATISTICS);
  await Promise.all([firstRequest, secondRequest]);

  assert.equal(loading.length, 2);
  assert.deepEqual(results, [
    {
      statistics: RASTER_STATISTICS,
      item: secondItem,
      context: { styleRevision: 1 },
    },
  ]);
});

test("RasterStatisticsController aborts and ignores a stale clicked area", async () => {
  const requests = [];
  const results = [];
  const controller = new RasterStatisticsController(
    (item, signal, selectedBounds) => new Promise((resolve) => {
      requests.push({ item, signal, selectedBounds, resolve });
    }),
    () => {},
    (statistics) => results.push(statistics),
    () => assert.fail("Unexpected statistics error"),
  );
  const secondBounds = { ...SELECTED_BOUNDS, west: -120, east: -118 };

  const firstRequest = controller.activate(
    MOUNTED_GEOTIFF_ITEM,
    undefined,
    SELECTED_BOUNDS,
  );
  const secondRequest = controller.activate(
    MOUNTED_GEOTIFF_ITEM,
    undefined,
    secondBounds,
  );
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(requests.map(({ selectedBounds }) => selectedBounds), [
    SELECTED_BOUNDS,
    secondBounds,
  ]);

  requests[0].resolve(SELECTED_RASTER_STATISTICS);
  requests[1].resolve({
    ...SELECTED_RASTER_STATISTICS,
    selectedBounds: secondBounds,
  });
  await Promise.all([firstRequest, secondRequest]);
  assert.deepEqual(results, [{
    ...SELECTED_RASTER_STATISTICS,
    selectedBounds: secondBounds,
  }]);
});

test("RasterStatisticsController retains its Item for a recoverable retry", async () => {
  let attempts = 0;
  const requestedBounds = [];
  const errors = [];
  const results = [];
  const controller = new RasterStatisticsController(
    async (_item, _signal, selectedBounds) => {
      attempts += 1;
      requestedBounds.push(selectedBounds);
      if (attempts === 1) {
        throw new Error("Statistics service busy");
      }
      return RASTER_STATISTICS;
    },
    () => {},
    (statistics) => results.push(statistics),
    (error) => errors.push(error.message),
  );

  assert.equal(
    await controller.activate(
      MOUNTED_GEOTIFF_ITEM,
      undefined,
      SELECTED_BOUNDS,
    ),
    null,
  );
  assert.deepEqual(errors, ["Statistics service busy"]);
  assert.equal(await controller.retry(), RASTER_STATISTICS);
  assert.deepEqual(requestedBounds, [SELECTED_BOUNDS, SELECTED_BOUNDS]);
  assert.deepEqual(results, [RASTER_STATISTICS]);
});

function createFakeClock() {
  return {
    time: 0,
    nextTimerId: 1,
    timers: new Map(),
    setTimeout(callback, delay) {
      const timerId = this.nextTimerId++;
      this.timers.set(timerId, { callback, at: this.time + delay });
      return timerId;
    },
    clearTimeout(timerId) {
      this.timers.delete(timerId);
    },
    advanceTo(time) {
      this.time = time;
      for (const [timerId, timer] of this.timers) {
        if (timer.at <= time) {
          this.timers.delete(timerId);
          timer.callback();
        }
      }
    },
  };
}

test("CatalogRasterLayerController ignores stale publication results", async () => {
  const leafletMap = { removeLayer() {} };
  const resolvers = [];
  const controller = new CatalogRasterLayerController(
    leafletMap,
    () => new Promise((resolve) => resolvers.push(resolve)),
    ({ layerName }) => ({
      layerName,
      addTo(map) {
        this.map = map;
        return this;
      },
    }),
  );

  const staleRequest = controller.show({ id: "first" });
  controller.clear();
  resolvers[0]({ layerName: "eolab:first", bbox: [0, 0, 1, 1] });

  assert.equal(await staleRequest, null);
  assert.equal(controller.activeLayer, null);
});

test("CatalogRasterLayerController keeps only the latest layer", async () => {
  const removedLayers = [];
  const leafletMap = { removeLayer: (layer) => removedLayers.push(layer) };
  const publications = [
    { layerName: "eolab:first", bbox: [0, 0, 1, 1] },
    { layerName: "eolab:second", bbox: [1, 1, 2, 2] },
  ];
  const controller = new CatalogRasterLayerController(
    leafletMap,
    async () => publications.shift(),
    ({ layerName }) => ({
      layerName,
      addTo(map) {
        this.map = map;
        return this;
      },
    }),
  );

  await controller.show({ id: "first" });
  const firstLayer = controller.activeLayer;
  await controller.show({ id: "second" });

  assert.deepEqual(removedLayers, [firstLayer]);
  assert.equal(controller.activeLayer.layerName, "eolab:second");
});
