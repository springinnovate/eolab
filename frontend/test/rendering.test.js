import assert from "node:assert/strict";
import test from "node:test";

import { loadWmsCapabilities } from "../src/rendering.js";


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
