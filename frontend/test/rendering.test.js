import assert from "node:assert/strict";
import test from "node:test";

import {
  CatalogRasterLayerController,
  loadWmsCapabilities,
  publishCatalogRaster,
} from "../src/rendering.js";

const MOUNTED_GEOTIFF_ITEM = Object.freeze({
  collection: "eolab-mounted-geotiffs",
  id: "geotiff-0123456789abcdef01234567",
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

test("publishCatalogRaster requires a valid bounding box", async () => {
  await assert.rejects(
    publishCatalogRaster(
      MOUNTED_GEOTIFF_ITEM,
      async () => new Response(
        JSON.stringify({
          layerName: "eolab:stac-invalid",
          bbox: [-123, 48, -123, 49],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
    /invalid bounding box/,
  );
});

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
