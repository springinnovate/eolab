import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRasterStyleEnvironment,
  loadWmsCapabilities,
} from "../../src/raster/wms.js";
import {
  DEFAULT_RASTER_STYLE,
  deriveRasterStyleFromStatistics,
} from "../../src/raster/style.js";
import {
  CONSTANT_RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

test("raster style builds the dynamic SLD environment contract", () => {
  assert.equal(
    buildRasterStyleEnvironment(DEFAULT_RASTER_STYLE),
    "min:0;med:50;max:100;cmin:#2b83ba;cmed:#ffffbf;cmax:#d7191c",
  );
});

test("raster style environment rejects values outside its six-field contract", () => {
  assert.throws(
    () => buildRasterStyleEnvironment({
      ...DEFAULT_RASTER_STYLE,
      minimum: NaN,
    }),
    /finite numbers/,
  );
  assert.throws(
    () => buildRasterStyleEnvironment({
      ...DEFAULT_RASTER_STYLE,
      midpoint: 100,
    }),
    /Minimum must be less/,
  );
  assert.throws(
    () => buildRasterStyleEnvironment({
      ...DEFAULT_RASTER_STYLE,
      maximumColor: "red",
    }),
    /six-digit hex/,
  );
});

test("constant raster suggestions build valid WMS environments", () => {
  assert.doesNotThrow(() => buildRasterStyleEnvironment(
    deriveRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      CONSTANT_RASTER_STATISTICS,
    ),
  ));
  assert.doesNotThrow(() => buildRasterStyleEnvironment(
    deriveRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      CONSTANT_RASTER_STATISTICS,
      { lower: 10, middle: 50, upper: 90 },
    ),
  ));
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
        },
      );
    },
  );

  assert.equal(
    capabilitiesUrl,
    "/geoserver/eolab/wms?service=WMS&version=1.3.0&request=GetCapabilities",
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
      async () => new Response("", { status: 502 }),
    ),
    /returned 502/,
  );
});

test("loadWmsCapabilities rejects a non-WMS document", async () => {
  await assert.rejects(
    loadWmsCapabilities(
      "/geoserver/eolab/wms",
      async () => new Response("<html>not WMS</html>", { status: 200 }),
    ),
    /unexpected document/,
  );
});
